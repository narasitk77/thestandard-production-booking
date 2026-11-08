// 2026-11-08 maintenance — post-shoot survey silently dropped jobs.
//
// Prod runs lookback=1 · max=3/run while 5–7 jobs finish a day. Jobs over the cap
// were logged "deferred to the next run", but a job whose last shoot day is the
// window's OLDEST day is outside tomorrow's window: never surveyed (13 jobs
// 22 ต.ค.–3 พ.ย. without one invite row). The run must call those `dropped` and
// alert ops, and spend the cap on the jobs closest to leaving the window first
// (ordering by shootDate put a multi-day job that ended yesterday ahead of them).
// Also: the route now accepts any configured secret (internal-auth), so a
// RECONCILE_SECRET that only one container has no longer 403s the worker.
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'
import { startOfTodayBangkok } from '../bangkok-day'
import { dueWindow } from '../shoot-review'

const { from, to } = dueWindow(startOfTodayBangkok(), 1, 1)
const crew = {
  status: 'COMPLETED', deletedAt: null,
  producerEmail: 'pd@thestandard.co', createdByEmail: 'pd@thestandard.co',
  assignedEmails: ['cam@thestandard.co', 'snd@thestandard.co'],
  mainVideographerEmail: 'cam@thestandard.co', crewRequired: ['Videographer', 'Sound'],
  program: { name: 'รายการ' }, outlet: { name: 'NWS' }, episodes: [],
}
const day = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)
// returned in shootDate order, exactly as the old `orderBy: { shootDate: 'asc' }` did
const BOOKINGS = [
  { ...crew, id: 'm', bookingCode: 'MULTI-ENDS-TO', shootDate: day(from, -3), shootEndDate: to },
  { ...crew, id: 'b', bookingCode: 'ONE-DAY-FROM-1', shootDate: from, shootEndDate: null },
  { ...crew, id: 'c', bookingCode: 'ONE-DAY-FROM-2', shootDate: from, shootEndDate: null },
]
const invitedFor: string[] = []
mock.module('../db', {
  namedExports: {
    prisma: {
      booking: { findMany: async () => BOOKINGS.map((b) => ({ ...b })) },
      teamMember: {
        findMany: async () => [
          { email: 'cam@thestandard.co', role: 'video' }, { email: 'snd@thestandard.co', role: 'sound' },
          { email: 'pd@thestandard.co', role: 'producer' },
        ],
      },
      shootReviewInvite: {
        findMany: async () => [],
        create: async (args: any) => {
          if (!invitedFor.includes(args.data.bookingId)) invitedFor.push(args.data.bookingId)
          return { id: `i-${invitedFor.length}`, token: 't' }
        },
        update: async () => ({}),
      },
    },
  },
})
mock.module('../email', { namedExports: { sendEmail: async () => ({}), isEmailConfigured: () => false } })
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../heartbeat', { namedExports: { recordHeartbeat: async () => {} } })
mock.module('../booking-complete', { namedExports: { autoCompleteBookings: async () => 0 } })
const alerts: { key: string; text: string }[] = []
mock.module('../ops-alert', {
  namedExports: { alertOps: async (key: string, _s: string, text: string) => { alerts.push({ key, text }); return {} } },
})

let POST: (r: any) => Promise<Response>
before(async () => {
  Object.assign(process.env, {
    SHOOT_REVIEW_ENABLED: '1', SHOOT_REVIEW_DELAY_DAYS: '1', SHOOT_REVIEW_LOOKBACK_DAYS: '1',
    SHOOT_REVIEW_MAX_BOOKINGS: '1', AUTH_SECRET: 'auth-only-secret',
  })
  delete process.env.RECONCILE_SECRET
  delete process.env.NEXTAUTH_SECRET
  ;({ POST } = await import('../../app/api/internal/shoot-reviews/send/route'))
})

const req = (secret: string) =>
  new Request('https://probook.test/api/internal/shoot-reviews/send?dryRun=0', {
    method: 'POST', headers: { 'x-reconcile-secret': secret },
  }) as any

test('wrong secret is still refused', async () => {
  assert.equal((await POST(req('nope'))).status, 403)
})

test('over-cap job about to leave the window is reported dropped + alerted; the cap goes to it first', async () => {
  const quiet = { log: console.log, error: console.error }
  console.log = () => {}
  console.error = () => {}
  let body: any
  try {
    const res = await POST(req('auth-only-secret'))  // the worker's AUTH_SECRET fallback must be accepted
    assert.equal(res.status, 200)
    body = await res.json()
  } finally {
    console.log = quiet.log
    console.error = quiet.error
  }
  assert.deepEqual(invitedFor, ['b'], 'the cap goes to a job whose last day is the window\'s oldest')
  assert.equal(body.deferred, 2)
  assert.deepEqual(body.dropped, ['ONE-DAY-FROM-2'], 'MULTI-ENDS-TO is still in tomorrow\'s window — not dropped')
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].key, 'shoot-review-dropped')
  assert.match(alerts[0].text, /ONE-DAY-FROM-2/)
})
