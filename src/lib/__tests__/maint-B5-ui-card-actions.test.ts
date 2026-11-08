/**
 * maint 2026-11-08 (B5-ui) — queue-card 📦/📣 result readers (ui-1, ui-12) and
 * the Week Plan flush (ui-2). Pure helpers exported from the client components.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergePollState, notifyResultMessage } from '../../app/_components/CardFootageActions'
import { flushPendingPatches } from '../../app/admin/week-plan/WeekPlanClient'

test('mergePollState: a failed poll is "unreadable", never "reset" (ui-12)', () => {
  assert.equal(mergePollState(false, null), 'unreadable')                       // 502 HTML → json() failed
  assert.equal(mergePollState(false, { error: 'Unauthorized' }), 'unreadable')  // 401 after session expiry
  assert.equal(mergePollState(true, {}), 'unreadable')                          // 200 with no job
})

test('mergePollState: real states', () => {
  assert.equal(mergePollState(true, { job: { running: true, done: false } }), 'running')
  assert.equal(mergePollState(true, { job: { running: false, done: true, result: {} } }), 'done')
  assert.equal(mergePollState(true, { job: { running: false, done: false } }), 'reset') // getMergeJobStatus after a restart
})

// The 200 reply notify-ready/route.ts really sends: recipients = DELIVERED only,
// failedRecipients = rejected by SMTP (r2: the old fixture used recipients = intended).
const sent = (over: any) => ({ ok: true, recipients: ['a@x.co', 'b@x.co', 'c@x.co'], failedRecipients: [], emailed: 3, emailConfigured: true, emailError: null, ...over })

test('notifyResultMessage: SMTP down → not "✓ ส่งแล้ว" (ui-1)', () => {
  // the server now answers 502 EMAIL_FAILED for this…
  const m502 = notifyResultMessage(false, 502, { error: 'ส่งเมลไม่ถึงใครเลย (3/3 ส่งไม่สำเร็จ: a@x.co, b@x.co, c@x.co)', code: 'EMAIL_FAILED' })
  assert.equal(m502.ok, false)
  assert.doesNotMatch(m502.text, /✓/)
  assert.match(m502.text, /ไม่ถึงใครเลย/)
  // …and a 200 in that state (older server) still must not read as success
  const m = notifyResultMessage(true, 200, sent({ recipients: [], failedRecipients: ['a@x.co', 'b@x.co', 'c@x.co'], emailed: 0, emailError: '3/3 ส่งไม่สำเร็จ' }))
  assert.equal(m.ok, false)
  assert.doesNotMatch(m.text, /✓/)
  assert.match(m.text, /0\/3/)
})

test('notifyResultMessage: email not configured → says nobody got it', () => {
  const m503 = notifyResultMessage(false, 503, { error: 'ระบบอีเมลยังไม่ได้ตั้งค่า — ยังไม่มีใครได้รับแจ้ง', code: 'EMAIL_NOT_CONFIGURED' })
  assert.equal(m503.ok, false)
  assert.match(m503.text, /ยังไม่มีใครได้รับ/)
  const m = notifyResultMessage(true, 200, sent({ emailed: 0, emailConfigured: false }))
  assert.equal(m.ok, false)
  assert.match(m.text, /ไม่มีใครได้รับ/)
})

test('notifyResultMessage: partial delivery shows x/N + the server error (real reply shape)', () => {
  const m = notifyResultMessage(true, 200, sent({ recipients: ['a@x.co', 'b@x.co'], failedRecipients: ['c@x.co'], emailed: 2, emailError: '1/3 ส่งไม่สำเร็จ: c@x.co' }))
  assert.equal(m.ok, false)
  assert.match(m.text, /2\/3/)                 // denominator = delivered + failed, never 2/2
  assert.doesNotMatch(m.text, /2\/2/)
  assert.match(m.text, /1\/3 ส่งไม่สำเร็จ: c@x\.co/)
})

test('notifyResultMessage: partial delivery without emailError still names who missed it', () => {
  const m = notifyResultMessage(true, 200, sent({ recipients: ['a@x.co'], failedRecipients: ['c@x.co'], emailed: 1, emailError: null }))
  assert.equal(m.ok, false)
  assert.match(m.text, /1\/2/)
  assert.match(m.text, /c@x\.co/)
})

test('notifyResultMessage: unreadable 200 is a warning, not success', () => {
  assert.equal(notifyResultMessage(true, 200, null).ok, false)
  assert.equal(notifyResultMessage(true, 200, { ok: true }).ok, false)
})

test('notifyResultMessage: HTTP error passes the server message through', () => {
  assert.deepEqual(notifyResultMessage(false, 403, { error: 'Forbidden' }), { ok: false, text: 'Forbidden' })
  assert.match(notifyResultMessage(false, 504, null).text, /HTTP 504/)
})

test('notifyResultMessage: everyone mailed → ✓ with the DELIVERED count', () => {
  assert.deepEqual(notifyResultMessage(true, 200, sent({})), { ok: true, text: '✓ ส่งแล้ว 3 คน' })
})

test('flushPendingPatches: every queued patch is sent once and the queue empties (ui-2)', () => {
  const pending: Record<string, any> = { b1: { equipmentNote: 'FX3 ×2' }, b2: { rentalGearNote: 'ไมค์ไร้สาย' } }
  const calls: Array<[string, any]> = []
  assert.equal(flushPendingPatches(pending, (id, p) => calls.push([id, p])), 2)
  assert.deepEqual(calls, [['b1', { equipmentNote: 'FX3 ×2' }], ['b2', { rentalGearNote: 'ไมค์ไร้สาย' }]])
  assert.deepEqual(pending, {})
  assert.equal(flushPendingPatches(pending, () => assert.fail('nothing left to send')), 0)
})
