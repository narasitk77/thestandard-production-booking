#!/usr/bin/env python3
"""probook → operator's Discord room relay (Hermes `--no-agent` job, every 5 min) — v1.262

Posts what the operator wants to HEAR, from /api/internal/notify-feed:
  📣 ฟุตเทจพร้อม  — every footage-ready notice probook sent to a team (auto or 📣 by hand)
  ✅ NAS ส่งครบ    — a NAS queue drained (the Mac agent's manifest)
  ⚠️ NAS เงียบ     — the NAS picture is older than 2 h (once per 12 h while it stays silent)
  ✅ กล้องครบแล้ว  — v1.268: the cameras missing when the notice went out have arrived (second notice)
  ⚠️ ops          — every alertOps() the app raised (sync storm, stale worker, …) — v1.263, nobody else
                    hears these: the app's own ops Discord room (DISCORD_OPS_WEBHOOK_URL) is not set
Prints NOTHING when there is nothing new (Hermes then sends nothing).

Why (นัท 9 ต.ค. 2569 "ไม่มีแจ้งเตือนเมื่อฟุตเทจพร้อมมานานแล้ว"): the team got 31 notices in 14 days by
email + the "Ohm" Discord room, but the operator's own email copy had been cut since v1.248 (on the false
belief that Gmail drops self-sends; restored v1.262.2) — and the NAS "ส่งครบ" notice had been dead for 87 days. A record the server wrote is not a
message anyone read; this relay reads the records and delivers them where Nat actually looks.

At-least-once, never silent-skip: the cursor advances only past events this run printed. A failed fetch
prints one error line (at most every 6 h) and keeps the cursor, so the next run catches up.
Install:  cp scripts/hermes/probook-notify-relay.py ~/.hermes/scripts/
Self-check without network: python3 probook-notify-relay.py --selftest
"""
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ENV_FILE = os.path.expanduser("~/.hermes/scripts/probook.env")
STATE = os.path.expanduser("~/.hermes/state/probook/notify-relay.json")
OUTBOX = os.path.expanduser("~/.hermes/state/probook/outbox-notify-relay.json")
HERMES_JOBS = os.path.expanduser("~/.hermes/cron/jobs.json")
JOB_NAME = "probook-notify-relay"
FIRST_RUN_BACKFILL_H = 24
NAS_STALE_ALERT_MIN = 120
NAS_ALERT_EVERY_S = 12 * 3600
ERROR_ALERT_EVERY_S = 6 * 3600
MAX_CHARS = 1800          # one Discord message
MAX_PAGES = 5
OVERLAP_MIN = 15        # re-read this far behind the cursor (late-committing audit rows)


def env_val(key, path=ENV_FILE):
    try:
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return os.environ.get(key, "")


STATE_NOTE = []   # set by read_state when the state file had to be reset — printed by run()


def read_state():
    """{} only when the file does not exist yet. A corrupt/unreadable file is moved aside and SAID:
    resetting silently would re-backfill 24 h and skip anything older without telling anyone."""
    try:
        return json.load(open(STATE, encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as e:
        bad = f"{STATE}.bad-{time.strftime('%Y%m%d-%H%M%S')}"
        try:
            os.replace(STATE, bad)
        except Exception:
            pass
        STATE_NOTE.append(f"⚠️ relay: state อ่านไม่ได้ ({type(e).__name__}) — ย้ายไป {os.path.basename(bad)} แล้วเริ่มนับจาก 24 ชม.ก่อน"
                          " · ถ้า relay หยุดไปนานกว่านั้น ใบที่เก่ากว่าต้องดูใน probook เอง")
        return {}


def write_state(st):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, STATE)  # never a half-written cursor


def _delivery_error(job_name=JOB_NAME):
    """last_delivery_error of this Hermes job (None = the previous message arrived, or unreadable).
    Same OUTBOX pattern as probook-worker-check.py: Discord delivery happens in Hermes AFTER this script
    exits and Hermes does not retry, so the script itself re-sends what did not arrive."""
    try:
        raw = json.load(open(HERMES_JOBS, encoding="utf-8"))
    except Exception:
        return None
    jobs = raw if isinstance(raw, list) else raw.get("jobs", raw)
    jobs = list(jobs.values()) if isinstance(jobs, dict) else jobs
    for j in jobs if isinstance(jobs, list) else []:
        if isinstance(j, dict) and j.get("name") == job_name:
            return j.get("last_delivery_error")
    return None


def _ob_read(path):
    """ไฟล์ OUTBOX อ่านไม่ได้/ไม่มี = None (เหมือนเดิม: อ่านไม่ออก = ไม่มีอะไรค้าง)"""
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return None


def _ob_write(path, data):
    """เขียนแบบ atomic เหมือน remember() เดิม · เขียนไม่ได้ = raise (ดัง ไม่กลืน)"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(path + ".tmp", path)


# เดิมสคริปต์นี้ไม่มีเพดาน (เก็บข้อความทั้งก้อน) — 🔴/📣 ห้ามถูกตัดตอนส่งซ้ำ จึงตั้งสูงกว่าตัวอื่น (60)
# Hermes แบ่งข้อความยาวเป็นหลาย Discord message เอง
OUTBOX_MAX_LINES = 400


def _ob_rounds(saved):
    """ไฟล์ OUTBOX → รอบที่ยังค้าง [{runAt, text}] · รูปเดิม {runAt, text} (ก่อน 17 พ.ย. 2569) = หนึ่งรอบ"""
    if isinstance(saved, dict) and isinstance(saved.get("rounds"), list):
        return [r for r in saved["rounds"] if isinstance(r, dict) and r.get("text")]
    if isinstance(saved, dict) and saved.get("text"):
        return [{"runAt": saved.get("runAt", "ก่อนหน้า"), "text": str(saved["text"])}]
    return []


def undelivered(job_name, outbox):
    """-> {"rounds": [...], "dropped": n} รอบที่ Hermes ยังส่งไม่ถึง · rounds ว่าง = ไม่มีอะไรค้าง
    (รอบก่อนส่งถึงแล้ว = ล้างไฟล์ทิ้งที่นี่) · ค้าง = last_delivery_error มีค่า *หรือ* ไฟล์มีธง "undelivered"
    (hold_outbox จดไว้ตอนรอบที่ไม่ได้ทำงานเพราะแมคยังหลับ — Hermes เขียน last_delivery_error ทับเป็น None ไปแล้ว)"""
    saved = _ob_read(outbox)
    rounds = _ob_rounds(saved)
    held = isinstance(saved, dict) and saved.get("undelivered") is True
    if not rounds or not (_delivery_error(job_name) or held):
        if os.path.exists(outbox):
            try:
                os.remove(outbox)   # ถึงมือแล้ว (หรือไม่มีอะไรให้ส่งซ้ำ)
            except Exception:
                pass
        return {"rounds": [], "dropped": 0}
    dropped = saved.get("dropped") if isinstance(saved, dict) else 0
    return {"rounds": rounds, "dropped": dropped if isinstance(dropped, int) else 0}


def hold_outbox(job_name, outbox):
    """รอบที่ไม่ทำงานเพราะแมคยังหลับ (await_full_wake() คืน False): ออกเงียบ แต่ Hermes จะเขียน last_delivery_error
    ทับเป็น None ทั้งที่รอบก่อนยังส่งไม่ถึง → จดธง "undelivered" ไว้ในไฟล์เอง ให้ undelivered() รอบหน้ายังส่งซ้ำ"""
    if not _delivery_error(job_name):
        return
    saved = _ob_read(outbox)
    if isinstance(saved, dict) and _ob_rounds(saved) and saved.get("undelivered") is not True:
        _ob_write(outbox, {**saved, "undelivered": True})


def resend_lines(carried):
    """บรรทัดส่งซ้ำ — รอบละหนึ่งบล็อก เก่าไปใหม่ ไม่ซ้อนกัน · รอบที่ถูกตัดทิ้ง = บอกจำนวนและที่อ่านฉบับเต็ม
    relay: บล็อกคั่นด้วยบรรทัดว่าง ไม่มีบรรทัดปิด (= "\\n\\n" แบบเดิม) · เนื้อข้อความใส่ทั้งก้อนตามที่เก็บไว้"""
    out = []
    if carried["rounds"] and carried.get("dropped"):
        out.append(f"📮 ข้อความเก่าที่ส่งไม่ออกอีก {carried['dropped']} รอบถูกตัดทิ้ง (เพดาน {OUTBOX_MAX_LINES} บรรทัด) — "
                   "ฉบับเต็มอยู่ใน ~/.hermes/cron/output/")
    for r in carried["rounds"]:
        out += ([""] if out else []) + [f"📮 ส่งซ้ำ — ข้อความรอบ {r.get('runAt', 'ก่อนหน้า')} ส่งไม่ออก", str(r["text"])]
    return out


def remember_report(outbox, carried, text):
    """เก็บ *เนื้อรายงานของรอบนี้เอง* ต่อท้ายรอบที่ยังค้าง (carried) เผื่อรอบนี้ส่งไม่ออกอีก
    ห้ามเก็บ payload ทั้งก้อน: payload มีบล็อกส่งซ้ำ + บรรทัด ‼️ อยู่แล้ว → รอบถัดไปห่อซ้ำเป็นชั้น ๆ
    (14–17 พ.ย. 2569 episode-drift ส่งรายงาน 3 คืนซ้อนกัน 3 ชั้น) · heartbeat ไม่ต้องเก็บ (ผู้เรียกส่ง "" มา):
    heartbeat ที่หายไปแก้ตัวเองรอบหน้า แต่ *คำเตือน* ที่หายคือความเสียหายจริง
    เกิน OUTBOX_MAX_LINES = ทิ้งรอบเก่าสุดก่อน (นับไว้ บอกตอนส่งซ้ำ) · เหลือรอบเดียวที่ยาวเกิน = ตัดท้ายพร้อมบอก"""
    rounds = list(carried["rounds"]) + ([{"runAt": time.strftime("%Y-%m-%d %H:%M"), "text": text}] if text else [])
    if not rounds:
        return
    dropped = carried.get("dropped") or 0
    while len(rounds) > 1 and sum(len(str(r["text"]).splitlines()) for r in rounds) > OUTBOX_MAX_LINES:
        rounds.pop(0)
        dropped += 1
    lines = str(rounds[0]["text"]).splitlines()
    if len(rounds) == 1 and len(lines) > OUTBOX_MAX_LINES:
        rounds[0] = {**rounds[0], "text": "\n".join(
            lines[:OUTBOX_MAX_LINES] + [f"… ตัดอีก {len(lines) - OUTBOX_MAX_LINES} บรรทัด (ฉบับเต็มอยู่ใน ~/.hermes/cron/output/)"])}
    _ob_write(outbox, {"rounds": rounds, "dropped": dropped})


# ── DARKWAKE: รอแมคตื่นจริงก่อนทำงาน (ซ้ำทุกสคริปต์ Hermes โดยเจตนา — README scripts/hermes ข้อ 8) ──
# 14–17 พ.ย. 2569: แมคบุ๊กหลับ (ใช้แบต) แต่ตื่นแบบ DarkWake ทุก ~15 นาที ครั้งละ 2–20 วิ (pmset -g log) · Hermes ได้ CPU
# ช่วงนั้นแล้วยิงงานที่ถึงเวลาทันทีทั้งที่ Wi-Fi/DNS ยังไม่มา → episode-drift 'nodename nor servname' 3 คืนติด ·
# rental-sheet 'read operation timed out' · relay TimeoutError · trash-watch ค้างกลางคำขอ 12 ชม. (นาฬิกา monotonic
# ไม่เดินตอนหลับ timeout ของ socket และของ Hermes จึงไม่ทำงาน) → รอจน Graphics กลับมา (ตื่นจริง) แล้วค่อยทำ
# รอ ไม่ข้ามเงียบ: Hermes เขียน last_delivery_error ทับทุกรอบ รอบที่ไม่มีอะไรส่งจะลบร่องรอยว่ารอบก่อนส่งไม่ออก ·
# ข้อยกเว้นเดียว (20 พ.ย.): หลับครบเพดานและไม่มีเน็ต = ไม่ทำรอบนี้ โดย hold_outbox() จดธง "undelivered" ในไฟล์แทน ·
# ไม่แน่ใจ (ไม่มี pmset / อ่านไม่ออก) = ถือว่าตื่น ทำงานตามปกติ ห้ามเงียบเพราะเดา
def dark_wake(out=None):
    """True เฉพาะเมื่อ `pmset -g systemstate` บอกชัดว่ามี CPU แต่ไม่มี Graphics (= DarkWake)"""
    if out is None:
        try:
            out = subprocess.run(["/usr/bin/pmset", "-g", "systemstate"], capture_output=True, text=True, timeout=10).stdout
        except Exception:
            return False
    m = re.search(r"Capabilities are:([^\n]*)", out or "")
    caps = m.group(1).split() if m else []
    return "CPU" in caps and "Graphics" not in caps


def await_full_wake(cap_s=1800, dns_s=600, _dark=None, _sleep=time.sleep, _now=time.monotonic, _resolve=socket.getaddrinfo):
    """-> True = ทำงานได้ · False = ยังหลับครบเพดานและไม่มีเน็ต (ไม่ทำรอบนี้ — ผู้เรียก hold_outbox() แล้วออกเงียบ)
    บล็อกจนแมคตื่นจริง แล้วรอ DNS อีกไม่เกิน dns_s วิ · เพดาน cap_s นับ monotonic = นาฬิกาเดียวกับ timeout 3600 วิ
    ของ Hermes (ไม่เดินตอนหลับ) · _dark/_sleep/_now/_resolve = ของปลอมใน self-test
    18 พ.ย. 2569: หลับ 15.6 ชม. มี DarkWake 90 ครั้งรวม 2,012 วิ → เพดาน 1800 หมดตอน 08:2x แล้วเดิมปล่อยรันตอนหลับ
    (relay/rental/trash ล้มเน็ตล่ม) → ครบเพดาน: มีเน็ต (Power Nap เสียบไฟ) = ทำ · ไม่มี = ไม่ทำรอบนี้ Hermes ยิงรอบหน้าเอง
    19 พ.ย. 2569: ตื่นจริง 09:50 (เสียบ USB-C) แต่เน็ตมา ~10:00 → DNS 60 วิไม่พอ idfirst/rental/trash ล้ม → รอ 10 นาที
    ตื่นจริงแล้วเน็ตไม่มาเกิน dns_s = ทำงานต่อ (True) ให้ทางเน็ตล่มของสคริปต์บอกเอง — เครื่องตื่นแต่ออฟไลน์จริงต้องรู้"""
    dark = _dark or dark_wake

    def online():
        try:
            _resolve("google.com", 443)
            return True
        except OSError:
            return False
    t0 = _now()
    while dark():
        if _now() - t0 >= cap_s:
            return online()
        _sleep(3)
    t1 = _now()
    while not online():
        if _now() - t1 >= dns_s:
            return True
        _sleep(5)
    return True


def net_down():
    for host in ("cloudflare.com", "google.com"):
        try:
            socket.getaddrinfo(host, 443)
            return False
        except Exception:
            continue
    return True


def fetch(base, secret, since):
    url = f"{base}/api/internal/notify-feed?" + urllib.parse.urlencode({"since": since, "limit": 50})
    req = urllib.request.Request(url, headers={"x-footage-ready-secret": secret, "User-Agent": "hermes-probook-relay"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def gb(b):
    return f"{b / 1024 ** 3:.1f} GB" if b else ""


OPS_LINES, OPS_CHARS, OPS_LINE_CHARS = 6, 700, 300
KNOWN = {"footage-ready", "footage-ready-manual", "footage-complete", "nas-drained", "ops-alert"}


def quiet(t):
    """App text (Drive file names, exception messages) must not ping the room: @everyone / @here / <@id>."""
    return (t or "").replace("@", "@\u200b")


def ops_line(e):
    """Subject + whole lines while they fit; anything left out is SAID, with where to read the rest."""
    lines = [l.rstrip() for l in quiet(e.get("text")).splitlines() if l.strip()]
    shown, used, cut = [], 0, False
    for l in lines:
        if len(l) > OPS_LINE_CHARS:
            l, cut = l[:OPS_LINE_CHARS] + "…", True
        if len(shown) >= OPS_LINES or (shown and used + len(l) > OPS_CHARS):
            break
        shown.append(l)
        used += len(l)
    hidden = len(lines) - len(shown)
    where = "ดูเมล" if e.get("emailed") else "เมลไม่ได้ส่ง — ข้อความเต็มอยู่ใน audit log (ops.alert)"
    tail = ""
    if hidden or cut:
        tail = f"\n   … " + (f"อีก {hidden} บรรทัด" if hidden else "บางบรรทัดถูกตัด") + f" ({where})"
    head = f"⚠️ ops · {quiet(e.get('title')) or e.get('code') or '?'}"
    return head + "".join("\n   " + l for l in shown) + tail


def line_for(e):
    code, title = e.get("code") or "?", e.get("title") or ""
    if e["kind"] == "ops-alert":
        return ops_line(e)
    if e["kind"] not in KNOWN:  # a newer feed than this relay: say it, never dress it up as footage-ready
        return f"❔ {e['kind']} · {quiet(title) or code} (relay ยังไม่รู้จักชนิดนี้ — อัปเดต probook-notify-relay.py)"
    head = f"{code} — {title}" if title else code
    if e["kind"] == "footage-complete":  # v1.268 — the cameras missing at the first notice arrived
        people = f" · แจ้งทีม {e['people']} คน" if e.get("people") else " · ⚠️ ไม่มีคนในทีมได้รับเมล"
        err = f" · ⚠️ เมล: {e['emailError']}" if e.get("emailError") else ""
        link = e.get("boxUrl") or e.get("url") or ""
        return f"✅ กล้องตามมาครบแล้ว · {quiet(head)}{people}{err}" + (f"\n   {link}" if link else "")
    if e["kind"] == "nas-drained":
        size = f" ({gb(e['bytes'])})" if e.get("bytes") else ""
        files = f" · บน Drive {e['files']} ไฟล์{size}" if e.get("files") is not None else ""
        return f"✅ NAS ส่งขึ้น Drive ครบ · {head}{files}"
    files = f" · {e['files']} ไฟล์" if e.get("files") is not None else ""
    who = f" · แจ้งมือโดย {e['by'].split('@')[0]}" if e["kind"] == "footage-ready-manual" and e.get("by") else ""
    people = f" · แจ้งทีม {e['people']} คน" if e.get("people") else " · ⚠️ ไม่มีคนในทีมได้รับเมล"
    err = f" · ⚠️ เมล: {e['emailError']}" if e.get("emailError") else ""
    link = e.get("boxUrl") or e.get("url") or ""
    return f"📣 ฟุตเทจพร้อม · {head}{files}{people}{who}{err}" + (f"\n   {link}" if link else "")


def fit(events):
    """-> (events that fit in one message, how many wait for the next run). Never drops one: what does
    not fit stays after the cursor and goes out 5 minutes later."""
    used, n = 0, 0
    for e in events:
        l = len(line_for(e)) + 1
        if n and used + l > MAX_CHARS - 80:
            break
        used, n = used + l, n + 1
    return events[:n], len(events) - n


def run(now=None, fetcher=fetch):
    now = now or datetime.now(timezone.utc)
    base = (env_val("PROBOOK_BASE") or "https://probook.thestandard.co").rstrip("/")
    secret = env_val("PROBOOK_LANDING_SECRET") or env_val("FOOTAGE_READY_SECRET")
    st = read_state()
    out = []
    if not secret:
        if time.time() - st.get("lastErrorAt", 0) > ERROR_ALERT_EVERY_S:
            st["lastErrorAt"] = time.time()
            write_state(st)
            return f"⚠️ relay แจ้งฟุตเทจ: ไม่มี PROBOOK_LANDING_SECRET ใน {ENV_FILE} — ส่งต่อไม่ได้"
        return ""

    cursor = st.get("cursor") or (now - timedelta(hours=FIRST_RUN_BACKFILL_H)).isoformat()
    # An audit row is stamped at INSERT and a slow writer can commit a moment after a later one, so read
    # OVERLAP_MIN behind the cursor every time and drop what was already delivered (by id).
    delivered = dict(st.get("delivered", {}))          # id -> at, kept DELIVERED_KEEP_H
    since = (datetime.fromisoformat(cursor.replace("Z", "+00:00")) - timedelta(minutes=OVERLAP_MIN)).isoformat()
    events, nas = [], None
    try:
        for _ in range(MAX_PAGES):
            d = fetcher(base, secret, since)
            nas = d.get("nas")
            events += [e for e in d.get("events", []) if e["id"] not in delivered]
            if not d.get("more") or not d.get("events"):
                break
            since = d["events"][-1]["at"]                   # gte: the boundary rows come back, de-duped below
    except Exception as e:
        if net_down():
            return ""  # this Mac is offline — catch up next run, nobody to warn
        if time.time() - st.get("lastErrorAt", 0) > ERROR_ALERT_EVERY_S:
            st["lastErrorAt"] = time.time()
            write_state(st)
            code = getattr(e, "code", "")
            hint = " — secret ใน probook.env ไม่ตรงกับ prod" if code == 401 else ""
            return f"⚠️ relay แจ้งฟุตเทจ: ดึง notify-feed ไม่ได้ ({code or type(e).__name__}){hint} · จะลองใหม่ทุก 5 นาที"
        return ""

    st.pop("lastErrorAt", None)  # fetched fine — the next failure is news again
    events = sorted({e["id"]: e for e in events}.values(), key=lambda e: (e["at"], e["id"]))
    send, waiting = fit(events)
    if send:
        out.append("\n".join(line_for(e) for e in send) + (f"\n…มีอีก {waiting} รายการ จะตามมาในรอบถัดไป" if waiting else ""))
        for e in send:
            delivered[e["id"]] = e["at"]
        st["cursor"] = max(cursor, send[-1]["at"]) if "cursor" in st else send[-1]["at"]
    elif "cursor" not in st:
        st["cursor"] = cursor  # first run with nothing to say: start from the backfill point
    # keep every id the NEXT run can re-read (cursor − overlap, with a margin) — pruning by wall-clock age
    # re-posted the last notice every 5 min once a quiet spell outlasted the keep period
    keep_after = (datetime.fromisoformat(st["cursor"].replace("Z", "+00:00")) - timedelta(minutes=OVERLAP_MIN + 5)).isoformat()
    st["delivered"] = {k: v for k, v in delivered.items() if v >= keep_after}
    st.pop("seenAtCursor", None)

    if nas and nas.get("error"):
        pass  # the server could not read its NAS state this time — not evidence either way
    elif nas and nas.get("stale") and (nas.get("ageMinutes") is None or nas["ageMinutes"] >= NAS_STALE_ALERT_MIN):
        if time.time() - st.get("nasAlertAt", 0) > NAS_ALERT_EVERY_S:
            st["nasAlertAt"] = time.time()
            age = f"{nas['ageMinutes'] // 60} ชม." if nas.get("ageMinutes") is not None else "ไม่เคยมีข้อมูล"
            out.append(f"⚠️ ตัวสแกน NAS เงียบ {age} — แจ้ง 'NAS ส่งขึ้น Drive ครบ' จะไม่มาจนกว่าจะกลับมา\n"
                       "   เช็กบนเครื่องนัท: tail /tmp/probook-nas-agent.log")
    elif nas and not nas.get("stale"):
        st.pop("nasAlertAt", None)

    write_state(st)
    if STATE_NOTE:
        out.insert(0, STATE_NOTE.pop())
    return "\n".join(out)


def run_once(runner=run):
    """run() + OUTBOX -> ข้อความที่จะพิมพ์ ("" = เงียบ) · __main__ และ --selftest ใช้ตัวเดียวกัน
    ลำดับสำคัญ: อ่าน+ล้าง outbox ของรอบก่อนให้เสร็จ แล้วจึงเขียนของรอบนี้ทับ · เดิม remember(msg) เก็บแค่ msg
    → ส่งไม่ออก 2 รอบติดที่มีข้อความทั้งคู่ = ข้อความรอบแรกหาย · ตอนนี้ต่อท้ายรอบที่ค้าง (carried) แบบแบน ไม่ซ้อน"""
    carried = undelivered(JOB_NAME, OUTBOX)
    msg = runner()
    remember_report(OUTBOX, carried, msg)   # เนื้อรอบนี้เท่านั้น · msg ว่างแต่มีของค้าง = ยังเก็บของค้างไว้
    return "\n\n".join(x for x in ("\n".join(resend_lines(carried)), msg) if x)


def selftest():
    global STATE
    import tempfile
    d = tempfile.mkdtemp()
    STATE = os.path.join(d, "s.json")
    os.environ["PROBOOK_LANDING_SECRET"] = "x"
    global ENV_FILE
    ENV_FILE = os.path.join(d, "none.env")
    now = datetime(2026, 10, 9, 8, 0, tzinfo=timezone.utc)
    ev = lambda i, at, kind="footage-ready", **k: {"id": f"e{i}", "at": at, "kind": kind, "code": f"NWS-KYM-26100{i}-01",
                                                   "title": "Key Message", "files": 12, "bytes": 3 * 1024 ** 3, "people": 4,
                                                   "boxUrl": f"https://drive/{i}", **k}
    calls = []

    def f1(base, secret, since):
        calls.append(since)
        return {"events": [ev(1, "2026-10-09T01:00:00Z"), ev(2, "2026-10-09T02:00:00Z", "nas-drained")], "more": False,
                "nas": {"stale": False, "ageMinutes": 5}}
    out = run(now, f1)
    assert "📣 ฟุตเทจพร้อม · NWS-KYM-261001-01 — Key Message · 12 ไฟล์ · แจ้งทีม 4 คน" in out, out
    assert "✅ NAS ส่งขึ้น Drive ครบ · NWS-KYM-261002-01 — Key Message · บน Drive 12 ไฟล์ (3.0 GB)" in out, out
    assert calls[0] == "2026-10-08T07:45:00+00:00", calls       # first run backfills 24 h (+15 min overlap)
    # second run: the feed returns the last event again (gte) → nothing new, nothing printed
    assert run(now, lambda b, s, since: {"events": [ev(2, "2026-10-09T02:00:00Z", "nas-drained")], "more": False,
                                         "nas": {"stale": False}}) == ""
    # fetch error → one line, cursor kept; second error inside 6 h → silent
    def boom(*a):
        raise urllib.error.HTTPError("u", 401, "no", {}, None)
    globals()["net_down"] = lambda: False
    first = run(now, boom)
    assert "401" in first and "secret" in first, first
    assert run(now, boom) == ""
    assert read_state()["cursor"] == "2026-10-09T02:00:00Z"
    # stale NAS → one alert, then quiet for 12 h
    stale = lambda *a: {"events": [], "more": False, "nas": {"stale": True, "ageMinutes": 87 * 24 * 60}}
    assert "ตัวสแกน NAS เงียบ 2088 ชม." in run(now, stale)
    assert run(now, stale) == ""
    # many events → as many as fit now, the rest NEXT run (never summarised away)
    def many(base, secret, since):  # honours `since` like the real feed (at >= since)
        cut = datetime.fromisoformat(since.replace("Z", "+00:00"))
        evs = [ev(i, f"2026-10-09T03:{i:02d}:00Z") for i in range(10, 60)]
        return {"events": [e for e in evs if datetime.fromisoformat(e["at"].replace("Z", "+00:00")) >= cut], "more": False, "nas": {"stale": False}}
    got, rounds = set(), 0
    while rounds < 20:
        rounds += 1
        msg = run(now, many)
        if not msg:
            break
        assert len(msg) <= MAX_CHARS, len(msg)
        got |= {l.split(" · ")[1].split(" — ")[0] for l in msg.splitlines() if l.startswith("📣")}
    assert got == {f"NWS-KYM-26100{i}-01" for i in range(10, 60)}, sorted(got)[:5]
    assert rounds > 2, "should have needed several messages"
    # a row that commits late with an EARLIER timestamp than the cursor is still delivered (overlap window)
    def late(base, secret, since):
        e = ev(99, "2026-10-09T03:50:00Z")
        return {"events": [e] if e["at"] >= since.replace("+00:00", "Z") else [], "more": False, "nas": {"stale": False}}
    assert "NWS-KYM-2610099-01" in run(now, late)
    assert run(now, late) == ""
    # a quiet week later the last notice is NOT posted again
    later = now + timedelta(days=7)
    assert run(later, late) == "", "re-sent an old notice after a quiet spell"
    assert run(later + timedelta(minutes=5), late) == ""
    # outbox: Hermes failed to deliver → next run re-sends; delivered → cleared
    global OUTBOX, HERMES_JOBS
    OUTBOX, HERMES_JOBS = os.path.join(d, "ob.json"), os.path.join(d, "jobs.json")
    remember_report(OUTBOX, {"rounds": [], "dropped": 0}, "📣 ฟุตเทจพร้อม · X")
    json.dump({"jobs": [{"name": JOB_NAME, "last_delivery_error": "DNS"}]}, open(HERMES_JOBS, "w"))
    assert "\n".join(resend_lines(undelivered(JOB_NAME, OUTBOX))).endswith("📣 ฟุตเทจพร้อม · X")
    json.dump({"jobs": [{"name": JOB_NAME, "last_delivery_error": None}]}, open(HERMES_JOBS, "w"))
    assert undelivered(JOB_NAME, OUTBOX) == {"rounds": [], "dropped": 0} and not os.path.exists(OUTBOX)

    # ── OUTBOX ไม่ซ้อนชั้น + ไม่ทำของค้างหาย (เดิม remember(msg) เขียนทับ: ส่งไม่ออก 2 รอบติด = ข้อความรอบแรกหาย) ──
    def relay(err, text):                # หนึ่งรอบของ __main__ (run_once) · err = ผลส่งของรอบก่อน · run() คืน text
        _ob_write(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": err}]})
        return run_once(lambda: text)
    for i in range(4):                   # ส่งไม่ออกทุกรอบ และทุกรอบมีข้อความของตัวเอง
        out = relay("DNS", f"📣 ฟุตเทจพร้อม · R{i}")
    saved = _ob_read(OUTBOX)
    assert [r["text"] for r in saved["rounds"]] == [f"📣 ฟุตเทจพร้อม · R{i}" for i in range(4)], saved   # แบน เก่าไปใหม่
    assert not any("📮" in r["text"] for r in saved["rounds"]), saved
    blocks = out.split("\n\n")           # ส่งซ้ำรอบละครั้ง ไม่ซ้อน แล้วตามด้วยของรอบนี้
    assert len(blocks) == 4 and blocks[3] == "📣 ฟุตเทจพร้อม · R3" and out.count("📮") == 3, out
    assert all(b.startswith("📮 ส่งซ้ำ — ข้อความรอบ ") and b.endswith(f" ส่งไม่ออก\n📣 ฟุตเทจพร้อม · R{i}")
               for i, b in enumerate(blocks[:3])), out
    # รอบนี้ไม่มีอะไรใหม่แต่ของค้างยังส่งไม่ถึง → ส่งซ้ำครบ และไฟล์ยังเก็บไว้ (รอบนี้ก็อาจส่งไม่ออกอีก)
    for _ in range(2):
        out = relay("DNS", "")
        assert out.count("📮 ส่งซ้ำ") == 4 and all(out.count(f"R{i}") == 1 for i in range(4)), out
        assert _ob_read(OUTBOX)["rounds"] == saved["rounds"], _ob_read(OUTBOX)
    # รอบก่อนส่งถึง → ไม่ส่งซ้ำ เหลือแค่ของรอบนี้ · ถึงแล้ว + ไม่มีอะไรใหม่ = เงียบ และไฟล์หาย
    out = relay(None, "📣 ฟุตเทจพร้อม · NEW")
    assert out == "📣 ฟุตเทจพร้อม · NEW" and [r["text"] for r in _ob_read(OUTBOX)["rounds"]] == [out], out
    assert relay(None, "") == "" and not os.path.exists(OUTBOX)
    # รูปไฟล์เดิม (ก่อน 17 พ.ย.) ยังส่งซ้ำได้ หน้าตาเดิมเป๊ะ และไม่ซ้ำเมื่อรอบนี้มีข้อความใหม่
    _ob_write(OUTBOX, {"runAt": "2026-11-16 03:15", "text": "📣 OLD-FORMAT"})
    assert relay("DNS", "") == "📮 ส่งซ้ำ — ข้อความรอบ 2026-11-16 03:15 ส่งไม่ออก\n📣 OLD-FORMAT"
    out = relay("DNS", "📣 ใหม่")
    assert out.count("📮 ส่งซ้ำ — ข้อความรอบ 2026-11-16 03:15") == 1 and out.count("OLD-FORMAT") == 1, out
    assert out.endswith("ส่งไม่ออก\n📣 OLD-FORMAT\n\n📣 ใหม่"), out
    # เพดาน 60 บรรทัด: ทิ้งรอบเก่าสุดแล้ว *บอก* · รอบเดียวยาวเกิน = ตัดท้ายพร้อมบอก
    os.remove(OUTBOX)
    for _ in range(3):
        relay("DNS", "\n".join(f"บรรทัด {i}" for i in range(OUTBOX_MAX_LINES * 5 // 12)))
    saved = _ob_read(OUTBOX)
    assert len(saved["rounds"]) == 2 and saved["dropped"] == 1, saved
    out = relay("DNS", "")
    assert "อีก 1 รอบถูกตัดทิ้ง" in out and out.count("📮 ส่งซ้ำ") == 2, out
    os.remove(OUTBOX)
    relay("DNS", "\n".join(f"บรรทัด {i}" for i in range(OUTBOX_MAX_LINES + 20)))
    (only,) = _ob_read(OUTBOX)["rounds"]
    assert only["text"].count("\n") == OUTBOX_MAX_LINES and "ตัดอีก 20 บรรทัด" in only["text"], only

    # ── DARKWAKE ──
    assert dark_wake("Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4\n") is False
    assert dark_wake("Current System Capabilities are: CPU Network \nCurrent Power State: 4\n") is True
    assert dark_wake("Current System Capabilities are: CPU \n") is True
    for junk in ("", "pmset: command not found", "Current System Capabilities are: \n", "Graphics CPU"):
        assert dark_wake(junk) is False, junk   # ไม่แน่ใจ = ตื่น (ห้ามเงียบเพราะเดา)
    clock, hits = [0.0], []

    def tick(s):
        clock[0] += s
    states = iter([True, True, True, False])
    ok = await_full_wake(_dark=lambda: next(states), _sleep=tick, _now=lambda: clock[0], _resolve=lambda h, p: hits.append(h))
    assert ok is True and clock[0] == 9 and hits == ["google.com"], (ok, clock, hits)   # รอข้าม 3 DarkWake แล้วทำงาน
    clock[0], tries = 0.0, [0]

    def flaky(h, p):
        tries[0] += 1
        if tries[0] < 3:
            raise OSError("nodename nor servname provided")
    ok = await_full_wake(_dark=lambda: False, _sleep=tick, _now=lambda: clock[0], _resolve=flaky)
    assert ok is True and tries[0] == 3 and clock[0] == 10, (ok, tries, clock)   # ตื่นแล้วแต่ DNS ยังไม่มา = รอ
    clock[0] = 0.0

    def dead(h, p):
        raise OSError("down")
    ok = await_full_wake(cap_s=30, dns_s=10, _dark=lambda: True, _sleep=tick, _now=lambda: clock[0], _resolve=dead)
    assert ok is False and clock[0] == 30, (ok, clock)              # หลับครบเพดาน + ไม่มีเน็ต = ไม่ทำรอบนี้ (18 พ.ย. ล้ม 3 ตัว)
    clock[0] = 0.0
    ok = await_full_wake(cap_s=30, _dark=lambda: True, _sleep=tick, _now=lambda: clock[0], _resolve=lambda h, p: None)
    assert ok is True and clock[0] == 30, (ok, clock)               # หลับครบเพดานแต่มีเน็ต (Power Nap เสียบไฟ) = ทำ
    clock[0] = 0.0
    ok = await_full_wake(dns_s=12, _dark=lambda: False, _sleep=tick, _now=lambda: clock[0], _resolve=dead)
    assert ok is True and 12 <= clock[0] <= 17, (ok, clock)         # ตื่นจริงแต่ออฟไลน์เกิน dns_s = ทำต่อ ให้ทางเน็ตล่มบอกเอง
    assert await_full_wake.__defaults__[:2] == (1800, 600), await_full_wake.__defaults__   # 19 พ.ย.: เน็ตมาหลังตื่น ~10 นาที
    entry = open(__file__, encoding="utf-8").read().split('if __name__ == "__main__":')[-1]
    assert 0 <= entry.find("await_full_wake()") < entry.find("run_once()"), "ทางจริงต้องรอแมคตื่นก่อน run_once()"
    # v1.263 ops alert: subject + whole lines while they fit · what is left out is SAID, with where to read it
    ops = ev(7, "2026-10-09T05:00:00Z", "ops-alert", code="sync-storm:POP-PIV-261007-02", title="⚠️ โฟลเดอร์ชื่อซ้ำ \"(1)\" ใน landing — POP-PIV-261007-02",
             text="\n".join(f"บรรทัด {i}" for i in range(1, 12)), emailed=True)
    line = line_for(ops)
    assert line.startswith("⚠️ ops · ⚠️ โฟลเดอร์ชื่อซ้ำ"), line
    assert line.splitlines()[1:7] == [f"   บรรทัด {i}" for i in range(1, 7)], line
    assert line.endswith("… อีก 5 บรรทัด (ดูเมล)"), line
    assert "audit log" in line_for({**ops, "emailed": False}), "no email went out → must not point to the inbox"
    assert line_for({**ops, "title": None, "text": ""}) == "⚠️ ops · sync-storm:POP-PIV-261007-02"
    # one long list line: cut WITH a marker and said, never silently (footage-stranded joins boxes on one line)
    long1 = line_for({**ops, "text": " · ".join(f"BOX-{i:02d}" for i in range(80))})
    assert "…\n" in long1 and long1.endswith("บางบรรทัดถูกตัด (ดูเมล)") and len(long1) < 600, long1
    # the char budget stops at a WHOLE line and counts what it left out
    wide = line_for({**ops, "text": "\n".join("y" * 250 for _ in range(6))})
    assert "อีก 4 บรรทัด" in wide and len(wide) < 1000, wide
    # app text never pings the room
    assert "@\u200beveryone" in line_for({**ops, "text": "@everyone ไฟล์หาย"})
    # v1.268 follow-up line
    fc = line_for(ev(9, "2026-10-09T05:00:00Z", "footage-complete"))
    assert fc.startswith("✅ กล้องตามมาครบแล้ว · NWS-KYM-261009-01 — Key Message · แจ้งทีม 4 คน"), fc
    assert "⚠️ เมล: 1/3" in line_for(ev(9, "2026-10-09T05:00:00Z", "footage-complete", emailError="1/3 ส่งไม่สำเร็จ"))
    assert "⚠️ ไม่มีคนในทีมได้รับเมล" in line_for(ev(9, "2026-10-09T05:00:00Z", "footage-complete", people=0))
    # an unknown kind from a newer feed is SAID, never posted as footage-ready
    assert line_for(ev(8, "2026-10-09T05:00:00Z", "new-thing")).startswith("❔ new-thing"), "unknown kind"
    # ops rows travel through run() with footage rows, in order, and are not posted twice
    def mixed(base, secret, since):
        evs = [{**ev(40, "2026-10-09T06:00:00Z"), "id": "f40"}, {**ops, "id": "o41", "at": "2026-10-09T06:01:00Z"}]  # fresh ids: e40 was delivered above
        return {"events": [x for x in evs if x["at"] >= since.replace("+00:00", "Z")], "more": False, "nas": {"stale": False}}
    out = run(now + timedelta(hours=1), mixed)
    assert out.index("📣 ฟุตเทจพร้อม · NWS-KYM-2610040-01") < out.index("⚠️ ops · "), out
    assert run(now + timedelta(hours=1, minutes=5), mixed) == ""
    # a corrupt state file is moved aside and SAID, not silently reset
    open(STATE, "w").write("{not json")
    msg = run(now, lambda *a: {"events": [], "more": False, "nas": {"stale": False}})
    assert msg.startswith("⚠️ relay: state อ่านไม่ได้"), msg
    assert any(f.startswith("s.json.bad-") for f in os.listdir(d))
    # ทางจริงเรียก await_full_wake() *ครั้งเดียว* ในบล็อก __main__ เท่านั้น — ไม่ใช่คอมเมนต์ (ตรวจข้อความหลุด)
    # และไม่อยู่ในฟังก์ชันที่ self-test เรียก (เทสต์ต้องไม่แตะ pmset/DNS จริง) · ตัวปลอมในเทสต์ส่ง keyword เสมอ
    import ast
    _tree = ast.parse(open(__file__, encoding="utf-8").read())
    _real = [n for n in ast.walk(_tree) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "await_full_wake"
             and not n.args and not n.keywords]
    _entry = [n for n in _tree.body if isinstance(n, ast.If) and "__main__" in ast.dump(n.test)]
    assert len(_entry) == 1 and len(_real) == 1 and any(n is _real[0] for n in ast.walk(_entry[0])), \
        "await_full_wake() ต้องถูกเรียกครั้งเดียวบนทางจริงในบล็อก __main__"
    # และผลของมันต้องถูกใช้: `if not await_full_wake(): hold_outbox(...); sys.exit(0)` — ไม่ทำงานตอนหลับครบเพดาน
    _guard = [n for n in ast.walk(_entry[0]) if isinstance(n, ast.If) and isinstance(n.test, ast.UnaryOp)
              and isinstance(n.test.op, ast.Not) and n.test.operand is _real[0]]
    _gcalls = {getattr(c.func, "id", None) or getattr(c.func, "attr", None) for g_ in _guard for b in g_.body
               for c in ast.walk(b) if isinstance(c, ast.Call)}
    assert len(_guard) == 1 and {"hold_outbox", "exit"} <= _gcalls, ("ต้อง hold_outbox แล้ว exit เมื่อยังหลับ", _gcalls)
    # ── hold_outbox: รอบที่ไม่ทำงานเพราะยังหลับ ห้ามทำให้ของค้างส่งหาย (Hermes เขียน last_delivery_error ทับเป็น None) ──
    _ob_write(OUTBOX, {"rounds": [{"runAt": "2026-11-18 13:21", "text": "⚠️ HELD-REPORT"}], "dropped": 0})
    _ob_write(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": "DNS"}]})
    hold_outbox(JOB_NAME, OUTBOX)
    assert _ob_read(OUTBOX).get("undelivered") is True, _ob_read(OUTBOX)
    _ob_write(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": None}]})   # รอบที่ hold: Hermes ล้างเป็น None
    hold_outbox(JOB_NAME, OUTBOX)                         # hold ซ้ำตอน error ว่าง = ไม่แตะธง
    _c = undelivered(JOB_NAME, OUTBOX)
    assert [r["text"] for r in _c["rounds"]] == ["⚠️ HELD-REPORT"], _c
    out = relay(None, "")                                 # รอบถัดไปที่ทำงานจริง: ส่งซ้ำ + เขียนไฟล์ใหม่ไม่มีธง
    assert "⚠️ HELD-REPORT" in out and "undelivered" not in (_ob_read(OUTBOX) or {}), (out, _ob_read(OUTBOX))
    assert undelivered(JOB_NAME, OUTBOX)["rounds"] == [] and not os.path.exists(OUTBOX)   # ส่งถึง → ล้าง
    _ob_write(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": "DNS"}]})
    hold_outbox(JOB_NAME, OUTBOX)
    assert not os.path.exists(OUTBOX), "ไม่มีของค้าง = hold ห้ามสร้างไฟล์"
    _ob_write(OUTBOX, {"rounds": [], "undelivered": True})
    assert undelivered(JOB_NAME, OUTBOX)["rounds"] == [] and not os.path.exists(OUTBOX), "ธงลอย ๆ ไม่มีรอบ = ล้างทิ้ง"
    # เพดาน OUTBOX ทิ้ง *รอบเก่าสุด* ก่อน (ไม่ใช่ใหม่สุด) และนับรวมกับที่เคยทิ้ง
    import tempfile as _tf
    _p, _h = os.path.join(_tf.mkdtemp(prefix="ob-cap-"), "ob.json"), OUTBOX_MAX_LINES // 2
    remember_report(_p, {"rounds": [{"runAt": "r1", "text": "\n".join(["OLD"] * _h)},
                                    {"runAt": "r2", "text": "\n".join(["MID"] * _h)}], "dropped": 2}, "\n".join(["NEW"] * _h))
    _s = _ob_read(_p)
    assert [r["runAt"] for r in _s["rounds"]][0] == "r2" and _s["rounds"][-1]["text"].startswith("NEW") and _s["dropped"] == 3, _s
    # รูปของรอบที่ข้ามต้องเป๊ะ (รีวิว 20 พ.ย.): hold_outbox(JOB_NAME, OUTBOX) ก่อน แล้ว sys.exit(0) — ลำดับถูก exit 0 ไม่พิมพ์ ไม่ทำอย่างอื่น
    import ast as _ast
    _t = _ast.parse(open(__file__, encoding="utf-8").read())
    _m = [n for n in _t.body if isinstance(n, _ast.If) and "__main__" in _ast.dump(n.test)][0]
    _g = [n for n in _ast.walk(_m) if isinstance(n, _ast.If) and _ast.unparse(n.test) == "not await_full_wake()"]
    assert len(_g) == 1 and [_ast.unparse(b) for b in _g[0].body] == ["hold_outbox(JOB_NAME, OUTBOX)", "sys.exit(0)"], \
        ([_ast.unparse(b) for b in _g[0].body] if _g else "ไม่พบ if not await_full_wake()")
    # hold_outbox ห้ามติดธงเมื่อรอบก่อนส่งถึงแล้ว (last_delivery_error ว่าง) — ไม่งั้นรายงานที่ถึงแล้วถูกส่งซ้ำ (รีวิว 20 พ.ย.)
    import tempfile as _tf3
    _gl, _d = globals(), _tf3.mkdtemp(prefix="hold-gate-")
    _jobs_saved = _gl["HERMES_JOBS"]
    _gl["HERMES_JOBS"] = os.path.join(_d, "jobs.json")
    _ob_write(_gl["HERMES_JOBS"], {"jobs": [{"name": JOB_NAME, "last_delivery_error": None}]})
    _obp = os.path.join(_d, "ob.json")
    _ob_write(_obp, {"rounds": [{"runAt": "x", "text": "DELIVERED"}], "dropped": 0})
    hold_outbox(JOB_NAME, _obp)
    assert "undelivered" not in _ob_read(_obp), _ob_read(_obp)
    _gl["HERMES_JOBS"] = _jobs_saved
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        if not await_full_wake():   # Hermes ยิงงานตอน DarkWake ได้ — รอเครื่องตื่นจริงก่อน (ดูบล็อก DARKWAKE)
            hold_outbox(JOB_NAME, OUTBOX)   # หลับครบเพดานและไม่มีเน็ต: ไม่ทำรอบนี้ · จดว่ารอบก่อนยังค้างส่ง
            sys.exit(0)
        out = run_once()
        if out:
            print(out)
