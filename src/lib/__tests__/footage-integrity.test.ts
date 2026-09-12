import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findIssues } from '../footage-integrity'

function f(over: any = {}) {
  return {
    id: over.id || 'id1', name: over.name || 'A.MXF',
    mimeType: over.mimeType ?? 'application/octet-stream',
    parents: over.parents || ['p1'], webViewLink: null,
    size: over.size === undefined ? 100 : over.size,
    createdTime: null, modifiedTime: null,
    folderPath: over.folderPath || ['EP01', 'CAM-A', 'Clip'],
    topFolderId: null,
  } as any
}

test('a truncated upload is reported', () => {
  const issues = findIssues('X-1', [f({ size: 0 })])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'zero-byte')
})

test('SONYCARD.IND at 0 bytes is NORMAL — every Sony card ships one', () => {
  // Regression for v1.221.1. v1.221 would have fired on every Sony shoot,
  // and an alert that cries wolf on normal footage gets ignored on the day
  // it finally matters.
  const issues = findIssues('X-1', [f({ name: 'SONYCARD.IND', size: 0, folderPath: ['EP01', 'CAM-A', 'SONY'] })])
  assert.deepEqual(issues, [])
})

test('the sidecar exemption is case-insensitive and does not leak to other names', () => {
  assert.deepEqual(findIssues('X', [f({ name: 'sonycard.ind', size: 0 })]), [])
  assert.equal(findIssues('X', [f({ name: 'SONYCARD.MXF', size: 0 })]).length, 1)
})

test('two files sharing one name in one folder is reported with both sizes', () => {
  const issues = findIssues('X-1', [
    f({ id: 'a', name: 'A.MXF', size: 9_873_129_472, parents: ['same'] }),
    f({ id: 'b', name: 'A.MXF', size: 47_908_238_384, parents: ['same'] }),
  ])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'duplicate-name')
  assert.equal(issues[0].fileIds.length, 2)
})

test('same name in DIFFERENT folders is normal — cameras reuse filenames', () => {
  const issues = findIssues('X-1', [
    f({ id: 'a', name: 'A.MXF', parents: ['camA'] }),
    f({ id: 'b', name: 'A.MXF', parents: ['camB'] }),
  ])
  assert.deepEqual(issues, [])
})

test('an episode with sound but no picture is reported', () => {
  const issues = findIssues('X-1', [f({ name: 'REC-001.WAV', folderPath: ['EP01', 'AUDIO'] })])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'audio-without-video')
})

test('sound AND picture together is fine', () => {
  const issues = findIssues('X-1', [
    f({ name: 'REC-001.WAV', folderPath: ['EP01', 'AUDIO'] }),
    f({ name: 'A.MXF', folderPath: ['EP01', 'CAM-A', 'Clip'] }),
  ])
  assert.deepEqual(issues, [])
})
