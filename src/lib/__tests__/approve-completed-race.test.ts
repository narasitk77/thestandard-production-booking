// Maintenance 23 Nov 2026 — SPT-OTH-261106-02 (shoot 6 Nov, approved 8 Nov) stuck PENDING with no
// calendar event. Approve creates the event in the background and persists it with a CAS; a booking
// approved after its shoot day is auto-completed (booking-complete.ts, on every GET /api/bookings)
// while the event is being created, so the CAS — CONFIRMED only — missed, the route deleted the fresh
// event as a "duplicate" and nothing ever retried (the reconciler reads CONFIRMED rows only).
// COMPLETED now counts as still approved; a real state change (cancelled / deleted / event already
// attached) still drops the fresh event.
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let booking: any
let deleted: string[] = []
let duringCreate: (() => void) | null = null

const matches = (b: any, where: any) => Object.entries(where).every(([k, v]: [string, any]) =>
  v && typeof v === 'object' && 'in' in v ? v.in.includes(b[k]) : b[k] === v)

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findUnique: async () => booking && { ...booking },
        updateMany: async (a: any) => {
          if (!matches(booking, a.where)) return { count: 0 }
          Object.assign(booking, a.data)
          return { count: 1 }
        },
        update: async (a: any) => { Object.assign(booking, a.data); return { ...booking } },
      },
    },
  },
})
mock.module('../google-calendar', {
  namedExports: {
    createCalendarEvent: async () => { duringCreate?.(); return 'ev-new' },
    deleteCalendarEvent: async (id: string) => { deleted.push(id); return true },
  },
})
mock.module('../google-sheets', { namedExports: { updateBookingRow: async () => 'updated' } })
mock.module('../session', { namedExports: { requireConsole: async () => ({ email: 'admin@x.co', role: 'ADMIN' }) } })
mock.module('../ot-sync', { namedExports: { syncBookingOT: async () => ({ created: 0 }) } })
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../email', { namedExports: { sendBookingConfirmedEmail: async () => {}, sendAssignmentEmail: async () => {} } })
mock.module('../google-token', { namedExports: { getValidGoogleAccessToken: async () => null } })
mock.module('next-auth/jwt', { namedExports: { getToken: async () => null } })
mock.module('../google-drive', {
  namedExports: {
    hasDriveCredentials: () => false, ensureShootCameraFolders: async () => ({}), ensurePhotoAlbumFolder: async () => ({}),
    ensureSoundStagingFolder: async () => ({}), upsertTextFile: async () => {},
  },
})
mock.module('../drive-links', { namedExports: { rememberDriveLinks: async () => {} } })
mock.module('../landing-lifecycle', { namedExports: { ensureLandingAfterBox: async () => ({ ok: true }), shootIsImminentBkk: () => false } })
mock.module('../ops-alert', { namedExports: { alertOps: async () => ({ attempted: true, delivered: true }) } })

let POST: (r: any, ctx: any) => Promise<Response>
before(async () => { ({ POST } = await import('../../app/api/admin/[id]/approve/route')) })
beforeEach(() => {
  deleted = []; duringCreate = null
  booking = {
    id: 'b1', bookingCode: 'SPT-OTH-261106-02', status: 'REQUESTED', deletedAt: null, calendarEventId: null,
    shootDate: new Date('2026-11-06T00:00:00Z'), shootEndDate: null, callTime: '09:00', estimatedWrap: '12:00',
    createdByEmail: 'admin@x.co', assignedEmails: [], crewRequired: [], virtualProduction: false,
    outlet: { code: 'SPT', name: 'Sport' }, program: { code: 'OTH', name: 'Other' }, episodes: [], sheetRowIndex: 5,
  }
})

const approve = () => POST(new Request('https://probook.test/api/admin/b1/approve', { method: 'POST' }) as any, { params: { id: 'b1' } })
/** the calendar work runs after the response — wait until it settles */
const settle = async () => {
  for (let i = 0; i < 50 && booking.calendarSyncStatus === 'PENDING' && deleted.length === 0; i++) await new Promise(r => setImmediate(r))
}

test('approved after the shoot day: auto-complete lands mid-create → event kept, row OK (not deleted, not stuck PENDING)', async () => {
  duringCreate = () => { booking.status = 'COMPLETED' }   // GET /api/bookings → autoCompleteBookings
  const res = await approve()
  assert.equal(res.status, 200)
  await settle()
  assert.deepEqual(deleted, [], 'the fresh event must not be deleted for this race')
  assert.equal(booking.calendarEventId, 'ev-new')
  assert.equal(booking.calendarSyncStatus, 'OK')
  assert.equal(booking.status, 'COMPLETED', 'the approve path does not undo the auto-complete')
})

test('cancelled while the event was being created → the fresh event is still dropped', async () => {
  duringCreate = () => { booking.status = 'CANCELLED' }
  await approve()
  await settle()
  assert.deepEqual(deleted, ['ev-new'])
  assert.equal(booking.calendarEventId, null)
})

test('another path attached an event first → the fresh one is dropped as the duplicate', async () => {
  duringCreate = () => { booking.calendarEventId = 'ev-other' }
  await approve()
  await settle()
  assert.deepEqual(deleted, ['ev-new'])
  assert.equal(booking.calendarEventId, 'ev-other')
})
