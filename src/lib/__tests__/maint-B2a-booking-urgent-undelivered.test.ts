// maint 2026-11-08 (B2a) — a rush-booking alert that reaches nobody must reach
// ops. maybeAlertUrgentBooking runs once from create-booking with no retry, so
// "release the claim so it isn't silently lost" lost it anyway.
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let emailOk = false
let emailConfigured = true
let alerts: any[][] = []
mock.module('../db', { namedExports: { prisma: { booking: { updateMany: async () => ({ count: 1 }) } } } })
mock.module('../notify', { namedExports: { notifyEmail: async () => emailOk, notifyLine: async () => false } })
mock.module('../email', { namedExports: { isEmailConfigured: () => emailConfigured } })
mock.module('../ops-alert', { namedExports: { alertOps: async (...a: any[]) => { alerts.push(a); return { attempted: true, delivered: true } } } })

let maybeAlertUrgentBooking: typeof import('../urgent-booking').maybeAlertUrgentBooking
before(async () => { ({ maybeAlertUrgentBooking } = await import('../urgent-booking')) })
beforeEach(() => { alerts = []; emailOk = false; emailConfigured = true })

const now = new Date()
const rush = {
  id: 'b1', bookingCode: 'NWS-KYM-261109-01', shootDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)),
  callTime: '09:00', createdAt: now, isRoutine: false, urgentAlertedAt: null, producer: 'แพร',
  outlet: { code: 'NWS', name: 'News' }, program: { name: 'Key Message' },
}

test('every channel failed → ops hears about the rush job', async () => {
  const r = await maybeAlertUrgentBooking(rush)
  assert.equal(r.reason, 'delivery-failed')
  assert.equal(alerts.length, 1)
  assert.match(alerts[0][0], /NWS-KYM-261109-01/, 'one alert key per booking')
  assert.match(alerts[0][2], /งานด่วน/)
})

test('no channel configured → ops hears about it too', async () => {
  emailConfigured = false
  const r = await maybeAlertUrgentBooking(rush)
  assert.equal(r.reason, 'no-channel')
  assert.equal(alerts.length, 1)
})

test('delivered → no ops alert', async () => {
  emailOk = true
  const r = await maybeAlertUrgentBooking(rush)
  assert.equal(r.alerted, true)
  assert.equal(alerts.length, 0)
})
