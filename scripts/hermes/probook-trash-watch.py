#!/usr/bin/env python3
"""probook-trash-watch — เฝ้าถังขยะไดรฟ์ฟุตเทจ (อ่านอย่างเดียว) · Hermes cron ทุก 15 นาที → ห้อง Discord hermes-agent

ที่มา: นัท 11 ต.ค. 2569 "ตั้งตัวเฝ้าเลย" — แทนการลดสิทธิ์ napat.p บนไดรฟ์กล่อง (นัทเลือกไม่ลด)
ตลอด 30 ก.ย.–8 ต.ค. มีโฟลเดอร์การ์ดทั้งใบถูกทิ้งลงถังโดยไม่มีใครรู้จนฟุตเทจเหลือแต่ในถัง (และถัง Production Team
เคยถูกล้างถาวร 3 ต.ค.) — ตัวนี้ทำให้ "ทิ้งของที่มีฟุตเทจ" มีคนเห็นภายใน 15 นาที

วิธี (ทำในคอนเทนเนอร์แอปผ่าน Portainer exec — สิทธิ์ service account เดียวกับแอป, ไม่มี write call ใด ๆ):
  1. Drive Changes API ต่อไดรฟ์ (pageToken เก็บใน state) → รายการที่ถูกทิ้งตรง ๆ (explicitlyTrashed) ตั้งแต่รอบก่อน
  2. ไล่ทุกไฟล์ข้างใต้ (รวมที่อยู่ในถังอยู่แล้ว) · ข้อมูล = >0 ไบต์ ไม่ใช่ .DS_Store/_SHOOT*/_DiskStation_
  3. แต่ละไฟล์: มีสำเนา md5 เดียวกันที่ยังไม่อยู่ในถัง (ไม่มีบรรพบุรุษอยู่ในถัง) ไหม — ค้นด้วยชื่อ (ชื่อเดิม + ชื่อที่ตัด " (n)")
     ไม่มี md5 ตรง แต่มีไฟล์ชื่อเดียวกันที่ใหญ่กว่า = ตัวอัปไม่จบ (ตัวเต็มยังอยู่) → ไม่ถือว่าหาย
  4. 🔴 = มีข้อมูลที่ไม่เหลือสำเนานอกถัง · 🟡 = ทิ้งของที่มีฟุตเทจ (ยังมีสำเนา) ≥ 50 MB · ไม่มีอะไรน่ารู้ = stdout ว่าง = ไม่มีข้อความ

ความล้มเหลวของตัวเอง (Portainer/DNS/คอนเทนเนอร์รีสตาร์ต) → exit 1 ให้ Hermes นับ streak · พิมพ์เตือนเฉพาะรอบแรกของ streak
และตอนกลับมาได้ · pageToken เลื่อนเฉพาะเมื่อประมวลผลสำเร็จ — รอบที่ล้มไม่ทำให้เหตุการณ์หาย
(รอบที่ล้มระหว่างนั้น stdout ว่างแต่ exit 1 — Hermes ยังส่ง "failed: Script exited with code 1" ทุกรอบเอง)
รายงานที่ส่งไม่ออก (last_delivery_error ของ job) ถูกส่งซ้ำรอบถัดไป · exit 1 ส่งถึงห้องได้แค่ ~146 ตัว (hermes_fail_view)
→ รอบที่ล้มพร้อมรายงานส่งซ้ำค้าง (🔴) = exit 0 + ‼️ นำหน้าให้ถึงครบ
Self-check ไม่แตะ Portainer/Drive: python3 probook-trash-watch.py --self-test
"""
import base64, json, os, re, socket, subprocess, sys, time, urllib.request

ENV_FILE = os.path.expanduser("~/.hermes/scripts/probook.env")
STATE = os.path.expanduser("~/.hermes/state/probook/trash-watch.json")
OUTBOX = os.path.expanduser("~/.hermes/state/probook/outbox-trash-watch.json")
HERMES_JOBS = os.path.expanduser("~/.hermes/cron/jobs.json")
JOB_NAME = "probook-trash-watch"
DRIVES = {"0AH7f4FZNrHsOUk9PVA": "กล่อง Video", "0AGendsFHFQYKUk9PVA": "Production Team"}
YELLOW_MIN_BYTES = 50 * 1024 * 1024

JS = r"""
const { google } = require('googleapis')
const creds = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n') }
const auth = new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: ['https://www.googleapis.com/auth/drive'], subject: process.env.GOOGLE_IMPERSONATE_SUBJECT || undefined })
const drive = google.drive({ version: 'v3', auth })
const IN = JSON.parse(require('fs').readFileSync(process.env.TW_IN, 'utf8'))
const FOLDER = 'application/vnd.google-apps.folder'
const CONF = /(?: \(\d+\))+(?=(?:\.[^.]*)?$)/
// SALVAGE.TMP = Sony card scratch buffer (same name on every card, not footage) → would raise a false 🔴 on every card trash
const JUNK = n => n === '.DS_Store' || /^_SHOOT\b/i.test(n) || /_DiskStation_/.test(n) || /^\._/.test(n) || /^SALVAGE( \(\d+\))*\.TMP$/i.test(n)
const CODE = /\(([A-Z]{2,4}(?:-[A-Z0-9]{2,6})?-\d{6}-\d{2})\)/
const sleep = ms => new Promise(r => setTimeout(r, ms))
const DEADLINE = Date.now() + 9 * 60 * 1000
async function retry(fn) { for (let i = 1; ; i++) { try { return await fn() } catch (e) { const c = e.code || e.response?.status; if (i < 5 && (c === 429 || c >= 500 || (c === 403 && /rate/i.test(e.message)))) { await sleep(2000 * i); continue } throw e } } }
const meta = {}
async function get(id) { if (!meta[id]) meta[id] = retry(() => drive.files.get({ fileId: id, fields: 'id,name,parents,trashed', supportsAllDrives: true })).then(r => r.data).catch(() => ({ id, name: '?', parents: [], trashed: false })); return meta[id] }
async function chain(id) { const out = []; for (let cur = id, i = 0; cur && i < 14; i++) { const m = await get(cur); out.unshift(m); cur = m.parents?.[0] } return out }
async function list(q) { const out = []; let t; do { const r = await retry(() => drive.files.list({ q, pageSize: 1000, pageToken: t, fields: 'nextPageToken,files(id,name,mimeType,size,md5Checksum,trashed,parents)', supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives' })); out.push(...r.data.files); t = r.data.nextPageToken } while (t); return out }
async function filesUnder(item) {
  if (item.mimeType !== FOLDER) return [{ ...item, rel: '' }]
  const out = [], q = [{ id: item.id, p: '' }]
  while (q.length && out.length < 3000 && Date.now() < DEADLINE) { const { id, p } = q.shift(); for (const c of await list(`'${id}' in parents`)) { if (c.mimeType === FOLDER) q.push({ id: c.id, p: p + '/' + c.name }); else out.push({ ...c, rel: p }) } }
  return out
}
async function listIn(q, driveId) { const out = []; let t; do { const r = await retry(() => drive.files.list({ q, pageSize: 1000, pageToken: t, fields: 'nextPageToken,files(id,name,size,md5Checksum,parents)', supportsAllDrives: true, includeItemsFromAllDrives: true, ...(driveId ? { corpora: 'drive', driveId } : { corpora: 'allDrives' }) })); out.push(...r.data.files); t = r.data.nextPageToken } while (t); return out }
// verdict for one trashed data file: 'twin' (same md5 live) · 'partial' (a bigger same-name file is live) · 'none'
// filter by md5/size FIRST and walk ancestors only for those, stopping at the first live one — generic names
// (MEDIAPRO.XML, CUEUP.XML …) match thousands of files and walking all of them was the whole run budget
async function verdict(f, driveId) {
  const names = [...new Set([f.name, f.name.replace(CONF, '')])]
  const q = n => `name = '${n.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`
  const isLive = async c => !(await chain(c.parents?.[0])).some(a => a.trashed)
  const firstLive = async cs => { for (const c of cs) if (await isLive(c)) return true; return false }
  const scan = async scope => {
    const cands = []
    for (const n of names) for (const c of await listIn(q(n), scope)) if (c.id !== f.id) cands.push(c)
    if (await firstLive(cands.filter(c => c.md5Checksum === f.md5Checksum))) return 'twin'
    if (await firstLive(cands.filter(c => +(c.size || 0) > +(f.size || 0)).sort((a, b) => +(b.size || 0) - +(a.size || 0)).slice(0, 5))) return 'partial'
    return 'none'
  }
  const own = await scan(driveId)
  if (own === 'twin' || +(f.size || 0) < 50 * 1024 * 1024) return own      // small sidecars: their twins live in the same drive
  const any = await scan(null)
  return any === 'none' ? own : any
}
;(async () => {
  const out = { tokens: {}, items: [], errors: [] }
  if (IN.testIds) {   // --test: evaluate given trashed items as if they were just trashed (no tokens, no state)
    IN.drives = []
    for (const id of IN.testIds) { const f = (await retry(() => drive.files.get({ fileId: id, supportsAllDrives: true, fields: 'id,name,mimeType,size,md5Checksum,trashed,explicitlyTrashed,trashedTime,trashingUser(emailAddress,displayName),parents,driveId' }))).data; IN._test = (IN._test || []).concat([f]) }
  }
  for (const f of IN._test || []) await evaluate(f, f.driveId)
  for (const driveId of IN.drives) {
    let token = IN.tokens[driveId]
    if (!token) { out.tokens[driveId] = (await retry(() => drive.changes.getStartPageToken({ driveId, supportsAllDrives: true }))).data.startPageToken; out.baseline = true; continue }
    const trashed = new Map()
    while (true) {
      const r = await retry(() => drive.changes.list({ driveId, pageToken: token, pageSize: 1000, includeItemsFromAllDrives: true, supportsAllDrives: true, includeRemoved: false,
        fields: 'nextPageToken,newStartPageToken,changes(fileId,file(id,name,mimeType,size,md5Checksum,trashed,explicitlyTrashed,trashedTime,trashingUser(emailAddress,displayName),parents))' }))
      for (const c of r.data.changes || []) { const f = c.file; if (f && f.trashed && f.explicitlyTrashed && !(IN.seen || []).includes(f.id + '|' + f.trashedTime)) trashed.set(f.id, f) }
      if (r.data.nextPageToken) token = r.data.nextPageToken
      else { out.tokens[driveId] = r.data.newStartPageToken; break }
    }
    // เก่าก่อน และหยุดเมื่อหมดงบเวลา — ทำไม่ทัน = ไม่เลื่อน token ของไดรฟ์นี้ รอบหน้าข้ามรายการที่ทำแล้ว (seen) แล้วทำต่อ
    // (17–19 ต.ค. 2569: backlog ~800 รายการ ทำไม่จบใน 14 นาที → docker_exec timeout → token ไม่เลื่อน → เริ่มใหม่หมดทุกรอบ ล้ม 71 รอบติด)
    const todo = [...trashed.values()].sort((a, b) => (a.trashedTime || '').localeCompare(b.trashedTime || ''))
    let done = 0
    for (const f of todo) { if (Date.now() >= DEADLINE) break; await evaluate(f, driveId); done++ }
    if (done < todo.length) { delete out.tokens[driveId]; out.backlog = (out.backlog || 0) + (todo.length - done) }
  }
  console.log('TW>' + JSON.stringify(out))
  async function evaluate(f, driveId) {
    {
      const item = { drive: driveId, id: f.id, name: f.name, folder: f.mimeType === FOLDER, by: f.trashingUser?.emailAddress || f.trashingUser?.displayName || '?', at: f.trashedTime }
      try {
        const ch = await chain(f.parents?.[0]); item.path = ch.map(a => a.name).slice(1).join(' / ')
        const m = ch.map(a => a.name).concat(f.name).join(' ').match(CODE); item.booking = m ? m[1] : null
        const all = await filesUnder(f)
        const files = all.filter(x => +(x.size || 0) > 0 && !JUNK(x.name) && x.md5Checksum).sort((a, b) => +(b.size || 0) - +(a.size || 0))   // biggest (footage) first
        item.dataFiles = files.length; item.bytes = files.reduce((s, x) => s + +(x.size || 0), 0); item.capped = all.length >= 3000
        item.noLive = []; item.partial = 0; item.checked = 0
        // 8 at a time, inside the run's time budget — an unchecked file is reported as unknown, never as safe
        const todo = files.slice(0, IN.maxCheck)
        let next = 0
        const worker = async () => { while (next < todo.length && Date.now() < DEADLINE) { const x = todo[next++]; const v = await verdict(x, driveId); item.checked++
          if (v === 'twin') continue
          if (v === 'partial') { item.partial++; continue }
          item.noLive.push({ name: x.name, size: +(x.size || 0), rel: x.rel }) } }
        await Promise.all(Array.from({ length: 8 }, worker))
      } catch (e) { item.error = e.message }
      out.items.push(item)
    }
  }
})().catch(e => console.log('TW>' + JSON.stringify({ fatal: e.message })))
"""


def env():
    d = {}
    for line in open(ENV_FILE, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            d[k.strip()] = v.strip().strip('"').strip("'")
    return d


def docker_exec(cmd, timeout=840):
    e = env()
    base, key, ep = e["PORTAINER_URL"].rstrip("/"), e["PORTAINER_API_KEY"], e.get("PORTAINER_ENDPOINT_ID", "2")
    container = e.get("PORTAINER_CONTAINER", "production-booking-app")

    def call(path, payload):
        req = urllib.request.Request(base + path, data=json.dumps(payload).encode(),
                                     headers={"X-API-Key": key, "Content-Type": "application/json"}, method="POST")
        return urllib.request.urlopen(req, timeout=timeout)

    eid = json.loads(call(f"/api/endpoints/{ep}/docker/containers/{container}/exec",
                          {"AttachStdout": True, "AttachStderr": True, "Tty": True, "Cmd": cmd}).read())["Id"]
    raw = call(f"/api/endpoints/{ep}/docker/exec/{eid}/start", {"Detach": False, "Tty": True}).read()
    return re.sub(r"\x1b\[[0-9;]*m", "", raw.decode("utf-8", "replace"))


# Linux MAX_ARG_STRLEN = 131,072 ไบต์ต่อ argv หนึ่งตัว · 4–11 พ.ย. 2569 เดิมยัด base64(JS) + TW_IN=base64(payload)
# ใน sh -c ตัวเดียว — seen โตถึง 1,443 รายการ = 131,077 ไบต์ (เกิน 5) → "exec /bin/sh: argument list too long" 472 รอบติด
# และรอบที่ล้มไม่เซฟ state → seen ไม่เคยหด = ตายถาวร · ตัด seen อย่างเดียวแค่เลื่อนหน้าผา (cap 3,000 ≈ 250 KB)
# → ข้อมูลเข้าคอนเทนเนอร์เป็นไฟล์ ทีละท่อนไม่เกิน CHUNK (เทสต์ใน --self-test ที่ seen เต็ม cap)
CHUNK = 90_000


def run_in_container(js, payload):
    """เขียน JS + payload เป็นไฟล์ใน /tmp ของคอนเทนเนอร์ทีละท่อน แล้วรัน node (TW_IN = path ของ payload) -> stdout ดิบ"""
    tmp = f"/tmp/_tw_{os.getpid()}"
    for ext, data in (("cjs", js.encode()), ("json", json.dumps(payload).encode())):
        b64 = base64.b64encode(data).decode()   # [A-Za-z0-9+/=] ปลอดภัยใน sh ไม่ต้อง quote
        for i in range(0, len(b64), CHUNK):
            docker_exec(["sh", "-c", f"printf %s {b64[i:i + CHUNK]} {'>' if i == 0 else '>>'} {tmp}.{ext}.b64"])
    return docker_exec(["sh", "-c", f"base64 -d {tmp}.cjs.b64 > {tmp}.cjs && base64 -d {tmp}.json.b64 > {tmp}.json && cd /app && "
                                    f"TW_IN={tmp}.json NODE_PATH=/app/node_modules node {tmp}.cjs; rm -f {tmp}.*"])


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def delivery_error(job_name=JOB_NAME):
    raw = load(HERMES_JOBS, None)
    if raw is None:
        return None
    jobs = raw if isinstance(raw, list) else raw.get("jobs", raw)
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    for j in jobs if isinstance(jobs, list) else []:
        if isinstance(j, dict) and j.get("name") == job_name:
            return j.get("last_delivery_error")
    return None


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
    saved = load(outbox, None)
    rounds = _ob_rounds(saved)
    held = isinstance(saved, dict) and saved.get("undelivered") is True
    if not rounds or not (delivery_error(job_name) or held):
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
    if not delivery_error(job_name):
        return
    saved = load(outbox, None)
    if isinstance(saved, dict) and _ob_rounds(saved) and saved.get("undelivered") is not True:
        save(outbox, {**saved, "undelivered": True})


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
    save(outbox, {"rounds": rounds, "dropped": dropped})


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


# Hermes ตัดข้อความของรอบ exit ≠ 0 (ตรวจกับ scheduler.py ที่ติดตั้งอยู่ 11 พ.ย. 2569): ไม่ส่ง stdout แต่ส่ง
# "⚠️ Cron '<ชื่อ>' failed: Script exited with code 1 stdout: …" ยุบเป็นบรรทัดเดียว ตัดที่ 177 ตัว · ข้อความสั้นนั้น
# ส่งถึง → last_delivery_error ว่าง → OUTBOX ไม่ส่งซ้ำ = ส่วนที่ถูกตัดหายถาวร → exit 1 ได้เฉพาะเมื่อทั้งก้อนรอด
def hermes_fail_view(stdout):
    """-> (ข้อความที่ห้อง Discord ได้จริงถ้ารอบนี้ exit 1, ได้ครบทั้งก้อนไหม) · จำลองตอน stderr ว่าง"""
    s = " ".join(f"Script exited with code 1\nstdout:\n{stdout}".split())
    return (s, True) if len(s) <= 180 else (s[:177].rstrip() + "...", False)


def gb(n):
    return f"{n / 1e9:.1f} GB" if n >= 1e8 else f"{n / 1e6:.0f} MB" if n >= 1e6 else f"{max(1, round(n / 1e3))} KB"


def bkk(ts):
    try:
        from datetime import datetime, timedelta, timezone
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=7))).strftime("%d/%m %H:%M")
    except Exception:
        return ts or "?"


def render(items):
    red = [i for i in items if i.get("noLive")]
    yellow = [i for i in items if not i.get("noLive") and not i.get("error") and i.get("bytes", 0) >= YELLOW_MIN_BYTES]
    err = [i for i in items if i.get("error")]
    lines = []
    for i in red:
        nl = i["noLive"]
        lines.append(f"🔴 ฟุตเทจไม่มีสำเนาเหลือนอกถัง · {i.get('booking') or 'ไม่ทราบใบ'} · {DRIVES.get(i['drive'], i['drive'])}")
        lines.append(f"   {i['by']} ทิ้ง \"{i['name']}\" {bkk(i.get('at'))} · {len(nl)} ไฟล์ {gb(sum(x['size'] for x in nl))} ไม่มีสำเนา (จากข้อมูล {i['dataFiles']} ไฟล์ {gb(i['bytes'])})")
        for x in sorted(nl, key=lambda x: -x["size"])[:5]:
            lines.append(f"   · {x['rel'].lstrip('/')}/{x['name']} {gb(x['size'])}".replace("   · /", "   · "))
        if len(nl) > 5:
            lines.append(f"   · … อีก {len(nl) - 5} ไฟล์")
        if i.get("checked", 0) < i.get("dataFiles", 0) or i.get("capped"):
            lines.append(f"   ⚠️ ตรวจได้ {i.get('checked')} จาก {i['dataFiles']} ไฟล์ — ส่วนที่เหลือยังไม่รู้")
        lines.append(f"   ที่อยู่: {i.get('path', '?')} · กู้ได้จากถังขยะของไดรฟ์ (30 วัน) — https://drive.google.com/drive/folders/{i['id']}" if i.get("folder")
                     else f"   ที่อยู่: {i.get('path', '?')} · กู้ได้จากถังขยะของไดรฟ์ (30 วัน)")
    for i in yellow:
        extra = f" · อัปไม่จบ {i['partial']} ไฟล์ (ตัวเต็มยังอยู่)" if i.get("partial") else ""
        done = i.get("checked", 0) >= i.get("dataFiles", 0) and not i.get("capped")
        verdict = "ยังมีสำเนานอกถังครบ" if done else f"ตรวจได้ {i.get('checked', 0)} จาก {i['dataFiles']} ไฟล์ ยังไม่พบไฟล์ที่ไม่มีสำเนา — ที่เหลือยังไม่รู้"
        lines.append(f"{'🟡' if done else '🟠'} {i['by']} ทิ้ง \"{i['name']}\" ({i.get('booking') or 'ไม่ทราบใบ'}) {bkk(i.get('at'))} · ข้อมูล {i['dataFiles']} ไฟล์ {gb(i['bytes'])} {verdict}{extra}")
    for i in err:
        lines.append(f"⚠️ ตรวจไม่ได้: \"{i['name']}\" ({i.get('booking') or '?'}) ทิ้งโดย {i['by']} — {i['error'][:120]}")
    if lines:
        head = "🗑️ เฝ้าถังขยะไดรฟ์ฟุตเทจ" + (f" — {len(red)} รายการที่ฟุตเทจไม่มีสำเนาเหลือ" if red else "")
        lines.insert(0, head)
    return "\n".join(lines)


LOCK = STATE + ".lock"


def main():
    # one run at a time: a big trashed card folder can take most of the 15-min slot (a --test run never takes the lock)
    if any(a.startswith("--test=") for a in sys.argv[1:]):
        return run()
    try:
        if time.time() - os.path.getmtime(LOCK) < 20 * 60:
            return
    except OSError:
        pass
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    open(LOCK, "w").close()
    try:
        run()
    finally:
        try:
            os.remove(LOCK)
        except OSError:
            pass


def run():
    st = load(STATE, {"tokens": {}, "seen": [], "failStreak": 0})
    # ลำดับสำคัญ: อ่าน+ล้าง outbox ของรอบก่อนให้เสร็จ แล้วจึงเขียนของรอบนี้ทับ (remember_report ข้างล่าง)
    # รอบที่ล้ม (res is None) ไม่แตะไฟล์ = รอบที่ค้างยังอยู่ครบ
    carried = undelivered(JOB_NAME, OUTBOX)
    pending = resend_lines(carried)

    test = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--test=")), None)
    payload = {"drives": list(DRIVES), "tokens": st.get("tokens", {}), "seen": st.get("seen", [])[-3000:], "maxCheck": 250}
    if test:
        payload["testIds"] = [x for x in test.split(",") if x]
    res, why = None, ""
    for attempt in range(3):
        try:
            raw = run_in_container(JS, payload)
            # split("\n") ไม่ใช่ splitlines(): ชื่อไฟล์ใน Drive ที่มี U+2028/U+0085 จะตัด JSON ขาดกลาง (บั๊กเดียวกับ tuy-digest 11 พ.ย.)
            line = next((l.rstrip("\r") for l in raw.split("\n") if l.startswith("TW>")), None)
            if line:
                res = json.loads(line[3:])
                if not res.get("fatal"):
                    break
                why = res["fatal"]
            else:
                why = "no result line: " + raw.strip()[-200:]
        except Exception as e:
            why = f"{type(e).__name__}: {e}"
        res = None
        time.sleep(20 * (attempt + 1))

    if res is None:
        st["failStreak"] = st.get("failStreak", 0) + 1
        save(STATE, st)
        out = "\n".join(pending)
        # บอกครั้งแรก แล้วบอกซ้ำทุก 6 ชม. — เงียบสนิทระหว่างล้ม 71 รอบ (17–19 ต.ค. 2569) คือสิ่งที่ทำให้ไม่มีใครเห็น
        if st["failStreak"] == 1 or time.time() - st.get("failToldAt", 0) > 6 * 3600:
            st["failToldAt"] = time.time()
            save(STATE, st)
            # สั้นพอให้ exit 1 ส่งครบ: ข้อความสำคัญก่อน เหตุผล (why) ท้าย ตัดที่ 65
            out += ("\n" if out else "") + f"⚠️ เฝ้าถังขยะไดรฟ์ตรวจไม่ได้ {st['failStreak']} รอบติด — เหตุการณ์ไม่หาย จะตรวจย้อนให้ · {why[:65]}"
        # ส่งซ้ำไปในรอบนี้แล้ว → เขียนไฟล์ใหม่ (ไม่มีธง undelivered) — ไม่งั้นธงค้างแล้วส่งซ้ำทุก 15 นาทีตลอดที่ยังล้ม (รีวิว 20 พ.ย.)
        if carried["rounds"]:
            remember_report(OUTBOX, carried, "")
        # มีรายงานส่งซ้ำค้าง (🔴 ทิ้งของที่ไม่มีสำเนา) = ยาวเกิน exit 1 → exit 0 + ‼️ ไม่งั้นโดนตัด แล้ว OUTBOX ถูกลบรอบหน้า
        # ไม่มีอะไรจะพูด (ช่วงเงียบ 6 ชม.) = exit 0 — exit 1 เปล่า ๆ ทำให้ Hermes ส่ง "Script exited with code 1"
        # ที่ไม่มีเนื้อหาเข้าห้อง (เกิดจริง 18 พ.ย. 2569 10:23–13:24)
        code = 1 if out and hermes_fail_view(out)[1] else 0
        if out and not code:
            out = f"‼️ {JOB_NAME} ตรวจไม่ได้รอบนี้ — รายงานเต็มข้างล่าง\n{out}"
        if out:
            print(out)
        sys.exit(code)

    if test:   # never touch state/outbox in a test
        print(render(res.get("items", [])) or "(test: ไม่มีอะไรน่ารายงาน)")
        print(json.dumps([{k: i.get(k) for k in ("name", "booking", "dataFiles", "bytes", "checked", "partial", "error")} | {"noLive": len(i.get("noLive", []))} for i in res.get("items", [])], ensure_ascii=False))
        return
    recovered = st.get("failStreak", 0) > 0
    st["failStreak"] = 0
    st["tokens"].update(res.get("tokens", {}))
    st["seen"] = (st.get("seen", []) + [f"{i['id']}|{i.get('at')}" for i in res.get("items", [])])[-3000:]
    st["lastOk"] = time.strftime("%Y-%m-%d %H:%M")
    save(STATE, st)

    report = render(res.get("items", []))
    parts = list(pending)
    if res.get("baseline"):
        parts.append("👀 เริ่มเฝ้าถังขยะไดรฟ์ฟุตเทจแล้ว (กล่อง Video + Production Team) — ทุก 15 นาที จะแจ้งเมื่อมีคนทิ้งของที่มีฟุตเทจ · 🔴 = ไม่มีสำเนาเหลือนอกถัง")
    if recovered:
        parts.append("✅ เฝ้าถังขยะไดรฟ์กลับมาตรวจได้แล้ว (ตรวจย้อนช่วงที่หลุดให้ครบในรอบนี้)")
    if report:
        parts.append(report)
    # เนื้อรอบนี้เท่านั้น ต่อท้ายรอบที่ค้าง — ไม่ใช่ parts (ซ้อนชั้น 14–17 พ.ย.) · 👀/✅/⏳ = heartbeat ไม่เก็บ
    # (เดิม save ทับด้วย report ของรอบนี้ = 🔴 ของรอบก่อนที่ยังส่งไม่ออกหายเมื่อส่งไม่ออกสองรอบติด)
    remember_report(OUTBOX, carried, report)
    if res.get("backlog"):
        parts.append(f"⏳ เฝ้าถังขยะ: รอบนี้ตรวจ {len(res.get('items', []))} รายการ ยังค้างอีก {res['backlog']} (หมดงบเวลา 9 นาที) — รอบหน้าทำต่อเอง")
    out = "\n".join(p for p in parts if p is not None).strip()
    if out:
        print(out)


def self_test():
    """ทางล้มจริงของ run() ด้วยของปลอม ไม่แตะ Portainer/Drive — ล็อกว่ารอบ exit 1 ส่งข้อความสำคัญถึงห้องครบ"""
    import contextlib
    import io
    import tempfile
    g, tmp = globals(), tempfile.mkdtemp(prefix="tw-selftest-")
    g.update(STATE=os.path.join(tmp, "s.json"), OUTBOX=os.path.join(tmp, "ob.json"), HERMES_JOBS=os.path.join(tmp, "jobs.json"),
             docker_exec=lambda cmd: "exec /bin/sh: argument list too long\r\n")   # ข้อความล้มจริง 4–11 พ.ย. 2569
    time.sleep = lambda s: None

    def attempt(delivery_err=None):
        save(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": delivery_err}]})
        buf, code = io.StringIO(), 0
        with contextlib.redirect_stdout(buf):
            try:
                run()
            except SystemExit as e:
                code = e.code or 0
        return buf.getvalue().strip(), code

    # ── ส่งข้อมูลเข้าคอนเทนเนอร์: seen เต็ม cap 3,000 แล้วทุก argv ต้อง < 100 KB และไฟล์ที่ประกอบกลับต้องตรงต้นฉบับ ──
    files, longest = {}, [0]

    def fake_container(cmd):   # จำลอง sh ในคอนเทนเนอร์: printf ต่อไฟล์ · base64 -d แล้ว "รัน" node
        s = cmd[-1]
        longest[0] = max(longest[0], len(s.encode()))
        m = re.fullmatch(r"printf %s (\S+) (>>?) (\S+)", s)
        if m:
            files[m[3]] = (files.get(m[3], "") if m[2] == ">>" else "") + m[1]
            return ""
        js_b64, in_b64 = re.findall(r"base64 -d (\S+) >", s)
        assert base64.b64decode(files[js_b64]).decode() == JS and "TW_IN=" in s and "node " in s, s[:200]
        return "TW>" + json.dumps({"n": len(json.loads(base64.b64decode(files[in_b64]))["seen"])}) + "\r\n"
    g["docker_exec"] = fake_container
    seen = [f"1AbCdEfGhIjKlMnOpQrStUvWxYz012345{i:04d}|2026-11-04T02:45:12.345Z" for i in range(3000)]
    raw = run_in_container(JS, {"drives": list(DRIVES), "tokens": {d: "123456" for d in DRIVES}, "seen": seen, "maxCheck": 250})
    assert json.loads(raw.split("TW>", 1)[1]) == {"n": 3000}, raw
    assert longest[0] < 100_000, f"argv ยาว {longest[0]} ไบต์ — เกิน MAX_ARG_STRLEN 131,072 ได้"
    # ตัวอ่านผล: ชื่อไฟล์มี U+2028 ต้องยังอ่านออก (splitlines() ตัด JSON ขาด = รอบล้มทั้งที่ตรวจเสร็จแล้ว)
    g["docker_exec"] = lambda cmd: "TW>" + json.dumps({"tokens": {}, "items": [], "note": "คลิป\u2028A001"}, ensure_ascii=False) + "\r\n"
    out, code = attempt()
    assert code == 0 and load(STATE, {}).get("failStreak") == 0, (code, out)
    g["docker_exec"] = lambda cmd: "exec /bin/sh: argument list too long\r\n"

    out, code = attempt()
    view, whole = hermes_fail_view(out)
    assert code == 1 and whole and "ตรวจไม่ได้ 1 รอบติด" in view and "argument list too long" in view, (code, view)
    # รายงาน 🔴 รอบก่อนส่งไม่ออก + รอบนี้ตรวจไม่ได้ → exit 1 จะตัด 🔴 ทิ้ง แล้ว OUTBOX ถูกลบรอบหน้า → ต้อง exit 0 + ‼️
    save(OUTBOX, {"runAt": "2026-11-11 09:00", "text": "🔴 ฟุตเทจไม่มีสำเนาเหลือนอกถัง · OLD-" + "z" * 200})
    save(STATE, {**load(STATE, {}), "failToldAt": 0})   # ถึงรอบเตือนซ้ำ
    out, code = attempt("DNS")
    assert code == 0 and out.startswith("‼️") and "OLD-" + "z" * 200 in out and "ตรวจไม่ได้ 2 รอบติด" in out, (code, out)

    # ── OUTBOX ไม่ซ้อนชั้น ไม่หาย (14–17 พ.ย. 2569 ซ้อน 3 ชั้น · เดิม save ทับ = 🔴 รอบก่อนหายเมื่อส่งไม่ออกสองรอบติด) ──
    def tw(items, **extra):
        return lambda cmd: "TW>" + json.dumps({"tokens": {}, "items": items, **extra}, ensure_ascii=False) + "\r\n"

    def red(name):      # 🔴 หนึ่งรายการ = รายงาน 5 บรรทัด ชื่อโผล่ครั้งเดียว
        return {"drive": "0AH7f4FZNrHsOUk9PVA", "id": name, "name": name, "by": "x@y", "at": "2026-11-17T01:00:00Z",
                "dataFiles": 1, "bytes": 10 ** 9, "checked": 1, "noLive": [{"name": "C0001.MP4", "size": 10 ** 9, "rel": ""}]}

    def yellow(j):      # 🟡 หนึ่งรายการ = หนึ่งบรรทัด
        return {"drive": "0AH7f4FZNrHsOUk9PVA", "id": f"Y{j}", "name": f"Y{j}", "by": "x@y", "at": "2026-11-17T01:00:00Z",
                "dataFiles": 1, "bytes": 10 ** 9, "checked": 1}

    def stored():
        return [r["text"] for r in load(OUTBOX, None)["rounds"]]

    os.remove(OUTBOX)
    for n in range(1, 5):                # ทุกรอบเจอ 🔴 และทุกรอบ Hermes ส่งไม่ออก
        g["docker_exec"] = tw([red(f"CARD-{n}")])
        out, code = attempt("DNS")
    texts = stored()
    assert [f"CARD-{n}" in t for n, t in enumerate(texts, 1)] == [True] * 4, texts      # แบน เก่าไปใหม่
    assert not any(m in t for t in texts for m in ("📮", "‼️", "✅")), texts
    assert code == 0 and out.count("📮 ส่งซ้ำ") == 3 and all(out.count(f"CARD-{n}") == 1 for n in range(1, 5)), out
    g["docker_exec"] = tw([red("CARD-5")])
    out, code = attempt(None)            # รอบก่อนส่งถึง → ไม่ส่งซ้ำ เหลือแค่ของรอบนี้
    assert "📮" not in out and [("CARD-5" in t) for t in stored()] == [True], out
    # รูปไฟล์เดิม (ก่อน 17 พ.ย.) ยังส่งซ้ำได้หนึ่งครั้ง ไม่หาย
    save(OUTBOX, {"runAt": "2026-11-16 03:15", "text": "🔴 OLD-FORMAT"})
    g["docker_exec"] = tw([])
    out, code = attempt("DNS")
    assert out.count("📮 ส่งซ้ำ — รายงานรอบ 2026-11-16 03:15") == 1 and out.count("🔴 OLD-FORMAT") == 1, out
    # รอบที่ไม่มีเนื้อของตัวเอง (ไม่มีอะไรทิ้ง / 👀 baseline / รอบล้ม) = รอบที่ค้างยังอยู่ในไฟล์ · heartbeat ไม่ถูกเก็บ
    assert stored() == ["🔴 OLD-FORMAT"], stored()
    g["docker_exec"] = tw([], baseline=True)
    out, code = attempt("DNS")
    assert "👀" in out and "🔴 OLD-FORMAT" in out and stored() == ["🔴 OLD-FORMAT"], out
    g["docker_exec"] = lambda cmd: "exec /bin/sh: argument list too long\r\n"
    out, code = attempt("DNS")
    assert code == 0 and out.startswith("‼️") and "🔴 OLD-FORMAT" in out and stored() == ["🔴 OLD-FORMAT"], (code, out)
    g["docker_exec"] = tw([red("CARD-6")])
    out, code = attempt("DNS")           # กลับมาได้ (✅) หลังรอบล้ม (‼️): เก็บแค่ 🔴 สองรอบ ไม่มีบรรทัดของ payload
    texts = stored()
    assert "✅" in out and len(texts) == 2 and texts[0] == "🔴 OLD-FORMAT" and "CARD-6" in texts[1], texts
    assert not any(m in t for t in texts for m in ("📮", "‼️", "✅", "⚠️ เฝ้าถังขยะ")), texts
    # เพดาน OUTBOX_MAX_LINES: ทิ้งรอบเก่าสุดแล้ว *บอก* · รอบเดียวยาวเกิน = ตัดท้ายพร้อมบอก
    os.remove(OUTBOX)
    g["docker_exec"] = tw([yellow(j) for j in range(OUTBOX_MAX_LINES * 5 // 12 - 1)])   # รายงานรอบละ ~5/12 เพดาน: 2 รอบพอดี 3 รอบล้น
    for _ in range(3):
        attempt("DNS")
    saved = load(OUTBOX, None)
    assert len(saved["rounds"]) == 2 and saved["dropped"] == 1, saved
    out, code = attempt("DNS")
    assert "อีก 1 รอบถูกตัดทิ้ง" in out and out.count("📮 ส่งซ้ำ") == 2, out
    os.remove(OUTBOX)
    g["docker_exec"] = tw([yellow(j) for j in range(OUTBOX_MAX_LINES + 19)])   # รายงานยาวกว่าเพดาน 20 บรรทัด
    attempt("DNS")
    (only,) = stored()
    assert only.count("\n") == OUTBOX_MAX_LINES and "ตัดอีก 20 บรรทัด" in only, only

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
    assert 0 <= entry.find("await_full_wake()") < entry.find("main()"), "ทางจริงต้องรอแมคตื่นก่อน main() จับ LOCK"
    # รันบล็อก __main__ จริงด้วยของปลอม: ไม่มี flag = รอแล้วค่อย main · --test= ไม่รอ · --self-test ไม่รอ ไม่แตะ main
    # · หลับครบเพดานและไม่มีเน็ต (await_full_wake() คืน False) = hold_outbox แล้ว exit 0 ไม่จับ LOCK ไม่แตะ main
    def _exit(c):
        calls.append(f"exit{c}")
        raise SystemExit(c)
    for argv, awake, want in ((["x"], True, ["wait", "main"]), (["x", "--test=abc"], True, ["main"]),
                              (["x", "--self-test"], True, ["self"]), (["x"], False, ["wait", "hold", "exit0"])):
        calls = []
        try:
            exec('if __name__ == "__main__":' + entry, {"__name__": "__main__", "sys": type("S", (), {"argv": argv, "exit": _exit}),
                 "await_full_wake": lambda: calls.append("wait") or awake, "main": lambda: calls.append("main"),
                 "self_test": lambda: calls.append("self"), "hold_outbox": lambda j, o: calls.append("hold"),
                 "JOB_NAME": JOB_NAME, "OUTBOX": OUTBOX})
        except SystemExit:
            pass
        assert calls == want, (argv, awake, calls)
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
    save(OUTBOX, {"rounds": [{"runAt": "2026-11-18 13:21", "text": "⚠️ HELD-REPORT"}], "dropped": 0})
    save(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": "DNS"}]})
    hold_outbox(JOB_NAME, OUTBOX)
    assert load(OUTBOX, None).get("undelivered") is True, load(OUTBOX, None)
    save(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": None}]})   # รอบที่ hold: Hermes ล้างเป็น None
    hold_outbox(JOB_NAME, OUTBOX)                         # hold ซ้ำตอน error ว่าง = ไม่แตะธง
    _c = undelivered(JOB_NAME, OUTBOX)
    assert [r["text"] for r in _c["rounds"]] == ["⚠️ HELD-REPORT"], _c
    g["docker_exec"] = tw([])
    out, code = attempt(None)                             # รอบถัดไปที่ทำงานจริง: ส่งซ้ำ + เขียนไฟล์ใหม่ไม่มีธง
    assert "⚠️ HELD-REPORT" in out and "undelivered" not in (load(OUTBOX, None) or {}), (out, load(OUTBOX, None))
    assert undelivered(JOB_NAME, OUTBOX)["rounds"] == [] and not os.path.exists(OUTBOX)   # ส่งถึง → ล้าง
    save(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": "DNS"}]})
    hold_outbox(JOB_NAME, OUTBOX)
    assert not os.path.exists(OUTBOX), "ไม่มีของค้าง = hold ห้ามสร้างไฟล์"
    save(OUTBOX, {"rounds": [], "undelivered": True})
    assert undelivered(JOB_NAME, OUTBOX)["rounds"] == [] and not os.path.exists(OUTBOX), "ธงลอย ๆ ไม่มีรอบ = ล้างทิ้ง"
    # เพดาน OUTBOX ทิ้ง *รอบเก่าสุด* ก่อน (ไม่ใช่ใหม่สุด) และนับรวมกับที่เคยทิ้ง
    import tempfile as _tf
    _p, _h = os.path.join(_tf.mkdtemp(prefix="ob-cap-"), "ob.json"), OUTBOX_MAX_LINES // 2
    remember_report(_p, {"rounds": [{"runAt": "r1", "text": "\n".join(["OLD"] * _h)},
                                    {"runAt": "r2", "text": "\n".join(["MID"] * _h)}], "dropped": 2}, "\n".join(["NEW"] * _h))
    _s = (lambda q: load(q, None))(_p)
    assert [r["runAt"] for r in _s["rounds"]][0] == "r2" and _s["rounds"][-1]["text"].startswith("NEW") and _s["dropped"] == 3, _s
    # รูปของรอบที่ข้ามต้องเป๊ะ (รีวิว 20 พ.ย.): hold_outbox(JOB_NAME, OUTBOX) ก่อน แล้ว sys.exit(0) — ลำดับถูก exit 0 ไม่พิมพ์ ไม่ทำอย่างอื่น
    import ast as _ast
    _t = _ast.parse(open(__file__, encoding="utf-8").read())
    _m = [n for n in _t.body if isinstance(n, _ast.If) and "__main__" in _ast.dump(n.test)][0]
    _g = [n for n in _ast.walk(_m) if isinstance(n, _ast.If) and _ast.unparse(n.test) == "not await_full_wake()"]
    assert len(_g) == 1 and [_ast.unparse(b) for b in _g[0].body] == ["hold_outbox(JOB_NAME, OUTBOX)", "sys.exit(0)"], \
        ([_ast.unparse(b) for b in _g[0].body] if _g else "ไม่พบ if not await_full_wake()")
    # ── ทางล้มของรอบ (res is None) — รีวิว 20 พ.ย. 2569 ──
    g["docker_exec"] = lambda cmd: "exec /bin/sh: argument list too long\r\n"
    save(OUTBOX, {"rounds": [{"runAt": "2026-11-18 09:38", "text": "🔴 HELD-RED"}], "dropped": 0, "undelivered": True})
    save(STATE, {"tokens": {}, "seen": [], "failStreak": 3, "failToldAt": time.time()})   # อยู่ในช่วงเงียบ 6 ชม.
    out, code = attempt(None)        # Hermes ล้าง error แล้ว แต่ธงบอกว่ายังค้าง → ส่งซ้ำ แล้วไฟล์ต้องไม่มีธงค้าง
    assert "🔴 HELD-RED" in out and "undelivered" not in load(OUTBOX, None), (out, load(OUTBOX, None))
    out, code = attempt(None)        # ส่งถึงแล้ว + ช่วงเงียบ + ไม่มีอะไรค้าง = เงียบสนิท exit 0 (เดิม exit 1 เปล่า ๆ)
    assert out == "" and code == 0 and not os.path.exists(OUTBOX), (out, code)
    # hold_outbox ห้ามติดธงเมื่อรอบก่อนส่งถึงแล้ว (last_delivery_error ว่าง) — ไม่งั้นรายงานที่ถึงแล้วถูกส่งซ้ำ (รีวิว 20 พ.ย.)
    import tempfile as _tf3
    _gl, _d = globals(), _tf3.mkdtemp(prefix="hold-gate-")
    _jobs_saved = _gl["HERMES_JOBS"]
    _gl["HERMES_JOBS"] = os.path.join(_d, "jobs.json")
    save(_gl["HERMES_JOBS"], {"jobs": [{"name": JOB_NAME, "last_delivery_error": None}]})
    _obp = os.path.join(_d, "ob.json")
    save(_obp, {"rounds": [{"runAt": "x", "text": "DELIVERED"}], "dropped": 0})
    hold_outbox(JOB_NAME, _obp)
    assert "undelivered" not in (lambda q: load(q, None))(_obp), (lambda q: load(q, None))(_obp)
    _gl["HERMES_JOBS"] = _jobs_saved
    print("self-test ok")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    else:
        if not any(a.startswith("--test=") for a in sys.argv[1:]):   # --test = คนสั่งเองตอนตื่นอยู่ ไม่ต้องรอ
            if not await_full_wake():   # Hermes ยิงงานตอน DarkWake ได้ — รอเครื่องตื่นจริงก่อนจับ LOCK (ดูบล็อก DARKWAKE)
                hold_outbox(JOB_NAME, OUTBOX)   # หลับครบเพดานและไม่มีเน็ต: ไม่ทำรอบนี้ · จดว่ารอบก่อนยังค้างส่ง
                sys.exit(0)
        main()
