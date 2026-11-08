/**
 * Maintenance 2026-11-08 — /api/internal/usage OT funnel:
 *  - hoursApproved / perPerson.hours summed the legacy `hours` column (@default(0),
 *    written by nothing) → always 0.
 *  - "edited" counted submit/approve (updateMany bumps updatedAt) and auto rows the
 *    user cannot edit at all (PATCH 400) as draft edits.
 */
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'

const T0 = new Date('2026-11-01T02:00:00Z')
const later = (min: number) => new Date(T0.getTime() + min * 60_000)
const row = (over: any) => ({
  userEmail: 'cam@thestandard.co', createdAt: T0, updatedAt: T0, submittedAt: null, approvedAt: null,
  approvalStatus: 'DRAFT', date: new Date('2026-11-07T00:00:00Z'), endDate: null,
  startTime: '09:00', endTime: '20:00', bookingId: 'b1', ...over,
})
let ot: any[] = []
mock.module('../db', {
  namedExports: {
    prisma: {
      pageEvent: { findMany: async () => [] },
      oTRecord: { findMany: async () => ot },
    },
  },
})
mock.module('../session', { namedExports: { getSession: async () => ({ email: 'boss@thestandard.co', role: 'ADMIN' }) } })

let GET: (r: any) => Promise<Response>
before(async () => { ({ GET } = await import('../../app/api/internal/usage/route')) })

test('hours come from start/end (overnight included); submit/approve are not "edits"', async () => {
  ot = [
    // auto row, submitted then approved — never edited by anyone
    row({ approvalStatus: 'APPROVED', submittedAt: later(10), approvedAt: later(60), updatedAt: later(60) }),
    // manual overnight row the user really edited after creating it, then left as draft
    row({ bookingId: null, startTime: '22:00', endTime: '02:00', endDate: new Date('2026-11-08T00:00:00Z'), updatedAt: later(30) }),
  ]
  const body = await (await GET(new Request('https://probook.test/api/internal/usage?month=2026-11') as any)).json()
  assert.equal(body.ot.records.hoursApproved, 11)
  assert.equal(body.ot.perPerson[0].hours, 15)
  assert.equal(body.ot.records.edited, 1)
  assert.equal(body.ot.funnel.edited, 1)
})
