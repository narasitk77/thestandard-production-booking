/**
 * v1.276 — which bookings may hold a room (review of PR #21). Bot requests made
 * through an MCP request key wait for approval; everything else keeps the v1.270
 * rule (REQUESTED already locks the room). NULL creators must stay eligible.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roomEligibleWhere } from '../room-booking-reconcile'

// tiny evaluator for the exact shape roomEligibleWhere returns (no DB needed)
function matches(w: any, b: { status: string; createdByEmail: string | null }): boolean {
  if (w.OR) return w.OR.some((x: any) => matches(x, b)) && Object.keys(w).filter(k => k !== 'OR').every(k => matches({ [k]: w[k] }, b))
  if (w.status !== undefined) {
    const ok = typeof w.status === 'string' ? b.status === w.status : w.status.in.includes(b.status)
    if (!ok) return false
  }
  if ('createdByEmail' in w) {
    const c = w.createdByEmail
    if (c === null) return b.createdByEmail === null
    if (c && typeof c === 'object' && 'not' in c) return b.createdByEmail !== null && b.createdByEmail !== c.not // SQL <> drops NULL
  }
  return true
}

test('roomEligibleWhere: producers\' REQUESTED keep rooms, bot REQUESTED waits, approved always eligible', () => {
  const w = roomEligibleWhere('mcp-request@probook')
  assert.equal(matches(w, { status: 'REQUESTED', createdByEmail: 'prod@thestandard.co' }), true)
  assert.equal(matches(w, { status: 'REQUESTED', createdByEmail: null }), true, 'NULL creator must not fall out')
  assert.equal(matches(w, { status: 'REQUESTED', createdByEmail: 'mcp-request@probook' }), false)
  assert.equal(matches(w, { status: 'ASSIGNED', createdByEmail: 'mcp-request@probook' }), true, 'after approval the bot request gets its room')
  assert.equal(matches(w, { status: 'CONFIRMED', createdByEmail: null }), true)
  assert.equal(matches(w, { status: 'CANCELLED', createdByEmail: 'prod@thestandard.co' }), false)
})
