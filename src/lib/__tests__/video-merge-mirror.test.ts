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
    downloadDriveFile: (id: string) => drive.downloadDriveFile(id), // v1.280 — the card hold reads MEDIAPRO.XML
    hasDriveCredentials: () => true,
    // imported by video-merge but unused by mirrorMove — present so the binding exists
    findEpisodeFolderUrls: async () => ({}),
  },
})
// Imported after the mock is registered (top-level await is unavailable under
// the cjs test transform, so use the async `before` hook).
let mirrorMove: typeof import('../video-merge').mirrorMove
before(async () => { ({ mirrorMove } = await import('../video-merge')) })

const noStats = () => ({ seen: 0, moved: 0, movedFolders: 0, dup: 0, err: 0, conflicts: [] as string[], cardHolds: [] as string[] })

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

// ── v1.280: a multi-day booking's day 2 card must never land on day 1's ───────
// AGN-261104-01 (4–6 Nov, one EP): every day's cards went into the same EP/CAM-X. Per-file dedup
// (name|size per folder) then put day 2's MEDIAPRO.XML beside day 1's in one XDROOT, or left the
// 0-byte SONYCARD.IND in landing forever as "dup". Day folders + the card hold close both.

/** MEDIAPRO.XML in `parent` listing these clips: [uri under the card root folder, dur, umid?] (a real Sony index, trimmed) */
function mediapro(parent: string, clips: Array<[string, number, string?]>, size = 100) {
  const id = drive.mkFile('MEDIAPRO.XML', parent, size)
  drive.content.set(id, `<?xml version="1.0"?><MediaProfile xmlns="http://xmlns.sony.net/pro/metadata/mediaprofile"><Contents>${
    clips.map(([uri, dur, umid]) => `<Material uri="./${uri}" type="MXF" dur="${dur}" fps="25p"${umid ? ` umid="${umid}"` : ''}/>`).join('')}</Contents></MediaProfile>`)
  return id
}

/** a Sony card root: XDROOT/{MEDIAPRO.XML, Clip/<clip>.MXF} + SONY/SONYCARD.IND (0 bytes, every card) */
function card(parent: string, mediaproSize: number, clip: string) {
  const xd = drive.mkFolder('XDROOT', parent)
  mediapro(xd, [[`Clip/${clip}`, 1000]], mediaproSize)
  drive.mkFile(clip, drive.mkFolder('Clip', xd), 1000)
  drive.mkFile('SONYCARD.IND', drive.mkFolder('SONY', parent), 0)
  return xd
}

test('v1.280: a day folder with no box twin moves WHOLE — no index file lands beside day 1', async () => {
  const root = drive.mkFolder('root', null)
  const box = drive.mkFolder('box', root)
  const boxCam = drive.mkFolder('CAM-A', drive.mkFolder('EP01 · x', box))
  const boxXd = card(boxCam, 100, 'A001C001_261104XX.MXF') // day 1, merged yesterday
  const landing = drive.mkFolder('x (AGN-261104-01)', root)
  const landCam = drive.mkFolder('CAM-A', drive.mkFolder('EP01 · x', landing))
  card(drive.mkFolder('D2-261105', landCam), 120, 'A008C001_261105XX.MXF')

  const stats = noStats()
  await mirrorMove(landing, box, 'AGN-261104-01', stats, false)

  assert.equal(stats.movedFolders, 1)
  assert.deepEqual(stats.cardHolds, [])
  assert.deepEqual(drive.filesUnder(landing), [])                                // landing empty — SONYCARD.IND not stranded
  assert.deepEqual(drive.childFolderNames(boxCam), ['XDROOT', 'SONY', 'D2-261105']) // day 2 is its own folder
  assert.deepEqual(drive.filesUnder(boxXd).filter(n => n === 'MEDIAPRO.XML'), ['MEDIAPRO.XML']) // still ONE in day 1's XDROOT
})

test('v1.280: with box day folders pre-made, only the FILLED landing day moves; the empty one stays a drop target', async () => {
  const root = drive.mkFolder('root', null)
  const box = drive.mkFolder('box', root)
  const boxCam = drive.mkFolder('CAM-A', box)
  drive.mkFolder('D1-261104', boxCam) // box first (landing-lifecycle ensureBoxDays)
  drive.mkFolder('D2-261105', boxCam)
  const landing = drive.mkFolder('landing', root)
  const landCam = drive.mkFolder('CAM-A', landing)
  const landD1 = drive.mkFolder('D1-261104', landCam)
  card(landD1, 100, 'A001C001_261104XX.MXF')
  drive.mkFolder('D2-261105', landCam) // tomorrow's, still empty

  const stats = noStats()
  await mirrorMove(landing, box, 'X', stats, false)

  assert.equal(stats.movedFolders, 1)
  assert.deepEqual(drive.childFolderNames(landCam), ['D2-261105'])               // the crew still has day 2's door
  assert.deepEqual(drive.childFolderNames(boxCam).sort(), ['D1-261104', 'D2-261105']) // ONE D1 (empty twin swapped out)
  assert.ok(drive.filesUnder(boxCam).includes('A001C001_261104XX.MXF'))
})

// The hold (G1/G2): decided at the CARD ROOT (the folder holding XDROOT, or PRIVATE/M4ROOT) before any part of it
// moves. When the landing index folder and its box twin both hold MEDIAPRO.XML, both are READ: a clip in common
// (same umid, or same uri + dur when either side has no umid) = the same card offloaded again → merged exactly as
// before v1.280. None in common = a different card → its parts (XDROOT/M4ROOT/PRIVATE/SONY/DCIM/AVF_INFO/MISC + loose
// files) stay in landing and the card root is reported. An unreadable MEDIAPRO keeps the card too, as an ERROR.

/** box EP01/CAM-A = day 1's card (XDROOT/{MEDIAPRO[A001C001], Clip/A001C001}, SONY/SONYCARD.IND) + box CAM-B = B001 card */
function boxDay1(box: string) {
  const ep = drive.mkFolder('EP01 · x', box)
  const camA = drive.mkFolder('CAM-A', ep)
  const xd = drive.mkFolder('XDROOT', camA)
  mediapro(xd, [['Clip/A001C001_261104XX.MXF', 1000]], 100)
  drive.mkFile('A001C001_261104XX.MXF', drive.mkFolder('Clip', xd), 1000)
  drive.mkFile('SONYCARD.IND', drive.mkFolder('SONY', camA), 0)
  const camB = drive.mkFolder('CAM-B', ep)
  drive.mkFile('B001C001_261104XX.MXF', drive.mkFolder('Clip', drive.mkFolder('XDROOT', camB)), 1000)
  return { ep, camA, xd, camB }
}

/** landing EP01/CAM-A with a DIFFERENT card (A008, its own MEDIAPRO) dumped flat onto day 1's slot */
function landDay2Flat(landing: string, mediaproSize = 120) {
  const ep = drive.mkFolder('EP01 · x', landing)
  const camA = drive.mkFolder('CAM-A', ep)
  const xd = drive.mkFolder('XDROOT', camA)
  mediapro(xd, [['Clip/A008C001_261105XX.MXF', 1000]], mediaproSize)
  drive.mkFile('A008C001_261105XX.MXF', drive.mkFolder('Clip', xd), 1000)
  drive.mkFile('SONYCARD.IND', drive.mkFolder('SONY', camA), 0)
  return { ep, camA }
}

/** run the same scenario on a fresh drive, real and dryRun; `left` = the landing files the real run moved out */
async function realAndDry(build: () => { landing: string; box: string }) {
  const once = async (dryRun: boolean) => {
    drive = new FakeDrive()
    const { landing, box } = build()
    const before = drive.filesUnder(landing)
    const stats = noStats()
    await mirrorMove(landing, box, 'AGN-261104-01', stats, dryRun)
    const landingFiles = drive.filesUnder(landing)
    const left = [...before]
    for (const n of landingFiles) left.splice(left.indexOf(n), 1)
    return { stats, landingFiles, boxFiles: drive.filesUnder(box), left }
  }
  const real = await once(false)
  const dry = await once(true)
  return { real, dry }
}

/**
 * dryRun says what the real run did: the same holds and errors, and one would-move per file that really left landing.
 * (Whole-stats deepEqual is impossible when the real run takes the whole-folder fast path — movedFolders, contents
 * uncounted — which dryRun never takes; that difference predates v1.280.)
 */
function assertPreviewMatches(real: { stats: ReturnType<typeof noStats>; left: string[] }, dry: { stats: ReturnType<typeof noStats>; landingFiles: string[] }) {
  assert.deepEqual(dry.stats.cardHolds, real.stats.cardHolds)
  assert.equal(dry.stats.err, real.stats.err)
  assert.equal(dry.stats.moved, real.left.length)
}

for (const [label, size] of [['a bigger', 120], ['an EQUAL-size', 100]] as const) {
  test(`v1.280: a second card (${label} MEDIAPRO.XML, no clip in common) poured flat onto day 1's card is HELD whole — dryRun the same`, async () => {
    const { real, dry } = await realAndDry(() => {
      const root = drive.mkFolder('root', null)
      const box = drive.mkFolder('box', root)
      boxDay1(box)
      const landing = drive.mkFolder('landing', root)
      landDay2Flat(landing, size)
      return { landing, box }
    })
    assert.equal(real.stats.moved, 0)
    assert.equal(real.stats.movedFolders, 0)
    assert.equal(real.stats.err, 0)
    assert.deepEqual(real.stats.cardHolds, ['AGN-261104-01: EP01 · x/CAM-A']) // the CARD ROOT
    assert.deepEqual(real.landingFiles, ['A008C001_261105XX.MXF', 'MEDIAPRO.XML', 'SONYCARD.IND']) // whole card still in landing
    assert.deepEqual(real.boxFiles, ['A001C001_261104XX.MXF', 'B001C001_261104XX.MXF', 'MEDIAPRO.XML', 'SONYCARD.IND'])
    assert.deepEqual(dry.stats, real.stats) // the preview reports exactly the real run's holds
  })
}

test('v1.280: a held card moves NOTHING of itself — not its SONY/SONYCARD.IND, not an AVF_INFO of another size, not a loose file', async () => {
  const { real, dry } = await realAndDry(() => {
    const root = drive.mkFolder('root', null)
    const box = drive.mkFolder('box', root)
    const { camA } = boxDay1(box)
    drive.mkFile('AVIN0001.BNP', drive.mkFolder('AVF_INFO', camA), 300)
    const landing = drive.mkFolder('landing', root)
    const land = landDay2Flat(landing)
    drive.mkFile('AVIN0001.BNP', drive.mkFolder('AVF_INFO', land.camA), 420) // a size the box has not got → would move
    drive.mkFile('DISCMETA.XML', land.camA, 40)                               // loose at the card root
    return { landing, box }
  })
  assert.deepEqual(real.stats.cardHolds, ['AGN-261104-01: EP01 · x/CAM-A'])
  assert.deepEqual(real.left, [])                                     // nothing of the card left landing
  assert.equal(real.boxFiles.filter(n => n === 'AVIN0001.BNP').length, 1) // the box kept only its own
  assert.ok(!real.boxFiles.includes('DISCMETA.XML'))
  assert.deepEqual(dry.stats, real.stats)
})

test('v1.280: a correct D2-261105 beside a flat-dumped different card still moves WHOLE; the flat card stays', async () => {
  const { real, dry } = await realAndDry(() => {
    const root = drive.mkFolder('root', null)
    const box = drive.mkFolder('box', root)
    boxDay1(box)
    const landing = drive.mkFolder('landing', root)
    const land = landDay2Flat(landing)
    card(drive.mkFolder('D2-261105', land.camA), 90, 'A009C001_261105XX.MXF') // the crew rule: its own folder
    return { landing, box }
  })
  assert.deepEqual(real.stats.cardHolds, ['AGN-261104-01: EP01 · x/CAM-A'])
  assert.equal(real.stats.movedFolders, 1)                           // D2-261105 relocated whole
  assert.deepEqual(real.left.sort(), ['A009C001_261105XX.MXF', 'MEDIAPRO.XML', 'SONYCARD.IND'])
  assert.deepEqual(real.landingFiles, ['A008C001_261105XX.MXF', 'MEDIAPRO.XML', 'SONYCARD.IND']) // only the held card
  assert.ok(real.boxFiles.includes('A009C001_261105XX.MXF'))
  assertPreviewMatches(real, dry)
})

test('v1.280: the SAME card offloaded again (MEDIAPRO shares a clip) is NOT held — merged exactly as before', async () => {
  const { real, dry } = await realAndDry(() => {
    const root = drive.mkFolder('root', null)
    const box = drive.mkFolder('box', root)
    boxDay1(box)
    const landing = drive.mkFolder('landing', root)
    const xd = drive.mkFolder('XDROOT', drive.mkFolder('CAM-A', drive.mkFolder('EP01 · x', landing)))
    mediapro(xd, [['Clip/A001C001_261104XX.MXF', 1000], ['Clip/A001C002_261104XX.MXF', 800]], 150) // index grew since lunch
    const clip = drive.mkFolder('Clip', xd)
    drive.mkFile('A001C001_261104XX.MXF', clip, 1000)            // already in the box
    drive.mkFile('A001C002_261104XX.MXF', clip, 1000)            // recorded after lunch
    return { landing, box }
  })
  assert.deepEqual(real.stats.cardHolds, [])
  assert.equal(real.stats.moved, 2)  // MEDIAPRO.XML (different size → new, as before v1.280) + A001C002
  assert.equal(real.stats.dup, 1)    // A001C001 already in the box
  assert.deepEqual(real.landingFiles, ['A001C001_261104XX.MXF'])
  assert.deepEqual(dry.stats, real.stats)
})

test('v1.280: a PARTIAL re-offload (only the new clips + a grown MEDIAPRO that still lists the old ones) is NOT held', async () => {
  // Cloud Sync re-sends only new/changed files: the landing card shares no clip FILE with the box, only the index knows
  const { real, dry } = await realAndDry(() => {
    const root = drive.mkFolder('root', null)
    const box = drive.mkFolder('box', root)
    boxDay1(box)
    const landing = drive.mkFolder('landing', root)
    const xd = drive.mkFolder('XDROOT', drive.mkFolder('CAM-A', drive.mkFolder('EP01 · x', landing)))
    mediapro(xd, [['Clip/A001C001_261104XX.MXF', 1000], ['Clip/A001C002_261104XX.MXF', 800]], 150)
    drive.mkFile('A001C002_261104XX.MXF', drive.mkFolder('Clip', xd), 1000)
    return { landing, box }
  })
  assert.deepEqual(real.stats.cardHolds, [])
  assert.equal(real.stats.moved, 2) // the grown MEDIAPRO.XML + A001C002, as before v1.280
  assert.deepEqual(real.landingFiles, [])
  assert.deepEqual(dry.stats, real.stats)
})

test('v1.280: the same card FULLY re-offloaded (identical index + clips) is not held — every file is a dup, as before', async () => {
  const { real, dry } = await realAndDry(() => {
    const root = drive.mkFolder('root', null)
    const box = drive.mkFolder('box', root)
    boxDay1(box)
    const landing = drive.mkFolder('landing', root)
    const camA = drive.mkFolder('CAM-A', drive.mkFolder('EP01 · x', landing))
    card(camA, 100, 'A001C001_261104XX.MXF')
    return { landing, box }
  })
  assert.deepEqual(real.stats.cardHolds, [])
  assert.equal(real.stats.moved, 0)
  assert.equal(real.stats.dup, 3) // MEDIAPRO.XML, A001C001, SONYCARD.IND
  assert.deepEqual(dry.stats, real.stats)
})

// FX3/FX30 (XAVC-S): PRIVATE/M4ROOT, and CLIP restarts at C0001 on every card — the uri alone never tells two apart
for (const [label, box1, land1] of [
  ['the umids differ (same uri, same dur)', ['CLIP/C0001.MP4', 500, '060A2B34-AAAA'], ['CLIP/C0001.MP4', 500, '060A2B34-BBBB']],
  ['no umid: same uri, different dur', ['CLIP/C0001.MP4', 500], ['CLIP/C0001.MP4', 730]],
] as const) {
  test(`v1.280: a different FX3 card with C0001 names (${label}) is HELD by its card root — DCIM/AVF_INFO stay too`, async () => {
    const fx3 = (parent: string, mat: readonly [string, number, string?], clipSize: number, avin: number) => {
      const m4 = drive.mkFolder('M4ROOT', drive.mkFolder('PRIVATE', parent))
      mediapro(m4, [[mat[0], mat[1], mat[2]]], 100)
      drive.mkFile('C0001.MP4', drive.mkFolder('CLIP', m4), clipSize)
      drive.mkFile('AVIN0001.BNP', drive.mkFolder('AVF_INFO', parent), avin)
      drive.mkFile('DSC00001.JPG', drive.mkFolder('100MSDCF', drive.mkFolder('DCIM', parent)), avin)
    }
    const { real, dry } = await realAndDry(() => {
      const root = drive.mkFolder('root', null)
      const box = drive.mkFolder('box', root)
      fx3(drive.mkFolder('CAM-A', box), box1, 1000, 300)
      const landing = drive.mkFolder('landing', root)
      fx3(drive.mkFolder('CAM-A', landing), land1, 2000, 420)
      return { landing, box }
    })
    assert.deepEqual(real.stats.cardHolds, ['AGN-261104-01: CAM-A'])
    assert.deepEqual(real.left, [])
    assert.equal(real.stats.moved, 0)
    assert.deepEqual(dry.stats, real.stats)
  })
}

for (const [label, arrange] of [
  ['not a MEDIAPRO (an error page)', (id: string) => drive.content.set(id, '<html>error page</html>')],
  ['the download fails', (id: string) => drive.content.delete(id)],
] as const) {
  test(`v1.280: a landing MEDIAPRO that cannot be read (${label}) keeps the card in landing as an ERROR, not a hold — siblings still merge`, async () => {
    const { real, dry } = await realAndDry(() => {
      const root = drive.mkFolder('root', null)
      const box = drive.mkFolder('box', root)
      boxDay1(box)
      const landing = drive.mkFolder('landing', root)
      const ep = drive.mkFolder('EP01 · x', landing)
      const camA = drive.mkFolder('CAM-A', ep)
      const xd = drive.mkFolder('XDROOT', camA)
      arrange(mediapro(xd, [['Clip/A008C001_261105XX.MXF', 1000]], 120))
      drive.mkFile('A008C001_261105XX.MXF', drive.mkFolder('Clip', xd), 1000)
      drive.mkFile('SONYCARD.IND', drive.mkFolder('SONY', camA), 0)
      card(drive.mkFolder('D2-261105', drive.mkFolder('CAM-B', ep)), 90, 'B008C001_261105XX.MXF')
      return { landing, box }
    })
    assert.equal(real.stats.err, 1)
    assert.deepEqual(real.stats.cardHolds, [])                       // never a guessed verdict
    assert.deepEqual(real.landingFiles, ['A008C001_261105XX.MXF', 'MEDIAPRO.XML', 'SONYCARD.IND']) // the card did not move
    assert.ok(real.boxFiles.includes('B008C001_261105XX.MXF'))         // CAM-B's card did
    assertPreviewMatches(real, dry)
  })
}

test('v1.280: a hold stops only its own card — a CAM-B sibling with a fresh card in its own folder still moves', async () => {
  const { real, dry } = await realAndDry(() => {
    const root = drive.mkFolder('root', null)
    const box = drive.mkFolder('box', root)
    boxDay1(box)
    const landing = drive.mkFolder('landing', root)
    const { ep } = landDay2Flat(landing)                                  // poured onto day 1's card → held
    card(drive.mkFolder('D2-261105', drive.mkFolder('CAM-B', ep)), 90, 'B008C001_261105XX.MXF') // the crew rule: its own folder
    return { landing, box }
  })
  assert.deepEqual(real.stats.cardHolds, ['AGN-261104-01: EP01 · x/CAM-A'])
  assert.equal(real.stats.movedFolders, 1) // CAM-B/D2-261105 relocated whole
  assert.deepEqual(real.landingFiles, ['A008C001_261105XX.MXF', 'MEDIAPRO.XML', 'SONYCARD.IND']) // only CAM-A's held card is left
  assert.ok(real.boxFiles.includes('B008C001_261105XX.MXF'))
  assertPreviewMatches(real, dry)
})

test('v1.280: an empty day folder holding only Finder junk (.DS_Store) is a shell — not moved', async () => {
  const root = drive.mkFolder('root', null)
  const box = drive.mkFolder('box', root)
  const boxCam = drive.mkFolder('CAM-A', box)
  card(drive.mkFolder('D1-261104', boxCam), 100, 'A001C001_261104XX.MXF')
  const landing = drive.mkFolder('landing', root)
  const landCam = drive.mkFolder('CAM-A', landing)
  drive.mkFile('.DS_Store', drive.mkFolder('D2-261105', landCam), 6148) // someone opened it in Finder

  const stats = noStats()
  await mirrorMove(landing, box, 'X', stats, false)

  assert.equal(stats.movedFolders, 0)
  assert.deepEqual(drive.childFolderNames(landCam), ['D2-261105'])
  assert.deepEqual(drive.childFolderNames(boxCam), ['D1-261104'])
})

test('v1.280: CARD_HOLD=0 is the rollback lever — the different card merges exactly as before v1.280 (no hold)', async () => {
  const prev = process.env.CARD_HOLD
  process.env.CARD_HOLD = '0'
  try {
    drive = new FakeDrive()
    const root = drive.mkFolder('root', null)
    const box = drive.mkFolder('box', root)
    boxDay1(box)
    const landing = drive.mkFolder('landing', root)
    landDay2Flat(landing, 120)
    const stats = noStats()
    await mirrorMove(landing, box, 'AGN-261104-01', stats, false)
    assert.deepEqual(stats.cardHolds, [])
    assert.equal(stats.err, 0)
    assert.ok(drive.filesUnder(box).includes('A008C001_261105XX.MXF'), 'pre-v1.280: the clip is mirrored into the box')
  } finally {
    if (prev === undefined) delete process.env.CARD_HOLD
    else process.env.CARD_HOLD = prev
  }
})

test('v1.280: a 0-byte MEDIAPRO.XML (interrupted copy) is no index — merged as before, never an endless "unreadable" error', async () => {
  const { real, dry } = await realAndDry(() => {
    const root = drive.mkFolder('root', null)
    const box = drive.mkFolder('box', root)
    boxDay1(box)
    const landing = drive.mkFolder('landing', root)
    const camA = drive.mkFolder('CAM-A', drive.mkFolder('EP01 · x', landing))
    const xd = drive.mkFolder('XDROOT', camA)
    drive.mkFile('MEDIAPRO.XML', xd, 0) // no content set: downloading it would throw → 'unreadable' if not filtered
    drive.mkFile('A001C002_261104XX.MXF', drive.mkFolder('Clip', xd), 1000)
    return { landing, box }
  })
  assert.equal(real.stats.err, 0)
  assert.deepEqual(real.stats.cardHolds, [])
  assert.ok(real.boxFiles.includes('A001C002_261104XX.MXF'))
  assertPreviewMatches(real, dry)
})
