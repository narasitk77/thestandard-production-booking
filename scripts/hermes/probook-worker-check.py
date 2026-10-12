#!/usr/bin/env python3
"""probook worker-health watchdog — ported from the Claude Code routine
`probook-worker-check` (2026-08-18). Read-only. Prints NOTHING when healthy,
so Hermes `--no-agent` delivery stays silent unless something is wrong.

Why it exists: probook runs 12 supervised workers inside the app container.
The in-app dead-man switch emails when a heartbeat goes stale — but it runs
INSIDE the app, so a dead container fires nothing. This is the outside observer.

Steps (1–2 came from the original routine, 3–5 were added as blind spots surfaced):
  1. /api/health-summary + /api/version — catches "worker heartbeat went stale"
  2. Portainer container-log scan (24h) — catches the class health-summary CANNOT see:
     a worker whose HTTP call fails every run while the job underneath still completes
     ([sound-merge] run failed: fetch failed, 48/48 runs, before v1.172).
Step 2 uses a **Portainer access token** (X-API-Key) from ~/.hermes/scripts/probook.env,
not a browser session — Hermes drives its own browser and cannot borrow the user's
logged-in Chrome. No token configured = step 2 is skipped silently.
  3. launchd NAS agent   4. footage-drive period roll
  5. footage-ready OUTCOME — did the mail reach a human on the job? Liveness said
     green for five weeks while 103 notifications went only to the operator.
  6. Claude desktop routine probook-nightly-check stuck (per_task_limit skips in main.log)
Self-check without network/prod/Hermes: python3 probook-worker-check.py --selftest
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

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
# v1.238 — ความหมายของบรรทัด "supervisor: worker exited" **เปลี่ยนไปแล้ว**
#
# ก่อน v1.238 ลูป restart ใน start.sh ไม่เคยรอดการแครช (`set -e` ฆ่า subshell)
# บรรทัดนี้จึงมีแต่ตอน worker ที่ถูกปิด exit สะอาด = เสียงรบกวนล้วน → skip ถูกต้อง
# ตั้งแต่ v1.238 ลูปรอดการแครชจริง บรรทัดเดียวกันจึงแปลว่า "worker แครชแล้ววนใหม่"
# ซึ่งเป็นสัญญาณที่ดีที่สุดที่เรามี ⇒ ต้องไม่ skip (ดู BAD_RE)
#
# แยกด้วยรหัสออก: (code 0) = จบเอง ไม่ใช่ปัญหา · (code ไม่ใช่ 0) = แครช
# คงรูปแบบเก่า (ไม่มีวงเล็บ) ไว้ใน SKIP ด้วย ไม่งั้นหน้าต่าง log 24 ชม. แรก
# หลัง deploy ที่คร่อมสองรูปแบบจะเด้งบรรทัดเก่าเป็น error ทั้งกอง
SKIP_RE = re.compile(
    r"supervisor: worker exited \(code 0\)"     # จบเอง ไม่ใช่แครช
    r"|supervisor: worker exited, restarting"    # รูปเดิม ก่อน v1.238
    r"|supervisor: worker ปิดอยู่"                # v1.238 supervisor หยุดปลุก
    r"|ปิดอยู่ — ไม่สตาร์ต"                        # v1.238 worker บอกว่าถูกปิด
    r"|is off — exiting"                          # รูปเดิม
    r"|WORKER_ENABLED=0"                          # รูปเดิม
)
WORKER_RE = re.compile(r"\[([a-z][a-z-]+)\]")
# "รอบจบแล้วและ worker ได้คำตอบ" = บรรทัดสรุปที่ worker พิมพ์หลังได้ 2xx (`bookings=3 files=…`,
# `scanned=81 …`, `ok file=… size=…`, `[x] skipped: …`) — ใช้ตัดสินว่า error "หายแล้ว" จริงไหม
# 2026-10-07: เดิมนับทุกบรรทัดที่ไม่ใช่ error เป็นรอบที่ดี → `running merge (interval)` กับคำเตือน
# sync-conflict ที่ฝั่ง server พิมพ์หลัง worker เลิกรอไปแล้ว ถูกอ่านเป็น "video-merge หายแล้ว"
# ทั้งที่ล้ม 17/17 รอบ (2 ต.ค. ก็หลอกแบบเดียวกัน) · ไม่รู้จักบรรทัดสรุปของ worker ไหน = รายงานว่า
# ยังเกิดอยู่ (ดังเกินดีกว่าเงียบผิด)
DONE_RE = re.compile(r"[A-Za-z]=\d|\] skipped: ")   # `] skipped:` = บรรทัดของ worker · server "not mailable, skipped:" ไม่ใช่จบรอบ
NOT_DONE_RE = re.compile(r"worker started|running merge|next run in"
                         r"|\] page \d+ offset="        # footage-integrity ระหว่างรอบ
                         r"|\bINCOMPLETE\b|=FAILED\b"    # จบแต่บอกเองว่าไม่ครบ
                         r"|prune off|inaccessible")     # บรรทัดตอนสตาร์ต / ล้มที่แต่งตัวเป็น skip
BAD_RE = re.compile(
    r"run failed|no activity for|route error|\] [45]\d\d:"
    # v1.238 — worker แครชแล้ว supervisor ปลุกใหม่ · รหัสที่ไม่ใช่ 0 เท่านั้น
    r"|supervisor: worker exited \(code (?!0\))"
)


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


# 2026-10-02: probook.xtec9.xyz ตอบ 404 แล้ว (ย้ายโดเมน 30 ก.ย.) · ย้ายอีกรอบ = แก้ PROBOOK_BASE ใน probook.env
# (อยู่ใต้ env_val เพราะต้องอ่าน probook.env — get()/footage-ready ใช้ BASE ตอนเรียก ไม่ใช่ตอน import)
BASE = (env_val("PROBOOK_BASE") or "https://probook.thestandard.co").rstrip("/")


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
    bad, seen, samples, last = {}, {}, [], {}
    for raw in (text or "").split("\n"):
        # ลอก byte framing ของ docker log (\x00-\x1f + U+FFFD ที่เกิดจาก decode ไม่ได้)
        line = re.sub(r"^[\x00-\x1f\ufffd]+", "", re.sub(r"[\x00-\x08\ufffd]", "", raw))
        m = WORKER_RE.search(line)
        if not m or SKIP_RE.search(line):
            continue
        name = m.group(1)
        seen[name] = seen.get(name, 0) + 1
        # framing byte ของ docker บางตัว decode เป็นตัวอักษรที่มองเห็นได้ (W, C, ?)
        # จึงต้อง search ไม่ใช่ match ไม่งั้น timestamp หลุดแล้วรายงานเวลาผิด
        tsm = re.search(r"(\d{4}-\d{2}-\d{2}T[\d:.]+)", line[:60])
        ts = tsm.group(1) if tsm else ""
        slot = last.setdefault(name, {"bad": "", "good": "", "goodAfter": 0})
        if BAD_RE.search(line):
            bad[name] = bad.get(name, 0) + 1
            slot["bad"] = ts or slot["bad"]
            slot["goodAfter"] = 0
            if len(samples) < 5:
                samples.append(line.strip()[:150])
        elif DONE_RE.search(line) and not NOT_DONE_RE.search(line):
            slot["good"] = ts or slot["good"]
            if slot["bad"]:
                slot["goodAfter"] += 1
    return bad, seen, samples, last


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

    bad, seen, samples, last = scan_logs(text)
    lines = []
    if bad:
        worst = sorted(bad.items(), key=lambda kv: -kv[1])
        lines.append("⚠️ log 24 ชม. มี error: " + ", ".join(f"{k}×{v}" for k, v in worst[:6]))
        # เตือนเรื่องที่จบไปแล้วคือการรบกวนคน — บอกให้ชัดว่ายังเกิดอยู่หรือหายแล้ว
        for k, _ in worst[:3]:
            sl = last.get(k, {})
            hhmm = lambda t: (t or "")[11:16] or "?"
            if sl.get("goodAfter"):
                lines.append(f"   ✅ {k}: หายแล้ว — ครั้งสุดท้าย {hhmm(sl.get('bad'))} UTC "
                             f"แล้วเดินปกติต่ออีก {sl['goodAfter']} รอบ (ล่าสุด {hhmm(sl.get('good'))})")
            else:
                lines.append(f"   🔴 {k}: ยังเกิดอยู่ — ล่าสุด {hhmm(sl.get('bad'))} UTC ยังไม่มีรอบที่สำเร็จตามหลัง")
        for s in samples[:3]:
            lines.append(f"   • {s}")
        joined = "\n".join(samples)
        if "no activity for" in joined:
            lines.append("   = worker เลิกรอที่ timeout ของ scripts/lib/http.js (WORKER_HTTP_TIMEOUT_MS) — งานฝั่ง server "
                         "มักเดินต่อจนจบและเขียน heartbeat (health-summary จึงเขียว) แต่ไม่มีใครเห็นผล · ทุกรอบ = pass ยาวเกิน timeout")
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


# ─────────── NAS manifest agent (launchd บนแมคเครื่องนี้ ทุก 600s) ───────────
# มันออกแบบให้ "เงียบ" เมื่อ /Volumes/production team ไม่ได้ mount (โน้ตบุ๊กไม่อยู่ออฟฟิศ)
# ปัญหาคือไม่มีใครรู้ว่ามันเงียบมานานแค่ไหน และ log อยู่ใน /tmp ซึ่งหายทุกครั้งที่รีบูต
# ตัวนี้จึงทำสองอย่าง: ก็อป log ไปเก็บที่ถาวร + แจ้งเมื่อ agent หยุดเด้ง หรือ manifest ค้างนาน
NAS_LOG = "/tmp/probook-nas-agent.log"
NAS_ARCHIVE = os.path.expanduser("~/.hermes/state/probook/nas-agent.log")
NAS_STATE = os.path.expanduser("~/.hermes/state/probook/nas-agent.json")
NAS_AGENT_INTERVAL_MIN = 10
AGENT_SILENT_MIN = 45          # log ไม่ขยับเกินนี้ = agent อาจไม่ได้เด้ง (interval 10 นาที)
NAS_UNMOUNTED_ALERT_HOURS = 48  # ไม่ mount ต่อเนื่องนานกว่านี้ = manifest ฝั่ง server ค้าง


def _read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def nas_agent_report():
    """-> list บรรทัดรายงาน · ว่าง = agent ปกติ (หรือไม่ได้ติดตั้ง)"""
    lines = []
    st = _read_json(NAS_STATE, {})
    now = time.time()

    if not os.path.exists(NAS_LOG):
        # /tmp ถูกล้าง (รีบูต) หรือไม่ได้ติดตั้ง agent — ใช้ archive ตัดสิน
        if not os.path.exists(NAS_ARCHIVE):
            return []
        last_seen = st.get("lastLogSeenAt", 0)
        if last_seen and now - last_seen > AGENT_SILENT_MIN * 60:
            mins = int((now - last_seen) / 60)
            lines.append(f"⚠️ NAS agent: ไม่มี log ใหม่ {mins} นาที และไฟล์ /tmp หายไป (รีบูตแล้ว launchd ไม่ได้เด้ง?)")
            lines.append("   เช็ก: launchctl list | grep probook-nas-agent")
        return lines

    try:
        raw = open(NAS_LOG, errors="replace").read().split("\n")
    except Exception as e:
        return [f"⚠️ NAS agent: อ่าน log ไม่ได้ ({str(e)[:60]})"]
    log_lines = [l.strip() for l in raw if l.strip()]
    mtime = os.stat(NAS_LOG).st_mtime

    # เก็บถาวร: ต่อท้ายเฉพาะบรรทัดที่ยังไม่เคยเก็บ (นับจากจำนวนที่เก็บไปแล้ว)
    kept = int(st.get("archivedCount", 0))
    if len(log_lines) < kept:      # ไฟล์ถูกล้าง/หมุนใหม่ → เริ่มนับใหม่
        kept = 0
    new = log_lines[kept:]
    if new:
        os.makedirs(os.path.dirname(NAS_ARCHIVE), exist_ok=True)
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with open(NAS_ARCHIVE, "a") as f:
            for l in new:
                f.write(f"{stamp} {l}\n")
    st["archivedCount"] = len(log_lines)
    st["lastLogSeenAt"] = mtime

    # agent หยุดเด้งหรือยัง
    if now - mtime > AGENT_SILENT_MIN * 60:
        mins = int((now - mtime) / 60)
        lines.append(f"⚠️ NAS agent ไม่ได้เด้งมา {mins} นาที (ควรทุก {NAS_AGENT_INTERVAL_MIN} นาที)")
        lines.append("   เช็ก: launchctl list | grep probook-nas-agent")

    # ไม่ mount ต่อเนื่องนานแค่ไหน (นับจากครั้งแรกที่เรา *เห็น* ว่ามันเริ่มไม่ mount)
    tail_unmounted = 0
    for l in reversed(log_lines):
        if "not mounted" in l:
            tail_unmounted += 1
        else:
            break
    if tail_unmounted and tail_unmounted == len(log_lines):
        # ถ้าทุกบรรทัดในไฟล์เป็น not mounted แปลว่ามันไม่เคย mount เลยตั้งแต่ไฟล์เริ่ม →
        # ใช้เวลาสร้างไฟล์เป็นจุดเริ่ม (ตรงกว่าเดา 10 นาที/บรรทัด เพราะเครื่องหลับบ้าง)
        try:
            birth = os.stat(NAS_LOG).st_birthtime
        except Exception:
            birth = mtime - tail_unmounted * NAS_AGENT_INTERVAL_MIN * 60
        first_seen = st.get("unmountedSinceAt") or min(birth, mtime - tail_unmounted * NAS_AGENT_INTERVAL_MIN * 60)
        st["unmountedSinceAt"] = first_seen
        hours = (now - first_seen) / 3600
        if hours >= NAS_UNMOUNTED_ALERT_HOURS and not lines:
            lines.append(f"⚠️ NAS ไม่ได้ mount ต่อเนื่อง ~{hours:.0f} ชม. ({tail_unmounted} รอบติด)")
            lines.append("   = manifest ฝั่ง server ค้างอยู่ที่ค่าเดิม · อีเมล 'โฟลเดอร์ sync เสร็จ' จะไม่มาเลย")
            lines.append("   ถ้าไม่ได้ใช้ฟีเจอร์นี้แล้วให้ถอน agent ทิ้ง (launchctl unload) จะได้ไม่มีเสียงรบกวน")
    elif tail_unmounted == 0:
        st.pop("unmountedSinceAt", None)

    _write_json(NAS_STATE, st)
    return lines


# ─────────── footage-ready: มีคนในงานได้รับเมลไหม (ไม่ใช่ "worker เต้นไหม") ───────────
# 14 ก.ค.–20 ส.ค. worker นี้ 🟢 ทุกวัน tick ครบ errors: [] ส่งไป 103 ใบ — และ
# **ไม่มีทีมงานคนไหนได้รับแม้ฉบับเดียว** เพราะ FOOTAGE_READY_AUDIENCE=admin ส่งเข้า
# digest ของ operator ที่เดียว ไม่มีอะไรพัง และไม่มีอะไรเฝ้าสิ่งเดียวที่มีความหมาย
# /api/internal/footage-ready/stats (v1.181) คิด alert ฝั่ง server จากกฎเดียวกับตัวส่ง
FOOTAGE_READY_DAYS = 7


def footage_ready_report():
    """-> list บรรทัดรายงาน · ว่าง = เช็กแล้วไม่มี alert เท่านั้น
    (2026-10-04: เดิมไม่มี secret / 404 = คืนลิสต์ว่าง → "เงียบ" อ่านเป็น "ปกติ" ทั้งที่ไม่ได้เช็ก)"""
    secret = env_val("PROBOOK_LANDING_SECRET") or env_val("FOOTAGE_READY_SECRET")
    if not secret:
        self_fail("footage-ready secret missing")
        return [f"⚠️ footage-ready: ไม่มี PROBOOK_LANDING_SECRET/FOOTAGE_READY_SECRET ใน {ENV_FILE} "
                "— ไม่ได้เช็กว่าเมลถึงทีมไหม"]
    url = f"{BASE}/api/internal/footage-ready/stats?days={FOOTAGE_READY_DAYS}"
    req = urllib.request.Request(url, headers={
        "x-footage-ready-secret": secret, "User-Agent": "hermes-probook-watchdog"})
    body = None
    for delay in (0,) + RETRY_DELAYS:
        if delay:
            time.sleep(delay)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                body = r.read().decode("utf-8", "replace")
                break
        except urllib.error.HTTPError as e:
            if e.code == 401:
                self_fail("footage-ready stats 401")
                return ["⚠️ footage-ready stats: 401 — secret ใน probook.env ไม่ตรงกับ prod แล้ว"]
            if e.code == 404:
                # endpoint มีมาตั้งแต่ v1.181 — 404 ตอนนี้ = BASE ผิด (เคยเกิดตอนย้ายโดเมน) หรือ route หาย
                return [f"⚠️ footage-ready stats: 404 — BASE ({BASE}) ผิดหรือ endpoint หายไปแล้ว "
                        "· ไม่ได้เช็กว่าเมลถึงทีมไหม"]
            last = f"HTTP {e.code}"
        except Exception as e:
            last = str(e)[:80]
    if body is None:
        return [f"⚠️ footage-ready stats: เรียกไม่ได้ ({last})"]
    try:
        d = json.loads(body)
    except Exception:
        return [f"⚠️ footage-ready stats: อ่าน JSON ไม่ได้ ({body[:80]})"]
    if not isinstance(d, dict) or not isinstance(d.get("alerts"), list):
        # 2026-10-04: ไม่มีคีย์ alerts = รูปแบบเปลี่ยน/proxy ตอบหน้าอื่น — ห้ามอ่านเป็น "ปกติ"
        return ["⚠️ footage-ready stats: คำตอบไม่มี alerts[] — รูปแบบเปลี่ยน? ไม่ได้เช็กว่าเมลถึงทีมไหม"]
    alerts = [a for a in d["alerts"] if isinstance(a, str)]
    if not alerts:
        return []
    s = d.get("sends") or {}
    head = (f"   ({FOOTAGE_READY_DAYS} วัน: แจ้ง {s.get('total', 0)} ใบ · ถึงทีม {s.get('toTeam', 0)} ใบ · "
            f"คนที่ได้รับ {s.get('peopleReached', 0)} คน · ถ่ายจบ {d.get('shootsOver', 0)} ใบ)")
    return alerts[:3] + [head]


# ─────────── งวดของไดรฟ์ฟุตเทจ (ระเบิดเวลาปี 2027) ───────────
# DRIVE_FOOTAGE_ROOT ชี้ไดรฟ์ "VIDEO 2026 [JUL–DEC]" ซึ่งหมุนด้วยมือทุกครึ่งปี
# ถ้าไม่มีใครเปลี่ยน env ตอนขึ้นงวดใหม่ ระบบจะสร้างกล่องลงไดรฟ์งวดเก่าต่อไปแบบเงียบ ๆ
FOOTAGE_ROOT_STATE = os.path.expanduser("~/.hermes/state/probook/footage-root.json")
SEED_PERIOD = "2026-H2"
PREWARN_DAYS = (14, 7, 3, 1)


def period_of(ts):
    tm = time.gmtime(ts + 7 * 3600)
    return f"{tm.tm_year}-H{1 if tm.tm_mon <= 6 else 2}"


def days_left_in_period(ts):
    tm = time.gmtime(ts + 7 * 3600)
    end_mon = 6 if tm.tm_mon <= 6 else 12
    end = time.mktime((tm.tm_year, end_mon, [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][end_mon - 1],
                       23, 59, 59, 0, 0, 0))
    start = time.mktime((tm.tm_year, tm.tm_mon, tm.tm_mday, tm.tm_hour, tm.tm_min, 0, 0, 0, 0))
    return int((end - start) / 86400)


def footage_root_report():
    """-> list บรรทัดรายงาน · เตือนเมื่อถึงงวดใหม่แล้วยังไม่หมุนไดรฟ์"""
    st = _read_json(FOOTAGE_ROOT_STATE, {"period": SEED_PERIOD})
    cur, acked = period_of(time.time()), st.get("period", SEED_PERIOD)
    if cur != acked:
        _write_json(FOOTAGE_ROOT_STATE, st)
        return [
            f"⚠️ ขึ้นงวด {cur} แล้ว แต่ DRIVE_FOOTAGE_ROOT ยังเป็นของงวด {acked}",
            "   ถ้าไม่หมุน env บน stack 125 ระบบจะสร้างกล่องลงไดรฟ์งวดเก่าต่อไปโดยไม่มี error",
            f"   หมุนแล้วสั่ง: python3 ~/.hermes/scripts/probook-worker-check.py --ack-footage-root {cur}",
        ]
    # เตือนล่วงหน้าแบบ "ช่วงละครั้ง" ไม่ใช่เทียบวันตรง ๆ (กัน off-by-one และกันเตือนซ้ำทุกวัน)
    left = days_left_in_period(time.time())
    bucket = min((t for t in PREWARN_DAYS if left <= t), default=None)
    if bucket is None:
        if st.pop("prewarnBucket", None) is not None:
            _write_json(FOOTAGE_ROOT_STATE, st)
        return []
    if st.get("prewarnBucket") == bucket:
        return []                       # ช่วงนี้เตือนไปแล้ว
    st["prewarnBucket"] = bucket
    _write_json(FOOTAGE_ROOT_STATE, st)
    return [f"ℹ️ อีก ~{left} วันจะขึ้นงวด {period_of(time.time() + (left + 1) * 86400)} — "
            f"เตรียมสร้างไดรฟ์ VIDEO งวดถัดไป แล้วหมุน DRIVE_FOOTAGE_ROOT บน stack 125"]


# ─────────── routine probook-nightly-check (Claude desktop) ค้างไหม ───────────
# รอบที่รอคนกด Allow ค้างอยู่ทำให้ scheduler ข้ามรอบใหม่ทุกครั้ง (per_task_limit active=1)
# โดยไม่มีอะไรเตือนเลย — 4 ต.ค. 2026 ถูกข้าม 28 ครั้งในวันเดียว
# รูปแบบ log จริง (เวลาท้องถิ่น ไม่มี timezone):
#   2026-10-04 20:35:04 [info] [CCDScheduledTasks] Skipping dispatch for probook-nightly-check: per_task_limit (active=1, limit=1)
# main.log หมุนไป main1.log ที่ ~10MB จึงต้องอ่านทั้งสองไฟล์ให้ครอบ 24 ชม.
#
# หลักฐานเชิงบวก (แก้ 2026-10-04): เดิมนับแค่บรรทัด skip ตรงตัว "per_task_limit" ไม่เจอ = ปกติ
# ซึ่งเงียบในอย่างน้อย 4 ทาง — แอปไม่ได้เปิด/task ถูกปิด (ไม่มี log ใหม่เลย), ถูกข้ามด้วยเหตุผลอื่น
# (global_limit), Claude เปลี่ยนถ้อยคำ, และรอบที่ค้างโดยไม่มีบรรทัด skip เลย (3 ต.ค. 01:05 ค้าง
# 43 ชม. แต่รอบ Hermes 09:00/21:00 นับได้ 0 ทั้งคู่). ตอนนี้จึงต้อง "เห็นการเริ่มรอบ" ภายใน 26 ชม.
# (log จริงเริ่มรอบทุกคืน ~00:04 ตั้งแต่ 23 ส.ค.) และนับ skip เหตุผลใดก็ได้เฉพาะที่ใหม่กว่า
# การเริ่มรอบล่าสุด — skip ก่อนหน้านั้นคือรอบที่หลุดออกมาเริ่มใหม่แล้ว ไม่ใช่ค้างอยู่
CLAUDE_LOGS = [os.path.expanduser("~/Library/Logs/Claude/main.log"),
               os.path.expanduser("~/Library/Logs/Claude/main1.log")]
NIGHTLY_SKIP = "Skipping dispatch for probook-nightly-check:"
_NIGHTLY_SKIP_RE = re.compile(r"Skipping dispatch for probook-nightly-check: (\S+)")
_NIGHTLY_START_RE = re.compile(r"(?:Spawning new session for scheduled task|runNow: dispatching session for task)"
                               r" probook-nightly-check(?=\s|$)")
NIGHTLY_MAX_GAP_H = 26
_LOG_TS_RE = re.compile(r"^\W*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[.,]\d+)?\s*(Z|[+-]\d{2}:?\d{2})?")


def _log_epoch(line):
    """เวลาหัวบรรทัด -> epoch · ไม่มี tz = เวลาท้องถิ่น · มี Z/+07:00 ก็รับ · อ่านไม่ออก = None"""
    from datetime import datetime
    m = _LOG_TS_RE.match(line)
    if not m:
        return None
    d, t, tz = m.groups()
    try:
        if tz:
            return datetime.strptime(f"{d} {t}{tz}", "%Y-%m-%d %H:%M:%S%z").timestamp()
        return datetime.strptime(f"{d} {t}", "%Y-%m-%d %H:%M:%S").timestamp()
    except ValueError:
        return None


def scan_nightly_log(paths, now):
    """-> (last_start epoch|None, skips [(epoch, เหตุผล)] ใน 24 ชม. ที่ใหม่กว่า last_start,
           จำนวนบรรทัด nightly ที่อ่านเวลาไม่ออก, errors) · paths[0] ต้องมี ที่เหลือมีหรือไม่ก็ได้"""
    cutoff = now - 24 * 3600
    last_start, skips, undated, errs = None, [], 0, []
    for i, p in enumerate(paths):
        if i and not os.path.exists(p):
            continue
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                for line in f:
                    m = _NIGHTLY_SKIP_RE.search(line)
                    start = not m and _NIGHTLY_START_RE.search(line)
                    if not (m or start):
                        continue
                    ts = _log_epoch(line)
                    if ts is None:
                        undated += 1
                    elif start:
                        last_start = ts if last_start is None else max(last_start, ts)
                    elif ts >= cutoff:
                        skips.append((ts, m.group(1)))
        except Exception as e:
            errs.append(f"{os.path.basename(p)}: {type(e).__name__}")
    skips = sorted(s for s in skips if last_start is None or s[0] > last_start)
    return last_start, skips, undated, errs


def nightly_stuck_report(paths=None, now=None):
    """-> list บรรทัดรายงาน · ว่าง = อ่าน log ได้, เริ่มรอบใน 26 ชม. และไม่มีรอบถูกข้ามหลังจากนั้น"""
    now = now or time.time()
    last_start, skips, undated, errs = scan_nightly_log(paths or CLAUDE_LOGS, now)
    fmt = lambda ts: time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))
    lines = []
    if errs:
        lines.append(f"⚠️ อ่าน log ของ Claude desktop ไม่ได้ — ไม่ได้เช็ก nightly ({', '.join(errs)[:100]})")
    elif last_start is None:
        lines.append("⚠️ probook-nightly-check ไม่ได้เริ่มรอบเลยใน log ของ Claude desktop "
                     "(แอปไม่ได้เปิด / task ถูกปิด / ถ้อยคำ log เปลี่ยน?)")
    elif now - last_start > NIGHTLY_MAX_GAP_H * 3600:
        lines.append(f"⚠️ probook-nightly-check ไม่ได้เริ่มรอบมา {int((now - last_start) // 3600)} ชม. "
                     f"(ล่าสุด {fmt(last_start)}) — แอป Claude desktop ไม่ได้เปิด หรือรอบนั้นค้างอยู่?")
    if skips:
        reasons = ", ".join(sorted({r for _, r in skips}))
        lines.append(f"⚠️ probook-nightly-check ค้าง (รอคนกด Allow หรือรอบก่อนยังไม่จบ) — "
                     f"รอบใหม่ถูกข้าม {len(skips)} ครั้งตั้งแต่ {fmt(skips[0][0])} "
                     f"(ล่าสุด {fmt(skips[-1][0])} · {reasons})")
    if undated:
        lines.append(f"⚠️ log Claude desktop มีบรรทัด nightly (เริ่มรอบ/skip) ที่อ่านเวลาไม่ออก {undated} บรรทัด "
                     "— รูปแบบ log เปลี่ยน? นับ nightly ค้างไม่ได้")
    return lines


# ── OUTBOX: ส่งซ้ำรายงานที่ Hermes ส่งไม่ออก ────────────────────────────────
# บล็อกนี้ถูกคัดลอกไว้เหมือนกันทั้ง 3 สคริปต์ *โดยเจตนา* — deploy คือการก๊อปไฟล์
# ด้วยมือไป ~/.hermes/scripts/ ดังนั้น module ร่วมที่ลืมก๊อป = ImportError = job
# ตายทั้งตัว ซึ่งแย่กว่าโค้ดซ้ำ 40 บรรทัด. แก้ที่ไหนให้แก้ให้ครบสามที่.
#
# ปัญหาที่มันแก้ (เหตุจริง 2026-08-19 21:26): RETRY_DELAYS ในสคริปต์กันได้แค่
# **ขาไปหา probook** แต่การส่ง Discord เป็นขั้นของ **Hermes ที่เกิดหลังสคริปต์จบ**
# และ Hermes ไม่ retry — DNS ล่มตอนนั้นรายงานจึงหายไปเลย ไม่มีใครรู้
#
# วิธี: เก็บรายงานของรอบนี้ลง outbox แล้ว *รอบถัดไป* อ่าน last_delivery_error ของ
# job ตัวเองจาก ~/.hermes/cron/jobs.json — ค้างอยู่ = รอบก่อนไม่ถึงคนอ่าน จึงพิมพ์
# ซ้ำนำหน้า · ไม่ค้าง = ถึงแล้ว ล้าง outbox. ทนเน็ตล่มนานเท่าไรก็ได้ ต่างจาก retry
# ที่ยอมรอได้แค่ ~200 วินาที
HERMES_JOBS = os.path.expanduser("~/.hermes/cron/jobs.json")


def _ob_read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _ob_write(path, data):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass


def _delivery_error(job_name):
    """last_delivery_error ของ job นี้ (None = รอบก่อนส่งถึงแล้ว หรืออ่านไฟล์ไม่ได้)"""
    raw = _ob_read(HERMES_JOBS)
    if raw is None:
        return None
    jobs = raw if isinstance(raw, list) else raw.get("jobs", raw)
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    if not isinstance(jobs, list):
        return None
    for j in jobs:
        if isinstance(j, dict) and j.get("name") == job_name:
            return j.get("last_delivery_error")
    return None


def undelivered_lines(job_name, outbox):
    """บรรทัดที่ต้องพิมพ์ซ้ำเพราะรอบก่อนส่งไม่ออก (ลิสต์ว่าง = ไม่มีอะไรค้าง)"""
    if not _delivery_error(job_name):
        if os.path.exists(outbox):
            try:
                os.remove(outbox)   # ถึงมือแล้ว
            except Exception:
                pass
        return []
    saved = _ob_read(outbox)
    if not isinstance(saved, dict) or not saved.get("text"):
        return []
    return [
        f"📮 ส่งซ้ำ — รายงานรอบ {saved.get('runAt', 'ก่อนหน้า')} ส่งไม่ออก",
        *str(saved["text"]).splitlines(),
        "— จบรายงานที่ส่งซ้ำ —",
        "",
    ]


def remember_report(outbox, text):
    """เก็บรายงานรอบนี้เผื่อส่งไม่ออก · heartbeat ไม่ต้องเก็บ (ดู hb ที่ผู้เรียก):
    heartbeat ที่หายไปแก้ตัวเองรอบหน้า แต่ *คำเตือน* ที่หายคือความเสียหายจริง"""
    if text:
        _ob_write(outbox, {"runAt": time.strftime("%Y-%m-%d %H:%M"), "text": text})


# ── SELF-FAILURE vs FINDING ───────────────────────────────────────────────────
# 2026-09-10: ทั้งสามสคริปต์เคย `exit 0` ทุกกรณี แม้ตอนที่ตัวเองทำงานไม่สำเร็จ.
# ผลคือ Hermes บันทึก last_status "ok" / failure_streak 0 ตลอด และกลไกเตือนซ้ำ
# ของมันเอง (_failure_streak_nudge, threshold 3) ไม่เคยทำงาน — รอบเที่ยงของ
# landing จึงตอบ 401 ติดกัน 13 วันโดยไม่มีใครลงมือ
#
# แยกให้ชัด: `self_fail()` = *เราเอง* ทำงานไม่สำเร็จ (401 / เน็ตล่ม / พังกลางคัน)
# → exit 1 เพื่อให้ Hermes นับ streak. ส่วน "เจอปัญหาที่ prod" (worker ค้าง,
# fallback พุ่ง) คือสคริปต์ทำงาน *สำเร็จ* → exit 0 ไม่งั้น streak จะเตือนผิดตัว
#
# ปลอดภัยกับรายงาน: scheduler.py:3660 เมื่อ returncode != 0 ยัง append
# "stdout:\n<payload>" ไปกับข้อความ ดังนั้นคนอ่านยังได้เนื้อรายงานครบเหมือนเดิม
_SELF_FAIL = []


def self_fail(reason=""):
    """ทำเครื่องหมายว่ารอบนี้ 'เราทำงานไม่สำเร็จ' — epilogue จะ exit 1"""
    _SELF_FAIL.append(reason or "self-failure")

OUTBOX = os.path.expanduser("~/.hermes/state/probook/outbox-worker-check.json")
JOB_NAME = "probook-worker-check"


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


def finish(lines, heartbeat=False):
    """epilogue เดียวของทุกทางออก (ยกเว้น --ack-footage-root)
    2026-10-04: เดิมทางเน็ตล่ม/prod ล่ม print แล้ว exit ก่อนถึง epilogue → ข้อความพวกนั้นไม่เข้า outbox
    และไม่ได้ล้าง outbox เก่า รอบถัดไปจึงส่งซ้ำรายงานเก่าที่ "ถึงแล้ว" พร้อมป้าย "ส่งไม่ออก"
    ส่วนข้อความเน็ตล่มที่หายจริงไม่เคยถูกส่งซ้ำ"""
    # ตัดที่ 14 บรรทัดเพื่อให้อ่านบนมือถือได้ — แต่ต้องบอกว่าตัด ไม่งั้นคำเตือนท้าย ๆ (nightly ค้าง, footage-ready) หายเงียบ
    shown = lines if len(lines) <= 14 else lines[:13] + [f"… (+{len(lines) - 13} บรรทัดถูกตัด)"]
    report = "\n".join(shown) if lines else ""

    # ลำดับสำคัญ: อ่าน+ล้าง outbox ของ "รอบก่อน" ให้เสร็จก่อน แล้วจึงเขียนของรอบนี้ทับ
    # (สลับลำดับ = undelivered_lines ลบรายงานรอบนี้ที่เพิ่งเขียนไปทิ้ง)
    resend = undelivered_lines(JOB_NAME, OUTBOX)
    payload = "\n".join(resend + ([report] if report else []))

    # เก็บ payload ทั้งก้อน ไม่ใช่แค่ report ของรอบนี้ — ถ้าเน็ตล่มติดกันหลายรอบ
    # ของเก่าจะได้ถูกหอบต่อไปเรื่อย ๆ แทนที่จะหล่นหายตั้งแต่รอบที่สอง (cap 60 บรรทัด)
    # heartbeat ไม่เข้า outbox: หายไปก็แก้ตัวเองรอบหน้า ส่วนคำเตือนที่หายคือของจริง
    remember_report(OUTBOX, "" if heartbeat else "\n".join(payload.splitlines()[:60]))

    if payload:
        print(payload)
    # exit 1 เฉพาะตอนที่ "เราเอง" เช็กไม่สำเร็จ (401 / เน็ตล่ม) — ไม่ใช่ตอนที่
    # เจอ worker ค้างที่ prod ซึ่งแปลว่าสคริปต์นี้ทำงานสำเร็จตามหน้าที่
    # เงียบเมื่อปกติ (รอบค่ำ) — ไม่ print อะไรเลย = Hermes ไม่ส่งข้อความ
    # (ทุกที่ที่เรียก self_fail ใส่บรรทัดรายงานด้วยเสมอ จึงไม่มีกรณี exit 1 แบบเงียบ)
    sys.exit(1 if _SELF_FAIL else 0)


def main():
    # โหมดยืนยันว่าหมุนไดรฟ์ให้งวดใหม่แล้ว: --ack-footage-root 2027-H1
    if "--ack-footage-root" in sys.argv:
        i = sys.argv.index("--ack-footage-root")
        period = sys.argv[i + 1] if len(sys.argv) > i + 1 else period_of(time.time())
        _write_json(FOOTAGE_ROOT_STATE, {"period": period, "ackedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
        print(f"บันทึกแล้ว: DRIVE_FOOTAGE_ROOT = งวด {period}")
        return

    started = time.time()
    state = load_state()
    lines = []

    status, body = get_retry("/api/health-summary")

    if status == 0:
        if net_down():
            # เครื่องนี้เน็ต/DNS ล่ม → เราไม่รู้อะไรเลยเรื่อง prod ห้ามตะโกนว่า prod ตาย
            self_fail("net down")
            save_state(state)
            hm = lambda ts: time.strftime("%H:%M", time.localtime(ts))
            finish([
                "⚠️ เช็ก probook ไม่ได้รอบนี้ — เน็ต/DNS ของเครื่องนี้ล่ม (ไม่ใช่ prod)",
                f"   ({body[:100]}) รอบหน้าจะลองใหม่เอง",
                f"   (เริ่ม {hm(started)} · เช็กเสร็จ {hm(time.time())} — ห่างกันนาน = แมคหลับระหว่างรัน)",
            ])
        self_fail("prod not responding")
        state["neverTicked"] = {}
        state["appDownStreak"] = int(state.get("appDownStreak", 0)) + 1
        save_state(state)
        finish([
            "⚠️ probook ตอบไม่ได้เลย — /api/health-summary ไม่มีการตอบกลับ (เน็ตเครื่องนี้ปกติ)",
            f"   ({body[:120]}) ครั้งที่ {state['appDownStreak']} ติดกัน",
            "   ดูต่อ: Portainer stack 125 → container production-booking-app (ผมรีสตาร์ทให้ไม่ได้)",
        ])
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

    # STEP 3 — เฝ้า launchd NAS agent (กลุ่มงานตั้งเวลาที่ไม่เคยมีใครตรวจ)
    try:
        lines.extend(nas_agent_report())
    except Exception as e:
        lines.append(f"⚠️ เช็ก NAS agent พังเอง: {str(e)[:80]}")

    # STEP 4 — งวดของไดรฟ์ฟุตเทจ (กันระเบิดเงียบตอนขึ้นปี/ครึ่งปีใหม่)
    try:
        lines.extend(footage_root_report())
    except Exception as e:
        lines.append(f"⚠️ เช็กงวดไดรฟ์พังเอง: {str(e)[:80]}")

    # STEP 5 — footage-ready: วัดผลลัพธ์ (มีคนได้รับเมลไหม) ไม่ใช่แค่ liveness
    try:
        lines.extend(footage_ready_report())
    except Exception as e:
        lines.append(f"⚠️ เช็ก footage-ready พังเอง: {str(e)[:80]}")

    # STEP 6 — routine probook-nightly-check ของ Claude desktop ค้างรอ Allow ไหม (อ่าน log ในเครื่อง)
    try:
        lines.extend(nightly_stuck_report())
    except Exception as e:
        lines.append(f"⚠️ เช็ก nightly ค้างพังเอง: {str(e)[:80]}")

    vstatus, vbody = get_retry("/api/version", timeout=15)
    if vstatus != 200:
        lines.append(f"⚠️ /api/version ตอบ HTTP {vstatus} (คาด 200)")

    save_state(state)

    # HEARTBEAT — รอบเช้าพูดเสมอ แม้ทุกอย่างปกติ
    # เหตุผล: สคริปต์นี้ออกแบบให้ "เงียบเมื่อปกติ" ซึ่งแลกมาด้วยการที่คนอ่าน
    # **แยกไม่ออกระหว่างเงียบเพราะปกติ กับเงียบเพราะตาย** — 20 ส.ค. แผง cron ขึ้น
    # "No runs yet" ทั้งที่รันครบทุกรอบ และเจ้าของระบบสรุปว่ามันไม่เคยทำงาน
    # รอบเช้า (0 9) จึงยืนยันว่ายังมีชีวิต · รอบค่ำ (0 21) ยังเงียบตามเดิม
    # เพื่อไม่กวนวันละสองครั้งโดยไม่มีเนื้อหา
    heartbeat = not lines and time.localtime().tm_hour < 12
    if heartbeat:
        ver = ""
        try:
            ver = json.loads(vbody).get("version", "")
        except Exception:
            pass
        on = [w for w in workers if w.get("enabled")]
        lines.append(
            f"✅ ตรวจแล้วปกติ — worker เปิดอยู่ {len(on)}/{len(workers)} ตัว tick ครบ"
            + (f" · prod {ver}" if ver else "")
        )

    finish(lines, heartbeat)


def selftest():
    """--selftest: ไม่แตะเน็ต/prod/Discord/Hermes · ทุก path state/outbox/log ชี้ไป temp dir"""
    import contextlib
    import io
    import tempfile
    g = globals()
    tmp = tempfile.mkdtemp(prefix="pwc-selftest-")
    P = lambda *a: os.path.join(tmp, *a)
    for k in [k for k in os.environ if k.startswith(("PORTAINER_", "PROBOOK_", "FOOTAGE_READY"))]:
        del os.environ[k]
    g.update(STATE=P("state.json"), OUTBOX=P("outbox.json"), HERMES_JOBS=P("jobs.json"),
             ENV_FILE=P("probook.env"), NAS_LOG=P("nas.log"), NAS_ARCHIVE=P("nas-archive.log"),
             NAS_STATE=P("nas.json"), FOOTAGE_ROOT_STATE=P("footage-root.json"),
             CLAUDE_LOGS=[P("main.log"), P("main1.log")], BASE="https://selftest.invalid",
             RETRY_DELAYS=())
    with open(ENV_FILE, "w") as f:
        f.write("PROBOOK_LANDING_SECRET=selftest\n")   # ไม่มี PORTAINER_* = log scan ข้ามตามดีไซน์
    with open(P("main.log"), "w") as f:                 # log Claude สะอาด: เพิ่งเริ่มรอบ ไม่มี skip
        f.write(time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - 3600))
                + " [info] [CCDScheduledTasks] Spawning new session for scheduled task probook-nightly-check { x }\n")

    sim = {"down": False, "footage404": False}

    class Resp:
        def __init__(self, status, body):
            self.status, self._b = status, body.encode()
        def read(self):
            return self._b
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        assert url.startswith("https://selftest.invalid/"), f"selftest เกือบยิงเน็ตจริง: {url}"
        if sim["down"]:
            raise urllib.error.URLError("simulated DNS failure")
        if "/api/health-summary" in url:
            return Resp(200, json.dumps({"workers": [{"key": "w", "enabled": True, "lastTickAgoSec": 60}]}))
        if "/api/version" in url:
            return Resp(200, json.dumps({"version": "v-selftest"}))
        if "/footage-ready/stats" in url:
            if sim["footage404"]:
                raise urllib.error.HTTPError(url, 404, "nf", {}, io.BytesIO(b""))
            return Resp(200, json.dumps({"alerts": []}))
        raise AssertionError(f"unexpected URL {url}")

    urllib.request.urlopen = fake_urlopen
    g["net_down"] = lambda: sim["down"]

    def jobs(err):
        _write_json(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": err}]})

    def run():
        _SELF_FAIL.clear()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            try:
                main()
                code = 0
            except SystemExit as e:
                code = e.code or 0
        return code, out.getvalue()

    # (a) เน็ตล่ม → exit != 0 และข้อความเข้า outbox · รอบถัดไปที่ส่งไม่ออกต้องส่งซ้ำ "ข้อความเน็ตล่ม"
    jobs(None)
    sim["down"] = True
    code, out = run()
    assert code != 0, code
    assert "เน็ต/DNS ของเครื่องนี้ล่ม" in out and "เริ่ม " in out and "เช็กเสร็จ" in out, out
    ob = _ob_read(OUTBOX)
    assert ob and "เน็ต/DNS ของเครื่องนี้ล่ม" in ob["text"], ob
    sim["down"] = False
    jobs("simulated delivery failure")
    code, out = run()
    assert "📮 ส่งซ้ำ" in out and "เน็ต/DNS ของเครื่องนี้ล่ม" in out, out
    print("ok (a) net-down -> outbox + exit!=0; resent next run")

    # (a2) prod ไม่ตอบ (เน็ตปกติ) ก็ต้องเข้า outbox
    jobs(None)
    sim["down"] = True
    g["net_down"] = lambda: False
    code, out = run()
    assert code == 1 and "probook ตอบไม่ได้เลย" in out, (code, out)
    assert "probook ตอบไม่ได้เลย" in _ob_read(OUTBOX)["text"]
    sim["down"] = False
    g["net_down"] = lambda: sim["down"]
    print("ok (a2) prod-down -> outbox + exit 1")

    # (b) outbox ค้างจากรอบก่อน → ส่งซ้ำครั้งเดียว · รอบถัดไปที่ส่งถึงแล้ว → ล้าง
    jobs("simulated delivery failure")
    _ob_write(OUTBOX, {"runAt": "2026-01-01 09:00", "text": "OLD-WARNING-XYZ"})
    code, out = run()
    assert code == 0, (code, out)
    assert out.count("OLD-WARNING-XYZ") == 1 and out.count("📮 ส่งซ้ำ") == 1, out
    jobs(None)
    code, out = run()
    assert code == 0 and "OLD-WARNING-XYZ" not in out and "📮" not in out, (code, out)
    assert not os.path.exists(OUTBOX), _ob_read(OUTBOX)
    print("ok (b) resent once, cleared after delivered")

    # (c) main.log สังเคราะห์: เริ่มรอบ 5 ชม.ก่อน (ใน main1) แล้ว skip 3 ครั้งหลังจากนั้น (มี global_limit)
    #     + skip ก่อนเริ่มรอบ 1 + skip เก่า 30 ชม. 1 → นับ 3 · เริ่มรอบใหม่แล้ว → เงียบ
    now = time.time()
    fmt = lambda ts: time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))
    TAG = "[info] [CCDScheduledTasks]"
    def logf(name, rows):
        with open(P(name), "w") as f:
            for ago, msg in rows:
                f.write(f"{fmt(now - ago)} {TAG} {msg}\n")
            f.write("  apiHost: 'continuation line without timestamp',\n")
    SKIP_T = NIGHTLY_SKIP + " per_task_limit (active=1, limit=1)"
    SKIP_G = NIGHTLY_SKIP + " global_limit (active=3, limit=3)"
    START = "Spawning new session for scheduled task probook-nightly-check { cronExpression: '0 0 * * *' }"
    logf("c-main1.log", [(30 * 3600, SKIP_T), (7 * 3600, SKIP_T), (5 * 3600, START)])
    logf("c-main.log", [(3 * 3600, SKIP_T), (2 * 3600, SKIP_G), (3600, SKIP_T),
                        (60, "Skipping dispatch for probook-nightly-check-other: per_task_limit (active=1, limit=1)")])
    last, skips, undated, errs = scan_nightly_log([P("c-main.log"), P("c-main1.log")], now)
    assert len(skips) == 3 and undated == 0 and not errs and abs(last - (now - 5 * 3600)) < 2, (last, skips, undated, errs)
    rep = nightly_stuck_report([P("c-main.log"), P("c-main1.log")], now)
    assert len(rep) == 1 and "ถูกข้าม 3 ครั้ง" in rep[0] and "global_limit" in rep[0], rep
    assert _log_epoch("2026-10-04T13:00:00Z x") == _log_epoch("2026-10-04 20:00:00+07:00 x")
    print("ok (c) skips after last start == 3 (any reason)")

    # (c2) false positive เดิม: skip 22 ครั้งแต่หลุดออกมาเริ่มรอบใหม่แล้ว (runNow) → เงียบ
    logf("c2-main.log", [(h * 1800, SKIP_T) for h in range(2, 24)]
         + [(1800, "runNow: dispatching session for task probook-nightly-check")])
    rep = nightly_stuck_report([P("c2-main.log")], now)
    assert rep == [], rep
    print("ok (c2) skips before a newer start are not 'stuck'")

    # (c3) log ไม่มีบรรทัดเริ่มรอบเลย (แอปไม่ได้เปิด/task ถูกปิด/ถ้อยคำเปลี่ยน) → ต้องเตือน
    logf("c3-main.log", [(3600, "Some unrelated line")])
    rep = nightly_stuck_report([P("c3-main.log")], now)
    assert len(rep) == 1 and "ไม่ได้เริ่มรอบเลย" in rep[0], rep
    print("ok (c3) no start line at all -> warning")

    # (c4) เริ่มรอบล่าสุด 30 ชม. ก่อน ไม่มี skip (ค้างเงียบแบบ 3 ต.ค.) → เตือน 30 ชม.
    logf("c4-main.log", [(30 * 3600, START), (29 * 3600, 'Not auto-approving "Bash" in scheduled task "probook-nightly-check"')])
    rep = nightly_stuck_report([P("c4-main.log")], now)
    assert len(rep) == 1 and "ไม่ได้เริ่มรอบมา 30 ชม." in rep[0], rep
    print("ok (c4) last start 30h ago -> warning")

    # (d) log อ่านไม่ได้ → มีบรรทัดเตือน ไม่เงียบ
    rep = nightly_stuck_report([P("nope", "main.log")], now)
    assert any("อ่าน log ของ Claude desktop ไม่ได้" in l for l in rep), rep
    rep = nightly_stuck_report([tmp], now)                 # directory = อ่านไม่ได้
    assert any("อ่าน log ของ Claude desktop ไม่ได้" in l for l in rep), rep
    print("ok (d) unreadable log -> warning")

    # (e) รูเงียบของ footage-ready: ไม่มี secret / 404
    _SELF_FAIL.clear()
    with open(ENV_FILE, "w") as f:
        f.write("")
    rep = footage_ready_report()
    assert rep and "ไม่ได้เช็ก" in rep[0] and _SELF_FAIL, (rep, _SELF_FAIL)
    _SELF_FAIL.clear()
    with open(ENV_FILE, "w") as f:
        f.write("PROBOOK_LANDING_SECRET=selftest\n")
    sim["footage404"] = True
    rep = footage_ready_report()
    assert rep and "404" in rep[0] and "ไม่ได้เช็ก" in rep[0], rep
    print("ok (e) footage-ready missing secret / 404 are loud")

    # (f) 2026-10-07 log จริง: worker เลิกรอ แล้ว server พิมพ์คำเตือนตามมา — ห้ามอ่านเป็น "หายแล้ว"
    vm = lambda t, m: f"\x01\x00\x00\x00\x00\x00\x00k2026-10-07T{t}.0Z [video-merge] {m}"
    seq = [vm("01:04:34", "running merge (interval)"),
           vm("01:34:35", "run failed: no activity for 1800s — giving up"),
           vm("01:38:24", "AGN-260930-01: 372 sync-conflict name(s) left in landing — not merged:"),
           "  A025 (2) (1) (1)",
           vm("02:04:35", "running merge (interval)")]
    bad, seen, _, last = scan_logs("\n".join(seq))
    assert bad == {"video-merge": 1} and seen["video-merge"] == 4, (bad, seen)
    assert last["video-merge"]["goodAfter"] == 0, last
    bad, seen, _, last = scan_logs("\n".join(seq + [vm("02:20:01", "bookings=318 files=0 folders=0 dupLeft=9 errors=0")]))
    assert last["video-merge"]["goodAfter"] == 1 and last["video-merge"]["good"].startswith("2026-10-07T02:20"), last
    is_done = lambda l: bool(DONE_RE.search(l)) and not NOT_DONE_RE.search(l)
    # บรรทัดสรุปจริงของ worker ที่เห็นใน log prod → ต้องนับเป็นจบรอบ
    for l in ("[backup] ok file=backup-x.sql.gz size=1234B pruned=0",
              "[shoot-marker] scanned 19p/41b · changed=0 warnings=0 errors=0",
              "[room-booking] scanned=81 ปลดแล้ว=0", "[video-merge] skipped: DRIVE_FOOTAGE_ROOT unset",
              "[footage-integrity] done boxes=12 ok=10 issues=1 waiting=1 unreadable=0 nobox=0 docs=on",
              "[mix-calendar] create=0 update=0 delete=0 failed=0"):
        assert is_done(l), l
    # บรรทัดเริ่ม/ระหว่างรอบ/ฝั่ง server/ล้มที่แต่งตัวเป็น skip → ต้องไม่นับ
    for l in ("[sound-merge] worker started; interval=3600000ms; baseUrl=http://127.0.0.1:3000",
              "[landing] next run in 412 min (~19:00 BKK)", "[video-merge] running merge (interval)",
              "[shoot-review] not mailable, skipped: video@x ×2",
              "[footage-integrity] page 2 offset=40 boxes=20 next=60 total=90",
              "[footage-integrity] done boxes=12 ok=10 issues=1 waiting=1 unreadable=0 nobox=0 docs=on INCOMPLETE",
              "[landing-prune] LANDING_PRUNE_ENABLED=0 — noon prune off.",
              "[lark-export] archive=FAILED file=x.json rows=3",
              "[video-merge] skipped: Production Team landing empty / inaccessible"):
        assert not is_done(l), l
    print("ok (f) only a worker's own run-summary line counts as a recovery")
    print("SELFTEST PASSED")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
