import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crewRoleFromPosition, missingCrewRoles } from '../crew-gaps'

test('crewRoleFromPosition: maps real team positions', () => {
  assert.equal(crewRoleFromPosition('Videographer'), 'Videographer')
  assert.equal(crewRoleFromPosition('Photographer'), 'Photographer')
  assert.equal(crewRoleFromPosition('Sound Recorder'), 'Sound')
  assert.equal(crewRoleFromPosition('Senior Sound Engineer'), 'Sound')
  assert.equal(crewRoleFromPosition('Switcher'), 'Switcher')
  assert.equal(crewRoleFromPosition('Virtual Production Developer'), 'Virtual Production')
})

test('crewRoleFromPosition: non-crew + video-but-not-camera → null', () => {
  assert.equal(crewRoleFromPosition('Producer'), null)
  assert.equal(crewRoleFromPosition('Video Director'), null)
  assert.equal(crewRoleFromPosition('Video Editor'), null)
  assert.equal(crewRoleFromPosition('Video Production Manager'), null)
  assert.equal(crewRoleFromPosition('Project Manager'), null)
  assert.equal(crewRoleFromPosition(''), null)
  assert.equal(crewRoleFromPosition(null), null)
})

test('missingCrewRoles: flags required roles no assigned staff covers', () => {
  // needs video+sound+photo; assigned a sound recorder + a videographer → photo missing
  assert.deepEqual(
    missingCrewRoles(['Videographer', 'Sound', 'Photographer'], ['Sound Recorder', 'Videographer']),
    ['Photographer'],
  )
  // the reported case: only sound assigned → video + photo missing
  assert.deepEqual(
    missingCrewRoles(['Videographer', 'Sound', 'Photographer'], ['Sound Engineer']),
    ['Videographer', 'Photographer'],
  )
  // fully covered → none
  assert.deepEqual(
    missingCrewRoles(['Videographer', 'Sound'], ['Videographer', 'Sound Recorder']),
    [],
  )
  // empty required → none
  assert.deepEqual(missingCrewRoles([], ['Videographer']), [])
})
