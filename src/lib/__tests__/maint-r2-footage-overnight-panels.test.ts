import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// maint r2 2026-11-08 (footage) — isShootOver needs callTime to see an overnight single-day shoot (wrap ≤ call ends
// the NEXT day). Two read panels built the object without it, so an overnight shoot counted as over on its own
// shoot day's morning: /api/internal/footage-ready/stats listed it as pending, /api/admin/monitor as due for review.
//
// Fixture: shootDate = today (BKK), call 23:59, wrap 00:00 → with callTime the last day is tomorrow (not over, any
// time of day); without it the last day is today and every time of day is ≥ 00:00 (over). Deterministic.

let bookings: any[] = []
let bookingSelect: any = null
let session: any = null

mock.module('../db', {
  namedExports: {
    prisma: {
      auditLog: { findMany: async () => [], findFirst: async () => null },
      booking: {
        findMany: async ({ select }: any) => { bookingSelect = select; return bookings },
        count: async () => 0,
      },
      feedbackTicket: { findMany: async () => [] },
      teamMember: { findMany: async () => [] },
      shootReviewInvite: { findMany: async () => [] },
      shootReview: { findMany: async () => [] },
    },
  },
})
mock.module('../session', { namedExports: { getSession: async () => session } })

let statsGET: (r: any) => Promise<Response>
let monitorGET: () => Promise<Response>
before(async () => {
  process.env.FOOTAGE_READY_SECRET = 'stats-secret'
  ;({ GET: statsGET } = await import('../../app/api/internal/footage-ready/stats/route'))
  ;({ GET: monitorGET } = await import('../../app/api/admin/monitor/route'))
})
beforeEach(() => { bookings = []; bookingSelect = null; session = null })

function todayBkk(): Date {
  const bkk = new Date(Date.now() + 7 * 3_600_000)
  return new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()))
}
const overnight = (code: string, callTime: string | null) => ({
  id: code, bookingCode: code, shootDate: todayBkk(), shootEndDate: null, estimatedWrap: '00:00', callTime,
})

test('r2: footage-ready/stats — งานข้ามคืนที่ยังไม่จบไม่ขึ้นเป็น pending · select มี callTime', async () => {
  const withFootage = { readyCheckedAt: null, footageCache: { fileCount: 3 }, footageCacheAt: new Date(), readySnapshot: null, program: { code: 'TSS' }, episodes: [] }
  bookings = [
    { ...overnight('NIGHT-01', '23:59'), ...withFootage },
    { ...overnight('NOCALL-01', null), ...withFootage }, // control: no callTime = the old same-day reading
  ]
  const res = await statsGET(new Request('https://probook.test/api/internal/footage-ready/stats', { headers: { 'x-footage-ready-secret': 'stats-secret' } }) as any)
  const body: any = await res.json()
  assert.equal(bookingSelect.callTime, true)
  assert.ok(!body.pending.waiting.includes('NIGHT-01'), 'ถ่ายคืนนี้ถึงตีหนึ่ง = ยังไม่จบ')
  assert.ok(body.pending.waiting.includes('NOCALL-01'), 'control: เทสต้องแยกได้จริง')
})

test('r2: admin/monitor — งานข้ามคืนที่ยังไม่จบไม่ถูกนับว่าถึงคิวรีวิว · select มี callTime', async () => {
  session = { role: 'ADMIN', email: 'narasit.k@thestandard.co' } // default activity reader
  const people = { status: 'CONFIRMED', deletedAt: null, producerEmail: null, createdByEmail: null, assignedEmails: [], mainVideographerEmail: null, crewRequired: [], program: { name: 'P' }, outlet: { name: 'O' } }
  bookings = [
    { ...overnight('NIGHT-02', '23:59'), ...people },
    { ...overnight('NOCALL-02', null), ...people },
  ]
  const body: any = await (await monitorGET()).json()
  assert.equal(bookingSelect.callTime, true)
  const codes = body.reviews.today.map((r: any) => r.code)
  assert.ok(!codes.includes('NIGHT-02'))
  assert.ok(codes.includes('NOCALL-02'), 'control: เทสต้องแยกได้จริง')
})
