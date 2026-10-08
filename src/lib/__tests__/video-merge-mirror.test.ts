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

const noStats = () => ({ seen: 0, moved: 0, movedFolders: 0, dup: 0, err: 0, conflicts: [] as string[] })

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

// ── v1.261: a sync storm ("XDROOT (1) (1)", "Thmbnl (2) (1)") must never land in the box ──
test('a landing subtree carrying sync-conflict names stays in landing and is reported', async () => {
  const root = drive.mkFolder('root', null)
  const landing = drive.mkFolder('Key Message · x (NWS-KYM-261005-01)', root)
  const ep = drive.mkFolder('EP01 · x', landing)
  const camB = drive.mkFolder('CAM-B', ep)
  // the clean card: must still merge
  const camA = drive.mkFolder('CAM-A', ep)
  drive.mkFile('A001C001.MXF', drive.mkFolder('Clip', drive.mkFolder('XDROOT', camA)), 10)
  // the storm: a clean-named XDROOT whose Thmbnl has conflict twins, plus shell siblings
  const xd = drive.mkFolder('XDROOT', camB)
  drive.mkFile('B001C001.MXF', drive.mkFolder('Clip', xd), 10)
  drive.mkFile('B001C001T01.JPG', drive.mkFolder('Thmbnl (1) (1)', xd), 1)
  drive.mkFile('SONYCARD.IND', drive.mkFolder('XDROOT (1) (2) (1)', camB), 0)
  drive.mkFile('B001C001 (1).MXF', camB, 10)
  const box = drive.mkFolder('box', root)

  const stats = noStats()
  await mirrorMove(landing, box, 'NWS-KYM-261005-01', stats, false)

  // clean footage from BOTH cards landed (CAM-B per file, not as a whole folder)…
  assert.ok(drive.filesUnder(box).includes('A001C001.MXF'))
  assert.ok(drive.filesUnder(box).includes('B001C001.MXF'))
  // …while every "(1)" item stayed behind in landing
  assert.ok(!drive.filesUnder(box).includes('SONYCARD.IND'))
  assert.ok(!drive.filesUnder(box).includes('B001C001 (1).MXF'))
  assert.ok(!drive.filesUnder(box).includes('B001C001T01.JPG'))
  assert.deepEqual(drive.childFolderNames(camB).sort(), ['XDROOT', 'XDROOT (1) (2) (1)'])
  assert.deepEqual(stats.conflicts.sort(), ['B001C001 (1).MXF', 'Thmbnl (1) (1)', 'XDROOT (1) (2) (1)'])
})

// ── v1.261.1: the hourly merge re-walked whole subtrees at every level ────────
// Steady state: the footage is already in the box, so every landing subfolder
// has a non-empty box twin. v1.261 still walked each subtree in full at every
// level (CLIP below was listed 6×); the hourly run went from ~6 to 33–52 min
// and the worker gave up at its 30-min timeout on every run. Here every level
// holds a file, so the empty-shell check stops at each folder's own first file:
// each folder is listed by that check and by the mirror itself, nothing more.
test('a steady-state pass does not re-walk subtrees (every level holds a file)', async () => {
  const root = drive.mkFolder('root', null)
  const landing = drive.mkFolder('landing', root)
  const box = drive.mkFolder('box', root)
  const landingIds: string[] = []
  let l = landing, b = box
  for (const name of ['EP01 · x', 'CAM-A', 'A032', 'M4ROOT', 'CLIP']) {
    l = drive.mkFolder(name, l); b = drive.mkFolder(name, b)
    landingIds.push(l)
    drive.mkFile(`${name}.bin`, l, 1); drive.mkFile(`${name}.bin`, b, 1) // already in box → stays
  }
  const listed = new Map<string, number>()
  const realList = drive.listFilesInFolder
  drive.listFilesInFolder = async (id: string) => { listed.set(id, (listed.get(id) ?? 0) + 1); return realList(id) }

  const stats = noStats()
  await mirrorMove(landing, box, 'X', stats, false)

  assert.equal(stats.dup, 5)
  for (const id of landingIds) assert.ok((listed.get(id) ?? 0) <= 2, `${id} listed ${listed.get(id)}×`)
})

// ── v1.261.1: a tree too deep to fully check for "(1)" names is not moved whole ──
test('a landing subtree deeper than the conflict scan is mirrored, not moved whole', async () => {
  const root = drive.mkFolder('root', null)
  const landing = drive.mkFolder('landing', root)
  const box = drive.mkFolder('box', root)
  let l = landing
  for (let i = 1; i <= 10; i++) l = drive.mkFolder(`L${i}`, l)
  drive.mkFile('deep.mxf', l, 10)

  const stats = noStats()
  await mirrorMove(landing, box, 'X', stats, false)

  assert.ok(drive.filesUnder(box).includes('deep.mxf'))  // footage still lands…
  assert.deepEqual(drive.childFolderNames(landing), ['L1']) // …but L1 itself was not carried over unchecked
  assert.equal(stats.movedFolders, 1)                      // the first fully-checked level moves whole
})

// ── v1.261.1: a folder left holding only empty "(1)" storm shells ─────────────
// After the real card has merged, a storm leaves CAM-B with nothing but empty
// "XDROOT (1) (1)" shells that keep regrowing. The shell check used to walk
// every one of them each hourly run (~12 Drive calls per shell) and then call
// CAM-B "empty", so the storm was never reported. It must be reported, stay in
// landing, and cost no walk into the shells.
test('a folder holding only empty "(1)" shells is reported, not walked', async () => {
  const root = drive.mkFolder('root', null)
  const landing = drive.mkFolder('landing', root)
  const ep = drive.mkFolder('EP01 · x', landing)
  const camB = drive.mkFolder('CAM-B', ep)
  const shellIds: string[] = []
  for (let i = 1; i <= 5; i++) {
    const shell = drive.mkFolder(`XDROOT${' (1)'.repeat(i)}`, camB)
    shellIds.push(shell)
    for (const sub of ['Clip', 'Sub', 'Thmbnl']) shellIds.push(drive.mkFolder(sub, shell))
  }
  const box = drive.mkFolder('box', root)
  const boxEp = drive.mkFolder('EP01 · x', box)
  drive.mkFile('B001C001.MXF', drive.mkFolder('XDROOT', drive.mkFolder('CAM-B', boxEp)), 10) // merged earlier
  const listed = new Set<string>()
  const realFiles = drive.listFilesInFolder, realFolders = drive.listChildFolders
  drive.listFilesInFolder = async (id: string) => { listed.add(id); return realFiles(id) }
  drive.listChildFolders = async (id: string) => { listed.add(id); return realFolders(id) }

  const stats = noStats()
  await mirrorMove(landing, box, 'X', stats, false)

  assert.equal(stats.conflicts.length, 5)                      // reported…
  assert.equal(drive.childFolderNames(camB).length, 5)         // …left in landing…
  assert.deepEqual(drive.filesUnder(box), ['B001C001.MXF'])    // …nothing new in the box
  assert.deepEqual(shellIds.filter(id => listed.has(id)), [])  // …and no shell was walked
})

// ── v1.261.1: the empty box twin is re-checked right before it is trashed ─────
// hasConflictInside runs between the first emptiness check and the trash; if
// footage lands in the twin meanwhile, the twin must survive (mirror into it).
test('a box twin that fills up during the conflict scan is not trashed', async () => {
  const root = drive.mkFolder('root', null)
  const landing = drive.mkFolder('landing', root)
  const landCam = drive.mkFolder('CAM-A', landing)
  drive.mkFile('A001.MXF', landCam, 10)
  const box = drive.mkFolder('box', root)
  const boxCam = drive.mkFolder('CAM-A', box) // empty prep skeleton
  // the 2nd listing of the landing CAM-A is hasConflictInside's — land a file in the twin right then
  let listings = 0
  const realList = drive.listFilesInFolder
  drive.listFilesInFolder = async (id: string) => {
    if (id === landCam && ++listings === 2) drive.mkFile('arrived-meanwhile.MXF', boxCam, 10)
    return realList(id)
  }

  await mirrorMove(landing, box, 'X', noStats(), false)

  assert.deepEqual(drive.childFolderNames(box), ['CAM-A'])
  assert.ok(drive.filesUnder(box).includes('arrived-meanwhile.MXF'))
  assert.ok(drive.filesUnder(box).includes('A001.MXF'))
})
