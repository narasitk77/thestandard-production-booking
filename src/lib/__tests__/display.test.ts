/**
 * bookingShowName — the one rule for labeling a booking on every
 * platform (in-app calendar/overview/lists + Google Calendar title).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookingShowName, bookingDisplayName } from '../display'

test('Content Agency booking shows the project name', () => {
  assert.equal(
    bookingShowName({ projectName: 'KEY MESSAGES x DMHT', program: { name: 'Long Form (project)' } }),
    'KEY MESSAGES x DMHT',
  )
})

test('outlet booking (no project) shows the program name', () => {
  assert.equal(bookingShowName({ projectName: null, program: { name: 'End Game' } }), 'End Game')
  assert.equal(bookingShowName({ program: { name: 'Key Message' } }), 'Key Message')
})

test('blank project name falls back to the program name', () => {
  assert.equal(bookingShowName({ projectName: '   ', program: { name: 'Event / Forum' } }), 'Event / Forum')
})

test('outlet booking with per-EP programs shows the EP program, not the Episode-Type bucket', () => {
  assert.equal(
    bookingShowName({
      program: { name: 'Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว' },
      episodes: [{ program: { name: 'Key Message' } }],
    }),
    'Key Message',
  )
})

test('mixed-program booking joins distinct show names', () => {
  assert.equal(
    bookingShowName({
      program: { name: 'Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว' },
      episodes: [
        { program: { name: 'Key Message' } },
        { program: { name: 'Key Message' } },
        { program: { name: 'End Game' } },
      ],
    }),
    'Key Message / End Game',
  )
})

test('legacy booking whose EP programs are just the Episode-Type bucket falls through to it', () => {
  assert.equal(
    bookingShowName({
      program: { name: 'Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว' },
      episodes: [{ program: { name: 'Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว' } }],
    }),
    'Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว',
  )
})

test('projectName wins even when EP programs exist', () => {
  assert.equal(
    bookingShowName({
      projectName: 'KEY MESSAGES x DMHT',
      program: { name: 'Long Form (project)' },
      episodes: [{ program: { name: 'Long Form (project)' } }],
    }),
    'KEY MESSAGES x DMHT',
  )
})

// v1.111 — bookingDisplayName: DISPLAY-only fallback to the episode title when the
// resolved show is a generic universal Episode-Type (migrated bookings).
test('bookingDisplayName: generic Episode-Type booking shows the episode title', () => {
  assert.equal(
    bookingDisplayName({
      program: { name: 'Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว' },
      episodes: [{ program: { name: 'Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว' }, title: 'Now' }],
    }),
    'Now',
  )
})

test('bookingDisplayName: real show is unchanged (not a generic type)', () => {
  assert.equal(
    bookingDisplayName({
      program: { name: 'Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว' },
      episodes: [{ program: { name: 'Global Focus' }, title: 'EP.185' }],
    }),
    'Global Focus',
  )
})

test('bookingDisplayName: projectName still wins', () => {
  assert.equal(
    bookingDisplayName({
      projectName: 'Awesome Skills Project',
      program: { name: 'Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว' },
      episodes: [{ title: 'EP.1' }],
    }),
    'Awesome Skills Project',
  )
})

test('bookingDisplayName: generic type with no usable title keeps the type name', () => {
  assert.equal(
    bookingDisplayName({
      program: { name: 'Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว' },
      episodes: [{ title: '-' }],
    }),
    'Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว',
  )
})
