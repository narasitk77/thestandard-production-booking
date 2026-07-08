/**
 * withProducer — v1.131. The reconciler's "correct" calendar attendee set is
 * crew + producer (a producer-only invite added at confirm-time must survive
 * every later reconcile tick, not get patched back out because the reconciler
 * only knew about assignedEmails).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withProducer } from '../calendar-reconcile'

test('adds the producer to the crew list', () => {
  assert.deepEqual(withProducer(['crew@thestandard.co'], 'producer@thestandard.co'), ['crew@thestandard.co', 'producer@thestandard.co'])
})

test('no producerEmail → crew list unchanged', () => {
  assert.deepEqual(withProducer(['crew@thestandard.co'], null), ['crew@thestandard.co'])
  assert.deepEqual(withProducer(['crew@thestandard.co'], undefined), ['crew@thestandard.co'])
  assert.deepEqual(withProducer(['crew@thestandard.co'], ''), ['crew@thestandard.co'])
  assert.deepEqual(withProducer(['crew@thestandard.co'], '   '), ['crew@thestandard.co'])
})

test('producer already crew-assigned (case-insensitive) → no duplicate', () => {
  assert.deepEqual(withProducer(['Producer@thestandard.co'], 'producer@thestandard.co'), ['Producer@thestandard.co'])
})

test('empty crew list, producer only', () => {
  assert.deepEqual(withProducer([], 'producer@thestandard.co'), ['producer@thestandard.co'])
})
