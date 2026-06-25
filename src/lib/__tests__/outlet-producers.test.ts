import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OUTLET_PRODUCERS } from '../outlet-producers'
import { OUTLET_MAP, OUTLETS } from '../data'

// v1.99.0 — guard the seed against silent bugs: a producer tagged to an outlet
// code that doesn't exist would just never appear in any dropdown.

test('every producer seed outlet code resolves to a real outlet', () => {
  for (const p of OUTLET_PRODUCERS) {
    assert.ok(OUTLET_MAP[p.outlet], `producer ${p.nickname} (${p.email}) → unknown outlet "${p.outlet}"`)
  }
})

test('Event (EVT) + PM outlets exist with a multi-char program (so the form dropdown is non-empty)', () => {
  for (const code of ['EVT', 'PM']) {
    const o = OUTLET_MAP[code]
    assert.ok(o, `outlet ${code} missing`)
    // the booking form filters single-char (L/S/A/T) episode-type programs out of
    // the Program dropdown — each outlet needs at least one named program left.
    assert.ok(o.programs.some(pr => pr.code.length > 1), `outlet ${code} has no selectable (multi-char) program`)
  }
})

test('the 17 Event + PM team members are seeded and tagged to EVT/PM', () => {
  const evt = OUTLET_PRODUCERS.filter(p => p.outlet === 'EVT')
  const pm = OUTLET_PRODUCERS.filter(p => p.outlet === 'PM')
  assert.equal(evt.length, 7, 'Event team should have 7 members')
  assert.equal(pm.length, 10, 'PM team should have 10 members')
  // emails are unique across the whole seed (the import upserts by email)
  const emails = OUTLET_PRODUCERS.map(p => p.email.toLowerCase())
  assert.equal(new Set(emails).size, emails.length, 'duplicate producer email in seed')
})

test('EVT/PM are sorted after the existing outlets (folder numbering 10·, 11·)', () => {
  const evt = OUTLETS.find(o => o.code === 'EVT')!
  const pm = OUTLETS.find(o => o.code === 'PM')!
  assert.equal(evt.sort, 10)
  assert.equal(pm.sort, 11)
})
