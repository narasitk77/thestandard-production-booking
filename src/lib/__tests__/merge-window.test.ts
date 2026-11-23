/**
 * maint 23 Nov 2026 — the booking picker of the hourly video-merge / sound-merge (mergeBookingsWhere).
 *
 * - PM-PMG-260916-01 shot 16 Sep–6 Oct; its 1,988 files (43 GB) reached landing on 2 Nov, 47 days after the FIRST shoot
 *   day. Both merges windowed on shootDate alone, so neither ever looked at it. The window now covers the whole range.
 * - `?code=PM-PMG-260916-01` answered `{ skipped:false, bookings:0 }` — "nothing to merge" — because the code was
 *   filtered inside the windowed list. A ?code= run now looks the code up with no window, and a code it will not merge
 *   (not found, deleted, not CONFIRMED/COMPLETED, no sound crew) answers skipped:true with the reason. Read-only, so
 *   the dry run answers the same.
 *
 * The db mock EVALUATES the where clause the code builds (a mock that ignored it would pass the old code too).
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDrive } from './helpers/fake-drive'

const DAY = 86_400_000
let drive: FakeDrive
let rows: any[] = []

function matches(b: any, w: any): boolean {
  if (!w) return true
  if (w.status?.in && !w.status.in.includes(b.status)) return false
  if ('deletedAt' in w && w.deletedAt === null && b.deletedAt) return false
  const bc = w.bookingCode
  if (bc && 'not' in bc && bc.not === null && !b.bookingCode) return false
  if (bc?.equals != null && (bc.mode === 'insensitive' ? String(b.bookingCode).toUpperCase() !== bc.equals.toUpperCase() : b.bookingCode !== bc.equals)) return false
  for (const k of ['shootDate', 'shootEndDate']) if (w[k]?.gte && !(b[k] && b[k] >= w[k].gte)) return false
  if (w.OR && !w.OR.some((o: any) => matches(b, o))) return false
  return true
}

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findMany: async ({ where }: any) => rows.filter(b => matches(b, where)),
        findFirst: async ({ where }: any) => rows.find(b => matches(b, where)) ?? null,
      },
      systemHeartbeat: { findUnique: async () => null, upsert: async () => ({}), updateMany: async () => ({ count: 0 }) },
    },
  },
})
mock.module('../ops-alert', { namedExports: { OPS_ALERT_EVERY_MS: 6 * 3_600_000, alertOps: async () => ({ attempted: true }) } })
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
    folderLiveness: (id: string) => drive.folderLiveness(id),
    hasDriveCredentials: () => true,
    findEpisodeFolderUrls: async () => ({}),
    SOUND_STAGING_DIR: '_SOUND-STAGING',
    listSoundStagingBookingFolders: async (id: string) => (await drive.listChildFolders(id)).map(f => ({ ...f, parentId: id })),
    listFilesRecursive: async () => [],
    copyFileToFolder: async () => { throw new Error('unexpected copy') },
  },
})

process.env.DRIVE_PRODUCTION_TEAM_ROOT = 'fld_1' // the landing root is the FIRST folder each test creates
let vm: typeof import('../video-merge')
let sm: typeof import('../sound-merge')
before(async () => { vm = await import('../video-merge'); sm = await import('../sound-merge') })

let landingRoot: string, footageRoot: string
beforeEach(() => {
  drive = new FakeDrive()
  landingRoot = drive.mkFolder('Production Team', null)
  footageRoot = drive.mkFolder('VIDEO 2026', null)
  drive.mkFolder('_SOUND-STAGING', footageRoot)
  process.env.DRIVE_FOOTAGE_ROOT = footageRoot
  rows = []
})

/** a booking with one clip waiting in landing and an (empty) box */
function booking(code: string, over: any = {}) {
  const landing = drive.mkFolder(`x (${code})`, landingRoot)
  drive.mkFile(`${code}.MXF`, landing, 10)
  const box = drive.mkFolder(`box ${code}`, footageRoot)
  const row = {
    id: code, bookingCode: code, status: 'COMPLETED', deletedAt: null, driveFolders: { landing, box },
    shootDate: new Date(Date.now() - 2 * DAY), shootEndDate: null,
    projectId: null, projectName: 'x', category: null, crewRequired: ['Sound'],
    outlet: { code: 'PM' }, program: { name: 'p' }, episodes: [] as any[], ...over,
  }
  rows.push(row)
  return { landing, box, row }
}

test('a multi-day shoot whose FIRST day is past 45 days but whose last day is not is still merged (PM-PMG-260916-01)', async () => {
  const pmg = booking('PM-PMG-260916-01', { shootDate: new Date(Date.now() - 50 * DAY), shootEndDate: new Date(Date.now() - 30 * DAY) })
  booking('PM-OLD-260801-01', { shootDate: new Date(Date.now() - 60 * DAY), shootEndDate: new Date(Date.now() - 55 * DAY) })
  const r = await vm.runVideoMerge()
  assert.equal(r.bookings, 1, 'pre-fix: 0 — windowed on shootDate only')
  assert.equal(r.moved, 1)
  assert.deepEqual(drive.filesUnder(pmg.box), ['PM-PMG-260916-01.MXF'])
  assert.equal(r.results.some(x => x.bookingCode === 'PM-OLD-260801-01'), false, 'a shoot that ended past the window stays out')

  const s = await sm.runSoundMerge({ dryRun: true })
  assert.equal(s.bookings, 1, 'sound-merge uses the same window')
})

test('?code= of a booking past the window: found and merged by code — not "bookings: 0" (dry run says the same)', async () => {
  const old = booking('PM-PMG-260916-01', { shootDate: new Date(Date.now() - 68 * DAY), shootEndDate: new Date(Date.now() - 48 * DAY) })
  const dry = await vm.runVideoMerge({ dryRun: true, onlyCode: 'pm-pmg-260916-01' })
  assert.equal(dry.skipped, false)
  assert.equal(dry.bookings, 1, 'pre-fix: bookings 0, skipped false')
  assert.equal(dry.moved, 1, 'would move')
  assert.deepEqual(drive.filesUnder(old.box), [], 'a dry run moves nothing')
  const real = await vm.runVideoMerge({ onlyCode: 'PM-PMG-260916-01' })
  assert.equal(real.moved, 1)
  assert.deepEqual(drive.filesUnder(old.box), ['PM-PMG-260916-01.MXF'])
})

test('the unattended run never reaches past the window on its own (no "any landing folder" rule)', async () => {
  const old = booking('PM-PMG-260916-01', { shootDate: new Date(Date.now() - 68 * DAY), shootEndDate: new Date(Date.now() - 48 * DAY) })
  const r = await vm.runVideoMerge()
  assert.equal(r.bookings, 0)
  assert.deepEqual(drive.filesUnder(old.box), [], 'moving 43 GB of an old job waits for a person')
})

test('?code= it will not merge → skipped:true with the reason, in the dry run too — never an empty success', async () => {
  booking('NWS-CXL-261101-01', { status: 'CANCELLED' })
  booking('NWS-DEL-261101-01', { deletedAt: new Date() })
  for (const dryRun of [true, false]) {
    const missing = await vm.runVideoMerge({ dryRun, onlyCode: 'NWS-XXX-261199-01' })
    assert.equal(missing.skipped, true)
    assert.match(missing.reason ?? '', /ไม่พบรหัส NWS-XXX-261199-01/)
    assert.match((await vm.runVideoMerge({ dryRun, onlyCode: 'NWS-CXL-261101-01' })).reason ?? '', /สถานะ CANCELLED/)
    assert.match((await vm.runVideoMerge({ dryRun, onlyCode: 'NWS-DEL-261101-01' })).reason ?? '', /ถูกลบแล้ว/)
    const s = await sm.runSoundMerge({ dryRun, onlyCode: 'NWS-XXX-261199-01' })
    assert.equal(s.skipped, true)
    assert.match(s.reason ?? '', /ไม่พบรหัส/)
  }
})

test('sound-merge ?code= of a booking with no sound crew says so (it used to answer bookings: 0)', async () => {
  booking('NWS-VID-261101-01', { crewRequired: ['Videographer'] })
  const s = await sm.runSoundMerge({ onlyCode: 'NWS-VID-261101-01' })
  assert.equal(s.skipped, true)
  assert.match(s.reason ?? '', /ไม่มีทีมเสียง/)
})
