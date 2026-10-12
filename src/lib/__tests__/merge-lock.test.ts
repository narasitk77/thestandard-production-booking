/**
 * v1.268.1 — one merge per booking at a time (merge-lock.ts).
 *
 * The "รวมไฟล์เข้ากล่องนี้" button (booking-merge startMergeJob) never took the lock the
 * hourly video/sound routes use, so both could merge the same booking at once. These
 * tests make them overlap for real: one side is paused INSIDE a Drive move (FakeDrive),
 * and the other runs meanwhile.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDrive } from './helpers/fake-drive'

let drive: FakeDrive
let bookings: any[] = []

mock.module('../db', {
  namedExports: { prisma: { booking: { findMany: async () => bookings } } },
})
mock.module('../ops-alert', {
  namedExports: { OPS_ALERT_EVERY_MS: 1, alertOps: async () => ({ attempted: false }) },
})
// FakeDrive ids ("fld_3") are too short for the real getDriveLink's id check.
mock.module('../drive-links', {
  namedExports: {
    getDriveLink: (df: any, k: string) => df?.[k] ?? null,
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
    isFolderAlive: (id: string) => drive.isFolderAlive(id),
    hasDriveCredentials: () => true,
    findEpisodeFolderUrls: async () => ({}),
    SOUND_STAGING_DIR: '_SOUND-STAGING',
    listSoundStagingBookingFolders: async (id: string) => (await drive.listChildFolders(id)).map(f => ({ ...f, parentId: id })),
    listFilesRecursive: (id: string) => drive.listFilesInFolder(id),
    copyFileToFolder: async () => { throw new Error('unexpected copy') },
  },
})

// The landing root is the FIRST folder each test creates.
process.env.DRIVE_PRODUCTION_TEAM_ROOT = 'fld_1'
let vm: typeof import('../video-merge')
let sm: typeof import('../sound-merge')
let bm: typeof import('../booking-merge')
let lk: typeof import('../merge-lock')
before(async () => {
  vm = await import('../video-merge'); sm = await import('../sound-merge')
  bm = await import('../booking-merge'); lk = await import('../merge-lock')
})

let landingRoot: string, footageRoot: string
beforeEach(() => {
  drive = new FakeDrive()
  landingRoot = drive.mkFolder('Production Team', null)
  assert.equal(landingRoot, 'fld_1')
  footageRoot = drive.mkFolder('VIDEO 2026', null)
  process.env.DRIVE_FOOTAGE_ROOT = footageRoot
})

const SKIPPED = 'merge already running for this booking (per-booking button)'

/** A booking whose landing folder holds one clip and whose box is empty. */
function booking(id: string, code: string) {
  const landing = drive.mkFolder(`x (${code})`, landingRoot)
  drive.mkFile(`${code}.MXF`, landing, 10)
  const box = drive.mkFolder(`box ${code}`, footageRoot)
  return {
    landing, box,
    row: {
      id, bookingCode: code, driveFolders: { landing, box } as Record<string, string>,
      projectId: null, projectName: 'x', category: null, crewRequired: [] as string[],
      outlet: { code: 'NWS' }, program: { name: 'p' }, episodes: [],
    },
  }
}

/** Pause the next Drive move until release(); `entered` resolves once it is paused. */
function pauseNextMove() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(r => { enter = r })
  const gate = new Promise<void>(r => { release = r })
  const real = drive.moveFileToFolder
  let first = true
  drive.moveFileToFolder = async (id: string, t: string, r: string) => {
    if (first) { first = false; enter(); await gate }
    return real(id, t, r)
  }
  return { entered, release }
}

test('the hourly video pass skips the booking the button is merging, and still merges the others', async () => {
  const a = booking('b1', 'NWS-X-261011-01')
  const b = booking('b2', 'NWS-X-261011-02')
  bookings = [a.row, b.row]
  const pause = pauseNextMove()
  let finished!: () => void
  const jobDone = new Promise<void>(r => { finished = r })

  assert.ok(bm.startMergeJob('b1', a.row, async () => finished()))
  await pause.entered // the button is mid-move on b1

  const hourly = await vm.runVideoMerge()
  assert.deepEqual(hourly.results.find(r => r.bookingCode === 'NWS-X-261011-01'), { bookingCode: 'NWS-X-261011-01', skipped: SKIPPED })
  assert.equal(hourly.results.find(r => r.bookingCode === 'NWS-X-261011-02')?.moved, 1)
  assert.deepEqual(drive.filesUnder(a.landing), ['NWS-X-261011-01.MXF']) // the hourly pass left b1 alone

  pause.release(); await jobDone
  assert.equal(bm.getMergeJobStatus('b1').result?.video.moved, 1)
  assert.deepEqual(drive.filesUnder(a.box), ['NWS-X-261011-01.MXF'])

  // the job let go: the next hourly pass handles b1 again
  const next = await vm.runVideoMerge()
  assert.equal(next.results.find(r => r.bookingCode === 'NWS-X-261011-01')?.skipped, undefined)
})

test('the button is refused (null → 409) while the hourly pass is on that booking', async () => {
  const a = booking('b3', 'NWS-X-261011-03')
  bookings = [a.row]
  const pause = pauseNextMove()

  const hourly = vm.runVideoMerge()
  await pause.entered // the hourly pass is mid-move on b3
  assert.equal(bm.startMergeJob('b3', a.row), null)
  assert.equal(bm.getMergeJobStatus('b3').running, false) // nothing was started

  pause.release(); await hourly
  let finished!: () => void
  const jobDone = new Promise<void>(r => { finished = r })
  assert.equal(bm.startMergeJob('b3', a.row, async () => finished())?.running, true)
  await jobDone
})

test('a merge job that throws still lets go of the booking', async () => {
  const a = booking('b4', 'NWS-X-261011-04')
  drive.isFolderAlive = async () => { throw new Error('drive down') }

  assert.ok(bm.startMergeJob('b4', a.row))
  while (!bm.getMergeJobStatus('b4').done) await new Promise(r => setImmediate(r))
  assert.match(bm.getMergeJobStatus('b4').error ?? '', /drive down/)
  const keys = [lk.videoMergeKey('b4'), lk.soundMergeKey('b4')]
  assert.ok(lk.tryLockMerge(keys))
  lk.unlockMerge(keys)
})

test('the button takes both keys or neither: refused by the hourly sound pass, it keeps no video key', async () => {
  const a = booking('b5', 'NWS-X-261011-05')
  const sound = [lk.soundMergeKey('b5')]
  assert.ok(lk.tryLockMerge(sound)) // the hourly sound pass is on b5

  assert.equal(bm.startMergeJob('b5', a.row), null)
  const video = [lk.videoMergeKey('b5')]
  assert.ok(lk.tryLockMerge(video), 'a refused button must not hold the video key')
  lk.unlockMerge(video); lk.unlockMerge(sound)
})

test('the hourly sound pass skips the booking the button holds, without touching Drive for it', async () => {
  const staging = drive.mkFolder('NWS-X-261011-06', drive.mkFolder('_SOUND-STAGING', footageRoot))
  const a = booking('b6', 'NWS-X-261011-06')
  bookings = [{ ...a.row, crewRequired: ['Sound'], driveFolders: { ...a.row.driveFolders, staging } }]
  const held = [lk.soundMergeKey('b6')]
  assert.ok(lk.tryLockMerge(held)) // the button is on b6
  const touched: string[] = []
  const realAlive = drive.isFolderAlive
  drive.isFolderAlive = async (id: string) => { touched.push(id); return realAlive(id) }

  const r = await sm.runSoundMerge()
  assert.deepEqual(r.results, [{ bookingCode: 'NWS-X-261011-06', skipped: SKIPPED }])
  assert.deepEqual(touched, [])

  lk.unlockMerge(held)
  const r2 = await sm.runSoundMerge()
  assert.deepEqual(r2.results, [{ bookingCode: 'NWS-X-261011-06', staged: 0 }]) // went on (empty staging)…
  assert.ok(lk.tryLockMerge(held)) // …and let go afterwards
  lk.unlockMerge(held)
})
