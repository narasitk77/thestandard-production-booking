// v1.290 r2 — 📣 preview (POST /api/bookings/:id/notify-ready?preview=1) must not hide a stale MEDIAPRO hold.
// It used to return held:null whenever the footage changed after the sweep held it — NWS-KYM-261026-01 went from
// 20 files to 1,019 (editors' exports), MEDIAPRO was still missing, and the confirm dialog showed no warning.
// Harness: same mocks as maint-B2a-booking-routes.test.ts.
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let booking: any
let sent = 0
mock.module('../db', {
  namedExports: {
    prisma: {
      booking: { findUnique: async () => booking, update: async () => { throw new Error('preview must not write') } },
      upload: { findMany: async () => [] },
      user: { findMany: async () => [] },
    },
  },
})
mock.module('../session', {
  namedExports: { getSession: async () => ({ email: 'crew@x.co', role: 'USER' }), canUploadToBooking: async () => ({ ok: true }) },
})
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../email', { namedExports: { isEmailConfigured: () => true, sendEmail: async () => { sent++; return {} } } })
// what the walk sees now: 1,019 files / 9e11 bytes
mock.module('../footage-folders', {
  namedExports: {
    getCachedFootagePayload: async () => ({ folders: [{ label: 'EP01', fileCount: 1019, totalBytes: 9e11, url: 'u' }], fileCount: 1019, bookingFolderUrl: null }),
  },
})
mock.module('../footage-report', { namedExports: { formatBytes: (n: number) => `${n} B` } })
mock.module('../footage-ready', {
  namedExports: {
    footageReadyRecipients: () => ({ people: ['pro@x.co'], inactive: [] }),
    inactiveUserEmails: async () => new Set(),
    markReadyOnCalendarWithin: async () => ({ ok: true, state: 'marked' }),
  },
})
mock.module('../ingest', { namedExports: { CARD_PREFIX: 'CARD_' } })

let notifyReady: any
before(async () => { notifyReady = (await import('../../app/api/bookings/[id]/notify-ready/route')).POST })

const HELD = { detail: 'ขาด MEDIAPRO.XML 2 การ์ด', at: '2026-10-27T05:00:00.000Z', fileCount: 20, totalBytes: 2e10 }
beforeEach(() => {
  sent = 0
  booking = {
    id: 'b1', bookingCode: 'NWS-KYM-261026-01', status: 'CONFIRMED', deletedAt: null, driveFolders: {}, readySnapshot: null,
    assignedEmails: ['crew@x.co'], createdByEmail: 'pro@x.co', producer: 'Pro', producerEmail: 'pro@x.co', coProducerEmail: null,
    directorEmail: null, director2Email: null, director3Email: null, crewRequired: [], projectId: null, projectName: 'Show',
    category: null, callTime: '09:00', shootDate: new Date('2026-10-26T00:00:00Z'),
    outlet: { code: 'NWS', name: 'NWS' }, program: { name: 'KYM' }, episodes: [],
  }
})
const preview = async () => {
  const r = new Request('https://probook.test/api/bookings/b1/notify-ready?preview=1', { method: 'POST', body: '{}' }) as any
  r.nextUrl = new URL(r.url)
  const res = await notifyReady(r, { params: { id: 'b1' } })
  assert.equal(res.status, 200)
  return res.json()
}

test('preview: footage changed since the hold → the hold comes back flagged stale (never hidden), with the code', async () => {
  booking.readySnapshot = { held: HELD }
  const body = await preview()
  assert.deepEqual(body.held, { ...HELD, stale: true })
  assert.equal(body.code, 'NWS-KYM-261026-01')
  assert.equal(sent, 0)
})

test('preview: hold still matches the footage → returned as before, not stale', async () => {
  booking.readySnapshot = { held: { ...HELD, fileCount: 1019, totalBytes: 9e11 } }
  assert.deepEqual((await preview()).held, { ...HELD, fileCount: 1019, totalBytes: 9e11 })
})

test('preview: never held → held:null (shape unchanged)', async () => {
  const body = await preview()
  assert.equal(body.held, null)
  assert.deepEqual(body.recipients, ['pro@x.co', 'crew@x.co'])
})
