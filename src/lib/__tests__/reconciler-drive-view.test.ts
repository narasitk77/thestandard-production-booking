// v1.171 — the per-run listing cache. The quota win is real, but the reason
// this file has tests is the OTHER half: a cache that outlives a second must
// never be the evidence for deleting someone's footage.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DriveView, type DriveIO } from '../reconciler/drive-view'

function fakeIO(tree: Record<string, { folders?: Array<{ id: string; name: string }>; files?: Array<{ id: string; name: string }> }>) {
  const calls = { folders: 0, files: 0 }
  const io: DriveIO = {
    async listChildFolders(id) { calls.folders++; return [...(tree[id]?.folders || [])] },
    async listFilesInFolder(id) { calls.files++; return [...(tree[id]?.files || [])] },
  }
  return { io, calls, tree }
}

test('the same folder is listed ONCE per run however many phases ask', () => {
  // The whole point: today four sweeps each pay for the same answer every hour.
  const { io, calls } = fakeIO({ box: { files: [{ id: 'f1', name: 'A001.MXF' }] } })
  const v = new DriveView(io)
  return (async () => {
    await v.filesIn('box'); await v.filesIn('box'); await v.filesIn('box')
    assert.equal(calls.files, 1)
    assert.equal(v.stats.fileListCalls, 1)
    assert.equal(v.stats.fileListHits, 2)
  })()
})

test('a FRESH read always goes to Drive, even when cached', async () => {
  const { io, calls, tree } = fakeIO({ landing: { files: [] } })
  const v = new DriveView(io)
  assert.deepEqual(await v.filesIn('landing'), [])
  // crew uploads mid-pass — exactly the case the fresh-read rule exists for
  tree.landing.files = [{ id: 'late', name: 'LATE.MXF' }]
  assert.deepEqual((await v.filesIn('landing')).map(f => f.name), [])          // stale cache
  assert.deepEqual((await v.freshFiles('landing')).map(f => f.name), ['LATE.MXF'])
  assert.equal(calls.files, 2)
  // and the fresh answer becomes the new truth for later readers
  assert.deepEqual((await v.filesIn('landing')).map(f => f.name), ['LATE.MXF'])
})

test('a cached listing may never justify a trash — the guard throws', () => {
  const v = new DriveView(fakeIO({}).io)
  assert.throws(() => (v.assertNotForDeletion as any)('cached'), /never justify a trash/)
  assert.doesNotThrow(() => v.assertNotForDeletion('fresh'))
})

test('folders created this run are tracked and known-empty without another call', async () => {
  const { io, calls } = fakeIO({ box: { folders: [] } })
  const v = new DriveView(io)
  await v.childFolders('box')
  v.noteCreatedFolder('box', { id: 'ep1', name: 'EP-1' })
  assert.equal(v.createdThisRun.has('ep1'), true)
  assert.deepEqual((await v.childFolders('box')).map(f => f.id), ['ep1'])  // no extra call
  assert.deepEqual(await v.filesIn('ep1'), [])                              // known-empty
  assert.equal(calls.files, 0)
})

test('createdThisRun is CONSUMABLE — the v1 "never trash" rule killed the fast path', () => {
  // A skeleton this pass created, seconds ago, under a per-booking lease, is
  // exactly what the merge fast path trashes so it can move the whole landing
  // folder in one write instead of copying file by file.
  const v = new DriveView(fakeIO({}).io)
  v.noteCreatedFolder('box', { id: 'twin', name: 'EP-1' })
  assert.equal(v.createdThisRun.has('twin'), true)
  v.noteTrashed('twin', 'box')
  assert.equal(v.createdThisRun.has('twin'), false)
})

test('trashing removes the folder from its parent listing too', async () => {
  const { io } = fakeIO({ box: { folders: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } })
  const v = new DriveView(io)
  await v.childFolders('box')
  v.noteTrashed('a', 'box')
  assert.deepEqual((await v.childFolders('box')).map(f => f.id), ['b'])
})

test('a move drops the folder from the old parent and EVICTS the new one', async () => {
  // We know the id left; we do not know how it will appear in the destination
  // listing, so inventing an entry would be a guess. Evicting is honest.
  const { io, calls } = fakeIO({
    old: { folders: [{ id: 'x', name: 'X' }] },
    dest: { folders: [] },
  })
  const v = new DriveView(io)
  await v.childFolders('old'); await v.childFolders('dest')
  v.noteMovedFolder('x', 'old', 'dest')
  assert.deepEqual((await v.childFolders('old')).map(f => f.id), [])
  const before = calls.folders
  await v.childFolders('dest')
  assert.equal(calls.folders, before + 1, 'destination must be re-listed, not guessed')
})

test('moving files evicts BOTH sides — neither listing is trustworthy after', async () => {
  const { io, calls } = fakeIO({ from: { files: [{ id: '1', name: 'a' }] }, to: { files: [] } })
  const v = new DriveView(io)
  await v.filesIn('from'); await v.filesIn('to')
  const before = calls.files
  v.noteFilesMoved('from', 'to')
  await v.filesIn('from'); await v.filesIn('to')
  assert.equal(calls.files, before + 2)
})
