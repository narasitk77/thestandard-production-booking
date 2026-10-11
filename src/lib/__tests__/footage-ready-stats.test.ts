import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// v1.266 — agedOut ของ /api/internal/footage-ready/stats ต้องมองย้อนไปไกลเท่ากับที่ตรวจฟุตเทจรายวันเดิน
// (FOOTAGE_INTEGRITY_DAYS, ค่าเริ่ม 30) — เดิม lookback+4 = 8 วัน ทำให้ AGN-260904-01 / EVT-EVF-260901-01 /
// KND-KNF-260916-01 (ถ่าย 1–16 ก.ย.) ไม่เคยขึ้นที่นี่ ทั้งที่ฟุตเทจอยู่บน Drive (เจอตอนตรวจมือ 11 ต.ค. 2569)
let bookingWhere: any = null
let bookings: any[] = []
mock.module('../db', {
  namedExports: {
    prisma: {
      auditLog: { findMany: async () => [] },
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
  bookingWhere = null; bookings = []
  delete process.env.FOOTAGE_INTEGRITY_DAYS
  delete process.env.FOOTAGE_READY_LOOKBACK_DAYS
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

test('ค่าเริ่ม: agedOut มองย้อน 30 วัน (เท่าตรวจฟุตเทจรายวัน) ไม่ใช่ lookback+4', async () => {
  process.env.FOOTAGE_READY_LOOKBACK_DAYS = '4'
  await GET(req())
  assert.equal(cutoffDays(), 30)
})

test('นับจากวันถ่ายวันสุดท้ายด้วย: งานหลายวันที่จบในหน้าต่างอยู่ในหน้าต่าง', async () => {
  await GET(req())
  assert.ok(bookingWhere.OR.some((c: any) => c.shootEndDate), 'ต้องมีเงื่อนไข shootEndDate')
  assert.equal(bookingWhere.shootDate, undefined, 'ห้ามกรองด้วย shootDate อย่างเดียว')
})

test('ตาม env ของ worker ตรวจฟุตเทจ · ?days= ที่ยาวกว่ายังชนะ', async () => {
  process.env.FOOTAGE_INTEGRITY_DAYS = '45'
  await GET(req())
  assert.equal(cutoffDays(), 45)

  process.env.FOOTAGE_INTEGRITY_DAYS = '30'
  await GET(req('?days=60'))
  assert.equal(cutoffDays(), 60)
})

test('เคส KND: ถ่าย 25 วันก่อน · cache เห็นฟุตเทจ → agedOut พร้อมชื่อใบ ให้คนกด 📣', async () => {
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
