/**
 * maint 23 Nov 2026 — a dry run is a preview (bug class 5): landing/manage's default path and shoot-markers/reconcile
 * mailed their automatic report whenever a WORKER secret called them, dry run or not. landing_call.py sends
 * x-prep-folders-secret, and a dry run still counts what it WOULD create/remove — so `dryRun=1` mailed
 * "[Landing] … — สร้าง N · ลบ M" for folders nobody created. Now the automatic report is the real run's only;
 * ?report=1 still forces it, and a forced landing dry run says "(DRY RUN)" and "จะสร้าง/จะลบ".
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const mails: Array<{ subject: string; text: string }> = []
let sweep: any
let markers: any

mock.module('../session', { namedExports: { getSession: async () => null } })
mock.module('../email', { namedExports: { sendEmail: async (m: any) => { mails.push({ subject: m.subject, text: m.text }); return {} } } })
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../heartbeat', { namedExports: { recordHeartbeat: async () => {} } })
mock.module('../notify', { namedExports: { notifyChat: async () => true } })
mock.module('../ops-alert', { namedExports: { alertOps: async () => ({ attempted: true, delivered: true }) } })
mock.module('../db', { namedExports: { prisma: { booking: { findMany: async () => [] }, systemHeartbeat: { findUnique: async () => null, upsert: async () => ({}) } } } })
mock.module('../google-drive', { namedExports: {} })
mock.module('../landing-duplicates', { namedExports: { verifyLandingDuplicates: async () => ({}), verdictLine: () => '' } })
mock.module('../landing-lifecycle', {
  namedExports: {
    manageLandingFolders: async () => sweep,
    pruneLandingToToday: async () => { throw new Error('not used') },
    ensureLandingForBooking: async () => { throw new Error('not used') },
    trashCancelledBookingFolders: async () => ({ trashed: [], keptWithFiles: [], skipped: [], errors: 0, actions: [] }),
    cancelledLandingText: () => '',
  },
})
mock.module('../shoot-marker-reconcile', {
  namedExports: {
    reconcileShootMarkers: async (o: any) => ({ ...markers, dryRun: o.dryRun }),
    reconcileGenericMarkers: async () => ({}),
    mergeReconcileResults: (a: any) => a,
    totalChanges: (r: any) => r.changes,
    formatReconcileReport: (r: any) => ({ subject: r.dryRun ? '[Footage] marker reconcile (DRY-RUN) — แก้ 2' : '[Footage] marker reconcile — แก้ 2', text: 'x' }),
  },
})

let landing: (r: any) => Promise<Response>
let reconcile: (r: any) => Promise<Response>
before(async () => {
  process.env.PREP_FOLDERS_SECRET = 'landing-secret'
  process.env.SHOOT_MARKER_RECONCILE_SECRET = 'marker-secret'
  ;({ GET: landing } = await import('../../app/api/internal/landing/manage/route'))
  ;({ GET: reconcile } = await import('../../app/api/internal/shoot-markers/reconcile/route'))
})
beforeEach(() => {
  mails.length = 0
  // what a dry run reports: it COUNTS the folders it would create / remove
  sweep = { targetDay: '2026-11-24', targetDayEnd: '2026-11-24', createDays: 1, created: 3, removedPastEmpty: 2, keptRecent: 0, createErrors: 0, removeErrors: 0, keepPastDays: 2, keptNoFootage: [], cancelledWithFiles: [], actions: ['create x'] }
  markers = { changes: 2, warnings: [], errors: 0, fixed: {}, scannedBookings: 1 }
})
const call = (fn: typeof landing, path: string, header: string, secret: string) =>
  fn(new Request(`https://probook.test/api/internal/${path}`, { headers: { [header]: secret } }) as any)

test('landing/manage: worker-secret dry run (the default) mails nothing; the real run still mails', async () => {
  assert.equal((await call(landing, 'landing/manage', 'x-prep-folders-secret', 'landing-secret')).status, 200)
  assert.equal((await call(landing, 'landing/manage?dryRun=1', 'x-prep-folders-secret', 'landing-secret')).status, 200)
  assert.equal(mails.length, 0, 'pre-fix: "[Landing] 2026-11-24 — สร้าง 3 · ลบ 2" for a plan')
  await call(landing, 'landing/manage?dryRun=0', 'x-prep-folders-secret', 'landing-secret')
  assert.deepEqual(mails.map(m => m.subject), ['[Landing] 2026-11-24 — สร้าง 3 · ลบ 2'], 'the real run: unchanged')
})

test('landing/manage: ?report=1 on a dry run still mails — marked DRY RUN, "would" counts', async () => {
  await call(landing, 'landing/manage?dryRun=1&report=1', 'x-prep-folders-secret', 'landing-secret')
  assert.equal(mails.length, 1)
  assert.equal(mails[0].subject, '(DRY RUN) [Landing] 2026-11-24 — จะสร้าง 3 · จะลบ 2')
  assert.match(mails[0].text, /^\(DRY RUN — แผนเท่านั้น/)
})

test('shoot-markers/reconcile: worker-secret dry run mails nothing; real run and ?report=1 still do', async () => {
  await call(reconcile, 'shoot-markers/reconcile?dryRun=1', 'x-reconcile-secret', 'marker-secret')
  assert.equal(mails.length, 0, 'pre-fix: the digest went out for a dry run')
  await call(reconcile, 'shoot-markers/reconcile?dryRun=1&report=1', 'x-reconcile-secret', 'marker-secret')
  await call(reconcile, 'shoot-markers/reconcile?dryRun=0', 'x-reconcile-secret', 'marker-secret')
  assert.deepEqual(mails.map(m => m.subject), ['[Footage] marker reconcile (DRY-RUN) — แก้ 2', '[Footage] marker reconcile — แก้ 2'])
})
