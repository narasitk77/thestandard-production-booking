import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDriveLink, mergeDriveLinks } from '../drive-links'

// v1.114 — id-first Drive linkage: names become cosmetic. These tests pin the
// pure logic (json shape tolerance + merge semantics) that every capture/read
// path depends on. เคสเทสตามที่ตกลง: พิสูจน์ว่าเก็บ/อ่าน/ทับซ้อน/ข้อมูลเสีย ทำงานถูกก่อนใช้จริง.

const ID_A = '1UzcK1fnavg23b_2pTpUWDkvVbSr3ymWM' // realistic Drive id shapes
const ID_B = '1BJftgZeNSQCHSdCyEBtkpytxlfdmLrMP'
const ID_C = '1ZebvZCFaUZipgV9lirei-wD0pivYjqrS'

test('getDriveLink: reads a stored id and rejects junk shapes without throwing', () => {
  assert.equal(getDriveLink({ box: ID_A }, 'box'), ID_A)
  assert.equal(getDriveLink({ box: ID_A }, 'landing'), null)      // other key absent
  assert.equal(getDriveLink(null, 'box'), null)                    // no json at all
  assert.equal(getDriveLink(undefined, 'box'), null)
  assert.equal(getDriveLink('garbage', 'box'), null)               // wrong type
  assert.equal(getDriveLink([ID_A], 'box'), null)                  // array
  assert.equal(getDriveLink({ box: 42 }, 'box'), null)             // non-string id
  assert.equal(getDriveLink({ box: 'has space' }, 'box'), null)    // invalid id chars
  assert.equal(getDriveLink({ box: '' }, 'box'), null)             // empty
  assert.equal(getDriveLink({ box: 'a/b/../etc' }, 'box'), null)   // path-ish junk
})

test('mergeDriveLinks: fills empty, keeps others, updates changed, null = no-op', () => {
  // first capture on a booking with no json yet
  assert.deepEqual(mergeDriveLinks(null, { box: ID_A }), { box: ID_A })
  // adding a second key keeps the first
  assert.deepEqual(mergeDriveLinks({ box: ID_A }, { landing: ID_B }), { box: ID_A, landing: ID_B })
  // same value again → no write (null)
  assert.equal(mergeDriveLinks({ box: ID_A }, { box: ID_A }), null)
  // moved/recreated folder → id updates
  assert.deepEqual(mergeDriveLinks({ box: ID_A }, { box: ID_C }), { box: ID_C })
})

test('mergeDriveLinks: never stores junk and never loses good ids to junk patches', () => {
  // junk in the patch is dropped; nothing else to store → no-op
  assert.equal(mergeDriveLinks({ box: ID_A }, { landing: 'not a real id!!' as any }), null)
  assert.equal(mergeDriveLinks({ box: ID_A }, { landing: undefined, staging: null as any }), null)
  // junk PRE-EXISTING in the db json is dropped on the next real write
  const next = mergeDriveLinks({ box: 'corrupted value !!!', staging: ID_C }, { landing: ID_B })
  assert.deepEqual(next, { staging: ID_C, landing: ID_B })
  // a good id in the patch wins even when the patch also carries junk keys
  assert.deepEqual(mergeDriveLinks(null, { box: ID_A, photo: '' as any }), { box: ID_A })
})

test('scenario: rename/move on Drive cannot break an id-first booking', () => {
  // stored once at create time…
  const stored = mergeDriveLinks(null, { box: ID_A, landing: ID_B })
  // …ops rename the folder / regenerate changes the booking code — the json is
  // untouched (Drive ids survive rename+move), readers still get the same id.
  assert.equal(getDriveLink(stored, 'box'), ID_A)
  assert.equal(getDriveLink(stored, 'landing'), ID_B)
})
