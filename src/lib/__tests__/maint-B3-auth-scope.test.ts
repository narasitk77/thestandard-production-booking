import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// maint 2026-11-08
//  (auth-mine-scope-case-and-legacy-copy) — assignedEmails keeps the case it was typed in
//    (email-list.ts, on purpose) but scope=mine matched it with Prisma's case-SENSITIVE `has`:
//    a crew member stored as 'Name.S@…' could upload to the booking (canUploadToBooking
//    lowercases) yet never saw it in My Bookings. And /api/bookings/export still carried a
//    pre-v1.196 copy of "mine" with no producer/co-producer branch.
//  (auth-nas-secret-overreach) — drive-links/backfill rewrote driveFolders (where video-merge
//    MOVES footage) with no audit, and its first-set `NAS || NEXTAUTH` chain meant
//    NEXTAUTH_SECRET silently stopped working once NAS_MANIFEST_SECRET was set.
let rawCalls: Array<{ sql: string; values: unknown[] }> = []
let rawRows: Array<{ id: string }> = []
let exportWhere: any = null
let bookingRow: any = null
let updates: any[] = []
let audits: any[] = []
let admin: any = null

mock.module('../db', {
  namedExports: {
    prisma: {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        rawCalls.push({ sql: strings.join('?'), values }); return rawRows
      },
      booking: {
        findMany: async ({ where }: any) => { exportWhere = where; return [] },
        findFirst: async () => bookingRow,
        update: async (a: any) => { updates.push(a); return {} },
      },
    },
  },
})
mock.module('../session', {
  namedExports: {
    getSession: async () => ({ email: 'name.s@thestandard.co', role: 'USER' }),
    requireAdmin: async () => admin,
  },
})
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { audits.push(a) } } })
mock.module('../google-drive', {
  namedExports: {
    findEpisodeFolderUrls: async () => ({}), listChildFolders: async () => [], findChildFolder: async () => null,
    hasDriveCredentials: () => true, SOUND_STAGING_DIR: '_SOUND-STAGING',
    listSoundStagingBookingFolders: async () => [], DRIVE_PHOTO_ROOT: '',
  },
})

let scope: typeof import('../my-bookings-scope')
let exportGET: (r: any) => Promise<Response>
let backfillPOST: (r: any) => Promise<Response>
before(async () => {
  scope = await import('../my-bookings-scope')
  ;({ GET: exportGET } = await import('../../app/api/bookings/export/route'))
  ;({ POST: backfillPOST } = await import('../../app/api/admin/drive-links/backfill/route'))
})
beforeEach(() => {
  rawCalls = []; rawRows = []; exportWhere = null; bookingRow = null; updates = []; audits = []; admin = null
  process.env.DRIVE_FOOTAGE_ROOT = 'root'
  process.env.NAS_MANIFEST_SECRET = 'nas-secret-value'
  process.env.NEXTAUTH_SECRET = 'nextauth-secret-value'
})

test('assignedBookingIdsCI: lowercase match in SQL, only rows `has` would miss', async () => {
  rawRows = [{ id: 'b-mixed-case' }]
  const ids = await scope.assignedBookingIdsCI('  Name.S@TheStandard.co ')
  assert.deepEqual(ids, ['b-mixed-case'])
  assert.match(rawCalls[0].sql, /lower\(trim\(e\)\)/)
  assert.match(rawCalls[0].sql, /NOT \(\? = ANY\("assignedEmails"\)\)/)
  assert.deepEqual(rawCalls[0].values, ['name.s@thestandard.co', 'name.s@thestandard.co'])
})

test('myBookingsWhere: mixed-case assignee ids join the OR; without ids the clause is unchanged', () => {
  const w = scope.myBookingsWhere('name.s@thestandard.co', ['b-mixed-case'])
  assert.ok(w.OR.some((c: any) => c.id?.in?.includes('b-mixed-case')))
  assert.equal(scope.myBookingsWhere('name.s@thestandard.co').OR.length, scope.MY_BOOKING_ROLE_FIELDS.length)
})

test('export (non-console, no scope) uses the one "mine" rule: producer + co-producer + CI assignee', async () => {
  rawRows = [{ id: 'b-mixed-case' }]
  await exportGET(new Request('https://probook.test/api/bookings/export') as any)
  const keys = exportWhere.OR.map((c: any) => Object.keys(c)[0])
  for (const f of ['createdByEmail', 'producerEmail', 'coProducerEmail', 'assignedEmails', 'id']) {
    assert.ok(keys.includes(f), `export ขาด ${f}`)
  }
  assert.equal(exportWhere.deletedAt, null)
})

const backfill = (secret: string, body: any) => backfillPOST(new Request('https://probook.test/api/admin/drive-links/backfill', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': secret }, body: JSON.stringify(body),
}) as any)

test('backfill: NEXTAUTH_SECRET works even while NAS_MANIFEST_SECRET is set (no first-set chain)', async () => {
  bookingRow = { id: 'bk1', driveFolders: null }
  const res = await backfill('nextauth-secret-value', { set: [{ code: 'AGN-261108-01', links: { box: 'BOX_ID_0123456789' } }] })
  assert.equal(res.status, 200)
})

test('backfill: wrong secret and no admin session = 403', async () => {
  const res = await backfill('nope', { set: [] })
  assert.equal(res.status, 403)
})

test('backfill set+apply writes an audit row with before/after (who moved the box link)', async () => {
  bookingRow = { id: 'bk1', driveFolders: { box: 'OLD_BOX_0123456789' } }
  const res = await backfill('nas-secret-value', { apply: true, set: [{ code: 'AGN-261108-01', links: { box: 'NEW_BOX_0123456789' } }] })
  assert.equal(res.status, 200)
  assert.equal(updates.length, 1)
  const a = audits.find(x => x.action === 'drive.links_backfill')
  assert.ok(a, 'apply must be audited')
  assert.equal(a.bookingCode, 'AGN-261108-01')
  assert.equal(a.actorEmail, 'internal-secret')
  assert.deepEqual(a.changes.before, { box: 'OLD_BOX_0123456789' })
  assert.equal(a.changes.after.box, 'NEW_BOX_0123456789')
})

test('backfill dry-run writes nothing and audits nothing', async () => {
  bookingRow = { id: 'bk1', driveFolders: null }
  await backfill('nas-secret-value', { set: [{ code: 'AGN-261108-01', links: { box: 'NEW_BOX_0123456789' } }] })
  assert.equal(updates.length, 0)
  assert.equal(audits.length, 0)
})
