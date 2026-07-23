// Integration-style regression tests for video-merge's mirrorMove, run against
// an in-memory Drive (helpers/fake-drive.ts) so the REAL folder-moving
// algorithm is exercised without touching Google.
//
// Every scenario here is a bug that actually shipped and was found by the crew,
// not by a test — this file is the test that would have caught them.
//
// Uses node:test module mocking to swap ./google-drive for the fake; requires
// the --experimental-test-module-mocks flag (set in the "test" npm script).

import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDrive } from './helpers/fake-drive'

// One fake per test; the mocked exports delegate to whatever `drive` currently
// points at, so mirrorMove (imported once, below) always hits the live fake.
let drive: FakeDrive
mock.module('../google-drive', {
  namedExports: {
    listFilesInFolder: (id: string) => drive.listFilesInFolder(id),
    listChildFolders: (id: string) => drive.listChildFolders(id),
    findChildFolder: (p: string, n: string) => drive.findChildFolder(p, n),
    isFolderEmpty: (id: string) => drive.isFolderEmpty(id),
    trashDriveItem: (id: string) => drive.trashDriveItem(id),
    moveFileToFolder: (id: string, t: string, r: string) => drive.moveFileToFolder(id, t, r),
    ensureFolderPath: (root: string, segs: string[]) => drive.ensureFolderPath(root, segs),
    isFolderAlive: (id: string) => drive.isFolderAlive(id),
    hasDriveCredentials: () => true,
    // imported by video-merge but unused by mirrorMove — present so the binding exists
    findEpisodeFolderUrls: async () => ({}),
  },
})
// Imported after the mock is registered (top-level await is unavailable under
// the cjs test transform, so use the async `before` hook).
let mirrorMove: typeof import('../video-merge').mirrorMove
before(async () => { ({ mirrorMove } = await import('../video-merge')) })

const noStats = () => ({ seen: 0, moved: 0, movedFolders: 0, dup: 0, err: 0 })

beforeEach(() => { drive = new FakeDrive() })

// ── v1.150.2: the crew's drop folders vanished every night ────────────────────
test('an EMPTY landing skeleton is never moved into the box', async () => {
  const root = drive.mkFolder('root', null)
  const landing = drive.mkFolder('PEA (AGN-260722-01)', root)
  const ep = drive.mkFolder('EP01 · PEA', landing)
  drive.mkFolder('CAM-A', ep) // empty skeleton created at 19:00
  drive.mkFolder('CAM-B', ep)
  const box = drive.mkFolder('box-PEA', root)

  const stats = noStats()
  await mirrorMove(landing, box, 'AGN-260722-01', stats, false)

  // the skeleton stays in the drop zone; nothing lands in the box
  assert.deepEqual(drive.childFolderNames(landing), ['EP01 · PEA'])
  assert.deepEqual(drive.childFolderNames(box), [])
  assert.equal(stats.movedFolders, 0)
})

// ── v1.151.3: one booking's footage split across two EP01 folders ─────────────
test('a landing EP folder merges into the box EP with a different display name', async () => {
  const root = drive.mkFolder('root', null)
  // box already has the canonical EP folder (created with the box on approve)
  const box = drive.mkFolder('box', root)
  const boxEp = drive.mkFolder('EP01 · THE INTERVIEW', box)
  drive.mkFolder('CAM-A', boxEp)
  // landing EP carries the crew's van note in its name — DIFFERENT from the box
  const landing = drive.mkFolder('landing', root)
  const landEp = drive.mkFolder('EP01 · THE INTERVIEW (รถ. 22. ก.ค)', landing)
  const landCamA = drive.mkFolder('CAM-A', landEp)
  drive.mkFile('clip.mp4', landCamA, 500)

  await mirrorMove(landing, box, 'POP-PIV-260722-01', noStats(), false)

  // THE regression: the box must still have exactly ONE EP01 folder, not two.
  const epFolders = drive.childFolderNames(box).filter(n => n.startsWith('EP01'))
  assert.deepEqual(epFolders, ['EP01 · THE INTERVIEW'])
  // and the file is now under that box EP, reachable
  assert.ok(drive.filesUnder(box).includes('clip.mp4'))
  assert.ok(!drive.filesUnder(landing).includes('clip.mp4'))
})

// ── the everyday happy path: move new files, leave dups where they are ────────
test('files already in the box are left in landing; only new files move', async () => {
  const root = drive.mkFolder('root', null)
  const landing = drive.mkFolder('landing', root)
  const box = drive.mkFolder('box', root)
  drive.mkFile('a.mp4', landing, 100) // already in box → dup
  drive.mkFile('b.mp4', landing, 200) // new → move
  drive.mkFile('a.mp4', box, 100)

  const stats = noStats()
  await mirrorMove(landing, box, 'X', stats, false)

  assert.equal(stats.dup, 1)
  assert.equal(stats.moved, 1)
  assert.deepEqual(drive.filesUnder(landing), ['a.mp4'])        // b.mp4 left landing
  assert.deepEqual(drive.filesUnder(box), ['a.mp4', 'b.mp4'])   // b.mp4 arrived
})

// ── size-sensitive dedup: same name, different size is NOT a duplicate ─────────
test('same filename but different size is treated as a new file', async () => {
  const root = drive.mkFolder('root', null)
  const landing = drive.mkFolder('landing', root)
  const box = drive.mkFolder('box', root)
  drive.mkFile('take.mp4', landing, 999) // re-export, bigger
  drive.mkFile('take.mp4', box, 100)     // old, smaller

  const stats = noStats()
  await mirrorMove(landing, box, 'X', stats, false)

  assert.equal(stats.dup, 0)
  assert.equal(stats.moved, 1)
})
