// maint 2026-11-08 R2 (booking) — cancel / delete / restore paths and the
// calendar event they leave behind:
//  - cancel (PATCH / DELETE / MCP): room, OT, sheet, audit run FIRST; the Google
//    delete runs LAST and a hung Calendar call cannot block the cleanup
//  - soft-delete / routine cancel never null calendarEventId themselves — the
//    helper clears it only once Google confirms the delete
//  - restore refuses only when the old event still cannot be removed
//  - hard delete is fail-closed on the calendar (the row is the last pointer)
//  - mark-upload-done flips COMPLETED but leaves the sheet Status alone (prod —
//    PMDC's Airtable sync reads that column; sending COMPLETED is Nat's decision)
//  - notify-ready counts delivery over the team, not the clicker's own CC
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let session: any
let booking: any
let rows: any[] = []
let order: string[] = []
let updateManys: any[] = []
let updates: any[] = []
let txRan = 0
let removeResult: boolean | 'hang' = true
let deleteResult = true
let failFor = new Set<string>()
let sent: string[] = []
let audits: any[] = []

const hang = () => new Promise<boolean>(() => {})

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findUnique: async () => booking && { ...booking },
        findFirst: async () => booking && { ...booking },
        findMany: async () => rows,
        update: async (a: any) => { order.push('db.update'); updates.push(a); return { ...booking, ...a.data } },
        updateMany: async (a: any) => {
          order.push('db.updateMany'); updateManys.push(a)
          return { count: a.where.status && booking && a.where.status !== booking.status ? 0 : 1 }
        },
        delete: () => ({}),
      },
      auditLog: { deleteMany: () => ({}) },
      footageLog: { deleteMany: () => ({}) },
      oTRecord: { deleteMany: () => ({}) },
      upload: { findMany: async () => [] },
      user: { findMany: async () => [] },
      $transaction: async (x: any) => {
        if (Array.isArray(x)) { txRan += 1; order.push('db.tx'); return [] }
        return x({
          booking: {
            updateMany: async (a: any) => { order.push('db.updateMany'); updateManys.push(a); Object.assign(booking, a.data); return { count: 1 } },
            update: async (a: any) => { updates.push(a); return { ...booking, ...a.data } },
          },
        })
      },
    },
  },
})
mock.module('../session', {
  namedExports: {
    getSession: async () => session,
    requireConsole: async () => session,
    requireAdmin: async () => session,
    canUploadToBooking: async () => ({ ok: true }),
  },
})
mock.module('../audit', {
  namedExports: {
    logAudit: async (a: any) => { order.push(`audit:${a.action}`); audits.push(a) },
    diffBooking: () => null,
  },
})
mock.module('../google-sheets', {
  namedExports: {
    updateBookingRow: async (code: string, fields: any) => { order.push(`sheet:${fields.status ?? Object.keys(fields).join(',')}`); return 'updated' },
    joinEpisodeTitles: (eps: any[]) => eps.map(e => e.title).join(' | '),
  },
})
mock.module('../calendar-reconcile', {
  namedExports: {
    removeCancelledBookingEvent: (id: string, ev: string) => {
      order.push(`calendar.remove:${id}:${ev}`)
      return removeResult === 'hang' ? hang() : Promise.resolve(removeResult)
    },
    pushCalendarDetails: async () => true,
  },
})
mock.module('../google-calendar', {
  namedExports: { deleteCalendarEvent: async (ev: string) => { order.push(`calendar.delete:${ev}`); return deleteResult } },
})
mock.module('../ot-sync', {
  namedExports: {
    clearBookingOT: async () => { order.push('ot.clear'); return 0 },
    syncBookingOT: async () => { order.push('ot.sync'); return { created: 0 } },
  },
})
mock.module('../room-booking-sync', {
  namedExports: {
    releaseRoomForBooking: () => { order.push('room.release') },
    resyncRoomForBooking: () => {},
    roomScheduleChanges: () => [],
    cancelRoomBookingFor: async () => ({ status: 'CANCELLED' }),
  },
})
mock.module('../email', {
  namedExports: {
    isEmailConfigured: () => true,
    sendEmail: async (m: any) => { const to = m.to[0]; if (failFor.has(to)) throw new Error('SMTP 550'); sent.push(to); return {} },
  },
})
mock.module('../footage-folders', {
  namedExports: {
    getCachedFootagePayload: async () => ({ folders: [{ label: 'EP01', fileCount: 3, totalBytes: 10, url: 'u' }], fileCount: 3, bookingFolderUrl: 'https://drive.google.com/drive/folders/1ResolvedBoxIdFromTheMail000' }),
    clearFootageCache: () => {},
  },
})
mock.module('../footage-report', { namedExports: { formatBytes: (n: number) => `${n} B` } })
let calendarMarks: any[] = []
let calendarFails = false
mock.module('../footage-ready', {
  namedExports: {
    footageReadyRecipients: () => ({ people: ['pro@x.co', 'cam@ext.co'], inactive: [] }),
    inactiveUserEmails: async () => new Set(),
    // v1.288 — the 📣 marks the calendar event; a failure is the sweep's to retry, never the click's
    markReadyOnCalendarWithin: async (b: any, _actor: string, box: string | null) => { calendarMarks.push({ ...b, boxOverride: box }); return calendarFails ? { ok: false, error: 'Google 500' } : { ok: true, state: 'marked' } },
  },
})
mock.module('../ingest', { namedExports: { CARD_PREFIX: 'CARD_' } })
mock.module('../crew-names', { namedExports: { resolveBookingCrew: async () => [] } })
mock.module('../shoot-marker', { namedExports: { refreshShootMarker: async () => {} } })
mock.module('../google-drive', { namedExports: { hasDriveCredentials: () => false } })
mock.module('../dashboard-episodes', { namedExports: { listProjectEpisodes: async () => ({ ok: true, episodes: [] }) } })
mock.module('../projects', { namedExports: { listProjects: async () => [] } })
mock.module('../create-booking', { namedExports: { createBookingFromPayload: async () => ({ ok: false, error: 'n/a' }) } })

let patch: any, del: any, softDelete: any, routine: any, restore: any, hardDelete: any, markDone: any, notifyReady: any, tools: any
before(async () => {
  ;({ PATCH: patch, DELETE: del } = await import('../../app/api/bookings/[id]/route'))
  softDelete = (await import('../../app/api/admin/[id]/soft-delete/route')).POST
  routine = (await import('../../app/api/admin/routine/route')).POST
  restore = (await import('../../app/api/admin/[id]/restore/route')).POST
  hardDelete = (await import('../../app/api/admin/[id]/delete/route')).POST
  markDone = (await import('../../app/api/admin/[id]/mark-upload-done/route')).POST
  notifyReady = (await import('../../app/api/bookings/[id]/notify-ready/route')).POST
  tools = (await import('../mcp/tools')).buildMcpRegistry()
})

const req = (body: any = {}) => {
  const r = new Request('https://probook.test/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) as any
  r.nextUrl = new URL(r.url)
  return r
}
const params = { params: { id: 'b1' } }
const tick = () => new Promise(r => setImmediate(r))
const idx = (s: string) => order.findIndex(o => o.startsWith(s))

beforeEach(() => {
  session = { email: 'admin@x.co', role: 'ADMIN' }
  booking = {
    id: 'b1', bookingCode: 'AGN-261108-01', status: 'CONFIRMED', deletedAt: null, calendarEventId: 'ev1', sheetRowIndex: 5,
    calendarSyncStatus: 'OK', approvedAt: new Date(), cancelReason: null, createdByEmail: 'pro@x.co',
    outlet: { code: 'AGN', name: 'Agency' }, program: { code: 'AGN', name: 'Agency' }, episodes: [],
    shootDate: new Date('2026-11-01T00:00:00Z'), shootEndDate: null, callTime: '09:00', estimatedWrap: '18:00',
    roomBookingNo: null, uploads: [], driveFolders: {}, readySnapshot: null, assignedEmails: ['cam@ext.co'],
    producer: 'Pro', producerEmail: 'pro@x.co', coProducerEmail: null, directorEmail: null, director2Email: null,
    director3Email: null, crewRequired: [], projectId: null, projectName: 'Show', category: null,
  }
  rows = []; order = []; updateManys = []; updates = []; txRan = 0; audits = []; sent = []
  removeResult = true; deleteResult = true; failFor = new Set()
})

test('PATCH cancel: room / OT / sheet / audit before the Google delete; a hung delete does not block', async () => {
  removeResult = 'hang'
  const res = await patch(req({ status: 'CANCELLED' }), params)
  assert.equal(res.status, 200, 'the reply must not wait on a hung Calendar call')
  const del = idx('calendar.remove')
  assert.ok(del > -1)
  for (const step of ['room.release', 'ot.clear', 'sheet:CANCELLED', 'audit:booking.status_change']) {
    assert.ok(idx(step) > -1 && idx(step) < del, `${step} runs before the Calendar delete`)
  }
})

test('DELETE cancel: same order, and the booking.delete audit row is not held up by Google', async () => {
  session = { email: 'pro@x.co', role: 'USER' }
  removeResult = 'hang'
  const res = await del(req(), params)
  assert.equal(res.status, 200)
  const d = idx('calendar.remove')
  for (const step of ['room.release', 'ot.clear', 'sheet:CANCELLED', 'audit:booking.delete']) {
    assert.ok(idx(step) > -1 && idx(step) < d, `${step} runs before the Calendar delete`)
  }
})

test('MCP cancel_booking: local cleanup first, delete last, failure still reported', async () => {
  removeResult = false
  const r = await tools.handlers.cancel_booking({ code: 'AGN-261108-01' })
  const d = idx('calendar.remove')
  for (const step of ['ot.clear', 'room.release', 'audit:booking.delete']) {
    assert.ok(idx(step) > -1 && idx(step) < d, `${step} runs before the Calendar delete`)
  }
  assert.match(r.warning, /could NOT be deleted/)
})

test('soft-delete: never nulls calendarEventId itself; the helper runs after the row is hidden', async () => {
  removeResult = 'hang'
  const res = await softDelete(req(), params)
  assert.equal(res.status, 200)
  const u = updates.find(x => 'deletedAt' in x.data)
  assert.equal('calendarEventId' in u.data, false)
  assert.ok(idx('db.update') < idx('calendar.remove:b1:ev1'), 'the sweep only sees it once deletedAt is set')
})

test('routine cancel: updateMany keeps the event ids; deletes run one by one afterwards', async () => {
  rows = [
    { id: 'r1', calendarEventId: 'e1', bookingCode: 'R-1', sheetRowIndex: 2 },
    { id: 'r2', calendarEventId: null, bookingCode: 'R-2', sheetRowIndex: 3 },
    { id: 'r3', calendarEventId: 'e3', bookingCode: 'R-3', sheetRowIndex: 4 },
  ]
  const res = await routine(req({ action: 'cancel', routineGroupId: 'g1' }))
  assert.equal(res.status, 200)
  assert.equal('calendarEventId' in updateManys[0].data, false)
  await tick(); await tick()
  assert.deepEqual(order.filter(o => o.startsWith('calendar.remove')), ['calendar.remove:r1:e1', 'calendar.remove:r3:e3'])
  assert.ok(idx('db.updateMany') < idx('calendar.remove'))
})

test('restore: old event cannot be removed → 409, booking untouched', async () => {
  booking.status = 'CANCELLED'
  removeResult = false
  const res = await restore(req(), params)
  assert.equal(res.status, 409)
  assert.deepEqual(updates, [])
})

test('restore: old event removed (or none) → REQUESTED', async () => {
  booking.status = 'CANCELLED'
  assert.equal((await restore(req(), params)).status, 200)
  assert.equal(updates[0].data.status, 'REQUESTED')
  booking.calendarEventId = null; order = []
  assert.equal((await restore(req(), params)).status, 200)
  assert.equal(idx('calendar.remove'), -1)
})

test('hard delete: Calendar delete failed → 409 and the row stays', async () => {
  deleteResult = false
  const res = await hardDelete(req(), params)
  assert.equal(res.status, 409)
  assert.equal(txRan, 0, 'never delete the last pointer to a live event')
  deleteResult = true
  assert.equal((await hardDelete(req(), params)).status, 200)
  assert.equal(txRan, 1)
})

test('mark-upload-done: flips the booking to COMPLETED; the sheet Status column is NOT written (prod)', async () => {
  booking.uploads = [
    { camera: 'CAM-A', status: 'COMPLETE', fileSize: 10 },
    { camera: 'SOUND', status: 'COMPLETE', fileSize: 10 },
  ]
  const res = await markDone(req(), params)
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.ok(updates.some(u => u.data?.status === 'COMPLETED'), 'the DB flip itself still happens')
  await new Promise(r => setImmediate(r))
  assert.equal(idx('sheet:'), -1, 'no sheet write of any kind — the Status column keeps CONFIRMED until Nat decides')
})

test("notify-ready: only the clicker's own CC got through → 502, not stamped", async () => {
  session = { email: 'admin@x.co', role: 'ADMIN' }
  failFor = new Set(['pro@x.co', 'cam@ext.co'])
  const res = await notifyReady(req(), params)
  assert.equal(res.status, 502)
  assert.deepEqual(sent, ['admin@x.co'])
  assert.ok(!updates.some(u => 'readyNotifiedAt' in u.data), 'the auto notice must still reach the crew later')
  assert.ok(audits.some(a => a.action === 'booking.notify_ready_failed'))
  assert.ok(!audits.some(a => a.action === 'booking.notified_ready'))
})

test('notify-ready: someone on the team got it → stamped (partial failure policy unchanged)', async () => {
  failFor = new Set(['cam@ext.co'])
  calendarMarks = []
  const res = await notifyReady(req(), params)
  assert.equal(res.status, 200)
  await tick()
  assert.ok(updates.some(u => 'readyNotifiedAt' in u.data))
  // v1.288 — ✅ on the event with the SAME instant that was stamped
  const stamp = updates.find(u => 'readyNotifiedAt' in u.data).data.readyNotifiedAt
  assert.equal(calendarMarks.length, 1)
  assert.equal(calendarMarks[0].readyNotifiedAt.getTime(), stamp.getTime())
  assert.equal(calendarMarks[0].boxOverride, '1ResolvedBoxIdFromTheMail000', 'the box the mail links to')
  assert.equal((await res.json()).calendar, 'marked')
})

test('notify-ready v1.288: calendar ✅ failing does not fail the 📣 (the sweep retries) · nobody reached = no ✅', async () => {
  failFor = new Set(['cam@ext.co'])
  calendarFails = true
  calendarMarks = []
  try {
    const res = await notifyReady(req(), params)
    assert.equal(res.status, 200)
    assert.equal((await res.json()).calendar, 'retry-later')
  } finally { calendarFails = false }
  calendarMarks = []
  failFor = new Set(['pro@x.co', 'cam@ext.co'])
  assert.equal((await notifyReady(req(), params)).status, 502)
  assert.equal(calendarMarks.length, 0, 'not announced → the event stays as it is')
})
