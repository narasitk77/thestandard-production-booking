import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// v1.266 — agedOut ของ /api/internal/footage-ready/stats ต้องมองย้อนไปไกลเท่ากับที่ตรวจฟุตเทจรายวันเดิน
// (FOOTAGE_INTEGRITY_DAYS, ค่าเริ่ม 30) — เดิม lookback+4 = 8 วัน ทำให้ AGN-260904-01 / EVT-EVF-260901-01 /
// KND-KNF-260916-01 (ถ่าย 1–16 ก.ย.) ไม่เคยขึ้นที่นี่ ทั้งที่ฟุตเทจอยู่บน Drive (เจอตอนตรวจมือ 11 ต.ค. 2569)
let bookingWhere: any = null
let bookings: any[] = []
// v1.290 — nas_sync_state as latestNasState reads it; a function so a test can make the read throw
let nasRow: () => any = () => null
mock.module('../db', {
  namedExports: {
    prisma: {
      auditLog: { findMany: async () => [] },
      nasSyncState: { findUnique: async () => nasRow() },
      booking: {
        // Applies the date filter the way the DB would (review of v1.266: returning every row
        // let the KND case pass against the old 8-day query too). Handles the old shape
        // (`shootDate: { gte }`) and the new one (`OR: [{ shootDate }, { shootEndDate }]`).
        findMany: async ({ where }: any) => {
          bookingWhere = where
          const on = (row: any, f: string, c: any) => !c?.gte || (row[f] != null && row[f] >= c.gte)
          return bookings.filter(r => where.OR
            ? where.OR.some((c: any) => Object.entries(c).every(([f, cond]) => on(r, f, cond)))
            : on(r, 'shootDate', where.shootDate))
        },
        count: async () => 0,
      },
    },
  },
})
mock.module('../session', { namedExports: { getSession: async () => null } })

let GET: (r: any) => Promise<Response>
before(async () => {
  process.env.FOOTAGE_READY_SECRET = 'stats-secret'
  ;({ GET } = await import('../../app/api/internal/footage-ready/stats/route'))
})
beforeEach(() => {
  bookingWhere = null; bookings = []; nasRow = () => null
  delete process.env.FOOTAGE_INTEGRITY_DAYS
  delete process.env.FOOTAGE_READY_LOOKBACK_DAYS
  delete process.env.FOOTAGE_READY_AGED_OUT_DAYS
})
const req = (qs = '') =>
  new Request(`https://probook.test/api/internal/footage-ready/stats${qs}`, { headers: { 'x-footage-ready-secret': 'stats-secret' } }) as any
const DAY = 86_400_000

/** the cutoff the query used, in days before now (both OR branches must agree) */
function cutoffDays(): number {
  const or = bookingWhere.OR as Array<Record<string, { gte: Date }>>
  assert.equal(or.length, 2)
  const shoot = or.find(c => c.shootDate)!.shootDate.gte.getTime()
  const end = or.find(c => c.shootEndDate)!.shootEndDate.gte.getTime()
  assert.equal(shoot, end)
  return Math.round((Date.now() - shoot) / DAY)
}

// v1.290 — ค่าเริ่มขยายจาก 30 (FOOTAGE_INTEGRITY_DAYS) เป็น 60 (FOOTAGE_READY_AGED_OUT_DAYS): ใบที่ไม่เคยแจ้งแต่มีไฟล์
// หายจากรายงานเงียบ ๆ วันที่ 31 (WLT-MNW-261012-01, NWS-GLF-261012-01) · ยังไม่ใช่ lookback+4
test('ค่าเริ่ม: agedOut มองย้อน 60 วัน (ไม่หายเงียบหลังตรวจฟุตเทจรายวัน 30 วัน) ไม่ใช่ lookback+4', async () => {
  process.env.FOOTAGE_READY_LOOKBACK_DAYS = '4'
  await GET(req())
  assert.equal(cutoffDays(), 60)
})

test('นับจากวันถ่ายวันสุดท้ายด้วย: งานหลายวันที่จบในหน้าต่างอยู่ในหน้าต่าง', async () => {
  await GET(req())
  assert.ok(bookingWhere.OR.some((c: any) => c.shootEndDate), 'ต้องมีเงื่อนไข shootEndDate')
  assert.equal(bookingWhere.shootDate, undefined, 'ห้ามกรองด้วย shootDate อย่างเดียว')
})

test('ตาม env ของ worker ตรวจฟุตเทจ · ?days= ที่ยาวกว่ายังชนะ', async () => {
  process.env.FOOTAGE_INTEGRITY_DAYS = '90'
  await GET(req())
  assert.equal(cutoffDays(), 90, 'ตรวจรายวันเดินไกลกว่า 60 = ตามนั้น')

  process.env.FOOTAGE_INTEGRITY_DAYS = '30'
  process.env.FOOTAGE_READY_AGED_OUT_DAYS = '45'
  await GET(req())
  assert.equal(cutoffDays(), 45, 'env เฉพาะของรายงานนี้')

  process.env.FOOTAGE_READY_AGED_OUT_DAYS = '40'
  await GET(req('?days=60'))
  assert.equal(cutoffDays(), 60)
})

test('เคส KND: ถ่าย 25 วันก่อน · cache เห็นฟุตเทจ → agedOut พร้อมชื่อใบ ให้คนตามต่อ', async () => {
  process.env.FOOTAGE_READY_WORKER_ENABLED = '1' // worker ปิด = เตือนบรรทัดเดียว ไม่แจกแจง (ตามออกแบบ)
  const shot = new Date(Date.now() - 25 * DAY)
  bookings = [{
    bookingCode: 'KND-KNF-260916-01', shootDate: shot, shootEndDate: null, estimatedWrap: '18:00',
    readyCheckedAt: new Date(shot.getTime() + 4 * DAY),
    footageCache: { fileCount: 41 }, footageCacheAt: new Date(),
    program: { code: 'KNF' }, episodes: [],
  }]
  const body = await (await GET(req())).json()
  assert.deepEqual(body.pending.agedOut, ['KND-KNF-260916-01'])
  assert.ok(body.alerts.some((a: string) => a.includes('KND-KNF-260916-01')))
})

// ── v1.290 ───────────────────────────────────────────────────────────────────
const agedBooking = (code: string, daysAgo: number, o: any = {}) => {
  const shot = new Date(Date.now() - daysAgo * DAY)
  return { bookingCode: code, shootDate: shot, shootEndDate: null, estimatedWrap: '18:00',
    readyCheckedAt: new Date(shot.getTime() + DAY), footageCache: { fileCount: 41 }, footageCacheAt: new Date(),
    program: { code: 'X' }, episodes: [], ...o }
}

test('ใบที่ถ่ายเกิน 30 วันแต่มีไฟล์ยังขึ้น agedOut · บรรทัดเตือนบอกว่ากี่ใบที่เลยการตรวจรายวัน', async () => {
  process.env.FOOTAGE_READY_WORKER_ENABLED = '1'
  bookings = [agedBooking('WLT-MNW-261012-01', 39), agedBooking('KND-KNF-260916-01', 10),
    agedBooking('EMPTY-OLD', 45, { footageCache: { fileCount: 0 } })]
  const body = await (await GET(req())).json()
  assert.deepEqual(body.pending.agedOut, ['WLT-MNW-261012-01', 'KND-KNF-260916-01'])
  assert.deepEqual(body.pending.pastCheck, ['WLT-MNW-261012-01'])
  const line = body.alerts.find((a: string) => a.includes('WLT-MNW-261012-01'))
  assert.ok(line.includes('ในนี้ 1 ใบถ่ายเกิน 30 วัน'), line)
  assert.ok(!body.alerts.some((a: string) => a.includes('EMPTY-OLD')), 'ไม่มีไฟล์ + เลยหน้าต่าง = ไม่ใช่เรื่องของรายงานนี้')
  assert.equal(body.config.agedOutDays, 60)
})

test('NAS ยังรายงานไฟล์ค้าง (manifest สด) → agedOutNas ไม่ใช่ "ไฟล์อยู่บน Drive"', async () => {
  process.env.FOOTAGE_READY_WORKER_ENABLED = '1'
  nasRow = () => ({ manifest: { at: new Date().toISOString(), folders: [] }, status: { folders: { 'POP-7TG-261116-01': { lastPending: 5 } } } })
  bookings = [agedBooking('POP-7TG-261116-01', 8), agedBooking('KND-KNF-260916-01', 10)]
  const body = await (await GET(req())).json()
  assert.deepEqual(body.pending.agedOutNas, [{ code: 'POP-7TG-261116-01', pending: 5 }])
  assert.deepEqual(body.pending.agedOut, ['KND-KNF-260916-01'])
  assert.equal(body.nas.stale, false)
  assert.ok(body.alerts.some((a: string) => a.includes('POP-7TG-261116-01 (ค้าง 5 ไฟล์)')), body.alerts.join('\n'))
})

test('manifest เก่า = ด่าน NAS ของ worker ปิด → รายงานตาม worker (ไม่นับว่าค้าง NAS)', async () => {
  process.env.FOOTAGE_READY_WORKER_ENABLED = '1'
  nasRow = () => ({ manifest: { at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), folders: [] }, status: { folders: { 'POP-7TG-261116-01': { lastPending: 5 } } } })
  bookings = [agedBooking('POP-7TG-261116-01', 8)]
  const body = await (await GET(req())).json()
  assert.equal(body.nas.stale, true)
  assert.deepEqual(body.pending.agedOutNas, [])
  assert.deepEqual(body.pending.agedOut, ['POP-7TG-261116-01'])
})

test('อ่าน nas_sync_state ไม่ได้ → ไม่ล้มทั้งรายงาน แต่บรรทัด agedOut บอกว่าไม่รู้สถานะ NAS', async () => {
  process.env.FOOTAGE_READY_WORKER_ENABLED = '1'
  nasRow = () => { throw new Error('db hiccup') }
  bookings = [agedBooking('KND-KNF-260916-01', 10)]
  const res = await GET(req())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.nas.error, 'db hiccup')
  assert.ok(body.alerts.some((a: string) => a.includes('KND-KNF-260916-01') && a.includes('อ่านสถานะ NAS ไม่ได้ (db hiccup)')), body.alerts.join('\n'))
})

// r2 (M14) — no manifest at all is "NAS picture unknown", the same as stale: never `stale:false` (= a fresh read that
// found nothing pending), and statuses left without a manifest are not read (the worker's gate (d) is off without one)
test('ไม่มี manifest (agent ไม่เคยส่ง / แถวหาย) = stale ไม่ใช่ "NAS สด ไม่มีอะไรค้าง"', async () => {
  process.env.FOOTAGE_READY_WORKER_ENABLED = '1'
  bookings = [agedBooking('POP-7TG-261116-01', 8)]
  let body = await (await GET(req())).json()
  assert.deepEqual(body.nas, { manifestAt: null, stale: true, error: null }, 'no nas_sync_state row')

  nasRow = () => ({ manifest: null, status: { folders: { 'POP-7TG-261116-01': { lastPending: 5 } } } })
  body = await (await GET(req())).json()
  assert.deepEqual(body.nas, { manifestAt: null, stale: true, error: null }, 'row with statuses but no manifest')
  assert.deepEqual(body.pending.agedOutNas, [])
  assert.deepEqual(body.pending.agedOut, ['POP-7TG-261116-01'])
})
