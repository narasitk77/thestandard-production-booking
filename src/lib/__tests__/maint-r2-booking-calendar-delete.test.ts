// maint 2026-11-08 R2 (booking) — deleteCalendarEvent: Google answers 410 Gone
// for an event that is ALREADY deleted. Counting that as a failure kept every
// such cancelled row FAILED forever (sweep retried every 10 min + ops alerts).
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let deleteError: any = null
mock.module('googleapis', {
  namedExports: {
    google: {
      calendar: () => ({ events: { delete: async () => { if (deleteError) throw deleteError; return {} } } }),
      auth: { JWT: class {} },
    },
  },
})

// getCalendarAuth logs an impersonation-fallback audit row — keep it off any real DB
mock.module('../audit', { namedExports: { logAudit: async () => {} } })

let mod: typeof import('../google-calendar')
before(async () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'sa@x.iam.gserviceaccount.com'
  mod = await import('../google-calendar')
})
beforeEach(() => { deleteError = null })

test('deleted OK → true', async () => {
  assert.equal(await mod.deleteCalendarEvent('ev1'), true)
})

test('410 Gone (already deleted) → true', async () => {
  deleteError = Object.assign(new Error('Resource has been deleted'), { code: 410 })
  assert.equal(await mod.deleteCalendarEvent('ev1'), true)
  deleteError = { response: { status: 410 } }
  assert.equal(await mod.deleteCalendarEvent('ev1'), true)
})

test('404 → true (unchanged)', async () => {
  deleteError = Object.assign(new Error('Not Found'), { code: 404 })
  assert.equal(await mod.deleteCalendarEvent('ev1'), true)
})

test('429 / 500 → false (the event may still be on everyone\'s calendar)', async () => {
  deleteError = Object.assign(new Error('Rate Limit'), { code: 429 })
  assert.equal(await mod.deleteCalendarEvent('ev1'), false)
  deleteError = Object.assign(new Error('backend'), { code: 500 })
  assert.equal(await mod.deleteCalendarEvent('ev1'), false)
})
