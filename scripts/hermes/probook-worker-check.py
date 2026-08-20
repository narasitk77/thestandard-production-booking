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
BAD_RE = re.compile(r"run failed|no activity for|route error|\] [45]\d\d:")


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
        else:
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
    """-> list บรรทัดรายงาน · ไม่มี secret = ข้ามเงียบ (เหมือน log scan)"""
    secret = env_val("PROBOOK_LANDING_SECRET") or env_val("FOOTAGE_READY_SECRET")
    if not secret:
        return []
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
                return ["⚠️ footage-ready stats: 401 — secret ใน probook.env ไม่ตรงกับ prod แล้ว"]
            if e.code == 404:
                return []  # prod ยังไม่ได้ deploy endpoint นี้ — ไม่ใช่ความผิดปกติ
            last = f"HTTP {e.code}"
        except Exception as e:
            last = str(e)[:80]
    if body is None:
        return [f"⚠️ footage-ready stats: เรียกไม่ได้ ({last})"]
    try:
        d = json.loads(body)
    except Exception:
        return [f"⚠️ footage-ready stats: อ่าน JSON ไม่ได้ ({body[:80]})"]
    alerts = [a for a in (d.get("alerts") or []) if isinstance(a, str)]
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


def main():
    # โหมดยืนยันว่าหมุนไดรฟ์ให้งวดใหม่แล้ว: --ack-footage-root 2027-H1
    if "--ack-footage-root" in sys.argv:
        i = sys.argv.index("--ack-footage-root")
        period = sys.argv[i + 1] if len(sys.argv) > i + 1 else period_of(time.time())
        _write_json(FOOTAGE_ROOT_STATE, {"period": period, "ackedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
        print(f"บันทึกแล้ว: DRIVE_FOOTAGE_ROOT = งวด {period}")
        return

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

    report = "\n".join(lines[:14]) if lines else ""

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
        sys.exit(0)
    # เงียบเมื่อปกติ (รอบค่ำ) — ไม่ print อะไรเลย = Hermes ไม่ส่งข้อความ


if __name__ == "__main__":
    main()
