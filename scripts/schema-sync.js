// schema-sync.js — push schema ตอน boot โดย **ไม่ยอมลบข้อมูลเงียบ ๆ** (v1.252)
//
// เรียกจาก start.sh (web role) และ `npm start` แทน `prisma db push --accept-data-loss` ตรง ๆ
//
// WHY. คอนเทนเนอร์ push schema ทุก boot ด้วย --accept-data-loss และโปรเจกต์ไม่มี migration history
// ⇒ อิมเมจที่ schema ไม่มีตาราง/คอลัมน์ที่ DB มี = DROP พร้อมข้อมูลทันทีตอนบูต · ถอยอิมเมจจึงลบข้อมูลใหม่
// (เคยเกิดจริง v1.231: ผู้กำกับคนที่ 2-3 ของทุกใบหาย · 30 ก.ย. 2569 ถอยข้าม v1.249 = ตาราง mix_job_events
// หายทั้งตาราง) — ประวัติ 150 วัน: 57 จาก 59 commit ที่แตะ schema ถ้าถอยข้ามแล้วของหาย ขณะที่ release
// ไปข้างหน้าที่ลบของจริงมีแค่ 4 ครั้ง ทุกครั้งตั้งใจ
//
// กฎ (ทดสอบกับ Prisma 5.22.0 + Postgres 16 จริง 30 ก.ย.):
//   1. push แบบไม่มี flag ก่อนเสมอ — Prisma ไม่ทำอะไรเลยถ้าจะเสียข้อมูล (all-or-nothing) · ผ่าน = จบ
//      (ลบตาราง/คอลัมน์ที่ว่างผ่านได้เองโดยไม่ใช้ flag = ไม่มีข้อมูลเสีย)
//   2. ล้มด้วยเหตุอื่น (ต่อ DB ไม่ได้ · "cannot be executed" · prisma ถูก kill) = ออก non-zero → start.sh
//      (set -e) หยุดบูตเหมือนวันนี้
//   3. ล้มเพราะคำเตือนเสียข้อมูล — push ซ้ำด้วย flag **เฉพาะเมื่อทุกข้อ** เป็น:
//      - เพิ่ม unique (Prisma เตือนทุกครั้งแม้ไม่มีข้อมูลซ้ำ · ถ้าซ้ำ push ล้มเอง ไม่มีอะไรหาย) หรือ
//      - ลบ object ที่มีชื่ออยู่ใน SCHEMA_ACCEPT_DATA_LOSS (เช่น `column:uploads.wasabiKey table:purchase_items`
//        รูปเดียวกับที่ scripts/ops/schema_diff.py พิมพ์) — ผูกกับ **ชื่อ object** ไม่ใช่เวอร์ชัน:
//        ค่าที่ค้างบน stack ยอมได้แค่ของที่ระบุชื่อไว้ ถอยอิมเมจแล้วเจอตารางใหม่ = ไม่อยู่ในลิสต์ = ข้าม
//        (ผู้ตรวจจับได้ก่อนลงมือ: opt-in แบบเลขเวอร์ชันค้างบน stack แล้วถอยกลับไปเวอร์ชันนั้น = ลบของใหม่)
//      อย่างอื่นทั้งหมด (เปลี่ยนชนิด/recreate/PK · อ่านคำเตือนไม่ออก · ไม่มี bullet) → **ข้าม** push
//      บูตต่อบน DB เดิม (มีของมากกว่า schema นี้ = อิมเมจเก่าใช้ต่อได้) · พิมพ์ `[schema-guard] run failed:`
//      ให้ Hermes BAD_RE จับ · เขียน .schema-sync.json ให้ /api/version บอก deploy.py/rollback.py
//
// ข้อจำกัดที่รู้: ด่านนี้อยู่ในอิมเมจ — อิมเมจที่ build ก่อน v1.252 ยัง push แบบยอมลบ
// ⇒ scripts/ops/rollback.py + deploy.py เทียบ schema ปลายทางกับ DB จริงแล้วปฏิเสธเอง (schema_diff.py)

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const STATE_FILE = path.join(ROOT, '.schema-sync.json')
const LOSS_MARKER = 'Use the --accept-data-loss flag'
const UNEXECUTABLE = 'cannot be executed'
const UNIQUE_ADDED = /^A unique constraint covering the columns `\[[^\]]*\]` on the table `[^`]+` will be added\. If there are existing duplicate values, this will fail\.$/
const ANSI = /\x1b\[[0-9;]*m/g

/** bullet ของคำเตือนเสียข้อมูลใน stdout · null = ไม่ใช่การหยุดเพราะเสียข้อมูล · unparsed = มีบรรทัดที่อ่านไม่ออก */
function dataLossBullets(stdout, stderr) {
  const out = String(stdout || '').replace(ANSI, '')
  const err = String(stderr || '').replace(ANSI, '')
  if (!out.includes(LOSS_MARKER) && !err.includes(LOSS_MARKER)) return null
  const lines = out.split('\n')
  const start = lines.findIndex(l => l.includes('There might be data loss'))
  const bullets = []
  let unparsed = start < 0
  for (const l of start < 0 ? [] : lines.slice(start + 1)) {
    const t = l.trim()
    if (!t) continue
    if (t.includes(LOSS_MARKER)) break
    const m = /^•\s*(.+)$/.exec(t)
    if (m) bullets.push(m[1].trim())
    else unparsed = true
  }
  return { bullets, unparsed }
}

/**
 * bullet → ชื่อ object ใน DB (รูปเดียวกับ schema_diff.py) · null = ไม่ใช่การลบที่ระบุชื่อได้
 * (เปลี่ยนชนิด/recreate/PK = ไม่มีทาง opt-in ผ่าน env · ทำด้วย SQL ก่อน push แบบเดียวกับ enum rename ใน start.sh)
 */
function lossObjects(bullet) {
  let m = /^You are about to drop the column `([^`]+)` on the `([^`]+)` table\b/.exec(bullet)
  if (m) return [`column:${m[2]}.${m[1]}`]
  m = /^You are about to drop the `([^`]+)` table\b/.exec(bullet)
  if (m) return [`table:${m[1]}`]
  m = /^The values \[([^\]]+)\] on the enum `([^`]+)` will be removed\b/.exec(bullet)
  if (m) return m[1].split(',').map(v => `enumvalue:${m[2]}.${v.trim()}`).filter(v => !v.endsWith('.'))
  return null
}

/**
 * ตัดสินจากผล push รอบแรก (ไม่มี flag) — ฟังก์ชันบริสุทธิ์ เทสด้วยข้อความจริงของ Prisma
 * @returns {{ action: 'done'|'fail'|'accept'|'skip', why: string, bullets: string[] }}
 */
function decide({ code, stdout, stderr, optIn }) {
  if (code === 0) return { action: 'done', why: 'in sync', bullets: [] }
  const all = `${stdout || ''}\n${stderr || ''}`
  const parsed = dataLossBullets(stdout, stderr)
  // เปลี่ยนที่ทำไม่ได้ = ล้มแม้ใส่ flag (เหมือนวันนี้) · ต่อ DB ไม่ได้ · schema ผิด · ถูก kill → ล้มดังตามเดิม
  if (parsed === null || all.includes(UNEXECUTABLE)) return { action: 'fail', why: 'push failed (not a data-loss stop)', bullets: [] }
  const { bullets, unparsed } = parsed
  if (bullets.length === 0 || unparsed) {
    return { action: 'skip', why: 'data-loss stop with unreadable warnings (fail closed)', bullets }
  }
  const allowed = new Set(String(optIn || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean))
  const blocked = bullets.filter(b => {
    if (UNIQUE_ADDED.test(b)) return false
    const objs = lossObjects(b)
    return !(objs && objs.length > 0 && objs.every(o => allowed.has(o)))
  })
  if (blocked.length === 0) {
    const named = bullets.some(b => !UNIQUE_ADDED.test(b))
    return { action: 'accept', why: named ? 'every loss is named in SCHEMA_ACCEPT_DATA_LOSS' : 'only unique-constraint additions (lossless)', bullets }
  }
  return { action: 'skip', why: 'would lose data', bullets }
}

const ALLOWED_ARGS = /^(--skip-generate|--schema=.+)$/

/** push หนึ่งรอบ — พิมพ์ output ทันทีที่มา (push ค้างรอ lock ต้องเห็นได้) และเก็บไว้ตัดสิน */
function push(extra) {
  return new Promise(resolve => {
    const child = spawn('npx', ['prisma', 'db', 'push', ...extra], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8') // ถอด utf8 ข้ามรอยต่อ chunk ได้ถูก (• = 3 byte)
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', s => { stdout += s; process.stdout.write(s) })
    child.stderr.on('data', s => { stderr += s; process.stderr.write(s) })
    child.on('error', e => { stderr += `\n${e.message}`; process.stderr.write(`[schema-guard] เรียก prisma ไม่ได้: ${e.message}\n`) })
    // code null = ถูก kill (OOM / signal) → นับเป็นล้ม · process.exit(null) คือ exit 0 = ห้ามปล่อยถึงตรงนั้น
    child.on('close', (code, signal) => resolve({ code: code == null ? 1 : code, signal, stdout, stderr }))
  })
}

function writeState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, at: new Date().toISOString() })) } catch (e) {
    process.stderr.write(`[schema-guard] เขียน ${STATE_FILE} ไม่ได้: ${e.message}\n`)
  }
}

async function main() {
  const extra = process.argv.slice(2)
  const bad = extra.filter(a => !ALLOWED_ARGS.test(a))
  if (bad.length) {
    // กันทางลัดที่เห็นง่ายที่สุดตอนโดนข้าม: เติม --accept-data-loss ต่อท้ายคำสั่ง = ด่านนี้หายทั้งด่าน
    console.error(`[schema-guard] run failed: ไม่รับ argument ${bad.join(' ')} — ยอมลบข้อมูลได้ทาง SCHEMA_ACCEPT_DATA_LOSS เท่านั้น`)
    return 2
  }
  // start.sh sync ไปแล้วในบูตนี้ (มันตั้งค่านี้ก่อน exec npm start) — รอบสองไม่มีอะไรต่าง และเคยทำให้ 'accepted'
  // ถูกเขียนทับเป็น 'in-sync' + บรรทัด run failed ซ้ำสองชุดต่อบูต · รัน npm start เองนอก start.sh = ไม่มีค่านี้ = sync ตามปกติ
  if (process.env.SCHEMA_SYNC_DONE === '1') return 0
  const optIn = process.env.SCHEMA_ACCEPT_DATA_LOSS || ''
  const first = await push(extra)
  const d = decide({ code: first.code, stdout: first.stdout, stderr: first.stderr, optIn })
  if (d.action === 'done') { writeState({ result: 'in-sync' }); return 0 }
  if (d.action === 'fail') {
    if (first.signal) console.error(`[schema-guard] run failed: prisma ถูกหยุดด้วย ${first.signal}`)
    return first.code || 1
  }
  if (d.action === 'accept') {
    console.log(`[schema-sync] push ซ้ำด้วย --accept-data-loss (${d.why}):\n${d.bullets.map(b => `  • ${b}`).join('\n')}`)
    const again = await push([...extra, '--accept-data-loss'])
    if (again.code === 0) writeState({ result: 'accepted', bullets: d.bullets })
    return again.code
  }
  writeState({ result: 'skipped', bullets: d.bullets })
  // บรรทัดแรกเท่านั้นที่มี tag — บรรทัดรายละเอียดไม่มี tag เพื่อไม่ให้ Hermes นับเป็นบรรทัด "ปกติ" แล้วรายงานว่าหายแล้ว
  console.error([
    `[schema-guard] run failed: ข้าม db push เพื่อไม่ให้ข้อมูลหาย (${d.why}) — แอปบูตต่อบน schema เดิมใน DB: ${d.bullets.join(' | ')}`,
    '    ถ้านี่คือการถอยอิมเมจ: ถูกต้องแล้ว ของใหม่ใน DB ยังอยู่ อย่าตั้ง SCHEMA_ACCEPT_DATA_LOSS — ของพวกนี้จะกลับมาใช้ตอน deploy ไปข้างหน้า',
    '    ถ้าเป็น release ที่ตั้งใจลบ: ใช้ scripts/ops/deploy.py (มันบอกรายชื่อที่ต้องใส่ใน SCHEMA_ACCEPT_DATA_LOSS และขอให้ยืนยัน)',
    '    ระหว่างนี้ release นี้ยังไม่ได้ schema ใหม่ของตัวเองเลย (push เป็น all-or-nothing) — ดู /api/version schemaSync',
  ].join('\n'))
  return 0
}

module.exports = { decide, dataLossBullets, lossObjects }

if (require.main === module) main().then(code => process.exit(code), e => { console.error('[schema-guard] run failed:', e); process.exit(1) })
