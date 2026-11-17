#!/usr/bin/env python3
"""probook-landing-v1285-check — ตรวจผลจริงของรอบ landing หลัง v1.285.0 (ทิ้งโฟลเดอร์ drop ของงานเสียงล้วน)
Hermes `--no-agent` · stdlib ล้วน ไม่มี LLM · อ่านอย่างเดียว **โดยโค้ด**: Prisma findMany + Drive files.list เท่านั้น
(scope ที่ domain-wide delegation อนุญาตคือ `drive` เต็ม — `drive.readonly` ถูกปฏิเสธ unauthorized_client ลองแล้ว 11 พ.ย. จึงบังคับด้วยโค้ดแทนสโคป)

นัทสั่ง 11 พ.ย. 2569: "ตั้งบอทเชคให้ตรงรอบเลย" (หลังผมบอกว่า deploy แล้วแต่ยังไม่รู้ผลทิ้งจริงจนกว่ารอบ 19:00 จะรัน)

ทำไมไม่เชื่อรายงานของ worker อย่างเดียว: "บันทึกว่าทำแล้ว" ≠ "ผลเกิดจริง" (บั๊กชนิดเดียวกับ dry-run โกหก / Lark ตอบ 200 ทั้งที่ปฏิเสธ)
ตัวตรวจจึงถาม Drive เองด้วยว่าโฟลเดอร์ที่ควรถูกทิ้ง "ไม่มี live เหลือ + มีตัวที่ถูกทิ้งหลังรอบเริ่ม" และโฟลเดอร์ที่ควรรอด "ยัง live อยู่"

แต่ละ expectation ตรวจเมื่อถึง due (หลังรอบจบ) :
  - มีแถว audit ของรอบนั้นหลัง since (รอบ 19:00 = drive.landing_lifecycle · รอบเที่ยง = drive.prune_landing_to_today)
      · ยังไม่มีแถว ก่อน deadline = เงียบ รอ tick หน้า · เลย deadline แล้วยังไม่มี = ⚠️ ครั้งเดียว (worker ไม่รัน/ล้ม)
  - แถว audit ต้องไม่มี error (removeErrors/createErrors/errors = 0)
  - trashed[]: ไม่มีโฟลเดอร์ live ชื่อ "(CODE)" ใต้ root และมีตัวที่ถูกทิ้ง (trashedTime ≥ since)
  - kept[]:    ยังมีโฟลเดอร์ live อย่างน้อย 1 และไม่มีตัวที่ถูกทิ้งหลัง since (ถูกทิ้งผิด = ⚠️ ตัวแดง)
ผลผ่าน = 1 บรรทัด ✅ (ครั้งเดียวต่อ expectation) · ไม่ผ่าน = ⚠️ ครั้งเดียว (exit 0 — เป็นข้อค้นพบที่ prod ไม่ใช่สคริปต์ล้ม) ·
อ่าน prod/Drive ไม่ได้ = ⚠️ สั้น + exit 1 แล้วลองใหม่ tick หน้า (ปนกับผลตรวจของอีกรอบ = exit 0 + ‼️ ให้ผลถึงครบ — ดู exit_plan) ·
ส่ง Discord ไม่ถึง = OUTBOX พิมพ์ซ้ำรอบหน้า ·
บันทึก "done" หลังผลถูกเก็บลง OUTBOX และพิมพ์ออกแล้วเท่านั้น
ครบทุก expectation แล้ว = เงียบถาวร ไม่แตะเครือข่าย (ลบ job ได้: hermes cron remove <id>)

  python3 probook-landing-v1285-check.py              # รันจริง (Hermes เรียกแบบนี้)
  python3 probook-landing-v1285-check.py --dry-run    # ตรวจจริงทุกขั้นแต่ไม่เขียน state และข้ามเงื่อนไขเวลา (due/deadline)
  python3 probook-landing-v1285-check.py --self-test  # ตัวตัดสินด้วยข้อมูลปลอม ไม่แตะ prod
"""
import base64
import json
import os
import re
import socket
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

BKK = timezone(timedelta(hours=7))
STATE = os.path.expanduser("~/.hermes/state/probook/landing-v1285-check.json")
PROBOOK_ENV = os.path.expanduser("~/.hermes/scripts/probook.env")

SOUND_NO_AUDIO = ["EVT-OTH-260922-01", "POD-8MH-261012-03", "WLT-OTH-261015-01"]   # เสียงล้วนที่กล่องยังไม่มีเสียง → ต้องรอด
EXPECT = [
    {"id": "sweep-2026-11-11", "action": "drive.landing_lifecycle",
     "since": "2026-11-11T19:00:00+07:00", "due": "2026-11-11T19:25:00+07:00", "deadline": "2026-11-11T20:30:00+07:00",
     "trashed": ["POD-OTH-261105-01", "POD-OTH-261105-02", "POD-OTH-261109-01"], "kept": SOUND_NO_AUDIO},
    {"id": "prune-2026-11-12", "action": "drive.prune_landing_to_today",
     "since": "2026-11-12T12:00:00+07:00", "due": "2026-11-12T12:25:00+07:00", "deadline": "2026-11-12T13:30:00+07:00",
     "trashed": ["POD-OTH-261110-01"], "kept": SOUND_NO_AUDIO},
]

# READ-ONLY: findMany + drive.files.list เท่านั้น
PROBE_JS = r"""
const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient()
const { google } = require('googleapis')
const creds = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  : { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n') }
const auth = new google.auth.JWT({ email: creds.client_email, key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/drive'], subject: process.env.GOOGLE_IMPERSONATE_SUBJECT || undefined })
const drive = google.drive({ version: 'v3', auth })
;(async () => {
  const audit = await prisma.auditLog.findMany({ where: { action: process.env.ACTION, at: { gte: new Date(process.env.SINCE) } },
    orderBy: { at: 'asc' }, select: { at: true, actorEmail: true, changes: true } })
  // รากเดียวกับที่ worker ใช้ (landing-lifecycle.ts PRODUCTION_TEAM_ROOT) — ไม่ใช่ DRIVE_FOOTAGE_ROOT (นั่นคือรากกล่อง)
  const root = (process.env.DRIVE_PRODUCTION_TEAM_ROOT || '').trim() || '0AGendsFHFQYKUk9PVA'
  // ไม่กรอง trashed: ถังต้องเดินด้วย query ที่ไม่กรอง (footage-ops) — drop folder อยู่ใต้ root ตรง ๆ
  const kids = []
  let pageToken
  do {
    const r = await drive.files.list({ q: `'${root}' in parents and mimeType='application/vnd.google-apps.folder'`, pageSize: 1000, pageToken,
      fields: 'nextPageToken, files(id,name,trashed,trashedTime)', supportsAllDrives: true, includeItemsFromAllDrives: true })
    kids.push(...r.data.files); pageToken = r.data.nextPageToken
  } while (pageToken)
  // root ที่ไม่มีลูกเลย = ชี้ผิดตัว/อ่านไม่ได้ — ห้ามปล่อยให้ตัดสินจากความว่างเปล่า ("ไม่เจอ" ≠ "ถูกทิ้ง")
  if (kids.length === 0) throw new Error('root ' + root + ' ไม่มีโฟลเดอร์ลูกเลย — ชี้ผิดตัวหรืออ่านไม่ได้')
  const codes = JSON.parse(process.env.CODES), folders = {}
  for (const code of codes) folders[code] = kids.filter(f => (f.name || '').includes(`(${code})`)).map(f => ({ id: f.id, trashed: !!f.trashed, trashedTime: f.trashedTime || null }))
  console.log('OUT>' + JSON.stringify({ audit, folders, rootChildren: kids.length }))
  await prisma.$disconnect()
})().catch(e => { console.log('OUT>' + JSON.stringify({ error: String(e && e.message || e) })); process.exit(1) })
"""


def read_env(path):
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def probe(exp):
    """อ่านแถว audit + สถานะโฟลเดอร์ใน Drive ผ่าน Portainer docker exec (ทางเดียวกับ probook-tuy-digest)"""
    e = read_env(PROBOOK_ENV)
    base, key, ep = e["PORTAINER_URL"].rstrip("/"), e["PORTAINER_API_KEY"], e.get("PORTAINER_ENDPOINT_ID", "2")

    def call(path, payload, timeout=240):
        req = urllib.request.Request(base + path, data=json.dumps(payload).encode(), method="POST",
                                     headers={"X-API-Key": key, "Content-Type": "application/json"})
        return urllib.request.urlopen(req, timeout=timeout)

    since_utc = datetime.fromisoformat(exp["since"]).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    codes = json.dumps(exp["trashed"] + exp["kept"])
    b64 = base64.b64encode(PROBE_JS.encode()).decode()
    tmp = f"/tmp/_l1285chk_{os.getpid()}.cjs"
    sh = (f"echo {b64} | base64 -d > {tmp} && cd /app && ACTION={exp['action']} SINCE={since_utc} CODES='{codes}' "
          f"NODE_PATH=/app/node_modules node {tmp}; rm -f {tmp}")
    eid = json.loads(call(f"/api/endpoints/{ep}/docker/containers/production-booking-app/exec",
                          {"AttachStdout": True, "AttachStderr": True, "Tty": True, "Cmd": ["sh", "-c", sh]}).read())["Id"]
    raw = call(f"/api/endpoints/{ep}/docker/exec/{eid}/start", {"Detach": False, "Tty": True}).read().decode("utf-8", "replace")
    # split("\n") ไม่ใช่ splitlines(): splitlines ตัดที่ U+2028/U+0085/\x1c… ด้วย — ข้อมูล prod มี U+2028 อยู่ 1 ตัว
    # = JSON ขาดกลางบรรทัด → tuy-digest ล้มถาวรตั้งแต่ 11 พ.ย. 2569 17:30 ("Unterminated string") · Tty ให้ \r\n → rstrip("\r")
    line = next((l.rstrip("\r") for l in raw.split("\n") if l.startswith("OUT>")), None)
    if line is None:
        raise RuntimeError(f"คอนเทนเนอร์ไม่ตอบผลการตรวจ: {raw[-200:]!r}")
    d = json.loads(line[4:])
    if "error" in d:
        raise RuntimeError(f"ตรวจไม่สำเร็จ: {d['error'][:200]}")
    return d


def judge(exp, d, now):
    """ตัวตัดสิน (pure — เทสต์ใน --self-test) · d = ผลจาก probe() · คืน (status, ข้อความ)
    status: 'ok' | 'fail' | 'pending' (ยังไม่มีแถว audit ก่อน deadline) | 'missing' (เลย deadline ยังไม่มีแถว)"""
    since = datetime.fromisoformat(exp["since"])
    rows = d.get("audit") or []
    if not rows:
        if now >= datetime.fromisoformat(exp["deadline"]):
            return "missing", (f"⚠️ landing v1.285: ไม่พบแถว audit `{exp['action']}` หลัง {since.astimezone(BKK):%d/%m %H:%M} "
                               f"จนถึง {now.astimezone(BKK):%H:%M} — worker ไม่รันหรือรันไม่จบ · ตรวจ container log ของ worker")
        return "pending", ""
    problems, notes = [], []
    last = rows[-1].get("changes") or {}
    errs = {k: last.get(k) for k in ("removeErrors", "createErrors", "errors") if last.get(k)}
    if errs:
        problems.append(f"รอบนี้มี error {errs}")

    def trashed_after(f):
        t = f.get("trashedTime")
        return bool(f.get("trashed") and t and datetime.fromisoformat(t.replace("Z", "+00:00")) >= since)

    for code in exp["trashed"]:
        fs = d["folders"].get(code) or []
        live = [f for f in fs if not f["trashed"]]
        if live:
            problems.append(f"{code}: ยังมีโฟลเดอร์ live {len(live)} ตัว (ควรถูกทิ้ง)")
        elif not any(trashed_after(f) for f in fs):
            problems.append(f"{code}: ไม่มี live แต่ก็ไม่เจอตัวที่ถูกทิ้งหลังรอบเริ่ม (หายไปทางอื่น/ไม่เคยมี?)")
        else:
            notes.append(code)
    for code in exp["kept"]:
        fs = d["folders"].get(code) or []
        live = [f for f in fs if not f["trashed"]]
        if any(trashed_after(f) for f in fs):
            problems.append(f"🔴 {code}: ถูกทิ้งในรอบนี้ทั้งที่กล่องยังไม่มีเสียง (ควรรอด)")
        elif not live:
            problems.append(f"{code}: ไม่พบโฟลเดอร์ live (ควรยังอยู่)")
    if problems:
        return "fail", "⚠️ landing v1.285 ตรวจผลรอบ " + since.astimezone(BKK).strftime("%d/%m") + " ไม่ผ่าน:\n" + "\n".join("  • " + p for p in problems)
    return "ok", (f"✅ landing v1.285 รอบ {since.astimezone(BKK):%d/%m}: ทิ้งแล้ว {len(notes)} ({', '.join(notes)}) · "
                  f"เก็บไว้ถูกต้อง {len(exp['kept'])} · แถว audit {len(rows)} · error 0 · ตรวจจาก Drive จริง")


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"done": {}}


def save_state(st):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


import time

# ── OUTBOX + SELF-FAIL (ก๊อปจาก probook-tuy-digest.py — README scripts/hermes ข้อ 4: รายงานที่ส่งไม่ออกต้องส่งซ้ำ) ──
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


OUTBOX_MAX_LINES = 60


def _ob_rounds(saved):
    """ไฟล์ OUTBOX → รอบที่ยังค้าง [{runAt, text}] · รูปเดิม {runAt, text} (ก่อน 17 พ.ย. 2569) = หนึ่งรอบ"""
    if isinstance(saved, dict) and isinstance(saved.get("rounds"), list):
        return [r for r in saved["rounds"] if isinstance(r, dict) and r.get("text")]
    if isinstance(saved, dict) and saved.get("text"):
        return [{"runAt": saved.get("runAt", "ก่อนหน้า"), "text": str(saved["text"])}]
    return []


def undelivered(job_name, outbox):
    """-> {"rounds": [...], "dropped": n} รอบที่ Hermes ยังส่งไม่ถึง · rounds ว่าง = ไม่มีอะไรค้าง
    (รอบก่อนส่งถึงแล้ว = ล้างไฟล์ทิ้งที่นี่)"""
    if not _delivery_error(job_name):
        if os.path.exists(outbox):
            try:
                os.remove(outbox)   # ถึงมือแล้ว
            except Exception:
                pass
        return {"rounds": [], "dropped": 0}
    saved = _ob_read(outbox)
    dropped = saved.get("dropped") if isinstance(saved, dict) else 0
    return {"rounds": _ob_rounds(saved), "dropped": dropped if isinstance(dropped, int) else 0}


def resend_lines(carried):
    """บรรทัดส่งซ้ำ — รอบละหนึ่งบล็อก เก่าไปใหม่ ไม่ซ้อนกัน · รอบที่ถูกตัดทิ้ง = บอกจำนวนและที่อ่านฉบับเต็ม"""
    out = []
    if carried["rounds"] and carried.get("dropped"):
        out.append(f"📮 รายงานเก่าที่ส่งไม่ออกอีก {carried['dropped']} รอบถูกตัดทิ้ง (เพดาน {OUTBOX_MAX_LINES} บรรทัด) — "
                   "ฉบับเต็มอยู่ใน ~/.hermes/cron/output/")
    for r in carried["rounds"]:
        out += [f"📮 ส่งซ้ำ — รายงานรอบ {r.get('runAt', 'ก่อนหน้า')} ส่งไม่ออก", *str(r["text"]).splitlines(),
                "— จบรายงานที่ส่งซ้ำ —", ""]
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
# ห้าม "ข้ามเงียบ" แทนการรอ: Hermes เขียน last_delivery_error ทับทุกรอบ รอบที่ไม่มีอะไรส่งจะลบร่องรอยว่ารอบก่อน
# ส่งไม่ออก แล้ว OUTBOX ถูกลบทิ้ง · ไม่แน่ใจ (ไม่มี pmset / อ่านไม่ออก) = ถือว่าตื่น ทำงานตามปกติ ห้ามเงียบเพราะเดา
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


def await_full_wake(cap_s=1800, dns_s=60, _dark=None, _sleep=time.sleep, _now=time.monotonic, _resolve=socket.getaddrinfo):
    """บล็อกจนแมคตื่นจริง แล้วรอ DNS อีกไม่เกิน dns_s วิ (แมคเพิ่งตื่น = DNS ยังไม่มา 10–60 วิ) · เพดาน cap_s นับ
    monotonic = นาฬิกาเดียวกับ timeout 3600 วิ ของ Hermes (ไม่เดินตอนหลับ) · เกินเพดาน/DNS ไม่มา = ทำงานต่อเลย
    ให้ทางล้มเดิมของสคริปต์ดังเอง ดีกว่าโดน Hermes ฆ่ากลางทาง · _dark/_sleep/_now/_resolve = ของปลอมใน self-test"""
    dark = _dark or dark_wake
    t0 = _now()
    while dark() and _now() - t0 < cap_s:
        _sleep(3)
    t1 = _now()
    while True:
        try:
            _resolve("google.com", 443)
            return
        except OSError:
            if _now() - t1 >= dns_s:
                return
            _sleep(2)


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
# ⚠️ แก้ 11 พ.ย. 2569 — ความเชื่อเดิมตรงนี้ ("scheduler.py:3660 ยัง append stdout … คนอ่านได้เนื้อรายงานครบ") ผิด
# (ตรวจกับ ~/.hermes/hermes-agent/cron/scheduler.py ที่ติดตั้งอยู่): 3660 แค่ประกอบ error ภายใน ส่วนตอนส่ง (~6420)
# รอบที่ exit ≠ 0 ได้ _summarize_cron_failure_for_delivery() แทน stdout — "Script exited with code 1 stdout: …"
# ยุบช่องว่าง/ขึ้นบรรทัดเหลือช่องเดียว เกิน 180 ตัวตัดเหลือ 177 + "..." (มี stderr = มาก่อน stdout กินที่อีก)
# ฉบับเต็มอยู่แค่ ~/.hermes/cron/output/<job-id>/ · ข้อความสั้นนั้นส่งถึง → last_delivery_error ว่าง → OUTBOX ล้าง
# ทิ้งรอบหน้า → ส่วนที่ถูกตัดหายถาวร (เกิดจริง: landing 4 ต.ค. รายงานส่งซ้ำ + dry-run ล้ม ถึงห้องแค่ต้นบรรทัดแรก)
# กฎ (exit_plan): exit 1 เฉพาะเมื่อ stdout *ทั้งก้อน* รอดการตัด (ที่ว่างให้ stdout ~146 ตัว) · ยาวกว่านั้น = exit 0
# + บรรทัด ‼️ นำหน้า ให้รายงานถึงครบ (แลกกับที่รอบนั้น Hermes ไม่นับ failure_streak) · ข้อความ self_fail เดี่ยว ๆ
# จึงต้องสั้นพอ (ตัด detail) — --self-test ล็อกไว้ · ซ้ำทุกสคริปต์โดยเจตนา (เหตุผลเดียวกับบล็อก OUTBOX)
def hermes_fail_view(stdout):
    """-> (ข้อความที่ห้อง Discord ได้จริงถ้ารอบนี้ exit 1, ได้ครบทั้งก้อนไหม) · จำลองตอน stderr ว่าง"""
    s = " ".join(f"Script exited with code 1\nstdout:\n{stdout}".split())
    return (s, True) if len(s) <= 180 else (s[:177].rstrip() + "...", False)


def exit_plan(payload):
    """-> (stdout ที่จะพิมพ์, exit code) — ที่เดียวที่ตัดสิน exit code ของรอบ (OUTBOX เก็บแค่เนื้อรายงานของรอบ — ไม่ใช่สิ่งที่คืนจากที่นี่)"""
    if not _SELF_FAIL:
        return payload, 0
    if hermes_fail_view(payload)[1]:
        return payload, 1
    why = ", ".join(dict.fromkeys(_SELF_FAIL))
    return f"‼️ {JOB_NAME} ทำงานไม่สำเร็จรอบนี้ ({why}) — รายงานเต็มข้างล่าง\n{payload}", 0


_SELF_FAIL = []


def self_fail(reason=""):
    """ทำเครื่องหมายว่ารอบนี้ 'เราทำงานไม่สำเร็จ' — exit_plan() ตัดสิน exit code (1 = ข้อความสั้นพอ)"""
    _SELF_FAIL.append(reason or "self-failure")

OUTBOX = os.path.expanduser("~/.hermes/state/probook/outbox-landing-v1285-check.json")
JOB_NAME = "probook-landing-v1285-check"


_TO_MARK = {}


def main(dry_run=False):
    now = datetime.now(timezone.utc)
    st = load_state()
    todo = [x for x in EXPECT if x["id"] not in st["done"] and (dry_run or now >= datetime.fromisoformat(x["due"]))]
    if not todo:
        return                                     # ครบแล้วหรือยังไม่ถึงเวลา = เงียบ ไม่แตะเครือข่าย
    for exp in todo:
        try:
            d = probe(exp)
        except Exception as e:                     # อ่านไม่ได้ ≠ ผ่าน: ตะโกน แล้ว tick หน้าลองใหม่ (ไม่ mark done)
            # สั้นพอให้ exit 1 ส่งครบ (exit_plan) — ข้อความเต็มอยู่ใน ~/.hermes/cron/output/
            print(f"⚠️ landing v1.285 ({exp['id']}): ตรวจไม่ได้ จะลองใหม่ tick หน้า — {(type(e).__name__ + ': ' + str(e))[:60]}")
            self_fail("probe failed")              # เราเองตรวจไม่ได้ → exit 1 ให้ Hermes นับ streak
            continue
        status, text = judge(exp, d, now)
        if dry_run:
            print(f"[dry-run {exp['id']}] {status}: {text or '(รอแถว audit)'}")
            continue
        if status == "pending":
            continue
        print(text)
        # "done" is written only in the epilogue, AFTER the verdict is in the OUTBOX and printed: a kill between
        # here and there must not leave the expectation done with nobody told (review r2, reproduced with os._exit)
        _TO_MARK[exp["id"]] = {"status": status, "at": now.isoformat()}
        # ผลตรวจ "ไม่ผ่าน" = ข้อค้นพบที่ prod (สคริปต์ทำงานสำเร็จ) → ไม่ self-fail · ถ้าส่งไป Discord ไม่ถึง OUTBOX ส่งซ้ำรอบหน้า


def self_test():
    """ข้อมูลปลอม — ล็อกว่าตัวตัดสินจับ 'ถูกทิ้งผิด' / 'ยังไม่ทิ้ง' / 'ไม่มีแถว' / 'error' ได้"""
    exp = {"id": "t", "action": "drive.landing_lifecycle", "since": "2026-11-11T19:00:00+07:00",
           "due": "2026-11-11T19:25:00+07:00", "deadline": "2026-11-11T20:30:00+07:00", "trashed": ["T-1", "T-2"], "kept": ["K-1"]}
    at = datetime(2026, 11, 11, 19, 30, tzinfo=BKK)
    row = {"at": "2026-11-11T12:11:00Z", "changes": {"removedPastEmpty": 2, "removeErrors": 0, "createErrors": 0}}
    gone = lambda: [{"id": "x", "trashed": True, "trashedTime": "2026-11-11T12:11:30Z"}]
    live = lambda: [{"id": "y", "trashed": False, "trashedTime": None}]
    ok = {"audit": [row], "folders": {"T-1": gone(), "T-2": gone(), "K-1": live()}}
    assert judge(exp, ok, at)[0] == "ok", judge(exp, ok, at)
    # ตัวที่ควรทิ้งยัง live
    s, t = judge(exp, {**ok, "folders": {**ok["folders"], "T-2": live()}}, at)
    assert s == "fail" and "T-2" in t, t
    # ถูกทิ้งผิด (ควรรอด)
    s, t = judge(exp, {**ok, "folders": {**ok["folders"], "K-1": gone()}}, at)
    assert s == "fail" and "🔴 K-1" in t, t
    # ถูกทิ้งก่อนรอบเริ่ม ไม่นับว่าเป็นผลของรอบนี้
    old = [{"id": "z", "trashed": True, "trashedTime": "2026-11-09T05:00:00Z"}]
    s, t = judge(exp, {**ok, "folders": {**ok["folders"], "T-1": old}}, at)
    assert s == "fail" and "T-1" in t, t
    # error ในแถว audit
    bad = {**ok, "audit": [{"at": row["at"], "changes": {"removeErrors": 1}}]}
    assert judge(exp, bad, at)[0] == "fail"
    # ยังไม่มีแถว: ก่อน deadline = pending · เลย = missing
    assert judge(exp, {"audit": [], "folders": {}}, at)[0] == "pending"
    assert judge(exp, {"audit": [], "folders": {}}, datetime(2026, 11, 11, 21, 0, tzinfo=BKK))[0] == "missing"
    # ไม่เจอโฟลเดอร์เลย (ไม่ live ไม่ถังขยะ) ≠ ผ่าน
    s, t = judge(exp, {**ok, "folders": {**ok["folders"], "T-1": []}}, at)
    assert s == "fail" and "T-1" in t, t

    # ── ตัวอ่านผลจากคอนเทนเนอร์: ข้อมูลมี U+2028 (เกิดจริง 11 พ.ย. 2569) ต้องอ่านออก — splitlines() ตัด JSON ขาดกลาง ──
    import io as _io

    class _Resp(_io.BytesIO):
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
    _real_urlopen, _real_env = urllib.request.urlopen, read_env

    def _fake_portainer(raw):
        def urlopen(req, timeout=None):
            assert req.full_url.startswith("https://selftest.invalid/"), f"self-test เกือบยิงเน็ตจริง: {req.full_url}"
            return _Resp(b'{"Id": "e1"}' if req.full_url.endswith("/exec") else raw.encode())
        return urlopen
    globals()["read_env"] = lambda p: {"PORTAINER_URL": "https://selftest.invalid", "PORTAINER_API_KEY": "k"}
    data = {"audit": [row], "folders": {"T-1": [{"id": "x", "name": "งาน\u2028ทดสอบ (T-1)", "trashed": True, "trashedTime": None}]}}
    urllib.request.urlopen = _fake_portainer("OUT>" + json.dumps(data, ensure_ascii=False) + "\r\n")
    assert probe(exp) == data, "U+2028 ในชื่อโฟลเดอร์ต้องไม่ทำให้ JSON ขาด"
    urllib.request.urlopen, globals()["read_env"] = _real_urlopen, _real_env

    # ── exit code ↔ สิ่งที่ห้องได้จริง (exit_plan) — ทางจริง main()+run_once() ด้วยของปลอม ไม่แตะ prod ──
    import tempfile
    g, tmp, real_main = globals(), tempfile.mkdtemp(prefix="v1285-selftest-"), main
    g.update(STATE=os.path.join(tmp, "s.json"), OUTBOX=os.path.join(tmp, "ob.json"), HERMES_JOBS=os.path.join(tmp, "jobs.json"))
    past = {**exp, "since": "2026-11-01T19:00:00+07:00", "due": "2026-11-01T19:25:00+07:00", "deadline": "2026-11-01T20:30:00+07:00"}
    wrong = [{"id": "w", "trashed": True, "trashedTime": "2026-11-01T12:11:30Z"}]   # K-1 ถูกทิ้งในรอบนี้ = ผล 🔴

    def fake_probe(e):
        if e["id"] == "down":
            raise RuntimeError("คอนเทนเนอร์ไม่ตอบผลการตรวจ: " + "x" * 300)
        return {"audit": [row], "folders": {"T-1": gone(), "T-2": gone(), "K-1": wrong}}
    g["probe"] = fake_probe

    def must_reach(essential, out, code):   # exit 1 = ห้องได้แค่ hermes_fail_view() → ทั้งก้อนต้องรอด
        view, whole = hermes_fail_view(out)
        assert code == 1 and whole and all(e in view for e in essential), (code, view)

    def reaches(essential, out, code):      # สิ่งที่ห้องได้จริง: exit 1 = hermes_fail_view() · exit 0 = ทั้งก้อน
        got = hermes_fail_view(out)[0] if code else out
        assert all(e in got for e in essential), (code, got)

    def run(expects, delivery_err=None):
        _SELF_FAIL.clear()
        _TO_MARK.clear()
        g["EXPECT"] = expects
        _ob_write(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": delivery_err}]})
        return run_once()

    must_reach(["ตรวจไม่ได้", "tick หน้า"], *run([{**past, "id": "down"}]))
    # ผล "ไม่ผ่าน" ของรอบหนึ่ง + อีกรอบอ่านไม่ได้: exit 1 จะตัดผลทิ้ง แล้ว epilogue mark done = ไม่มีวันรายงานซ้ำ → exit 0 + ‼️
    out, code = run([{**past, "id": "judged"}, {**past, "id": "down"}])
    assert code == 0 and out.startswith("‼️") and "🔴 K-1" in out and "ตรวจไม่ได้" in out and "judged" in _TO_MARK, (code, out)
    g["main"] = lambda: {}["k" * 300]
    must_reach(["พังกลางคัน", "KeyError"], *run([]))

    # ── OUTBOX ไม่ซ้อนชั้น (14–17 พ.ย. 2569: 3 คืนส่งไม่ออก → รายงานห่อกันเป็นชั้น ๆ 3 ชั้น) ──
    os.remove(OUTBOX)
    for _ in range(4):                   # พังทุกรอบ และทุกรอบ Hermes ส่งไม่ออก
        out, code = run([], "DNS")
    saved = _ob_read(OUTBOX)
    assert len(saved["rounds"]) == 4 and not any("📮" in r["text"] or "‼️" in r["text"] for r in saved["rounds"]), saved
    assert out.count("📮 ส่งซ้ำ") == 3 and out.count("พังกลางคัน") == 4 and out.count("‼️") == 1, out
    out, code = run([], None)            # รอบก่อนส่งถึง → ไม่ส่งซ้ำ เหลือแค่ของรอบนี้
    assert "📮" not in out and len(_ob_read(OUTBOX)["rounds"]) == 1, out
    # รูปไฟล์เดิม (ก่อน 17 พ.ย.) ยังส่งซ้ำได้หนึ่งครั้ง ไม่หาย
    _ob_write(OUTBOX, {"runAt": "2026-11-16 03:15", "text": "⚠️ OLD-FORMAT"})
    out, code = run([], "DNS")
    assert out.count("📮 ส่งซ้ำ — รายงานรอบ 2026-11-16 03:15") == 1 and "⚠️ OLD-FORMAT" in out, out
    # ผลตรวจจริง (judged ‼️ ปน down) ส่งไม่ออก → ที่เก็บคือเนื้อรายงานเปล่า ๆ ไม่มีหัว ‼️ · รอบหน้าส่งซ้ำครั้งเดียว
    g["main"] = real_main
    os.remove(OUTBOX)
    out, code = run([{**past, "id": "judged"}, {**past, "id": "down"}], "DNS")
    (r1,) = _ob_read(OUTBOX)["rounds"]
    assert out.startswith("‼️") and "‼️" not in r1["text"] and "🔴 K-1" in r1["text"] and "ตรวจไม่ได้" in r1["text"], r1
    out, code = run([{**past, "id": "down"}], "DNS")
    assert out.count("📮 ส่งซ้ำ") == 1 and out.count("🔴 K-1") == 1 and out.count("‼️") == 1, out
    # รอบนี้ไม่มีอะไรของตัวเอง (ครบแล้ว/ยังไม่ถึงเวลา = เงียบ) แต่ยังมีรอบค้าง → ไฟล์ต้องเก็บรอบค้างไว้ เผื่อส่งซ้ำไม่ออกอีก
    _ob_write(OUTBOX, {"rounds": [{"runAt": "2026-11-16 19:25", "text": "⚠️ CARRIED"}], "dropped": 0})
    out, code = run([], "DNS")
    assert code == 0 and out.count("📮 ส่งซ้ำ — รายงานรอบ 2026-11-16 19:25") == 1 and "⚠️ CARRIED" in out, out
    assert _ob_read(OUTBOX) == {"rounds": [{"runAt": "2026-11-16 19:25", "text": "⚠️ CARRIED"}], "dropped": 0}, _ob_read(OUTBOX)
    out, code = run([], "DNS")           # ส่งซ้ำก็ไม่ออกอีก → ยังส่งซ้ำ (ครั้งเดียว ไม่ซ้อน)
    assert out.count("📮 ส่งซ้ำ") == 1 and out.count("⚠️ CARRIED") == 1, out
    out, code = run([], None)            # ถึงแล้ว → ล้างไฟล์ ไม่มีอะไรพิมพ์
    assert out == "" and code == 0 and not os.path.exists(OUTBOX), (out, code)
    # เพดาน 60 บรรทัด: ทิ้งรอบเก่าสุดแล้ว *บอก* · รอบเดียวยาวเกิน = ตัดท้ายพร้อมบอก
    g["main"] = lambda: print("\n".join(f"บรรทัด {i}" for i in range(25)))
    for _ in range(3):
        run([], "DNS")
    saved = _ob_read(OUTBOX)
    assert len(saved["rounds"]) == 2 and saved["dropped"] == 1, saved
    out, code = run([], "DNS")
    assert "อีก 1 รอบถูกตัดทิ้ง" in out and out.count("📮 ส่งซ้ำ") == 2, out
    os.remove(OUTBOX)
    g["main"] = lambda: print("\n".join(f"บรรทัด {i}" for i in range(80)))
    run([], "DNS")
    (only,) = _ob_read(OUTBOX)["rounds"]
    assert only["text"].count("\n") == OUTBOX_MAX_LINES and "ตัดอีก 20 บรรทัด" in only["text"], only
    g["main"] = real_main

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
    await_full_wake(_dark=lambda: next(states), _sleep=tick, _now=lambda: clock[0], _resolve=lambda h, p: hits.append(h))
    assert clock[0] == 9 and hits == ["google.com"], (clock, hits)   # รอข้าม 3 DarkWake แล้วทำงาน
    clock[0], tries = 0.0, [0]

    def flaky(h, p):
        tries[0] += 1
        if tries[0] < 3:
            raise OSError("nodename nor servname provided")
    await_full_wake(_dark=lambda: False, _sleep=tick, _now=lambda: clock[0], _resolve=flaky)
    assert tries[0] == 3 and clock[0] == 4, (tries, clock)          # ตื่นแล้วแต่ DNS ยังไม่มา = รอ
    clock[0] = 0.0

    def dead(h, p):
        raise OSError("down")
    await_full_wake(cap_s=30, dns_s=10, _dark=lambda: True, _sleep=tick, _now=lambda: clock[0], _resolve=dead)
    assert 30 <= clock[0] <= 45, clock                              # หลับเกินเพดาน/DNS ไม่มา = ทำงานต่อ ไม่ค้าง
    entry = open(__file__, encoding="utf-8").read().split('if __name__ == "__main__":')[-1]
    assert 0 <= entry.find("await_full_wake()") < entry.find("run_once()"), "ทางจริงต้องรอแมคตื่นก่อน run_once()"
    # --self-test / --dry-run (คนสั่งเอง) ไม่รอ: ทั้งสองทางต้องออกไปก่อนถึง await_full_wake()
    assert 0 <= entry.find("self_test()") < entry.find("main(dry_run=True)") < entry.find("await_full_wake()"), entry
    # ทางจริงเรียก await_full_wake() *ครั้งเดียว* ในบล็อก __main__ เท่านั้น — ไม่ใช่คอมเมนต์ (ตรวจข้อความหลุด)
    # และไม่อยู่ในฟังก์ชันที่ self-test เรียก (เทสต์ต้องไม่แตะ pmset/DNS จริง) · ตัวปลอมในเทสต์ส่ง keyword เสมอ
    import ast
    _tree = ast.parse(open(__file__, encoding="utf-8").read())
    _real = [n for n in ast.walk(_tree) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "await_full_wake"
             and not n.args and not n.keywords]
    _entry = [n for n in _tree.body if isinstance(n, ast.If) and "__main__" in ast.dump(n.test)]
    assert len(_entry) == 1 and len(_real) == 1 and any(n is _real[0] for n in ast.walk(_entry[0])), \
        "await_full_wake() ต้องถูกเรียกครั้งเดียวบนทางจริงในบล็อก __main__"
    # เพดาน OUTBOX ทิ้ง *รอบเก่าสุด* ก่อน (ไม่ใช่ใหม่สุด) และนับรวมกับที่เคยทิ้ง
    import tempfile as _tf
    _p, _h = os.path.join(_tf.mkdtemp(prefix="ob-cap-"), "ob.json"), OUTBOX_MAX_LINES // 2
    remember_report(_p, {"rounds": [{"runAt": "r1", "text": "\n".join(["OLD"] * _h)},
                                    {"runAt": "r2", "text": "\n".join(["MID"] * _h)}], "dropped": 2}, "\n".join(["NEW"] * _h))
    _s = _ob_read(_p)
    assert [r["runAt"] for r in _s["rounds"]][0] == "r2" and _s["rounds"][-1]["text"].startswith("NEW") and _s["dropped"] == 3, _s
    print("self-test ok")

def run_once():
    """main() + epilogue (OUTBOX + exit_plan) -> (stdout, exit code) · __main__ และ --self-test ใช้ตัวเดียวกัน"""
    import contextlib
    import io

    buf, crash = io.StringIO(), None
    try:
        with contextlib.redirect_stdout(buf):
            main()
    except SystemExit:
        pass
    except Exception as e:  # พังกลางคัน = แจ้งคน ไม่ใช่หายไปใน stderr · [:70] = สั้นพอให้ exit 1 ส่งครบ
        self_fail("crash")
        crash = f"⚠️ {JOB_NAME} พังกลางคัน: {type(e).__name__}: {str(e)[:70]}"
    report = buf.getvalue().rstrip("\n")
    if crash:
        report = (report + "\n" + crash).strip()

    # ลำดับสำคัญ: อ่าน+ล้าง outbox ของรอบก่อนให้เสร็จ แล้วจึงเขียนของรอบนี้ทับ
    carried = undelivered(JOB_NAME, OUTBOX)
    payload, code = exit_plan("\n".join(resend_lines(carried) + ([report] if report else [])))
    remember_report(OUTBOX, carried, report)   # เนื้อรอบนี้เท่านั้น — ไม่ใช่ payload (ซ้อนชั้น 14–17 พ.ย.)
    return payload, code


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
        sys.exit(0)
    if "--dry-run" in sys.argv:
        main(dry_run=True)
        sys.exit(1 if _SELF_FAIL else 0)
    await_full_wake()   # Hermes ยิงงานตอน DarkWake ได้ — รอเครื่องตื่นจริงก่อน (ดูบล็อก DARKWAKE)
    out, code = run_once()
    if out:
        print(out)
    sys.stdout.flush()
    if _TO_MARK:
        _st = load_state()
        _st["done"].update(_TO_MARK)
        save_state(_st)
    sys.exit(code)
