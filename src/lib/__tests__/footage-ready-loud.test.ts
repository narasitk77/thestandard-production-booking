/**
 * maint 23 Nov 2026 — footage-ready paths that went quiet (or too loud) while reporting nothing wrong:
 *
 * 1. SMTP down for the whole booking (15–19 Oct: 535 for four days): no stamp, retried every sweep — right — but the
 *    team chat got "→ 0/N อีเมล" every 30 min and ops never heard. Now: ops alert, chat only on that alert's 6 h beat.
 * 2. Two field cards of one booking go silent in one sweep: the alert key was the booking, so card 2 hit the throttle
 *    and — already flipped to ORPHANED — was never alerted at all. Now one alert naming every card.
 * 3. The 📣 preview showed no "MEDIAPRO incomplete" while the sweep knew: the fast path's verdict sat only in
 *    readySnapshot.fast, and any count change wiped readySnapshot.held.
 * 4. ?codes= silently dropped codes it would not process (already notified, cancelled, mistyped …).
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const CODE = 'TSS-TSS-261120-01'
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const shootDay = new Date(new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10) + 'T00:00:00Z')

let n = 0
const file = (folderPath: string[], name: string, size = 1000, extra: any = {}) =>
  ({ id: `f${n++}`, name, size, folderPath, md5: `m-${folderPath.join('/')}/${name}`, mimeType: 'x', parents: [], webViewLink: null, createdTime: ago(HOUR), modifiedTime: ago(HOUR), topFolderId: null, ...extra })
const material = (clip: string) => `<Material uri="./Clip/${clip}.MXF" type="MXF" dur="1000" fps="25p" videoType="AVC" umid="u-${clip}">
  <Proxy uri="./Sub/${clip}S03.MP4" type="MP4"/><RelevantInfo uri="./Clip/${clip}M01.XML" type="XML"/><RelevantInfo uri="./Thmbnl/${clip}T01.JPG" type="JPG"/></Material>`
let xmls: Record<string, string> = {}
/** a Sony card whose MEDIAPRO lists two clips; `skip` = file name endings left off Drive */
function sonyCard(skip: string[] = []) {
  const root = ['EP01', 'CAM-A', 'XDROOT']
  xmls['mp'] = `<?xml version="1.0"?><MediaProfile><Contents>${['A001C001_261120XF', 'A001C002_261120XF'].map(material).join('')}</Contents></MediaProfile>`
  return [
    file(root, 'MEDIAPRO.XML', 500, { id: 'mp', md5: 'x-mp' }),
    ...['A001C001_261120XF', 'A001C002_261120XF'].flatMap(c => [
      file([...root, 'Clip'], `${c}.MXF`, 1_000_000), file([...root, 'Sub'], `${c}S03.MP4`, 5000),
      file([...root, 'Clip'], `${c}M01.XML`, 10), file([...root, 'Thmbnl'], `${c}T01.JPG`, 10),
    ]),
  ].filter(f => !skip.some(s => f.name.endsWith(s)))
}
/** non-Sony footage: nothing for MEDIAPRO to compare → the 4 h settle path */
const GOPRO = () => [file(['EP01', 'CAM-A'], 'GX010001.MP4', 1_000_000)]

let payloadCount = 1
const payload = () => ({ found: 1, fileCount: payloadCount, folders: [{ label: 'EP01', url: 'u', fileCount: payloadCount, totalBytes: payloadCount * 1000 }], bookingFolderUrl: 'u', soundStagingUrl: null })
const mkBooking = (extra: any = {}) => ({
  id: 'b1', bookingCode: CODE, status: 'COMPLETED', deletedAt: null, cancelRequestedAt: null, readyNotifiedAt: null, deliveredAt: null,
  driveFolders: { box: 'BOX' }, calendarEventId: null, projectId: null, projectName: 'x', category: null, crewRequired: ['Videographer'],
  producer: 'P', producerEmail: 'pro@thestandard.co', coProducerEmail: null, createdByEmail: 'pro@thestandard.co',
  assignedEmails: ['video@thestandard.co'], directorEmail: null, director2Email: null, director3Email: null, cameraCount: 1,
  callTime: '09:00', shootDate: shootDay, shootEndDate: null, estimatedWrap: null,
  readySnapshot: { fileCount: 1, totalBytes: 1000, at: ago(5 * HOUR) }, readyCheckedAt: null, // settled (4 h)
  outlet: { code: 'TSS', name: 'TSS' }, program: { name: 'TSS', code: 'TSS' }, episodes: [],
  ...extra,
})

let bookings: any[] = []   // the sweep's candidates (eligible)
let followBooking: any = null
let audits: any[] = []     // notices the camera follow-up reads
let others: any[] = []     // rows only the ?codes= reason lookup can see (not eligible)
let files: any[] = []
let cardRows: any[] = []
let updates: any[] = []
let stamps = 0
let written: any[] = []
let mailed: string[] = []
let smtpDown = false
let chats: string[] = []
let alerts: Array<{ key: string; subject: string; text: string }> = []
const throttle = new Map<string, number>() // alertOps' own per-key throttle, simulated

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findMany: async ({ where }: any) => {
          if (where?.readyNotifiedAt?.gte) return [] // the calendar ✅ pass
          const pool = where?.status ? bookings : [...bookings, ...others] // the sweep's query vs the ?codes= reason lookup
          return where?.bookingCode?.in ? pool.filter(b => where.bookingCode.in.includes(b.bookingCode)) : pool
        },
        findFirst: async () => followBooking, // the camera follow-up reads its booking by id
        update: async ({ data }: any) => { updates.push(data); return {} },
        updateMany: async () => { stamps++; return { count: 1 } },
      },
      auditLog: {
        findMany: async ({ where }: any) => audits.filter(a => (typeof where.action === 'string' ? a.action === where.action : where.action.in.includes(a.action))
          && (!where.entityId?.in || where.entityId.in.includes(a.entityId))),
        create: async ({ data }: any) => { written.push(data); return data },
      },
      upload: {
        groupBy: async () => [], count: async () => 0,
        findMany: async ({ where }: any) => (where?.fileName?.startsWith ? cardRows : []),
        update: async ({ where, data }: any) => { const r = cardRows.find(c => c.id === where.id); if (r) Object.assign(r, data); return r },
      },
      user: { findMany: async () => [] },
    },
  },
})
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { written.push(a) } } })
mock.module('../email', {
  namedExports: {
    sendEmail: async (m: any) => { if (smtpDown) throw new Error('535-5.7.8 Username and Password not accepted'); mailed.push([].concat(m.to)[0]); return {} },
    isEmailConfigured: () => true,
  },
})
mock.module('../notify', {
  namedExports: { notifyChatDetailed: async (t: string) => { chats.push(t); return { discord: true, lark: false, any: true } }, notifyEmailDigest: async () => true },
})
mock.module('../ops-alert', {
  namedExports: {
    alertOps: async (key: string, subject: string, text: string, everyMs = 6 * HOUR) => {
      const last = throttle.get(key)
      if (last != null && Date.now() - last < everyMs) return { attempted: false, delivered: false, discord: false, lark: false, email: false }
      throttle.set(key, Date.now()); alerts.push({ key, subject, text })
      return { attempted: true, delivered: true, discord: true, lark: false, email: true }
    },
  },
})
mock.module('../google-calendar', { namedExports: { markCalendarFootageReady: async () => 'marked' } })
mock.module('../nas-sync', {
  namedExports: { freshNasState: async () => ({ manifest: { at: ago(MIN), folders: [] }, statuses: {} }), codeOf: () => null, verifyNasMirror: async () => ({ folders: [], allMatch: true }) },
})
mock.module('../footage-folders', { namedExports: { getCachedFootagePayload: async () => payload(), computeFootagePayload: async () => payload() } })
mock.module('../google-drive', {
  namedExports: {
    folderLiveness: async () => 'alive',
    findFoldersByCode: async () => [],
    listFilesRecursive: async () => files,
    downloadDriveFile: async (id: string) => { if (!(id in xmls)) throw new Error(`no MEDIAPRO: ${id}`); return Buffer.from(xmls[id]) },
  },
})

let fr: typeof import('../footage-ready')
let health: typeof import('../footage-ready-health')
before(async () => {
  process.env.FOOTAGE_READY_AUDIENCE = 'team'
  process.env.FOOTAGE_READY_SETTLE_MS = String(4 * HOUR)
  process.env.FOOTAGE_READY_LOOKBACK_DAYS = '4'
  delete process.env.FOOTAGE_READY_VERIFIED_SETTLE_MS
  fr = await import('../footage-ready')
  health = await import('../footage-ready-health')
})
beforeEach(() => {
  bookings = [mkBooking()]; others = []; followBooking = null; audits = []; files = GOPRO(); cardRows = []; xmls = {}; payloadCount = 1
  updates = []; stamps = 0; written = []; mailed = []; smtpDown = false; chats = []; alerts = []; throttle.clear()
})
const snaps = () => updates.filter(u => 'readySnapshot' in u).map(u => u.readySnapshot)

// ── 1. SMTP down ─────────────────────────────────────────────────────────────

test('every mail fails: not stamped, retried each sweep — ops told, the team chat posts once per 6 h, not every sweep', async () => {
  smtpDown = true
  const errs = mock.method(console, 'error', () => {})
  try {
    for (let i = 0; i < 3; i++) {
      const r = await fr.runFootageReadyScan()
      assert.deepEqual(r.notified, [])
      assert.ok(r.errors.some(e => e.code === CODE && /2\/2 ส่งไม่สำเร็จ/.test(e.error)), 'still an error every sweep')
    }
  } finally { errs.mock.restore() }
  assert.equal(stamps, 0, 'no send-once stamp — retried next sweep (unchanged)')
  assert.equal(chats.length, 1, `pre-fix: ${chats.length} — "→ 0/2 อีเมล" every sweep`)
  assert.match(chats[0], /→ 0\/2 อีเมล/)
  assert.deepEqual(alerts.map(a => a.key), [`ready-mail-failed:${CODE}`], 'ops hear it (pre-fix: nothing)')
  assert.match(alerts[0].text, /ส่งไม่ถึงทั้ง 2 คน \(2\/2 ส่งไม่สำเร็จ\)/)

  smtpDown = false // SMTP back: sent and stamped as before
  const ok = await fr.runFootageReadyScan()
  assert.deepEqual(ok.notified, [CODE])
  assert.equal(stamps, 1)
  assert.equal(chats.length, 2)
})

test('the camera follow-up shares the rule: every mail fails = ops alert, its chat line once per 6 h, not every sweep', async () => {
  bookings = []
  followBooking = mkBooking({ id: 'fu1', cameraCount: 2 })
  audits = [{ action: 'booking.auto_notified_ready', entityId: 'fu1', bookingCode: CODE, at: new Date(Date.now() - DAY),
    changes: { readyPath: 'settle', cameraGap: 'มีไฟล์ภาพ 1/2 กล้อง (CAM-A)', cameraCams: ['CAM-A'] } }]
  const old = { createdTime: ago(5 * HOUR), modifiedTime: ago(5 * HOUR) }
  files = [file(['EP01', 'CAM-A'], 'GX010001.MP4', 1_000_000, old), file(['EP01', 'CAM-B'], 'GX020001.MP4', 1_000_000, old)]
  smtpDown = true
  const errs = mock.method(console, 'error', () => {})
  try {
    for (let i = 0; i < 3; i++) {
      const r = await fr.runFootageReadyScan()
      assert.deepEqual(r.followedUp, [])
      assert.ok(r.errors.some(e => e.code === CODE && /follow-up/.test(e.error)))
    }
  } finally { errs.mock.restore() }
  assert.equal(chats.filter(c => /กล้องตามมาครบ/.test(c)).length, 1, 'pre-fix: one per sweep')
  assert.deepEqual(alerts.map(a => a.key), [`ready-mail-failed:${CODE}`])
  assert.match(alerts[0].text, /Footage ครบแล้ว/)
})

// ── 2. silent field cards ────────────────────────────────────────────────────

test('two field cards of one booking go silent in one sweep: ONE alert naming both (card 2 used to be throttled away for good)', async () => {
  const card = (id: string, camera: string) => ({ id, bookingId: 'b1', fileName: `CARD_${camera}_261120_${id}`, status: 'UPLOADING', updatedAt: new Date(Date.now() - 45 * MIN), notes: null, uploadedBy: 'cam@x.co', camera, booking: { bookingCode: CODE } })
  cardRows = [card('c1', 'CAM-A'), card('c2', 'CAM-B')]
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(cardRows.map(c => c.status), ['ORPHANED', 'ORPHANED'])
  const stale = alerts.filter(a => a.key.startsWith(`ingest-stale:${CODE}`))
  assert.equal(stale.length, 1)
  assert.match(stale[0].text, /CARD_CAM-A_261120_c1/)
  assert.match(stale[0].text, /CARD_CAM-B_261120_c2/, 'pre-fix: card 2 hit the per-booking throttle → never alerted')
  assert.ok(r.skipped.some(s => s.code === CODE && s.reason === 'ingest-pending'))
  // a third card of the same booking going silent later (inside 6 h) is news too
  cardRows.push(card('c3', 'CAM-C'))
  await fr.runFootageReadyScan()
  assert.equal(alerts.filter(a => a.key.startsWith(`ingest-stale:${CODE}`)).length, 2)
  assert.match(alerts.at(-1)!.text, /CAM-C/)
})

// ── 3. the 📣 preview's MEDIAPRO warning ──────────────────────────────────────

test('held at 1 file, a 2nd file arrives: the settle rewrite keeps the hold → the 📣 preview warns (stale), not silence', async () => {
  const HELD = { detail: 'การ์ด Sony ไม่มี MEDIAPRO.XML 1 การ์ด', at: ago(HOUR), fileCount: 1, totalBytes: 1000 }
  bookings = [mkBooking({ readySnapshot: { fileCount: 1, totalBytes: 1000, at: ago(5 * HOUR), held: HELD } })]
  payloadCount = 2 // the counts change → the settle clock restarts
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.settling, [CODE])
  const snap = snaps().at(-1)
  assert.equal(snap.fileCount, 2)
  assert.deepEqual(snap.held, HELD, 'pre-fix: dropped with the rest of the snapshot')
  assert.deepEqual(health.previewHeld(snap, 2, 2000), { ...HELD, stale: true })
})

test('fast path finds MEDIAPRO files SHORT: remembered as incomplete → the 📣 preview warns before the 4 h hold exists', async () => {
  files = sonyCard(['A001C002_261120XF.MXF']) // one original missing
  payloadCount = 9
  bookings = [mkBooking({ readySnapshot: { fileCount: 9, totalBytes: 9000, at: ago(25 * MIN) } })] // past the short settle only
  const r = await fr.runFootageReadyScan()
  assert.equal(r.fast[0]?.ok, false)
  const snap = snaps().at(-1)
  assert.equal(snap.fast.incomplete, true)
  assert.equal(snap.held, undefined, 'held stays the full settle\'s (footage-ready-fast.test.ts)')
  const p = health.previewHeld(snap, 9, 9000)
  assert.match(p?.detail || '', /ขาด 1 ไฟล์ตาม MEDIAPRO/, 'pre-fix: null — no warning in the dialog')
  assert.equal(p?.stale, undefined)
  assert.equal(health.previewHeld(snap, 10, 10_000)?.stale, true, 'counts moved since = flagged stale, still shown')
})

test('a fast-path "no" that is NOT a MEDIAPRO shortfall (nothing to compare) is not a warning', async () => {
  files = GOPRO()
  bookings = [mkBooking({ readySnapshot: { fileCount: 1, totalBytes: 1000, at: ago(25 * MIN) } })]
  await fr.runFootageReadyScan()
  const snap = snaps().at(-1)
  assert.match(snap.fast.detail, /ไม่มี MEDIAPRO ให้เทียบ/)
  assert.equal(snap.fast.incomplete, undefined)
  assert.equal(health.previewHeld(snap, 1, 1000), null)
})

test('the full gate passes later: the hold AND the fast "incomplete" note are cleared', async () => {
  files = sonyCard()
  payloadCount = 9
  const HELD = { detail: 'ขาด 1 ไฟล์', at: ago(2 * HOUR), fileCount: 8, totalBytes: 8000 }
  bookings = [mkBooking({ readySnapshot: { fileCount: 9, totalBytes: 9000, at: ago(5 * HOUR), held: HELD, fast: { detail: 'ขาด 1 ไฟล์', fileCount: 9, totalBytes: 9000, at: ago(4 * HOUR), incomplete: true } } })]
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.notified, [CODE])
  const snap = snaps().at(-1)
  assert.equal(snap.held, undefined)
  assert.equal(snap.fast, undefined)
})

// ── 4. ?codes= names every code it will not process ──────────────────────────

test('?codes= with an already-notified and an unknown code: each comes back skipped with why (dry run = real run)', async () => {
  bookings = []
  others = [
    mkBooking({ id: 'n1', bookingCode: 'AGN-261119-01', readyNotifiedAt: new Date('2026-11-19T18:52:00Z') }),
    mkBooking({ id: 'c1', bookingCode: 'NWS-CXL-261101-01', status: 'CANCELLED' }),
    mkBooking({ id: 'd1', bookingCode: 'NWS-DLV-261101-01', deliveredAt: new Date() }),
  ]
  const codes = ['AGN-261119-01', 'NWS-XXX-261199-01', 'NWS-CXL-261101-01', 'NWS-DLV-261101-01']
  for (const dryRun of [true, false]) {
    const r = await fr.runFootageReadyScan({ codes, dryRun })
    assert.equal(r.scanned, 0)
    assert.deepEqual(r.skipped, [
      { code: 'AGN-261119-01', reason: 'not-eligible', detail: 'แจ้งแล้ว 2026-11-20 01:52 น.' },
      { code: 'NWS-XXX-261199-01', reason: 'not-eligible', detail: 'ไม่พบรหัสนี้' },
      { code: 'NWS-CXL-261101-01', reason: 'not-eligible', detail: 'สถานะ CANCELLED' },
      { code: 'NWS-DLV-261101-01', reason: 'not-eligible', detail: 'ส่งงานแล้ว' },
    ], `pre-fix: [] (dryRun=${dryRun})`)
  }
})

test('?codes= where some codes match: the matched one is processed, only the rest are named', async () => {
  others = [mkBooking({ id: 'n1', bookingCode: 'AGN-261119-01', readyNotifiedAt: new Date() })]
  const r = await fr.runFootageReadyScan({ codes: [CODE, 'AGN-261119-01'], dryRun: true })
  assert.deepEqual(r.notified, [CODE])
  assert.deepEqual(r.skipped.map(s => [s.code, s.reason]), [['AGN-261119-01', 'not-eligible']])
})
