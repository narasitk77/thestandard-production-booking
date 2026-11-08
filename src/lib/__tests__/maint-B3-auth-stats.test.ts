import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// maint 2026-11-08 — two "error / cap looks like data" fixes in read endpoints:
//  - id-first-stats: a DB failure answered {ok:true, daily:[]}; the Hermes monitor reads
//    an empty daily as "quiet day" and resets its fail streak (bug-class 2).
//  - admin/reviews: per-team averages were computed from the take:1000 list while the
//    response rate came from full counts — two populations on one page (bug-class 4).
let auditErr: Error | null = null
let reviewRows: any[] = []
let groups: any[] = []
mock.module('../db', {
  namedExports: {
    prisma: {
      auditLog: { findMany: async () => { if (auditErr) throw auditErr; return [] } },
      shootReview: {
        findMany: async ({ take }: any) => reviewRows.slice(0, take),
        groupBy: async () => groups,
      },
      shootReviewInvite: { count: async () => 0 },
      booking: { findMany: async () => [] },
    },
  },
})
mock.module('../session', { namedExports: { getSession: async () => ({ email: 'boss@thestandard.co', role: 'ADMIN' }) } })
mock.module('../review-access', { namedExports: { canReadReviewContent: () => true } })

let statsGET: () => Promise<Response>
let reviewsGET: (r: any) => Promise<Response>
before(async () => {
  ;({ GET: statsGET } = await import('../../app/api/internal/id-first-stats/route'))
  ;({ GET: reviewsGET } = await import('../../app/api/admin/reviews/route'))
})
beforeEach(() => { auditErr = null; reviewRows = []; groups = [] })

test('id-first-stats: DB read failure = 500 ok:false, never ok:true + empty daily', async () => {
  auditErr = new Error('connection terminated')
  const res = await statsGET()
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.equal(body.daily, undefined)
  assert.ok(!JSON.stringify(body).includes('connection terminated'), 'unauthenticated endpoint must not leak DB errors')
})

test('id-first-stats: healthy read still ok:true', async () => {
  const res = await statsGET()
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
})

test('admin/reviews: summary covers the whole window, not the capped list; truncated is flagged', async () => {
  // 1,200 rows in the window — the newest 1,000 (listed) all score 5, the 200 older score 1
  reviewRows = Array.from({ length: 1200 }, (_, i) => ({
    id: `r${i}`, bookingId: 'b', bookingCode: 'X', shootDate: null, raterEmail: 'a', raterRole: 'producer',
    targetRole: 'camera', score: i < 1000 ? 5 : 1, scores: null, comment: null, createdAt: new Date(),
  }))
  groups = [{ targetRole: 'camera', _count: { _all: 1200 }, _avg: { score: (1000 * 5 + 200) / 1200 } }]
  const body = await (await reviewsGET(new Request('https://probook.test/api/admin/reviews?days=365') as any)).json()
  assert.equal(body.reviews.length, 1000)
  assert.deepEqual(body.summary, [{ role: 'camera', count: 1200, average: 4.33 }])
  assert.equal(body.total, 1200)
  assert.equal(body.truncated, true)
})
