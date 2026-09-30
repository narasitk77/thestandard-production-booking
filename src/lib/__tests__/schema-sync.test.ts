// v1.252 — scripts/schema-sync.js: push schema ตอน boot โดยไม่ยอมลบข้อมูลเงียบ ๆ
//
// ข้อความข้างล่างคือรูปจริงของ `prisma db push` (Prisma 5.22.0 + Postgres 16) ที่เก็บจากการทดลอง 30 ก.ย. 2569
// — bullet ออก **stdout** (แต่ละข้อตามด้วยบรรทัดว่าง) ส่วน marker "Use the --accept-data-loss flag" ออก **stderr**
// รวมเคสจริงของวันนั้น: ถอยอิมเมจข้าม v1.249 = drop ตาราง mix_job_events ที่มีข้อมูล
// ถ้าอัปเกรด Prisma เทสแรกแดง → เก็บ output จริงของรุ่นใหม่มาแทน fixture ก่อน (ด่านต้อง fail closed)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
type Decision = { action: 'done' | 'fail' | 'accept' | 'skip'; why: string; bullets: string[] }
const { decide, lossObjects } = require_('../../../scripts/schema-sync.js') as {
  decide: (a: { code: number; stdout: string; stderr: string; optIn?: string }) => Decision
  lossObjects: (b: string) => string[] | null
}

const HDR = 'Prisma schema loaded from prisma/schema.prisma\nDatasource "db": PostgreSQL database "production_booking", schema "public" at "db:5432"\n\n'
const MARKER = 'Error: Use the --accept-data-loss flag to ignore the data loss warnings like prisma db push --accept-data-loss\n'
/** รูปเดียวกับของจริง: header + bullet ละบรรทัดตามด้วยบรรทัดว่าง ออก stdout · marker ออก stderr */
const loss = (...bullets: string[]) => ({
  code: 1,
  stdout: `${HDR}⚠️  There might be data loss when applying the changes:\n\n${bullets.map(b => `  • ${b}\n\n`).join('')}`,
  stderr: MARKER,
})

const DROP_TABLE = 'You are about to drop the `mix_job_events` table, which is not empty (1 rows).'
const DROP_COL = 'You are about to drop the column `note` on the `Job` table, which still contains 1 non-null values.'
const ENUM_GONE = 'The values [B] on the enum `Kind` will be removed. If these variants are still used in the database, this will fail.'
const UNIQUE = 'A unique constraint covering the columns `[code]` on the table `Job` will be added. If there are existing duplicate values, this will fail.'
const UNIQUE_MULTI = 'A unique constraint covering the columns `[bookingId,episodeId]` on the table `crew_slots` will be added. If there are existing duplicate values, this will fail.'
const CAST = 'You are about to alter the column `n` on the `Job` table, which contains 1 non-null values. The data in that column will be cast from `Text` to `Integer`.'

test('fixture ผูกกับ Prisma 5.22.0 — อัปเกรดแล้วต้องเก็บ output จริงใหม่', () => {
  assert.equal(require_('prisma/package.json').version, '5.22.0')
})

test('push ผ่าน = จบ (release ปกติ รวมลบตาราง/คอลัมน์ที่ว่าง)', () => {
  assert.equal(decide({ code: 0, stdout: `${HDR}🚀  Your database is now in sync`, stderr: '' }).action, 'done')
})

test('ถอยอิมเมจข้าม v1.249 (ตาราง mix_job_events มีข้อมูล) = ข้าม push ไม่ลบ', () => {
  const d = decide(loss(DROP_TABLE))
  assert.equal(d.action, 'skip')
  assert.deepEqual(d.bullets, [DROP_TABLE])
})

test('ลบคอลัมน์ที่มีค่า / ลบค่า enum / เปลี่ยนชนิด = ข้าม · unique มาก่อนแล้วตามด้วยการลบ ก็ยังข้าม', () => {
  for (const out of [loss(DROP_COL), loss(ENUM_GONE), loss(CAST), loss(UNIQUE, DROP_COL), loss(UNIQUE_MULTI, UNIQUE, DROP_TABLE)]) {
    assert.equal(decide(out).action, 'skip', out.stdout)
  }
})

test('เพิ่ม unique อย่างเดียว = push ด้วย flag เหมือนวันนี้ (ไม่มีข้อมูลหาย · ซ้ำ = Prisma ล้มเอง)', () => {
  assert.equal(decide(loss(UNIQUE)).action, 'accept')
  assert.equal(decide(loss(UNIQUE, UNIQUE_MULTI)).action, 'accept')
})

test('opt-in ต้องระบุชื่อ object ครบทุกข้อที่จะหาย — ค่าค้างบน stack ยอมได้แค่ของที่ระบุชื่อ', () => {
  const both = loss(DROP_COL, DROP_TABLE)
  assert.equal(decide({ ...both, optIn: 'column:Job.note table:mix_job_events' }).action, 'accept')
  assert.equal(decide({ ...both, optIn: ' column:Job.note, table:mix_job_events ' }).action, 'accept', 'คั่นด้วย , หรือช่องว่างก็ได้')
  // ถอยอิมเมจที่ opt-in เก่ายังค้าง แล้วเจอตารางใหม่ที่ไม่มีใครอนุญาต = ข้าม (ช่องที่ผู้ตรวจจับได้กับ opt-in แบบเลขเวอร์ชัน)
  assert.equal(decide({ ...both, optIn: 'column:Job.note' }).action, 'skip')
  assert.equal(decide({ ...loss(ENUM_GONE), optIn: 'enumvalue:Kind.B' }).action, 'accept')
  assert.equal(decide({ ...loss(ENUM_GONE), optIn: 'enum:Kind' }).action, 'skip', 'ต้องระบุค่า enum ไม่ใช่ทั้ง enum')
  for (const optIn of ['', '1', '1.252.0', 'all', '*', 'true']) {
    assert.equal(decide({ ...loss(DROP_TABLE), optIn }).action, 'skip', `optIn=${JSON.stringify(optIn)}`)
  }
  assert.equal(decide({ ...loss(CAST), optIn: 'column:Job.n' }).action, 'skip', 'เปลี่ยนชนิดไม่มีทาง opt-in ผ่าน env')
})

test('ล้มด้วยเหตุอื่น = ล้มตามเดิม (start.sh set -e หยุดบูต เหมือนวันนี้)', () => {
  const unreachable = { code: 1, stdout: HDR, stderr: "Error: P1001: Can't reach database server at `db:5432`\n" }
  const unexecutable = {
    code: 1, stdout: HDR,
    stderr: 'Error: \n⚠️ We found changes that cannot be executed:\n\n  • Made the column `code` on table `Job` required, but there are 1 existing NULL values.\n\nUse the --force-reset flag to drop the database before push like prisma db push --force-reset\nAll data will be lost.\n',
  }
  const spawnFailed = { code: 1, stdout: '', stderr: 'spawn npx ENOENT' }
  for (const r of [unreachable, unexecutable, spawnFailed]) assert.equal(decide(r).action, 'fail', r.stderr)
})

test('อ่านคำเตือนไม่ออก = ข้าม ไม่ใช่ยอม: ไม่มี bullet · มีบรรทัดแปลก · มีแต่ stderr แบบ execSync', () => {
  assert.equal(decide({ code: 1, stdout: HDR, stderr: MARKER }).action, 'skip', 'marker มา bullet ไม่มา')
  assert.equal(decide({ code: 1, stdout: '', stderr: `Command failed: npx prisma db push\n${MARKER}` }).action, 'skip', 'รูป err.message ของ execSync')
  const weird = loss(UNIQUE)
  weird.stdout += 'Some new line Prisma added in a later version\n'
  assert.equal(decide(weird).action, 'skip', 'บรรทัดที่ไม่รู้จักหลัง header = fail closed')
  const reworded = loss('A unique constraint on `Job(code)` will be created.')
  assert.equal(decide(reworded).action, 'skip')
})

test('สีจาก FORCE_COLOR ไม่ทำให้อ่านผิด', () => {
  const colored = loss(DROP_TABLE)
  colored.stdout = colored.stdout.replace('  • ', '  \x1b[33m•\x1b[39m ')
  colored.stderr = `\x1b[31mError: \x1b[39m${MARKER.slice(7)}`
  assert.equal(decide(colored).action, 'skip')
})

test('lossObjects แปลง bullet เป็นชื่อ object ใน DB รูปเดียวกับ schema_diff.py', () => {
  assert.deepEqual(lossObjects(DROP_TABLE), ['table:mix_job_events'])
  assert.deepEqual(lossObjects(DROP_COL), ['column:Job.note'])
  assert.deepEqual(lossObjects('The values [PENDING, DRAFT] on the enum `OTApprovalStatus` will be removed. If these variants are still used in the database, this will fail.'),
    ['enumvalue:OTApprovalStatus.PENDING', 'enumvalue:OTApprovalStatus.DRAFT'])
  assert.equal(lossObjects(CAST), null)
  assert.equal(lossObjects(UNIQUE), null)
})

test('ทางบูตทั้งสองทางผ่านด่าน · ไม่มี db push --accept-data-loss เปล่า ๆ กลับมาใน start.sh / npm start', () => {
  const { readFileSync } = require_('fs') as typeof import('fs')
  const { join } = require_('path') as typeof import('path')
  const root = join(__dirname, '..', '..', '..')
  const live = readFileSync(join(root, 'start.sh'), 'utf8').split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  assert.match(live, /^node scripts\/schema-sync\.js$/m, 'start.sh ต้องเรียกด่านเป็นคำสั่งเปล่า (set -e ต้องเห็น exit non-zero)')
  assert.ok(!/db push/.test(live), 'start.sh มี db push ตรง ๆ = ข้ามด่าน')
  const start = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.start as string
  assert.match(start, /^node scripts\/schema-sync\.js && next start$/)
  // scripts/ops/schema_diff.py ใช้เงื่อนไขเดียวกันตัดสินว่าอิมเมจของ sha หนึ่ง "มีด่าน" ไหม
})

// scripts/ops/schema_diff.py (กฎของ deploy.py/rollback.py) — selftest เป็น python · อิมเมจ alpine ไม่มี python3
// → ข้ามแบบบอกเหตุผล (bug class 6: ห้าม return เงียบ ๆ) · CI (ubuntu) กับเครื่อง dev มี python3 = รันจริง
const { spawnSync } = require_('child_process') as typeof import('child_process')
const hasPython = spawnSync('python3', ['--version']).status === 0
test('schema_diff.py --selftest (กฎ deploy/rollback)', { skip: hasPython ? false : 'ไม่มี python3 ในสภาพแวดล้อมนี้ (อิมเมจ alpine) — CI/เครื่อง dev รันจริง' }, () => {
  const { join } = require_('path') as typeof import('path')
  const r = spawnSync('python3', [join(__dirname, '..', '..', '..', 'scripts', 'ops', 'schema_diff.py'), '--selftest'], { encoding: 'utf8' })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /selftest OK/)
})
