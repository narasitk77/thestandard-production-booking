/**
 * maint 2026-11-08 (B5-ui) — GET /api/bookings list knobs: span=1 (multi-day
 * overlap), order=asc, and the `truncated` flag. Defaults must stay exactly as
 * before (Week Plan and every other caller rely on start-date + DESC).
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let findArgs: any = null
let rows: any[] = []
let total = 0
let ciRows: Array<{ id: string }> = [] // what assignedBookingIdsCI's $queryRaw returns
let rawCalls = 0
mock.module('../db', {
  namedExports: {
    prisma: {
      $queryRaw: async () => { rawCalls++; return ciRows }, // scope=mine case-insensitive crew lookup (my-bookings-scope.ts)
      booking: {
        findMany: async (a: any) => { findArgs = a; return rows },
        count: async () => total,
      },
    },
  },
})
mock.module('../session', { namedExports: { getSession: async () => ({ email: 'nat@thestandard.co', role: 'ADMIN' }) } })
mock.module('../booking-complete', { namedExports: { autoCompleteBookings: async () => 0 } })
mock.module('../create-booking', { namedExports: { createBookingFromPayload: async () => ({ ok: false, status: 500, error: 'x' }) } })
mock.module('../crew-names', {
  namedExports: {
    makeCrewNameResolver: async () => (e: string) => e,
    makeProducerNickResolver: async () => () => null,
    shortPersonName: () => '',
  },
})

let GET: (r: any) => Promise<Response>
before(async () => { ({ GET } = await import('../../app/api/bookings/route')) })
beforeEach(() => { findArgs = null; rows = []; total = 0; ciRows = []; rawCalls = 0 })
const get = async (qs: string) => {
  const r = await GET(new Request(`https://probook.test/api/bookings?${qs}`) as any)
  return { status: r.status, body: await r.json() as any }
}

test('default: start-date equality / range and shootDate DESC — unchanged', async () => {
  await get('date=2026-11-11')
  assert.deepEqual(findArgs.where.shootDate, new Date('2026-11-11'))
  assert.equal(findArgs.where.AND, undefined)
  assert.deepEqual(findArgs.orderBy, [{ shootDate: 'desc' }, { createdAt: 'desc' }])
  await get('from=2026-11-09&to=2026-11-16')
  assert.deepEqual(findArgs.where.shootDate, { gte: new Date('2026-11-09'), lt: new Date('2026-11-16') })
})

test('span=1&date=D → shootDate < D+1 AND (shootDate >= D OR shootEndDate >= D) — day 2 of a 3-day shoot matches (ui-5)', async () => {
  await get('date=2026-11-11&span=1')
  assert.equal(findArgs.where.shootDate, undefined)
  assert.deepEqual(findArgs.where.AND, [{
    AND: [
      { shootDate: { lt: new Date('2026-11-12') } },
      { OR: [{ shootDate: { gte: new Date('2026-11-11') } }, { shootEndDate: { gte: new Date('2026-11-11') } }] },
    ],
  }])
})

test('span=1 composes with scope=mine (top-level OR) and search (AND) without clobbering either', async () => {
  await get('scope=mine&search=PP-26&from=2026-11-08&span=1')
  assert.ok(Array.isArray(findArgs.where.OR), 'scope=mine OR kept')
  assert.equal(findArgs.where.AND.length, 2, 'search clause + span clause')
  assert.ok(findArgs.where.AND[0].OR.some((c: any) => c.bookingCode), 'search clause first')
  assert.deepEqual(findArgs.where.AND[1], { AND: [{ OR: [{ shootDate: { gte: new Date('2026-11-08') } }, { shootEndDate: { gte: new Date('2026-11-08') } }] }] })
})

test('order=asc → soonest first (ui-4)', async () => {
  await get('order=asc')
  assert.deepEqual(findArgs.orderBy, [{ shootDate: 'asc' }, { createdAt: 'asc' }])
})

test('truncated: true while rows remain past this page, false on the last page', async () => {
  rows = [{ id: 'a' }, { id: 'b' }]
  total = 5
  assert.equal((await get('limit=2')).body.truncated, true)
  rows = [{ id: 'e' }]
  assert.equal((await get('limit=2&page=3')).body.truncated, false)
  rows = [{ id: 'a' }]
  total = 1
  assert.equal((await get('limit=20')).body.truncated, false)
})

test('scope=mine includes bookings whose assignedEmails spell my address in another case (r2, bug-class 10)', async () => {
  ciRows = [{ id: 'bk-mixed-case' }]
  await get('scope=mine')
  assert.equal(rawCalls, 1, 'assignedBookingIdsCI ran')
  assert.ok(findArgs.where.OR.some((c: any) => c.id && Array.isArray(c.id.in) && c.id.in.includes('bk-mixed-case')),
    'the case-insensitive ids are an OR branch of scope=mine')
  assert.ok(findArgs.where.OR.some((c: any) => c.assignedEmails), 'the exact-case `has` branch is still there')
})

test('the case-insensitive lookup runs only for scope=mine', async () => {
  await get('limit=5')
  await get('scope=producer')
  assert.equal(rawCalls, 0)
})
