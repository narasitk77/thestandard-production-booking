/**
 * Maintenance 2026-11-08 — /api/mix/candidates sorted the -45..+60 day window by
 * shootDate desc and cut at 60: a producer with daily routine shoots kept the
 * furthest-future bookings and lost the shoots from 18–45 days ago — the ones that
 * actually need mixing ("งานมิกซ์เกิดหลังถ่าย").
 */
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'

const DAY = 86_400_000
let all: Array<{ id: string; shootDate: Date }> = []
let ciAssignedIds: string[] = []
const seenWhere: any[] = []

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        // honours the date filter / order / take the way Postgres would
        findMany: async ({ where, orderBy, take }: any) => {
          seenWhere.push(where)
          const c = where.shootDate
          let r = all.filter(b =>
            (!c.gte || b.shootDate >= c.gte) && (!c.gt || b.shootDate > c.gt) && (!c.lte || b.shootDate <= c.lte))
          r = r.sort((a, b) => (orderBy.shootDate === 'asc' ? 1 : -1) * (a.shootDate.getTime() - b.shootDate.getTime()))
          return r.slice(0, take)
        },
      },
      // assignedBookingIdsCI — ใบที่ assignedEmails สะกดตัวพิมพ์ต่างจากอีเมลล็อกอิน
      $queryRaw: async () => ciAssignedIds.map(id => ({ id })),
    },
  },
})
mock.module('../session', { namedExports: { getSession: async () => ({ email: 'prod@thestandard.co', role: 'USER' }) } })
mock.module('../mix-targets', {
  namedExports: {
    MIX_TARGET_SELECT: {},
    toMixTargetView: (b: any) => b,
    openMixJobsFor: async () => ({}),
  },
})

let GET: () => Promise<Response>
before(async () => { ({ GET } = await import('../../app/api/mix/candidates/route')) })

test('daily routine producer: every past shoot in the window is listed; the far future is what gets cut', async () => {
  const now = Date.now()
  all = []
  for (let d = 44; d >= 1; d--) all.push({ id: `past${d}`, shootDate: new Date(now - d * DAY) })
  for (let d = 1; d <= 59; d++) all.push({ id: `fut${d}`, shootDate: new Date(now + d * DAY) })

  const body = await (await GET()).json()
  const ids: string[] = body.bookings.map((b: any) => b.id)
  assert.equal(ids.length, 60)
  assert.ok(ids.includes('past44'), 'a shoot 44 days ago (waiting for its mix) must be offered')
  assert.ok(ids.includes('fut1') && ids.includes('fut16'), 'nearest upcoming shoots fill the rest')
  assert.ok(!ids.includes('fut17'), 'the furthest-future shoots are the ones cut')
  assert.equal(body.truncated, true)
  const times = body.bookings.map((b: any) => new Date(b.shootDate).getTime())
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'display order stays new→old')
})

test('exactly 60 bookings is not reported as truncated', async () => {
  const now = Date.now()
  all = Array.from({ length: 60 }, (_, i) => ({ id: `b${i}`, shootDate: new Date(now - (i + 1) * 12 * 3_600_000) }))
  const body = await (await GET()).json()
  assert.equal(body.bookings.length, 60)
  assert.equal(body.truncated, false)
})

test('crew stored as Prod@… (case differs from login) still sees the booking — class 10', async () => {
  all = []
  ciAssignedIds = ['b-mixed-case']
  seenWhere.length = 0
  await GET()
  assert.ok(seenWhere.length > 0)
  for (const w of seenWhere) {
    assert.ok(w.OR.some((c: any) => c.id?.in?.includes('b-mixed-case')),
      'the case-insensitive assigned ids must reach the scope=mine OR')
  }
  ciAssignedIds = []
})
