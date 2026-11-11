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
อ่าน prod/Drive ไม่ได้ = ⚠️ + exit 1 แล้วลองใหม่ tick หน้า · ส่ง Discord ไม่ถึง = OUTBOX พิมพ์ซ้ำรอบหน้า ·
บันทึก "done" หลังผลถูกเก็บลง OUTBOX และพิมพ์ออกแล้วเท่านั้น
ครบทุก expectation แล้ว = เงียบถาวร ไม่แตะเครือข่าย (ลบ job ได้: hermes cron remove <id>)

  python3 probook-landing-v1285-check.py              # รันจริง (Hermes เรียกแบบนี้)
  python3 probook-landing-v1285-check.py --dry-run    # ตรวจจริงทุกขั้นแต่ไม่เขียน state และข้ามเงื่อนไขเวลา (due/deadline)
  python3 probook-landing-v1285-check.py --self-test  # ตัวตัดสินด้วยข้อมูลปลอม ไม่แตะ prod
"""
import base64
import json
import os
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
    line = next((l for l in raw.splitlines() if l.startswith("OUT>")), None)
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
# ⚠️ แก้ 11 พ.ย. 2569 (ตรวจกับ Hermes ที่ติดตั้งอยู่): รอบที่ exit ≠ 0 ไม่ได้ส่ง stdout เต็ม — scheduler.py:6420 ส่ง
# _summarize_cron_failure_for_delivery() ซึ่งตัดเหลือ ~177 ตัวอักษร (ฉบับเต็มอยู่แค่ใน ~/.hermes/cron/output/) และการส่ง
# สรุปนั้นสำเร็จ = last_delivery_error ว่าง = OUTBOX ไม่ส่งซ้ำ · สคริปต์นี้จึง exit 1 เฉพาะเมื่อข้อความสั้นอยู่แล้ว
# (อ่านระบบไม่ได้/พังกลางคัน) ส่วนข้อความยาวที่คนต้องอ่านครบ = exit 0 แล้วพูดดัง ๆ ในข้อความเอง
_SELF_FAIL = []


def self_fail(reason=""):
    """ทำเครื่องหมายว่ารอบนี้ 'เราทำงานไม่สำเร็จ' — epilogue จะ exit 1"""
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
            print(f"⚠️ landing v1.285 ({exp['id']}): ตรวจไม่ได้ — {type(e).__name__}: {str(e)[:160]} · จะลองใหม่ tick หน้า")
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
    print("self-test ok")

if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
        sys.exit(0)
    if "--dry-run" in sys.argv:
        main(dry_run=True)
        sys.exit(1 if _SELF_FAIL else 0)
    import contextlib
    import io as _io

    _buf = _io.StringIO()
    _crash = None
    try:
        with contextlib.redirect_stdout(_buf):
            main()
    except SystemExit:
        pass
    except Exception as _e:  # พังกลางคัน = แจ้งคน ไม่ใช่หายไปใน stderr
        self_fail("crash")
        _crash = f"⚠️ {JOB_NAME} พังกลางคัน: {type(_e).__name__}: {str(_e)[:200]}"

    _report = _buf.getvalue().rstrip("\n")
    if _crash:
        _report = (_report + "\n" + _crash).strip()

    # ลำดับสำคัญ: อ่าน+ล้าง outbox ของรอบก่อนให้เสร็จ แล้วจึงเขียนของรอบนี้ทับ
    _resend = undelivered_lines(JOB_NAME, OUTBOX)
    _payload = "\n".join(_resend + ([_report] if _report else []))
    remember_report(OUTBOX, "\n".join(_payload.splitlines()[:60]))

    if _payload:
        print(_payload)
    sys.stdout.flush()
    if _TO_MARK:
        _st = load_state()
        _st["done"].update(_TO_MARK)
        save_state(_st)
    if _SELF_FAIL:
        sys.exit(1)
