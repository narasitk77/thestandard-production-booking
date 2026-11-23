// adversarial review 23 Nov 2026 — sheet-row-repair reads col A only while appendQueueIdle() is true.
// The counter must cover an append from the moment it is called (queued, not yet sent) until it
// settles, failure included — a leaked count would stop the repair for good, a missed one lets it
// read col A before a queued create-path append lands (= duplicate row).
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'

const pending: Array<{ resolve: (v: any) => void; reject: (e: any) => void }> = []
mock.module('googleapis', {
  namedExports: {
    google: {
      auth: { JWT: class {} },
      sheets: () => ({
        spreadsheets: {
          get: async () => ({ data: { sheets: [{ properties: { title: 'Bookings' } }] } }),
          batchUpdate: async () => ({}),
          values: {
            update: async () => ({}),
            append: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }) }),
          },
        },
      }),
    },
  },
})

let gs: typeof import('../google-sheets')
before(async () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'sa@test.iam'
  process.env.GOOGLE_PRIVATE_KEY = 'k'
  gs = await import('../google-sheets')
})

const row = (code: string): any => ({
  id: code, bookingCode: code, outlet: { name: 'O' }, program: { name: 'P' }, shootDate: new Date('2026-11-25T00:00:00Z'),
  callTime: '09:00', shootType: 'ON_LOCATION', producer: 'Pro', episodes: [], crewRequired: [], category: 'C', creative: [],
  status: 'REQUESTED', createdAt: new Date('2026-11-23T00:00:00Z'),
})
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise(r => setTimeout(r, 10))
  assert.ok(cond(), 'timed out waiting')
}

test('busy from the call (queued behind another append) until every append settles — a failed one included', async () => {
  assert.equal(gs.appendQueueIdle(), true)
  const first = gs.appendBookingRow(row('A-01'))
  const second = gs.appendBookingRow(row('B-01'))   // waits in the queue behind A-01
  assert.equal(gs.appendQueueIdle(), false)

  await until(() => pending.length === 1)
  pending.shift()!.resolve({ data: { updates: { updatedRange: 'Bookings!A10:AS10' } } })
  assert.equal(await first, 10)
  assert.equal(gs.appendQueueIdle(), false, 'B-01 is still queued')

  await until(() => pending.length === 1)   // the 1.1 s gap, then B-01 goes out
  const err = console.error
  console.error = () => {}
  try {
    pending.shift()!.reject(new Error('429 quota'))
    assert.equal(await second, null)
  } finally { console.error = err }
  assert.equal(gs.appendQueueIdle(), true)
})
