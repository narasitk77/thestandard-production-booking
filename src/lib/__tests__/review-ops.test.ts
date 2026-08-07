// v1.170 — the operator's KPI definitions. A KPI whose meaning drifts is worse
// than none, so every threshold is pinned here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  responseRate, undelivered, awaitingReply, rateHealth, deliveryHealth,
  medianResolveHours, oldestOpenDays, queueHealth, dueShootDay,
} from '../review-ops'

const now = new Date('2026-08-07T10:00:00.000Z')
const ago = (d: number) => new Date(now.getTime() - d * 86_400_000)
const inv = (o: Partial<{ mailedAt: Date | null; submittedAt: Date | null; sentAt: Date }> = {}) => ({
  bookingId: 'b', email: 'x@y', sentAt: o.sentAt ?? ago(1),
  mailedAt: o.mailedAt === undefined ? ago(1) : o.mailedAt,
  submittedAt: o.submittedAt ?? null,
})

test('response rate counts only invites that were actually DELIVERED', () => {
  // An invite we failed to email is OUR bug. Counting it against the crew makes
  // them look unresponsive for something they never received.
  const rows = [
    inv({ submittedAt: now }),        // delivered + answered
    inv({}),                          // delivered, no answer yet
    inv({ mailedAt: null }),          // never sent — excluded entirely
  ]
  assert.deepEqual(responseRate(rows), { sent: 2, answered: 1, pct: 50 })
})

test('nothing sent yet reads as "no data", not 0%', () => {
  assert.deepEqual(responseRate([]), { sent: 0, answered: 0, pct: null })
  assert.equal(rateHealth(null), 'ok')   // an empty week is not a failure
})

test('undelivered invites are surfaced as a to-do, and any of them is RED', () => {
  const rows = [inv({}), inv({ mailedAt: null }), inv({ mailedAt: null })]
  assert.equal(undelivered(rows).length, 2)
  assert.equal(deliveryHealth(0), 'ok')
  assert.equal(deliveryHealth(1), 'bad')   // not "warn" — it is a hard failure
})

test('response-rate thresholds are forgiving enough to stay meaningful', () => {
  // Too strict and the light is permanently red, so people stop looking at it.
  assert.equal(rateHealth(100), 'ok')
  assert.equal(rateHealth(60), 'ok')
  assert.equal(rateHealth(59), 'warn')
  assert.equal(rateHealth(30), 'warn')
  assert.equal(rateHealth(29), 'bad')
  assert.equal(rateHealth(0), 'bad')
})

test('awaiting-reply is sorted worst-first and counts days since DELIVERY', () => {
  const rows = [
    inv({ mailedAt: ago(1) }),
    inv({ mailedAt: ago(9) }),
    inv({ mailedAt: ago(3) }),
    inv({ mailedAt: ago(5), submittedAt: now }),  // answered — excluded
    inv({ mailedAt: null }),                       // never sent — excluded
  ]
  const out = awaitingReply(rows, now)
  assert.deepEqual(out.map(o => o.waitingDays), [9, 3, 1])
})

test('resolve time uses the MEDIAN — one ancient ticket must not skew it', () => {
  const t = (createdDaysAgo: number, resolvedDaysAgo: number | null) => ({
    status: resolvedDaysAgo === null ? 'NEW' : 'RESOLVED',
    createdAt: ago(createdDaysAgo),
    resolvedAt: resolvedDaysAgo === null ? null : ago(resolvedDaysAgo),
    lastMessageAt: now,
  })
  // three closed in ~1 day each, one that took 30 days
  const rows = [t(2, 1), t(3, 2), t(4, 3), t(31, 1)]
  const med = medianResolveHours(rows)!
  assert.ok(med > 20 && med < 30, `median should sit near 24h, got ${med}`)
  assert.equal(medianResolveHours([]), null)
  assert.equal(medianResolveHours([t(1, null)]), null)   // nothing closed yet
})

test('the queue light fires on UNACKNOWLEDGED reports, not on open ones', () => {
  const mk = (status: string, daysOld: number) => ({
    status, createdAt: ago(daysOld), resolvedAt: null, lastMessageAt: ago(daysOld),
  })
  assert.equal(queueHealth([], now), 'ok')
  assert.equal(queueHealth([mk('NEW', 0)], now), 'ok')
  assert.equal(queueHealth([mk('NEW', 1)], now), 'warn')
  assert.equal(queueHealth([mk('NEW', 2)], now), 'bad')
  // Somebody picked it up — that is the acknowledgement the light cares about.
  assert.equal(queueHealth([mk('IN_PROGRESS', 30)], now), 'ok')
  assert.equal(queueHealth([mk('RESOLVED', 30)], now), 'ok')
})

test('oldest-open is reported so one ignored person cannot hide in an average', () => {
  const mk = (status: string, daysOld: number) => ({
    status, createdAt: ago(daysOld), resolvedAt: null, lastMessageAt: ago(daysOld),
  })
  assert.equal(oldestOpenDays([mk('NEW', 5), mk('IN_PROGRESS', 12)], now), 12)
  assert.equal(oldestOpenDays([mk('RESOLVED', 99)], now), null)
  assert.equal(oldestOpenDays([], now), null)
})

test('the due-day matches the sender exactly, or the panel promises a batch that never runs', () => {
  assert.equal(dueShootDay(now, 1).toISOString().slice(0, 10), '2026-08-06')
  assert.equal(dueShootDay(now, 0).toISOString().slice(0, 10), '2026-08-07')
  assert.equal(dueShootDay(now, 3).toISOString().slice(0, 10), '2026-08-04')
})
