/**
 * Maintenance 2026-11-08 — syncBookingOT / clearBookingOT used to deleteMany every OT
 * row of a booking (no status filter) and recreate DRAFTs. Any admin save of the
 * booking (the edit form always sends callTime), assign, approve or restore wiped
 * SUBMITTED/APPROVED rows with their signatures; in a closed month the new DRAFT can
 * never be submitted again, so the approved OT was gone for good.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

type Row = {
  id: string; userEmail: string; month: string; approvalStatus: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'
  date: Date; endDate: Date | null; startTime: string | null; endTime: string | null; bookingId: string
}
let rows: Row[] = []
let booking: any = null
let nextId = 1

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: { findUnique: async () => booking },
      oTRecord: {
        findMany: async ({ where }: any) => rows.filter(r => r.bookingId === where.bookingId),
        deleteMany: async ({ where }: any) => {
          const ids = new Set<string>(where.id?.in ?? rows.filter(r => r.bookingId === where.bookingId).map(r => r.id))
          const before = rows.length
          rows = rows.filter(r => !ids.has(r.id))
          return { count: before - rows.length }
        },
        createMany: async ({ data }: any) => {
          for (const d of data) rows.push({ id: `new${nextId++}`, approvalStatus: 'DRAFT', ...d })
          return { count: data.length }
        },
      },
    },
  },
})

let planBookingOTSync: typeof import('../ot-sync').planBookingOTSync
let syncBookingOT: typeof import('../ot-sync').syncBookingOT
let clearBookingOT: typeof import('../ot-sync').clearBookingOT
before(async () => {
  ;({ planBookingOTSync, syncBookingOT, clearBookingOT } = await import('../ot-sync'))
})

// "Today" is 2026-11-08 Bangkok → only 2026-11 is editable.
beforeEach(() => {
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T05:00:00Z').getTime() })
  rows = []
  nextId = 1
})

const OCT = new Date('2026-10-20T00:00:00Z')
const NOV = new Date('2026-11-20T00:00:00Z')
const mkBooking = (shootDate: Date, over: any = {}) => ({
  id: 'b1', status: 'COMPLETED', deletedAt: null, shootDate,
  callTime: '09:00', estimatedWrap: '20:00',
  assignedEmails: ['cam@thestandard.co', 'snd@thestandard.co', 'video@thestandard.co'],
  outlet: { code: 'NWS' }, program: { code: 'KYM' }, episodes: [],
  ...over,
})
const signed = (id: string, email: string, status: Row['approvalStatus'], date: Date, start = '09:00', end = '20:00'): Row => ({
  id, userEmail: email, month: date.toISOString().slice(0, 7), approvalStatus: status,
  date, endDate: null, startTime: start, endTime: end, bookingId: 'b1',
})

test('admin re-saves a COMPLETED Oct booking unchanged → APPROVED/SUBMITTED rows survive, DRAFT regenerated', async () => {
  booking = mkBooking(OCT)
  rows = [
    signed('a1', 'cam@thestandard.co', 'APPROVED', OCT),
    signed('d1', 'snd@thestandard.co', 'DRAFT', OCT),
  ]
  const r = await syncBookingOT('b1')
  assert.equal(r.kept, 1)
  assert.equal(r.created, 1, 'only the DRAFT person is recreated; video@ is never a person')
  const a1 = rows.find(x => x.id === 'a1')
  assert.ok(a1, 'the approved row must not be deleted')
  assert.equal(a1!.approvalStatus, 'APPROVED')
  assert.equal(rows.filter(x => x.userEmail === 'cam@thestandard.co').length, 1, 'no duplicate DRAFT next to the kept row')
  assert.ok(!rows.some(x => x.id === 'd1'), 'old DRAFT replaced')
})

test('closed month + booking times changed → signed row kept (stale), never replaced by an unsubmittable DRAFT', async () => {
  booking = mkBooking(OCT, { estimatedWrap: '22:00' })
  rows = [signed('a1', 'cam@thestandard.co', 'APPROVED', OCT)]
  const warn = mock.method(console, 'warn', () => {})
  try {
    await syncBookingOT('b1')
  } finally { warn.mock.restore() }
  assert.ok(rows.some(x => x.id === 'a1'))
  assert.equal(rows.filter(x => x.userEmail === 'cam@thestandard.co').length, 1)
  assert.equal(warn.mock.callCount(), 1, 'a kept-but-stale signed row is logged')
})

test('open month + times changed → unchanged behaviour: signed row replaced by DRAFT so the crew re-signs', async () => {
  booking = mkBooking(NOV, { estimatedWrap: '22:00' })
  rows = [signed('s1', 'cam@thestandard.co', 'SUBMITTED', NOV)]
  await syncBookingOT('b1')
  assert.ok(!rows.some(x => x.id === 's1'))
  const cam = rows.filter(x => x.userEmail === 'cam@thestandard.co')
  assert.equal(cam.length, 1)
  assert.equal(cam[0].approvalStatus, 'DRAFT')
  assert.equal(cam[0].endTime, '22:00')
})

test('adding a crew member (assign) does not touch the others\' signed rows', async () => {
  booking = mkBooking(NOV, { assignedEmails: ['cam@thestandard.co', 'new@thestandard.co'] })
  rows = [signed('s1', 'cam@thestandard.co', 'SUBMITTED', NOV)]
  const r = await syncBookingOT('b1')
  assert.ok(rows.some(x => x.id === 's1'))
  assert.equal(r.created, 1)
  assert.ok(rows.some(x => x.userEmail === 'new@thestandard.co' && x.approvalStatus === 'DRAFT'))
})

test('clearBookingOT (soft-delete / cancel): closed-month signed rows kept, everything else deleted', async () => {
  rows = [
    signed('a1', 'cam@thestandard.co', 'APPROVED', OCT),
    signed('d1', 'snd@thestandard.co', 'DRAFT', OCT),
    signed('s2', 'x@thestandard.co', 'SUBMITTED', NOV),
  ]
  const warn = mock.method(console, 'warn', () => {})
  let r
  try { r = await clearBookingOT('b1') } finally { warn.mock.restore() }
  assert.deepEqual(rows.map(x => x.id), ['a1'])
  assert.deepEqual(r, { deleted: 2, kept: 1 })
})

test('soft-delete then restore of a closed-month booking keeps the APPROVED row (round trip)', async () => {
  rows = [signed('a1', 'cam@thestandard.co', 'APPROVED', OCT)]
  const warn = mock.method(console, 'warn', () => {})
  try {
    booking = mkBooking(OCT, { deletedAt: new Date() })
    await syncBookingOT('b1') // deleted booking → clear path
    booking = mkBooking(OCT) // restored
    await syncBookingOT('b1')
  } finally { warn.mock.restore() }
  assert.equal(rows.find(x => x.id === 'a1')?.approvalStatus, 'APPROVED')
  assert.equal(rows.filter(x => x.userEmail === 'cam@thestandard.co').length, 1)
})

test('planBookingOTSync: a jobTask relabel alone never discards a signature (only pay fields compared)', () => {
  const d = { userEmail: 'cam@thestandard.co', month: '2026-11', date: NOV, endDate: null, startTime: '09:00', endTime: '20:00', jobTask: '[Auto] OTHER·X', justification: 'j' }
  const plan = planBookingOTSync([signed('s1', 'cam@thestandard.co', 'SUBMITTED', NOV)], [d], () => true)
  assert.deepEqual(plan.deleteIds, [])
  assert.deepEqual(plan.create, [])
  assert.equal(plan.kept[0].stale, false)
})
