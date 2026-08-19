#!/usr/bin/env python3
"""probook worker-health watchdog — ported from the Claude Code routine
`probook-worker-check` (2026-08-18). Read-only. Prints NOTHING when healthy,
so Hermes `--no-agent` delivery stays silent unless something is wrong.

Why it exists: probook runs 12 supervised workers inside the app container.
The in-app dead-man switch emails when a heartbeat goes stale — but it runs
INSIDE the app, so a dead container fires nothing. This is the outside observer.

Two steps, same as the original routine:
  1. /api/health-summary + /api/version — catches "worker heartbeat went stale"
  2. Portainer container-log scan (24h) — catches the class health-summary CANNOT see:
     a worker whose HTTP call fails every run while the job underneath still completes
     ([sound-merge] run failed: fetch failed, 48/48 runs, before v1.172).
Step 2 uses a **Portainer access token** (X-API-Key) from ~/.hermes/scripts/probook.env,
not a browser session — Hermes drives its own browser and cannot borrow the user's
logged-in Chrome. No token configured = step 2 is skipped silently.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("PROBOOK_BASE", "https://probook.xtec9.xyz").rstrip("/")
STATE = os.path.expanduser("~/.hermes/state/probook/worker-check.json")
TIMEOUT = 20
RETRY_DELAYS = (20, 60, 120)  # เน็ตของเครื่องนี้สะดุดเป็นชั่วโมงได้ (DNS ล่ม 11:03–12:00 วันที่ 19 ส.ค.)


def net_down():
    """เน็ต/DNS ของเครื่องนี้พังเอง ≠ prod ล่ม — ต้องแยกให้ออก ไม่งั้นตะโกนผิดคน"""
    import socket
    for host in ("cloudflare.com", "google.com", "github.com"):
        try:
            socket.getaddrinfo(host, 443)
            return False
        except Exception:
            continue
    return True


def get(path, timeout=TIMEOUT):
    """-> (status, body_text). status 0 = no response at all."""
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "hermes-probook-watchdog"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:  # 503 carries the body we need
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def get_retry(path, timeout=TIMEOUT):
    """ไม่มีคำตอบเลย = ลองใหม่ตามจังหวะ RETRY_DELAYS ก่อนจะสรุปว่าเข้าไม่ถึง"""
    status, body = get(path, timeout)
    for delay in RETRY_DELAYS:
        if status != 0:
            return status, body
        time.sleep(delay)
        status, body = get(path, timeout)
    return status, body


ENV_FILE = os.path.expanduser("~/.hermes/scripts/probook.env")
LOG_HOURS = 24
LOG_TAIL = 8000

# บรรทัดที่ไม่ใช่ความผิดปกติ — supervisor ปิด worker ที่ตั้งใจปิด
SKIP_RE = re.compile(r"supervisor: worker exited|is off — exiting|WORKER_ENABLED=0")
WORKER_RE = re.compile(r"\[([a-z][a-z-]+)\]")
BAD_RE = re.compile(r"run failed|no activity for|\] [45]\d\d:")


def env_val(key):
    """อ่านจาก env ก่อน ถ้าไม่มีค่อยอ่านจาก probook.env (chmod 600)"""
    v = os.environ.get(key)
    if v:
        return v.strip()
    try:
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return ""


def fetch_container_logs():
    """-> (text, err). err='no-config' = ไม่ได้ตั้ง token ไว้ → ข้ามเงียบ ๆ ตามดีไซน์เดิม

    ใช้ Portainer access token (X-API-Key) ไม่ใช่ session ของ Chrome — Hermes ใช้
    บราวเซอร์คนละตัว การล็อกอินใน Chrome ของคนใช้จึงช่วยตรงนี้ไม่ได้
    """
    base = env_val("PORTAINER_URL")
    key = env_val("PORTAINER_API_KEY")
    if not base or not key:
        return None, "no-config"
    eid = env_val("PORTAINER_ENDPOINT_ID") or "2"
    cont = env_val("PORTAINER_CONTAINER") or "production-booking-app"
    since = int(time.time()) - LOG_HOURS * 3600
    url = (f"{base.rstrip('/')}/api/endpoints/{eid}/docker/containers/{cont}/logs"
           f"?stdout=1&stderr=1&timestamps=1&tail={LOG_TAIL}&since={since}")
    req = urllib.request.Request(url, headers={"X-API-Key": key, "User-Agent": "hermes-probook-watchdog"})
    for delay in (0,) + RETRY_DELAYS:
        if delay:
            time.sleep(delay)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace"), None
        except urllib.error.HTTPError as e:
            code = e.code
            if code in (401, 403):
                return None, f"auth-{code}"  # token หมดอายุ/ถูกเพิกถอน — บอกให้รู้ ไม่เงียบ
            if code == 404:
                return None, "not-found"     # endpoint id / ชื่อ container เปลี่ยน
            last = f"http-{code}"
        except Exception as e:
            last = str(e)[:100]
    return None, last


def scan_logs(text):
    """-> (bad, seen, samples) นับต่อ tag จาก log 24 ชม.

    `seen` = "มีร่องรอยว่ายังมีชีวิต" = บรรทัดใดก็ได้ของ tag นั้นที่ไม่ใช่ SKIP
    เดิมผมนับเฉพาะบรรทัดที่แมตช์รูปแบบสรุป (`bookings=`, `checked=` …) แล้วมันกล่าวหา
    backup / calendar-reconcile / shoot-marker ว่าตาย ทั้งที่ log มีบรรทัดของมันอยู่จริง —
    worker รายวันพิมพ์บรรทัดเดียวและใช้คำคนละแบบ (`ok file=…`, `scanned 19p/41b`)
    """
    bad, seen, samples = {}, {}, []
    for raw in (text or "").split("\n"):
        # ลอก byte framing ของ docker log (\x00-\x1f + U+FFFD ที่เกิดจาก decode ไม่ได้)
        line = re.sub(r"^[\x00-\x1f\ufffd]+", "", re.sub(r"[\x00-\x08\ufffd]", "", raw))
        m = WORKER_RE.search(line)
        if not m or SKIP_RE.search(line):
            continue
        name = m.group(1)
        seen[name] = seen.get(name, 0) + 1
        if BAD_RE.search(line):
            bad[name] = bad.get(name, 0) + 1
            if len(samples) < 5:
                samples.append(line.strip()[:150])
    return bad, seen, samples


def log_scan_report(enabled_keys, dead_keys=()):
    """-> list บรรทัดรายงาน (ว่าง = log สะอาด หรือไม่ได้ตั้ง token)

    dead_keys = worker ที่ health-summary บอกว่าเปิดอยู่แต่ไม่ tick มาเกิน 24 ชม.
    (หรือไม่เคย tick) — เฉพาะพวกนี้ที่ "ไม่มีร่องรอยใน log" ถึงจะเป็นสัญญาณจริง
    ตัวที่ tick ปกติแต่เงียบใน log = worker รายวันที่ยังไม่ถึงคิว ไม่ใช่ปัญหา
    """
    text, err = fetch_container_logs()
    if err == "no-config":
        return []  # ข้าม log scan เงียบ ๆ (เหมือน routine เดิมเมื่อไม่มี session)
    if err:
        hint = {
            "auth-401": "Portainer API token ใช้ไม่ได้แล้ว (หมดอายุ/ถูกเพิกถอน)",
            "auth-403": "Portainer API token ไม่มีสิทธิ์ดู log ของ container นี้",
            "not-found": "หา container/endpoint ไม่เจอ (PORTAINER_ENDPOINT_ID / PORTAINER_CONTAINER เปลี่ยน?)",
        }.get(err, f"เรียก Portainer ไม่ได้ ({err})")
        return [f"⚠️ ข้าม log scan — {hint}", f"   แก้ค่าใน {ENV_FILE}"]

    bad, seen, samples = scan_logs(text)
    lines = []
    if bad:
        worst = sorted(bad.items(), key=lambda kv: -kv[1])
        lines.append("⚠️ log 24 ชม. มี error: " + ", ".join(f"{k}×{v}" for k, v in worst[:6]))
        for s in samples[:3]:
            lines.append(f"   • {s}")
        joined = "\n".join(samples)
        if "no activity for" in joined:
            lines.append("   = endpoint ค้างจริง (timeout ของ scripts/lib/http.js, env WORKER_HTTP_TIMEOUT_MS)")
        if "fetch failed" in joined:
            lines.append("   = ไม่ควรเจอหลัง v1.172 — เช็ก /api/version ว่า deploy เก่ากว่าฟิกซ์หรือเปล่า")
        if re.search(r"\] 401:", joined):
            lines.append("   = 401 คือ shared secret ไม่ตรงกัน")
        if re.search(r"\] 409:", joined):
            lines.append("   = 409 นานๆ ครั้งปกติ แต่ทุกรอบ = pass เดินนานเกิน interval")

    # ไม่มีร่องรอยใน log = สัญญาณจริงเฉพาะกับ worker ที่ health-summary ก็บอกว่าไม่ tick แล้ว
    # (ถ้ามันยัง tick ปกติ การเงียบใน log แค่หมายความว่ายังไม่ถึงคิวพิมพ์สรุป)
    if seen:  # มี log อ่านได้จริงเท่านั้นถึงจะสรุปอะไรได้
        quiet = sorted(k for k in dead_keys if k not in seen)
        if quiet:
            lines.append(f"⚠️ ไม่ tick + ไม่มีร่องรอยใน log 24 ชม.: {', '.join(quiet)} (supervisor อาจไม่ได้รันสคริปต์)")
    return lines


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(s):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def hours(sec):
    try:
        return f"{float(sec) / 3600:.1f} ชม."
    except Exception:
        return "?"


def main():
    state = load_state()
    lines = []

    status, body = get_retry("/api/health-summary")

    if status == 0:
        if net_down():
            # เครื่องนี้เน็ต/DNS ล่ม → เราไม่รู้อะไรเลยเรื่อง prod ห้ามตะโกนว่า prod ตาย
            save_state(state)
            print("⚠️ เช็ก probook ไม่ได้รอบนี้ — เน็ต/DNS ของเครื่องนี้ล่ม (ไม่ใช่ prod)")
            print(f"   ({body[:100]}) รอบหน้าจะลองใหม่เอง")
            return
        state["neverTicked"] = {}
        state["appDownStreak"] = int(state.get("appDownStreak", 0)) + 1
        save_state(state)
        print("⚠️ probook ตอบไม่ได้เลย — /api/health-summary ไม่มีการตอบกลับ (เน็ตเครื่องนี้ปกติ)")
        print(f"   ({body[:120]}) ครั้งที่ {state['appDownStreak']} ติดกัน")
        print("   ดูต่อ: Portainer stack 125 → container production-booking-app (ผมรีสตาร์ทให้ไม่ได้)")
        return
    state["appDownStreak"] = 0

    try:
        data = json.loads(body)
        workers = data.get("workers", [])
    except Exception:
        workers = []
        lines.append(f"⚠️ /api/health-summary ตอบ HTTP {status} แต่อ่าน JSON ไม่ได้: {body[:120]}")

    if status not in (200, 503) and not lines:
        lines.append(f"⚠️ /api/health-summary ตอบ HTTP {status} (คาด 200 หรือ 503)")

    # stale = คำนวณจากฝั่ง server แล้ว (interval + grace 2 ชม.) — เชื่อ flag ได้เลย
    stale = [w for w in workers if w.get("enabled") and w.get("stale")]
    if stale:
        lines.append(f"⚠️ worker ค้าง {len(stale)} ตัว (health-summary = HTTP {status}):")
        for w in stale:
            lines.append(f"   • {w.get('key')} — ไม่ tick มา {hours(w.get('lastTickAgoSec'))}")

    # neverTicked ครั้งเดียวไม่ใช่เรื่องผิดปกติ (worker รายวัน / เพิ่ง redeploy)
    # แจ้งเฉพาะตัวที่ยัง neverTicked ติดกัน 2 รอบ
    prev_never = set(state.get("neverTicked", {}).keys()) if isinstance(state.get("neverTicked"), dict) else set()
    now_never = {w.get("key") for w in workers if w.get("enabled") and w.get("neverTicked")}
    repeat_never = sorted(now_never & prev_never)
    if repeat_never:
        lines.append(f"⚠️ ไม่เคย tick เลย 2 รอบติด: {', '.join(repeat_never)} (supervisor อาจไม่ได้รันสคริปต์)")
    state["neverTicked"] = {k: True for k in sorted(now_never)}

    # STEP 2 — สแกน log container 24 ชม. (best-effort; ไม่มี token = ข้ามเงียบ)
    #   worker ที่ยิง HTTP ล้มทุกรอบแต่งานข้างล่างยังเสร็จ health-summary จับไม่ได้
    #   (เคสจริง: [sound-merge] run failed: fetch failed 48/48 รอบ ก่อน v1.172)
    enabled_keys = {w.get("key") for w in workers if w.get("enabled")}
    dead_keys = {w.get("key") for w in workers if w.get("enabled")
                 and (w.get("neverTicked") or float(w.get("lastTickAgoSec") or 0) > LOG_HOURS * 3600)}
    try:
        lines.extend(log_scan_report(enabled_keys, dead_keys))
    except Exception as e:
        lines.append(f"⚠️ log scan พังเอง: {str(e)[:100]}")

    vstatus, vbody = get_retry("/api/version", timeout=15)
    if vstatus != 200:
        lines.append(f"⚠️ /api/version ตอบ HTTP {vstatus} (คาด 200)")

    save_state(state)

    if lines:
        print("\n".join(lines[:14]))
        sys.exit(0)
    # เงียบเมื่อปกติ — ไม่ print อะไรเลย = Hermes ไม่ส่งข้อความ


if __name__ == "__main__":
    main()
