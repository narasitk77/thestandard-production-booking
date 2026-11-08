// 2026-11-08 maintenance — reminders digest that reached NO channel.
//
// SMTP dead (the 15 ต.ค. password reset) + no ops Discord/Lark → dispatched was
// {discord:false, lark:false, email:false}, yet the rows still flipped PENDING→SENT,
// the heartbeat stayed green and nothing alerted. Bug class 1: a record is not
// delivery. Undelivered = rows stay PENDING + alertOps (its audit row reaches the
// Hermes relay) + a `run failed` line for the Hermes log scan.
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const OPEN = [
  { id: 'r1', type: 'LOAN_OVERDUE', title: 'กล้อง A ยืมเกินกำหนด', body: null, status: 'PENDING', dueDate: new Date() },
]
const sentUpdates: any[] = []
const empty = { findMany: async () => [] }
mock.module('../db', {
  namedExports: {
    prisma: {
      booking: empty, equipmentLoan: empty, rentalJob: empty, repairTicket: empty, equipment: empty,
      reminder: {
        // dedupe lookup → none · stale scan (no orderBy) → none · dispatch list (orderBy) → OPEN
        findMany: async (args: any) => (args?.orderBy ? OPEN : []),
        createMany: async () => ({ count: 0 }),
        updateMany: async (args: any) => { if (args.data?.status === 'SENT') sentUpdates.push(args) },
      },
    },
  },
})

let channels = { discord: false, lark: false, email: false }
mock.module('../notify', {
  namedExports: {
    notifyChatDetailed: async () => ({ discord: channels.discord, lark: channels.lark, any: channels.discord || channels.lark }),
    notifyEmailDigest: async () => channels.email,
  },
})
const alerts: { key: string; subject: string }[] = []
mock.module('../ops-alert', {
  namedExports: {
    alertOps: async (key: string, subject: string) => {
      alerts.push({ key, subject })
      return { attempted: true, delivered: false, discord: false, lark: false, email: false }
    },
  },
})
mock.module('../qu-reminder-dispatch', {
  namedExports: { runQuReminderSweep: async () => ({ pending: 0, emailed: 0, failed: 0 }) },
})

let reminders: typeof import('../reminders')
before(async () => { reminders = await import('../reminders') })
beforeEach(() => { sentUpdates.length = 0; alerts.length = 0 })

test('no channel took the digest → rows stay PENDING and ops is alerted', async () => {
  channels = { discord: false, lark: false, email: false }
  const origErr = console.error
  const errs: string[] = []
  console.error = (...a: any[]) => { errs.push(a.map(String).join(' ')) }
  try {
    const r = await reminders.runReminderScan()
    assert.deepEqual(r.dispatched, { discord: false, lark: false, email: false })
  } finally {
    console.error = origErr
  }
  assert.equal(sentUpdates.length, 0, 'an undelivered digest must not mark rows SENT')
  assert.deepEqual(alerts.map((a) => a.key), ['reminders-undelivered'])
  assert.ok(errs.some((l) => l.includes('[reminders] run failed')), 'Hermes BAD_RE needs a `run failed` line')
})

test('one channel delivered (email only) → rows marked SENT, no ops alert', async () => {
  channels = { discord: false, lark: false, email: true }
  await reminders.runReminderScan()
  assert.equal(sentUpdates.length, 1)
  assert.equal(alerts.length, 0)
})
