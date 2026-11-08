/**
 * maint 2026-11-08 (ui-11) — the admin "Calendar guests" card must expect the
 * reconciler's list (crew + Producer + Co-Producer + AGN directors), not crew.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calendarGuestCheck } from '../calendar-guest-check'

const base = { assignedEmails: ['Cam@thestandard.co'], producerEmail: 'prod@thestandard.co', outletCode: 'NWS' }

test('crew + producer on the event = in sync (was: producer flagged as "extra")', () => {
  const g = calendarGuestCheck(base, ['cam@thestandard.co', 'prod@thestandard.co'])
  assert.deepEqual(g.extra, [])
  assert.deepEqual(g.missing, [])
  assert.equal(g.inSync, true)
})

test('producer missing from the event is flagged (was: never noticed)', () => {
  const g = calendarGuestCheck(base, ['cam@thestandard.co'])
  assert.deepEqual(g.missing, ['prod@thestandard.co'])
  assert.equal(g.inSync, false)
})

test('routine booking with no crew but a producer can go green', () => {
  const g = calendarGuestCheck({ assignedEmails: [], producerEmail: 'prod@thestandard.co', outletCode: 'NOW' }, ['prod@thestandard.co'])
  assert.equal(g.inSync, true)
})

test('director: expected only on AGN — on other outlets an invited director is "extra"', () => {
  const agn = calendarGuestCheck({ ...base, outletCode: 'AGN', directorEmail: 'dir@thestandard.co' }, ['cam@thestandard.co', 'prod@thestandard.co'])
  assert.deepEqual(agn.missing, ['dir@thestandard.co'])
  const nws = calendarGuestCheck({ ...base, directorEmail: 'dir@thestandard.co' }, ['cam@thestandard.co', 'prod@thestandard.co', 'dir@thestandard.co'])
  assert.deepEqual(nws.extra, ['dir@thestandard.co'])
})

test('nobody expected and nobody invited is NOT "in sync"', () => {
  assert.equal(calendarGuestCheck({ assignedEmails: [] }, []).inSync, false)
})
