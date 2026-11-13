// maint 2026-11-08 (B2a) — write gates + delivery honesty on /api/bookings/:id/*
//  - notify-ready: readyNotifiedAt is stamped only when mail actually went out
//    (a failed 📣 used to suppress the auto footage-ready notice forever)
//  - request-cancel / equipment-request: any signed-in user may still file (prod;
//    "people on the booking only" is Nat's open decision) — an outsider, a
//    replaced request and a loan on a CANCELLED booking are made loud instead
//  - merge (R3): no MOVE into a cancelled / soft-deleted booking; ASSIGNED /
//    REQUESTED merge as in prod, with a warning that the hourly worker skips them
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let session: any
let booking: any
let bookingUpdates: any[] = []
let loans: any[] = []
let audits: any[] = []
let sent: string[] = []
let mails: any[] = []
let failFor: Set<string> = new Set()
let emailConfigured = true
let mergeStarted = 0

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findUnique: async () => booking,
        update: async (a: any) => { bookingUpdates.push(a); return { id: booking.id, ...a.data } },
      },
      upload: { findMany: async () => [] },
      user: { findMany: async () => [], findUnique: async () => ({ nickname: 'n', name: 'n' }) },
      equipment: { findMany: async ({ where }: any) => where.id.in.map((id: string) => ({ id, name: 'Cam', serialNumber: null, status: 'AVAILABLE', loanable: true })) },
      equipmentLoan: {
        findUnique: async () => null,
        create: async (a: any) => { loans.push(a); return { id: 'L1', ...a.data, items: [] } },
      },
    },
  },
})
mock.module('../session', {
  namedExports: {
    getSession: async () => session,
    canUploadToBooking: async () => ({ ok: true }),
  },
})
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { audits.push(a) } } })
mock.module('../email', {
  namedExports: {
    isEmailConfigured: () => emailConfigured,
    sendEmail: async (m: any) => { const to = m.to[0]; if (failFor.has(to)) throw new Error('SMTP 535'); sent.push(to); mails.push(m); return {} },
  },
})
mock.module('../footage-folders', {
  namedExports: {
    getCachedFootagePayload: async () => ({ folders: [{ label: 'EP01', fileCount: 3, totalBytes: 10, url: 'u' }], fileCount: 3, bookingFolderUrl: null }),
    clearFootageCache: () => {},
  },
})
mock.module('../footage-report', { namedExports: { formatBytes: (n: number) => `${n} B` } })
mock.module('../footage-ready', {
  namedExports: {
    footageReadyRecipients: () => ({ people: ['pro@x.co', 'crew@x.co'], inactive: [] }),
    inactiveUserEmails: async () => new Set(),
    markReadyOnCalendarWithin: async () => ({ ok: true, state: 'marked' }), // v1.288
  },
})
mock.module('../ingest', { namedExports: { CARD_PREFIX: 'CARD_' } })
mock.module('../booking-merge', {
  namedExports: {
    BOOKING_MERGE_SELECT: { id: true },
    runBookingMerge: async () => ({ dryRun: true }),
    startMergeJob: () => { mergeStarted += 1; return { running: true } },
    getMergeJobStatus: () => null,
  },
})

let notifyReady: any, requestCancel: any, equipmentRequest: any, merge: any
before(async () => {
  notifyReady = (await import('../../app/api/bookings/[id]/notify-ready/route')).POST
  requestCancel = (await import('../../app/api/bookings/[id]/request-cancel/route')).POST
  equipmentRequest = (await import('../../app/api/bookings/[id]/equipment-request/route')).POST
  merge = (await import('../../app/api/bookings/[id]/merge/route')).POST
})

const req = (url: string, body: any = {}) => {
  const r = new Request(`https://probook.test${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) as any
  r.nextUrl = new URL(r.url)
  return r
}
const params = { params: { id: 'b1' } }

beforeEach(() => {
  session = { email: 'crew@x.co', role: 'USER' }
  booking = {
    id: 'b1', bookingCode: 'TSS-TSS-261108-01', status: 'CONFIRMED', deletedAt: null, driveFolders: {}, readySnapshot: null,
    assignedEmails: ['crew@x.co'], createdByEmail: 'pro@x.co', producer: 'Pro', producerEmail: 'pro@x.co', coProducerEmail: null,
    directorEmail: null, director2Email: null, director3Email: null, crewRequired: [], projectId: null, projectName: 'Show',
    category: null, callTime: '09:00', shootDate: new Date('2026-11-08T00:00:00Z'), shootEndDate: null,
    outlet: { code: 'TSS', name: 'TSS' }, program: { name: 'TSS', code: 'TSS' }, episodes: [],
  }
  bookingUpdates = []; loans = []; audits = []; sent = []; mails = []; failFor = new Set(); emailConfigured = true; mergeStarted = 0
})

test('notify-ready: every send fails → 502, readyNotifiedAt NOT stamped, no "notified_ready" row', async () => {
  failFor = new Set(['pro@x.co', 'crew@x.co'])
  const res = await notifyReady(req('/api/bookings/b1/notify-ready'), params)
  assert.equal(res.status, 502)
  assert.ok(!bookingUpdates.some(u => 'readyNotifiedAt' in u.data), 'the auto notifier must still fire later')
  assert.ok(!audits.some(a => a.action === 'booking.notified_ready'))
  assert.ok(audits.some(a => a.action === 'booking.notify_ready_failed'))
})

test('notify-ready: email not configured → 503, nothing stamped', async () => {
  emailConfigured = false
  const res = await notifyReady(req('/api/bookings/b1/notify-ready'), params)
  assert.equal(res.status, 503)
  assert.deepEqual(bookingUpdates, [])
})

test('notify-ready: partial failure stamps, and the reply lists only who got it', async () => {
  failFor = new Set(['pro@x.co'])
  const res = await notifyReady(req('/api/bookings/b1/notify-ready'), params)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.deepEqual(body.recipients, ['crew@x.co'])
  assert.deepEqual(body.failedRecipients, ['pro@x.co'])
  await new Promise(r => setImmediate(r))
  assert.ok(bookingUpdates.some(u => 'readyNotifiedAt' in u.data))
})

test('request-cancel: someone not on the booking can still file (prod) — audit row + managers\' email name them as an outsider', async () => {
  process.env.CANCEL_NOTIFY_EMAIL = 'tui@x.co'
  try {
    session = { email: 'random@x.co', role: 'USER' }
    const res = await requestCancel(req('/api/bookings/b1/request-cancel', { reason: 'x' }), params)
    assert.equal(res.status, 200)
    assert.equal(bookingUpdates.length, 1)
    assert.equal(bookingUpdates[0].data.cancelRequestedBy, 'random@x.co')
    const a = audits.find(x => x.action === 'booking.cancel_requested')
    assert.ok(a, 'an audit row for every request')
    assert.equal(a.actorEmail, 'random@x.co')
    assert.equal(a.changes.requestedBy, 'random@x.co')
    assert.equal(a.changes.onBooking, false)
    await new Promise(r => setImmediate(r))
    assert.equal(mails.length, 1)
    assert.match(mails[0].text, /ไม่ได้อยู่ในรายชื่อของงานนี้/)
  } finally { delete process.env.CANCEL_NOTIFY_EMAIL }
})

test('request-cancel: replacing an earlier request keeps the earlier reason + requester in the audit row', async () => {
  booking.cancelRequestedAt = new Date('2026-11-07T03:00:00Z')
  booking.cancelReason = 'ลูกค้าเลื่อน'
  booking.cancelRequestedBy = 'pro@x.co'
  session = { email: 'random@x.co', role: 'USER' }
  assert.equal((await requestCancel(req('/api/bookings/b1/request-cancel', { reason: 'อื่น' }), params)).status, 200)
  const a = audits.find(x => x.action === 'booking.cancel_requested')
  assert.equal(a.changes.replaced.by, 'pro@x.co')
  assert.equal(a.changes.replaced.reason, 'ลูกค้าเลื่อน')
})

test('request-cancel: crew on the booking and console staff still can; crew is not flagged as an outsider', async () => {
  for (const s of [{ email: 'crew@x.co', role: 'USER' }, { email: 'admin@x.co', role: 'ADMIN' }]) {
    session = s; bookingUpdates = []; audits = []
    const res = await requestCancel(req('/api/bookings/b1/request-cancel', { reason: 'เลื่อน' }), params)
    assert.equal(res.status, 200, s.email)
    assert.equal(bookingUpdates.length, 1)
    assert.equal(audits.find(x => x.action === 'booking.cancel_requested').changes.onBooking, s.email === 'crew@x.co')
  }
})

test('request-cancel: closed bookings are still refused (unchanged)', async () => {
  booking.status = 'COMPLETED'
  assert.equal((await requestCancel(req('/api/bookings/b1/request-cancel', { reason: 'x' }), params)).status, 400)
  assert.deepEqual(bookingUpdates, [])
})

test('equipment-request: outsider and CANCELLED booking still open a loan (prod) — loudly', async () => {
  session = { email: 'random@x.co', role: 'USER' }
  let res = await equipmentRequest(req('/api/bookings/b1/equipment-request', { equipmentIds: ['e1'] }), params)
  assert.equal(res.status, 201)
  assert.equal((await res.json()).warning, undefined, 'a live booking needs no warning')
  assert.deepEqual(
    { onBooking: audits.at(-1).changes.onBooking, bookingStatus: audits.at(-1).changes.bookingStatus },
    { onBooking: false, bookingStatus: 'CONFIRMED' },
  )

  session = { email: 'crew@x.co', role: 'USER' }
  booking.status = 'CANCELLED'
  res = await equipmentRequest(req('/api/bookings/b1/equipment-request', { equipmentIds: ['e1'] }), params)
  assert.equal(res.status, 201)
  assert.match((await res.json()).warning, /ยกเลิก/)
  assert.equal(audits.at(-1).changes.bookingStatus, 'CANCELLED')
  assert.equal(audits.at(-1).changes.onBooking, true)
  assert.equal(loans.length, 2)
})

test('merge: CANCELLED / soft-deleted bookings never start a MOVE (dry run refused too)', async () => {
  for (const patch of [{ status: 'CANCELLED' }, { deletedAt: new Date() }]) {
    Object.assign(booking, { status: 'CONFIRMED', deletedAt: null }, patch)
    assert.equal((await merge(req('/api/bookings/b1/merge'), params)).status, 409, JSON.stringify(patch))
    assert.equal((await merge(req('/api/bookings/b1/merge?dryRun=1'), params)).status, 409)
  }
  assert.equal(mergeStarted, 0)
})

test('merge: ASSIGNED / REQUESTED merge as in prod, and the reply says the hourly worker skips them', async () => {
  for (const status of ['ASSIGNED', 'REQUESTED']) {
    Object.assign(booking, { status, deletedAt: null })
    const dry = await merge(req('/api/bookings/b1/merge?dryRun=1'), params)
    assert.equal(dry.status, 200, status)
    assert.match((await dry.json()).warning, /รายชั่วโมงไม่ดูแล/)
    const res = await merge(req('/api/bookings/b1/merge'), params)
    assert.equal(res.status, 202, status)
    assert.match((await res.json()).warning, /รายชั่วโมงไม่ดูแล/)
  }
  assert.equal(mergeStarted, 2)
})

test('merge: CONFIRMED / COMPLETED merge with no warning', async () => {
  for (const status of ['CONFIRMED', 'COMPLETED']) {
    Object.assign(booking, { status, deletedAt: null })
    const res = await merge(req('/api/bookings/b1/merge'), params)
    assert.equal(res.status, 202, status)
    assert.equal((await res.json()).warning, undefined)
  }
  assert.equal(mergeStarted, 2)
})
