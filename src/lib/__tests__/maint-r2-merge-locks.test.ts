/**
 * maint 2026-11-08 round 2 (merge) — the round-1 handoffs to sound-merge.ts / booking-merge.ts, against FakeDrive:
 *
 * - sound-merge chose between a stored staging/box id and the NAME walk with isFolderAlive, which reads 'unknown'
 *   (a 403 rateLimitExceeded, not retried) as dead → the walk picked a "(1)" twin staging folder / found no box.
 *   It now uses video-merge's storedFolder: only a folder Drive says is GONE falls back.
 * - sound-merge and the per-booking button freed their merge locks WITHOUT the token: a run that outlived its lock
 *   (hung Drive call) freed the lock of the run that had taken it over → two merges on one booking.
 * - the button JOINED an unfinished job forever: a job hung on Drive kept the button on "กำลังย้าย" even after its lock
 *   expired. It now joins only a job younger than MERGE_LOCK_MAX_MS.
 */
import { test, mock, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDrive } from './helpers/fake-drive'

let drive: FakeDrive
let bookings: any[] = []
let copyGate: Promise<void> | null = null
let copyEntered: () => void = () => {}
const copies: Array<{ id: string; to: string; name: string }> = []

mock.module('../db', {
  namedExports: { prisma: { booking: { findMany: async () => bookings } } },
})
mock.module('../ops-alert', {
  namedExports: { OPS_ALERT_EVERY_MS: 1, alertOps: async () => ({ attempted: false }) },
})
mock.module('../drive-links', {
  namedExports: {
    getDriveLink: (df: any, k: string) => df?.[k] ?? null, // FakeDrive ids are too short for the real id check
    rememberDriveLinks: async () => {},
  },
})
mock.module('../google-drive', {
  namedExports: {
    listFilesInFolder: (id: string) => drive.listFilesInFolder(id),
    listChildFolders: (id: string) => drive.listChildFolders(id),
    findChildFolder: (p: string, n: string) => drive.findChildFolder(p, n),
    isFolderEmpty: (id: string) => drive.isFolderEmpty(id),
    trashDriveItem: (id: string) => drive.trashDriveItem(id),
    moveFileToFolder: (id: string, t: string, r: string) => drive.moveFileToFolder(id, t, r),
    ensureFolderPath: (root: string, segs: string[]) => drive.ensureFolderPath(root, segs),
    downloadDriveFile: (id: string) => drive.downloadDriveFile(id),
    // the REAL boolean view: only 'alive' is true (what sound-merge used before)
    isFolderAlive: async (id: string) => (await drive.folderLiveness(id)) === 'alive',
    folderLiveness: (id: string) => drive.folderLiveness(id),
    hasDriveCredentials: () => true,
    findEpisodeFolderUrls: async () => ({}), // the name walk finds no box
    SOUND_STAGING_DIR: '_SOUND-STAGING',
    listSoundStagingBookingFolders: async (id: string) => (await drive.listChildFolders(id)).map(f => ({ ...f, parentId: id })),
    listFilesRecursive: (id: string) => drive.listFilesInFolder(id),
    copyFileToFolder: async (id: string, to: string, name: string) => {
      if (copyGate) { const g = copyGate; copyGate = null; copyEntered(); await g }
      copies.push({ id, to, name })
    },
  },
})

process.env.DRIVE_PRODUCTION_TEAM_ROOT = 'fld_1' // the landing root is the FIRST folder each test creates
let sm: typeof import('../sound-merge')
let bm: typeof import('../booking-merge')
let lk: typeof import('../merge-lock')
before(async () => {
  sm = await import('../sound-merge'); bm = await import('../booking-merge'); lk = await import('../merge-lock')
})

let landingRoot: string, footageRoot: string, stagingRoot: string
beforeEach(() => {
  drive = new FakeDrive()
  landingRoot = drive.mkFolder('Production Team', null)
  assert.equal(landingRoot, 'fld_1')
  footageRoot = drive.mkFolder('VIDEO 2026', null)
  stagingRoot = drive.mkFolder('_SOUND-STAGING', footageRoot)
  process.env.DRIVE_FOOTAGE_ROOT = footageRoot
  bookings = []; copies.length = 0; copyGate = null
})
afterEach(() => { mock.timers.reset() })

/** A Sound booking: stored staging (one WAV) + stored box. An older, empty "(1)" twin staging folder matches the code
 *  by name and is what the name walk picks first (oldest createdTime). */
function soundBooking(id: string, code: string) {
  const twin = drive.mkFolder(`${code} (1)`, stagingRoot)
  const staging = drive.mkFolder(code, stagingRoot)
  drive.mkFile(`${code}_A001.WAV`, staging, 10)
  const box = drive.mkFolder(`box ${code}`, footageRoot)
  return {
    staging, twin, box,
    row: {
      id, bookingCode: code, driveFolders: { staging, box } as Record<string, string>,
      projectId: null, projectName: 'x', category: null, crewRequired: ['Sound'],
      outlet: { code: 'NWS' }, program: { name: 'p' }, episodes: [],
    },
  }
}

test('sound-merge: stored staging/box that Drive cannot answer for (unknown) are trusted, not swapped for a name walk', async () => {
  const a = soundBooking('s1', 'NWS-X-261108-11')
  drive.unknown.add(a.staging); drive.unknown.add(a.box)
  bookings = [a.row]
  const r = await sm.runSoundMerge()
  assert.deepEqual(r.results, [{ bookingCode: 'NWS-X-261108-11', staged: 1, copied: 1 }],
    'pre-fix: unknown read as dead → the empty twin staging (staged 0) / "box not found"')
  assert.equal(copies.length, 1)
  assert.equal(drive.folders.get(copies[0].to)?.parent, a.box, 'copied into the stored box\'s AUDIO')

  // the per-booking variant (the merge button's sound step)
  copies.length = 0
  const b = soundBooking('s2', 'NWS-X-261108-12')
  drive.unknown.add(b.staging); drive.unknown.add(b.box)
  const one = await sm.mergeBookingSound(b.row)
  assert.equal(one.staged, 1)
  assert.equal(one.copied, 1)
  assert.equal(one.boxFolderUrl, `https://drive.google.com/drive/folders/${b.box}`)
})

test('sound-merge: a stored id Drive says is GONE still falls back to the name walk', async () => {
  const a = soundBooking('s3', 'NWS-X-261108-13')
  await drive.trashDriveItem(a.staging)
  bookings = [a.row]
  const r = await sm.runSoundMerge()
  // the name walk finds the twin "(1)" (the trashed folder is not listed) → it holds no audio
  assert.deepEqual(r.results, [{ bookingCode: 'NWS-X-261108-13', staged: 0 }])
})

test('sound-merge: a pass that outlived its lock does not free the lock of the run that took it over', async () => {
  const a = soundBooking('s4', 'NWS-X-261108-14')
  bookings = [a.row]
  const keys = [lk.soundMergeKey('s4')]
  const entered = new Promise<void>(r => { copyEntered = r })
  let release!: () => void
  copyGate = new Promise<void>(r => { release = r })
  const errors = mock.method(console, 'error', () => {})
  try {
    const hourly = sm.runSoundMerge()
    await entered // the hourly sound pass is mid-copy on s4 — hung on Drive, as far as anyone can tell
    const later = Date.now() + lk.MERGE_LOCK_MAX_MS + 1
    const takeover = lk.tryLockMerge(keys, later) // the button, 2 h later, takes the expired lock over
    assert.ok(takeover)
    release(); await hourly // the hung copy finally returns → the pass's finally runs
    assert.equal(lk.tryLockMerge(keys, later + 1), 0, 'pre-fix: the stale pass freed the button\'s lock')
    lk.unlockMerge(keys, takeover)
  } finally { errors.mock.restore() }
})

test('booking-merge: a hung job that outlived its lock does not free the lock of the run that took it over', async () => {
  const a = soundBooking('s5', 'NWS-X-261108-15')
  const keys = [lk.videoMergeKey('s5'), lk.soundMergeKey('s5')]
  const entered = new Promise<void>(r => { copyEntered = r })
  let release!: () => void
  copyGate = new Promise<void>(r => { release = r })
  let finished!: () => void
  const jobDone = new Promise<void>(r => { finished = r })
  const errors = mock.method(console, 'error', () => {})
  try {
    assert.ok(bm.startMergeJob('s5', a.row, async () => finished()))
    await entered // the button's job is mid-copy (its sound step)
    const later = Date.now() + lk.MERGE_LOCK_MAX_MS + 1
    const takeover = lk.tryLockMerge(keys, later) // the hourly passes, 2 h later, take both expired keys over
    assert.ok(takeover)
    release(); await jobDone
    while (!bm.getMergeJobStatus('s5').done) await new Promise(r => setImmediate(r))
    assert.equal(lk.tryLockMerge([keys[0]], later + 1), 0, 'pre-fix: the stale job freed the video key')
    assert.equal(lk.tryLockMerge([keys[1]], later + 1), 0, 'pre-fix: the stale job freed the sound key')
    lk.unlockMerge(keys, takeover)
  } finally { errors.mock.restore() }
})

test('booking-merge: the button joins a running job only while it is younger than MERGE_LOCK_MAX_MS, then starts a fresh one (loudly)', async () => {
  const T = 1_800_000_000_000
  mock.timers.enable({ apis: ['Date'], now: T })
  const a = soundBooking('s6', 'NWS-X-261108-16')
  const entered = new Promise<void>(r => { copyEntered = r })
  let release!: () => void
  copyGate = new Promise<void>(r => { release = r })
  const errors = mock.method(console, 'error', () => {})
  try {
    const first = bm.startMergeJob('s6', a.row)
    assert.ok(first?.running)
    await entered // hung on Drive

    mock.timers.setTime(T + lk.MERGE_LOCK_MAX_MS - 1)
    assert.equal(bm.startMergeJob('s6', a.row)?.startedAt, first!.startedAt, 'still young: join it')

    mock.timers.setTime(T + lk.MERGE_LOCK_MAX_MS)
    let finished!: () => void
    const jobDone = new Promise<void>(r => { finished = r })
    const fresh = bm.startMergeJob('s6', a.row, async () => finished())
    assert.ok(fresh?.running)
    assert.notEqual(fresh!.startedAt, first!.startedAt, 'pre-fix: joined the hung job forever ("กำลังย้าย" with nothing moving)')
    assert.ok(errors.mock.calls.some(c => /\[booking-merge\].*ยังไม่จบ/.test(String(c.arguments[0]))), 'giving up on it is logged as an error')
    await jobDone
    while (!bm.getMergeJobStatus('s6').done) await new Promise(r => setImmediate(r)) // the fresh job is the one reported

    release() // the hung job finally returns: it must not flip the fresh job's status
    await new Promise(r => setImmediate(r))
    assert.equal(bm.getMergeJobStatus('s6').startedAt, fresh!.startedAt)
  } finally { errors.mock.restore() }
})
