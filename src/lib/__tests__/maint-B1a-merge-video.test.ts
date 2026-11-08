/**
 * maint 2026-11-08 (batch B1a-merge) — video-merge against the in-memory Drive:
 *
 * - stored landing/box answering 'unknown' (a 403 rateLimitExceeded, not retried) used to read as dead and send the
 *   merge down the name walk → footage MOVED into whatever the walk found + the stored id overwritten.
 * - an empty landing listing was "skipped" whether the drive was empty or unreadable; now Drive is asked which.
 * - a ?code= run used to write the WHOLE-landing chat fingerprint with its partial set; runVideoMerge itself must
 *   never write it (only the route does, after notifyChat delivered).
 * - per-booking merge locks and the routes' run guard expire, so one hung Drive call cannot stall a booking (or the
 *   whole route) for the life of the process.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDrive } from './helpers/fake-drive'

let drive: FakeDrive
let bookings: any[] = []
let rows: Record<string, { key: string; at: Date; note: string | null }> = {}
const remembered: Array<{ id: string; links: any }> = []
const walks: any[] = []
let walkResult: { bookingFolderId?: string } = {}

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: { findMany: async () => bookings },
      systemHeartbeat: {
        findUnique: async ({ where }: any) => rows[where.key] ?? null,
        upsert: async ({ where, create, update }: any) => { rows[where.key] = { ...(rows[where.key] ?? create), ...update } },
        updateMany: async ({ where, data }: any) => {
          const r = rows[where.key]
          if (!r || r.note === where.NOT?.note) return { count: 0 }
          rows[where.key] = { ...r, ...data }; return { count: 1 }
        },
      },
    },
  },
})
mock.module('../ops-alert', {
  namedExports: { OPS_ALERT_EVERY_MS: 6 * 3_600_000, alertOps: async () => ({ attempted: true, delivered: true, discord: true, lark: false, email: false }) },
})
mock.module('../drive-links', {
  namedExports: {
    getDriveLink: (df: any, k: string) => df?.[k] ?? null, // FakeDrive ids are too short for the real id check
    rememberDriveLinks: async (id: string, links: any) => { remembered.push({ id, links }) },
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
    // the REAL boolean view: only 'alive' is true (so the pre-fix code reads 'unknown' as dead, as it did on prod)
    isFolderAlive: async (id: string) => (await drive.folderLiveness(id)) === 'alive',
    folderLiveness: (id: string) => drive.folderLiveness(id),
    hasDriveCredentials: () => true,
    findEpisodeFolderUrls: async (args: any) => { walks.push(args); return walkResult },
  },
})

process.env.DRIVE_PRODUCTION_TEAM_ROOT = 'fld_1' // the landing root is the FIRST folder each test creates
let vm: typeof import('../video-merge')
let lk: typeof import('../merge-lock')
before(async () => { vm = await import('../video-merge'); lk = await import('../merge-lock') })

let landingRoot: string, footageRoot: string
beforeEach(() => {
  drive = new FakeDrive()
  landingRoot = drive.mkFolder('Production Team', null)
  assert.equal(landingRoot, 'fld_1')
  footageRoot = drive.mkFolder('VIDEO 2026', null)
  process.env.DRIVE_FOOTAGE_ROOT = footageRoot
  bookings = []; rows = {}; remembered.length = 0; walks.length = 0; walkResult = {}
})

function booking(id: string, code: string) {
  const landing = drive.mkFolder(`x (${code})`, landingRoot)
  drive.mkFile(`${code}.MXF`, landing, 10)
  const box = drive.mkFolder(`box ${code}`, footageRoot)
  const row = {
    id, bookingCode: code, driveFolders: { landing, box } as Record<string, string>,
    projectId: null, projectName: 'x', category: null, crewRequired: [] as string[],
    outlet: { code: 'NWS' }, program: { name: 'p' }, episodes: [] as any[],
  }
  return { landing, box, row }
}

// ── stored id + Drive "cannot answer" ────────────────────────────────────────

test("stored box answering 'unknown' is TRUSTED: footage lands in it, no name walk, the stored id is not overwritten", async () => {
  const a = booking('b1', 'NWS-X-261108-01')
  const twin = drive.mkFolder('box NWS-X-261108-01 (twin)', footageRoot) // what a name walk could resolve instead
  walkResult = { bookingFolderId: twin }
  drive.unknown.add(a.box)
  bookings = [a.row]

  const r = await vm.runVideoMerge()
  assert.equal(r.moved, 1)
  assert.deepEqual(walks, [], 'no name walk on an unknown stored box')
  assert.deepEqual(drive.filesUnder(a.box), ['NWS-X-261108-01.MXF'])
  assert.deepEqual(drive.filesUnder(twin), [])
  assert.equal(remembered.find(x => x.links.box)?.links.box, a.box, 'stored id kept')
})

test("the booking button: 'unknown' stored landing + box are trusted the same way", async () => {
  const a = booking('b2', 'NWS-X-261108-02')
  walkResult = { bookingFolderId: drive.mkFolder('twin', footageRoot) }
  drive.unknown.add(a.box); drive.unknown.add(a.landing)

  const r = await vm.mergeBookingVideo(a.row)
  assert.equal(r.moved, 1)
  assert.deepEqual(walks, [])
  assert.deepEqual(drive.filesUnder(a.box), ['NWS-X-261108-02.MXF'])
})

test('a stored box Drive says is GONE still falls back to the name walk (unchanged)', async () => {
  const a = booking('b3', 'NWS-X-261108-03')
  const twin = drive.mkFolder('the live box', footageRoot)
  walkResult = { bookingFolderId: twin }
  await drive.trashDriveItem(a.box)
  bookings = [a.row]

  const r = await vm.runVideoMerge()
  assert.equal(walks.length, 1)
  assert.deepEqual(drive.filesUnder(twin), ['NWS-X-261108-03.MXF'])
  assert.equal(r.moved, 1)
})

// ── empty landing: empty vs unreadable ───────────────────────────────────────

test('an empty landing listing: readable drive = a finished run (not skipped) · unreadable = skipped', async () => {
  const empty = await vm.runVideoMerge()
  assert.equal(empty.skipped, false, 'a really-empty drop drive is not a failure')
  assert.match(empty.reason ?? '', /empty/)

  drive.unknown.add(landingRoot)
  const unknown = await vm.runVideoMerge()
  assert.equal(unknown.skipped, true)
  assert.match(unknown.reason ?? '', /inaccessible.*unknown/)

  drive.unknown.clear(); await drive.trashDriveItem(landingRoot)
  const dead = await vm.runVideoMerge()
  assert.equal(dead.skipped, true)
  assert.match(dead.reason ?? '', /inaccessible.*dead/)
})

// ── card holds: runVideoMerge never writes the team-chat fingerprint ─────────

function mediapro(parent: string, clip: string) {
  const id = drive.mkFile('MEDIAPRO.XML', parent, 100)
  drive.content.set(id, `<?xml version="1.0"?><MediaProfile xmlns="http://xmlns.sony.net/pro/metadata/mediaprofile"><Contents><Material uri="./Clip/${clip}" type="MXF" dur="1000" fps="25p"/></Contents></MediaProfile>`)
}
/** a booking whose landing CAM-A holds a DIFFERENT card than its box CAM-A → held */
function heldBooking(id: string, code: string) {
  const landing = drive.mkFolder(`x (${code})`, landingRoot)
  const box = drive.mkFolder(`box ${code}`, footageRoot)
  for (const [root, clip] of [[box, 'A001C001.MXF'], [landing, 'A008C001.MXF']] as const) {
    const xd = drive.mkFolder('XDROOT', drive.mkFolder('CAM-A', root))
    mediapro(xd, clip)
    drive.mkFile(clip, drive.mkFolder('Clip', xd), 1000)
  }
  return { id, bookingCode: code, driveFolders: { landing, box }, projectId: null, projectName: 'x', category: null, crewRequired: [], outlet: { code: 'NWS' }, program: { name: 'p' }, episodes: [] }
}

test('a ?code= run neither decides nor touches the team-chat set; the whole-landing run decides but never writes it', async () => {
  bookings = [heldBooking('h1', 'NWS-X-261108-11'), heldBooking('h2', 'NWS-X-261108-12')]
  rows['card-hold-set'] = { key: 'card-hold-set', at: new Date(0), note: 'what-the-team-has' }

  const one = await vm.runVideoMerge({ onlyCode: 'NWS-X-261108-11' })
  assert.deepEqual(one.cardHolds, ['NWS-X-261108-11: CAM-A'])
  assert.equal(one.cardHoldsChatDue, false, 'a partial set is not the chat\'s business')
  assert.equal(rows['card-hold-set'].note, 'what-the-team-has', 'pre-fix: overwritten with the one-booking subset')

  const all = await vm.runVideoMerge()
  assert.equal(all.cardHolds.length, 2)
  assert.equal(all.cardHoldsChatDue, true)
  assert.equal(rows['card-hold-set'].note, 'what-the-team-has', 'only the route writes it, after the post is delivered')
  assert.equal(Object.keys(rows).some(k => k.startsWith('card-hold-chat:')), false)
})

// ── locks that expire ────────────────────────────────────────────────────────

test('a per-booking lock left by a merge that never finished expires: the hourly pass merges that booking again (loudly)', async () => {
  const a = booking('b9', 'NWS-X-261108-09')
  bookings = [a.row]
  const errors = mock.method(console, 'error', () => {})
  try {
    const stuck = lk.tryLockMerge([lk.videoMergeKey('b9')], Date.now() - lk.MERGE_LOCK_MAX_MS - 1) // the button, hung on Drive
    assert.ok(stuck)
    const r = await vm.runVideoMerge()
    assert.equal(r.results[0].skipped, undefined, 'pre-fix: "merge already running" every hour, forever')
    assert.equal(r.moved, 1)
    assert.ok(errors.mock.calls.some(c => /video:b9.*หมดอายุ/.test(String(c.arguments[0]))), 'the takeover is logged as an error')
    lk.unlockMerge([lk.videoMergeKey('b9')], stuck) // the hung call finally returns: must not free anything now
  } finally { errors.mock.restore() }
})

test('tryLockMerge: live lock refused; expired lock taken over; the stale holder\'s unlock does not free the new holder', () => {
  const keys = [lk.soundMergeKey('z1')]
  const t0 = 1_000_000
  const errors = mock.method(console, 'error', () => {})
  try {
    const tok0 = lk.tryLockMerge(keys, t0)
    assert.ok(tok0)
    assert.equal(lk.tryLockMerge(keys, t0 + lk.MERGE_LOCK_MAX_MS - 1), 0, 'still live')
    const tok1 = lk.tryLockMerge(keys, t0 + lk.MERGE_LOCK_MAX_MS)
    assert.ok(tok1 && tok1 !== tok0)
    assert.equal(errors.mock.callCount(), 1)
    lk.unlockMerge(keys, tok0)
    assert.equal(lk.tryLockMerge(keys, t0 + lk.MERGE_LOCK_MAX_MS + 1), 0, 'the new holder keeps it')
    lk.unlockMerge(keys, tok1)
    assert.ok(lk.tryLockMerge(keys, t0 + lk.MERGE_LOCK_MAX_MS + 2))
    lk.unlockMerge(keys) // token-less unlock (callers that predate the token) still frees
    assert.ok(lk.tryLockMerge(keys, t0 + lk.MERGE_LOCK_MAX_MS + 3))
    lk.unlockMerge(keys)
  } finally { errors.mock.restore() }
})

test('runGuard: one live run at a time; a run older than maxMs no longer blocks (loudly); a stale end() frees nothing', () => {
  const g = lk.runGuard('test-route', 45 * 60_000)
  const errors = mock.method(console, 'error', () => {})
  try {
    const t0 = 5_000_000
    const a = g.start(t0)
    assert.ok(a)
    assert.equal(g.start(t0 + 44 * 60_000), 0, 'pre-fix boolean: 0 forever once a call hangs')
    const b = g.start(t0 + 45 * 60_000)
    assert.ok(b)
    assert.equal(errors.mock.callCount(), 1)
    g.end(a) // the hung run finally returns
    assert.equal(g.start(t0 + 46 * 60_000), 0, 'run b still holds the guard')
    g.end(b)
    assert.ok(g.start(t0 + 47 * 60_000))
  } finally { errors.mock.restore() }
})
