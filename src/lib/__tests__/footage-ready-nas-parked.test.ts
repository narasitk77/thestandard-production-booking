/**
 * v1.290 — ไฟล์ค้างบน NAS ที่ขึ้น Drive ไปแล้ว ไม่ควรกันแจ้ง "footage พร้อม" ตลอดไป (ด่าน d)
 *
 * KND-TMH-261117-01 (20 พ.ย. 2569): Cloud Sync อัป 100 ไฟล์ขึ้น Drive ครบ (ชื่อ+ขนาดตรง) แต่ไม่ลบออกจาก NAS →
 * lastPending>0 ตลอด → ด่าน (d) `nas-still-sending` ถือใบนี้ไม่มีวันจบ
 * กฎใหม่: โฟลเดอร์ NAS ของรหัสนี้ไม่มีอะไรเขียนมาเท่า settle → เทียบชื่อ+ขนาดกับ Drive (verifyNasMirror ของจริง) ·
 * ครบ = ไปด่าน (e)–(g) · ไม่ครบ = ถือไว้ + เตือน ops · Drive พัง = ถือไว้ (ดัง) · ยังเขียนอยู่ = ถือไว้ ไม่เดิน Drive ·
 * dry-run ตัดสินเหมือนรอบจริง
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const CODE = 'KND-TMH-261117-01'
const NAS_NAME = `Talk Me Home (${CODE})`
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const secondsAgo = (ms: number) => Math.floor((Date.now() - ms) / 1000)
const shootDay = new Date(new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10) + 'T00:00:00Z')

let n = 0
const driveFile = (folderPath: string[], name: string, size: number) =>
  ({ id: `f${n++}`, name, size, folderPath, md5: `m-${name}-${size}`, mimeType: 'video/mp4', parents: [], webViewLink: null, createdTime: ago(5 * HOUR), modifiedTime: ago(5 * HOUR), topFolderId: null })
const NAS_FILES = [{ p: 'CAM-A/GX010001.MP4', size: 1000 }, { p: 'CAM-A/GX010002.MP4', size: 2000 }]
const ON_DRIVE = () => [driveFile(['CAM-A'], 'GX010001.MP4', 1000), driveFile(['CAM-A'], 'GX010002.MP4', 2000)]

const PAYLOAD = { found: 1, fileCount: 2, folders: [{ label: 'EP01', url: 'u', fileCount: 2, totalBytes: 3000 }], bookingFolderUrl: 'u', soundStagingUrl: null }
const mkBooking = (extra: any = {}) => ({
  id: 'b1', bookingCode: CODE, status: 'COMPLETED', driveFolders: { box: 'BOX' }, calendarEventId: null,
  projectId: null, projectName: 'Talk Me Home', category: null, crewRequired: ['Videographer'],
  producer: 'แพร', producerEmail: 'producer@thestandard.co', coProducerEmail: null, createdByEmail: 'producer@thestandard.co',
  assignedEmails: [], directorEmail: null, director2Email: null, director3Email: null, cameraCount: 1,
  callTime: '09:00', shootDate: shootDay, shootEndDate: null, estimatedWrap: null,
  readySnapshot: { fileCount: 2, totalBytes: 3000, at: ago(5 * HOUR) }, readyCheckedAt: null, // settled (4 h)
  outlet: { code: 'KND', name: 'KND' }, program: { name: 'Talk Me Home', code: 'TMH' }, episodes: [],
  ...extra,
})
const nasFolder = (name: string, extra: any = {}) => ({ name, files: NAS_FILES, lastWrite: secondsAgo(5 * HOUR), ...extra })

// review r2 — a Sony card MEDIAPRO vouches for (the fast path's fixture: see footage-ready-fast.test.ts)
let xmls: Record<string, string> = {}
const material = (clip: string) => `<Material uri="./Clip/${clip}.MXF" type="MXF" dur="1000" fps="25p" videoType="AVC" umid="u-${clip}">
  <Proxy uri="./Sub/${clip}S03.MP4" type="MP4"/><RelevantInfo uri="./Clip/${clip}M01.XML" type="XML"/><RelevantInfo uri="./Thmbnl/${clip}T01.JPG" type="JPG"/></Material>`
function sonyCard(cam: string, clips: string[], arrivedAgo = 30 * MIN) {
  const root = [cam, 'XDROOT']
  const id = `mp-${cam}`
  xmls[id] = `<?xml version="1.0"?><MediaProfile><Contents>${clips.map(material).join('')}</Contents></MediaProfile>`
  const t = { createdTime: ago(arrivedAgo), modifiedTime: ago(arrivedAgo) }
  return [
    { ...driveFile(root, 'MEDIAPRO.XML', 500), id, md5: `x-${cam}`, ...t },
    ...clips.flatMap(c => [
      { ...driveFile([...root, 'Clip'], `${c}.MXF`, 1_000_000), ...t }, { ...driveFile([...root, 'Sub'], `${c}S03.MP4`, 5000), ...t },
      { ...driveFile([...root, 'Clip'], `${c}M01.XML`, 10), ...t }, { ...driveFile([...root, 'Thmbnl'], `${c}T01.JPG`, 10), ...t },
    ]),
  ]
}
/** the same files as the NAS lists them (Cloud Sync uploaded every one and left its copy) */
const nasFilesOf = (files: any[]) => files.map(f => ({ p: [...f.folderPath, f.name].join('/'), size: f.size }))

let bookings: any[] = []
let followBooking: any = null // what the camera follow-up pass reads by id
let audits: any[] = []        // audit rows the follow-up and the fast-notice watch read (logAudit writes here too)
let manifest: any = null
let statuses: Record<string, any> = {}
let trees: Record<string, any[]> = {}   // Drive folder id → files
let landings: Array<{ id: string; name: string }> = []
let driveDown = false
let driveCalls = 0
let updates: any[] = []
let written: any[] = []
let mailed: string[] = []
let alerts: Array<{ key: string; subject: string; text: string; everyMs?: number }> = []

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findMany: async ({ where }: any) => (where?.readyNotifiedAt ? [] : bookings), // the calendar ✅ pass reads announced ones
        findFirst: async () => followBooking,
        update: async ({ data }: any) => { updates.push(data); return {} },
        updateMany: async () => ({ count: 1 }),
      },
      auditLog: {
        findMany: async ({ where }: any = {}) => audits.filter(a =>
          (typeof where.action === 'string' ? a.action === where.action : !where.action?.in || where.action.in.includes(a.action))
          && (!where.entityId?.in || where.entityId.in.includes(a.entityId))
          && (!where.bookingCode?.in || where.bookingCode.in.includes(a.bookingCode))
          && (!where.at?.gte || a.at >= where.at.gte)),
        create: async ({ data }: any) => { const row = { at: new Date(), ...data }; written.push(row); audits.push(row); return row },
      },
      upload: { groupBy: async () => [], count: async () => 0, findMany: async () => [] },
      user: { findMany: async () => [] },
      nasSyncState: { findUnique: async () => (manifest ? { key: 'latest', manifest, status: { folders: statuses } } : null) },
    },
  },
})
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { const row = { at: new Date(), ...a }; written.push(row); audits.push(row) } } })
mock.module('../email', { namedExports: { sendEmail: async (m: any) => { mailed.push([].concat(m.to)[0]); return {} }, isEmailConfigured: () => true } })
mock.module('../notify', { namedExports: { notifyChatDetailed: async () => ({ discord: true, lark: false, any: true }), notifyEmailDigest: async () => true, notifyChat: async () => true } })
mock.module('../ops-alert', { namedExports: { alertOps: async (key: string, subject: string, text: string, everyMs?: number) => { alerts.push({ key, subject, text, everyMs }); return { attempted: true, delivered: true, discord: true, lark: false, email: true } } } })
mock.module('../google-calendar', { namedExports: { markCalendarFootageReady: async () => 'marked' } })
mock.module('../footage-folders', { namedExports: { getCachedFootagePayload: async () => PAYLOAD, computeFootagePayload: async () => PAYLOAD } })
const drive = <T>(v: () => T) => { driveCalls++; if (driveDown) throw new Error('Drive 500 Backend Error'); return v() }
mock.module('../google-drive', {
  namedExports: {
    folderLiveness: async () => 'alive',
    listChildFolders: async () => drive(() => landings),
    findFoldersByCode: async (code: string) => drive(() => landings.filter(l => l.name.includes(`(${code})`)).map(l => ({ ...l, parents: ['ROOT'] }))),
    listFilesRecursive: async (id: string) => drive(() => trees[id] || []),
    downloadDriveFile: async (id: string) => { if (!(id in xmls)) throw new Error(`no MEDIAPRO here: ${id}`); return Buffer.from(xmls[id]) },
  },
})

let fr: typeof import('../footage-ready')
before(async () => {
  process.env.FOOTAGE_READY_AUDIENCE = 'producer'
  process.env.FOOTAGE_READY_SETTLE_MS = String(4 * HOUR) // what prod runs
  delete process.env.FOOTAGE_READY_MAX_PER_RUN
  fr = await import('../footage-ready')
})
function reset() {
  bookings = [mkBooking()]
  manifest = { at: ago(2 * MIN), host: 'TSDNAS01', folders: [nasFolder(NAS_NAME)] }
  statuses = { [CODE]: { lastPending: 2, maxSeen: 2 } }
  landings = [{ id: 'LANDING', name: NAS_NAME }]
  trees = { BOX: [], LANDING: ON_DRIVE() }
  driveDown = false; driveCalls = 0; updates = []; written = []; mailed = []; alerts = []
  xmls = {}; followBooking = null; audits = []
}
beforeEach(reset)

const held = (r: any) => r.skipped.find((s: any) => s.code === CODE && s.reason === 'nas-still-sending')
/** everything the sweep DECIDED (no side effects) */
const decision = (r: any) => ({ notified: r.notified, settling: r.settling, skipped: r.skipped, nasParked: r.nasParked, errors: r.errors, eligible: r.eligible, walked: r.walked })

test('ไฟล์ค้างบน NAS นิ่งเกิน settle + อยู่บน Drive ครบ (ชื่อ+ขนาด) = ผ่านด่าน (d) ไปถึงด่าน (e)–(g) และแจ้ง — เคส KND-TMH-261117-01', async () => {
  const r = await fr.runFootageReadyScan()
  assert.equal(held(r), undefined, 'ไม่ถูกถือเป็น nas-still-sending')
  assert.deepEqual(r.nasParked, [{ code: CODE, ok: true, detail: 'ไฟล์ค้างบน NAS 2 ไฟล์ อยู่บน Drive ครบแล้ว (ชื่อ+ขนาด)' }])
  assert.equal(r.eligible, 1)
  assert.equal(r.walked, 1, 'ไปถึงด่าน (e) — เดิน Drive หา footage')
  assert.deepEqual(r.notified, [CODE], 'ด่าน (f) นิ่ง + (g) MEDIAPRO ผ่าน → แจ้ง')
  assert.deepEqual(mailed, ['producer@thestandard.co'])
  assert.deepEqual(alerts, [])
})

test('บางไฟล์ไม่มีบน Drive = ถือไว้ (nas-still-sending) + เตือน ops พร้อมชื่อไฟล์ที่ขาด ครั้งเดียวต่อใบ', async () => {
  trees.LANDING = [driveFile(['CAM-A'], 'GX010001.MP4', 1000)]
  const r = await fr.runFootageReadyScan()
  assert.match(held(r)?.detail || '', /1\/2 ไฟล์ไม่มีบน Drive.*CAM-A\/GX010002\.MP4/)
  assert.deepEqual(r.nasParked.map(p => [p.code, p.ok]), [[CODE, false]])
  assert.equal(r.eligible, 0)
  assert.equal(r.walked, 0)
  assert.deepEqual(r.notified, [])
  assert.deepEqual(mailed, [])
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].key, `nas-parked-missing:${CODE}`)
  assert.match(alerts[0].text, /CAM-A\/GX010002\.MP4/)
  assert.ok((alerts[0].everyMs || 0) >= 7 * DAY, 'ครั้งเดียวต่อใบ (throttle ยาว)')
  // review r2 — no promise of a release forever: re-checked only inside the window (shoot day + lookback 3), then ?codes=
  const until = new Date(shootDay.getTime() + 3 * DAY + 7 * HOUR).toISOString().slice(0, 16).replace('T', ' ')
  assert.ok(alerts[0].text.includes(`ถึง ${until} น. เท่านั้น`), alerts[0].text)
  assert.ok(alerts[0].text.includes(`footage-ready/run?codes=${CODE}`), alerts[0].text)
  assert.doesNotMatch(alerts[0].text, /ขึ้นครบเมื่อไรปล่อยเอง/)
})

test('ชื่อตรงแต่ขนาดไม่ตรง (อัปยังไม่จบ/ไฟล์คนละตัว) = ยังไม่อยู่บน Drive → ถือไว้', async () => {
  trees.LANDING = [driveFile(['CAM-A'], 'GX010001.MP4', 1000), driveFile(['CAM-A'], 'GX010002.MP4', 1999)]
  const r = await fr.runFootageReadyScan()
  assert.match(held(r)?.detail || '', /1\/2 ไฟล์ไม่มีบน Drive/)
  assert.deepEqual(r.notified, [])
})

test('เดิน Drive ไม่ได้ = ถือไว้ (fail closed) และดัง (errors) — ไม่ถือว่า "ครบ"', async () => {
  driveDown = true
  const r = await fr.runFootageReadyScan()
  assert.match(held(r)?.detail || '', /เทียบไฟล์ค้างบน NAS กับ Drive ไม่ได้.*Drive 500/)
  assert.deepEqual(r.nasParked.map(p => [p.code, p.ok]), [[CODE, false]])
  assert.ok(r.errors.some(e => e.code === CODE && /nas-parked/.test(e.error)), 'ต้องดัง ไม่ใช่เงียบ')
  assert.equal(r.eligible, 0)
  assert.deepEqual(r.notified, [])
  assert.deepEqual(alerts, [], 'ตรวจไม่ได้ ≠ ไฟล์หาย — ไม่เตือนว่าขาด')
})

test('NAS ยังเขียนไฟล์อยู่ (lastWrite สด) = ถือไว้โดยไม่เดิน Drive เลย', async () => {
  manifest.folders = [nasFolder(NAS_NAME, { lastWrite: secondsAgo(10 * MIN) })]
  const r = await fr.runFootageReadyScan()
  // quiet is NAS clock: scan (2 min ago) − last write (10 min ago)
  assert.match(held(r)?.detail || '', /NAS ค้าง 2 ไฟล์ · NAS เขียนไฟล์ล่าสุด 8 นาทีก่อนสแกนรอบล่าสุด/)
  assert.deepEqual(r.nasParked, [])
  assert.equal(driveCalls, 0, 'ไม่เดิน Drive')
  assert.equal(r.walked, 0)
})

test('dry-run ตัดสินเหมือนรอบจริงทุกกรณี — แต่ไม่เขียน ไม่ส่ง ไม่เตือน', async () => {
  const cases: Array<[string, () => void]> = [
    ['ครบ', () => {}],
    ['ขาด', () => { trees.LANDING = [driveFile(['CAM-A'], 'GX010001.MP4', 1000)] }],
    ['Drive พัง', () => { driveDown = true }],
    ['ยังเขียน', () => { manifest.folders = [nasFolder(NAS_NAME, { lastWrite: secondsAgo(10 * MIN) })] }],
  ]
  for (const [name, setup] of cases) {
    reset(); setup()
    const dry = await fr.runFootageReadyScan({ dryRun: true })
    assert.deepEqual(updates, [], `${name}: dry-run เขียน DB`)
    assert.deepEqual(mailed, [], `${name}: dry-run ส่งเมล`)
    assert.deepEqual(alerts, [], `${name}: dry-run เตือน ops`)
    reset(); setup()
    const real = await fr.runFootageReadyScan()
    assert.deepEqual(decision(dry), decision(real), `${name}: preview ≠ รอบจริง`)
  }
})

test('จำกัดรอบละ NAS_PARKED_MAX_PER_RUN ใบ · ใบที่เกินบอกว่า "รอบหน้า" (ไม่เงียบ) และได้ตรวจก่อนในรอบถัดไป', async () => {
  const codes = [1, 2, 3, 4].map(i => `KND-TMH-26111${i}-01`)
  bookings = codes.map((c, i) => mkBooking({ id: `cap${i}`, bookingCode: c, readySnapshot: null }))
  manifest.folders = codes.map(c => nasFolder(`Talk (${c})`))
  statuses = Object.fromEntries(codes.map(c => [c, { lastPending: 2 }]))
  landings = codes.map(c => ({ id: `L-${c}`, name: `Talk (${c})` }))
  trees = Object.fromEntries(codes.map(c => [`L-${c}`, ON_DRIVE()]))
  const first = await fr.runFootageReadyScan()
  assert.equal(fr.NAS_PARKED_MAX_PER_RUN, 3)
  assert.deepEqual(first.nasParked.map(p => p.code), codes.slice(0, 3))
  assert.ok(first.nasParked.every(p => p.ok))
  assert.deepEqual(first.settling.sort(), codes.slice(0, 3).sort(), 'ผ่านด่าน (d) แล้วไปรอ settle ตามปกติ')
  const later = first.skipped.find(s => s.code === codes[3])
  assert.equal(later?.reason, 'nas-still-sending')
  assert.match(later?.detail || '', /เทียบกับ Drive รอบหน้า/)
  const second = await fr.runFootageReadyScan()
  assert.equal(second.nasParked[0].code, codes[3], 'ใบที่รอไว้ได้ตรวจก่อน')
})

test('nasParkedBlocker — อะไรที่ manifest รับรองไม่ได้ = ถือไว้ (ไม่เดิน Drive)', () => {
  const SETTLE = 4 * HOUR
  const m = (folders: any[], extra: any = {}) => ({ at: ago(MIN), folders, ...extra })
  assert.equal(fr.nasParkedBlocker(m([nasFolder(NAS_NAME)]), CODE, SETTLE), '', 'นิ่ง 5 ชม. = ไปเทียบ Drive')
  assert.match(fr.nasParkedBlocker(null, CODE, SETTLE), /ไม่มี manifest/)
  assert.match(fr.nasParkedBlocker(m([nasFolder(NAS_NAME)], { skipped: [`Other (${CODE})`] }), CODE, SETTLE), /อ่านโฟลเดอร์ NAS ของใบนี้ไม่ได้/)
  assert.match(fr.nasParkedBlocker(m([nasFolder('Other (NWS-GLF-261117-01)')]), CODE, SETTLE), /ไม่เห็นโฟลเดอร์/, 'หายจาก NAS = งานของ nas-sync')
  assert.match(fr.nasParkedBlocker(m([nasFolder(NAS_NAME, { truncated: true })]), CODE, SETTLE), /ถูกตัด/)
  assert.match(fr.nasParkedBlocker(m([{ name: NAS_NAME, files: NAS_FILES }]), CODE, SETTLE), /ไม่ได้บอกเวลาเขียนล่าสุด/)
  // two NAS folders with this code (a re-dump twin): the NEWEST write decides (scan 1 min ago − write 30 min ago)
  assert.match(fr.nasParkedBlocker(m([nasFolder(NAS_NAME), nasFolder(`${NAS_NAME} (1)`, { lastWrite: secondsAgo(30 * MIN) })]), CODE, SETTLE), /29 นาทีก่อนสแกน/)
  assert.match(fr.nasParkedBlocker(m([nasFolder(NAS_NAME, { lastWrite: secondsAgo(-10 * MIN) })]), CODE, SETTLE), /0 นาทีก่อนสแกน/, 'นาฬิกา NAS เดินหน้า = ยังไม่นิ่ง')
  // review r2 — quiet is the NAS's own clock (scan time − last write), not server now: written 10 h ago by server time,
  // but only 3 h before the scan the NAS stamped → not quiet
  assert.match(fr.nasParkedBlocker(m([nasFolder(NAS_NAME, { lastWrite: secondsAgo(10 * HOUR) })], { at: ago(7 * HOUR) }), CODE, SETTLE), /180 นาทีก่อนสแกน/)
  assert.match(fr.nasParkedBlocker(m([nasFolder(NAS_NAME)], { at: 'yesterday-ish' }), CODE, SETTLE), /อ่านเวลาสแกนของ NAS ไม่ได้/, 'เวลาสแกนอ่านไม่ได้ = ถือไว้')
})

// ── review r2 ────────────────────────────────────────────────────────────────

test('review r2: จำกัดรอบละ 3 ใบ ใช้กับรอบปกติเท่านั้น — สั่ง ?codes= 4 ใบที่ค้างบน NAS = เทียบครบทั้ง 4 ไม่มี "รอบหน้า"', async () => {
  const codes = [1, 2, 3, 4].map(i => `KND-TMH-26113${i}-01`)
  bookings = codes.map((c, i) => mkBooking({ id: `forced${i}`, bookingCode: c }))
  manifest.folders = codes.map(c => nasFolder(`Talk (${c})`))
  statuses = Object.fromEntries(codes.map(c => [c, { lastPending: 2 }]))
  landings = codes.map(c => ({ id: `L-${c}`, name: `Talk (${c})` }))
  trees = { BOX: [], ...Object.fromEntries(codes.map(c => [`L-${c}`, ON_DRIVE()])) }
  const r = await fr.runFootageReadyScan({ codes })
  assert.deepEqual(r.nasParked.map(p => [p.code, p.ok]), codes.map(c => [c, true]))
  assert.deepEqual(r.skipped.filter(s => /รอบหน้า/.test(s.detail || '')), [])
  assert.deepEqual(r.notified.sort(), [...codes].sort(), 'คนสั่งรอทั้ง 4 ใบ')
})

test('review r2: dry-run ไม่ประทับคิวผลัด — dry แล้วจริง = ลำดับเดียวกับรอบจริงล้วน และ dry บอกลำดับที่รอบจริงจะใช้', async () => {
  const codes = [1, 2, 3, 4].map(i => `KND-TMH-26112${i}-02`)
  const world = (prefix: string) => {
    bookings = codes.map((c, i) => mkBooking({ id: `${prefix}${i}`, bookingCode: c, readySnapshot: null }))
    manifest.folders = codes.map(c => nasFolder(`Talk (${c})`))
    statuses = Object.fromEntries(codes.map(c => [c, { lastPending: 2 }]))
    landings = codes.map(c => ({ id: `L-${c}`, name: `Talk (${c})` }))
    trees = { BOX: [], ...Object.fromEntries(codes.map(c => [`L-${c}`, ON_DRIVE()])) }
  }
  const order = (r: any) => r.nasParked.map((p: any) => p.code)
  world('rotA')
  await fr.runFootageReadyScan()
  const realOnly = order(await fr.runFootageReadyScan())
  world('rotB')
  await fr.runFootageReadyScan()
  const preview = order(await fr.runFootageReadyScan({ dryRun: true }))
  const after = order(await fr.runFootageReadyScan())
  assert.equal(realOnly[0], codes[3], 'รอบที่สองตรวจใบที่รอไว้ก่อน')
  assert.deepEqual(after, realOnly, 'dry-run เลื่อนคิวผลัดของรอบจริง')
  assert.deepEqual(preview, realOnly, 'preview ≠ รอบจริงที่ตามมา')
})

test('review r2: ปล่อยด้วยกฎค้างบน NAS = ไม่ใช้ทางลัด MEDIAPRO (รอ settle เต็ม) แม้ MEDIAPRO รับรองครบ · คุมด้วยใบเดียวกันที่ NAS ว่าง = ทางลัดผ่าน', async () => {
  const mkCard = () => sonyCard('CAM-A', ['A001C001_261117XF', 'A001C002_261117XF'])
  const card = mkCard()
  trees.LANDING = card
  manifest.folders = [nasFolder(NAS_NAME, { files: nasFilesOf(card) })]
  const fastEligible = () => [mkBooking({ readySnapshot: { fileCount: 2, totalBytes: 3000, at: ago(30 * MIN) } })] // seen 30 min ago, NAS scanned since
  bookings = fastEligible()
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.nasParked.map(p => [p.code, p.ok]), [[CODE, true]])
  assert.deepEqual(r.fast, [], 'ไม่ลองทางลัดเลย')
  assert.deepEqual(r.settling, [CODE], 'รอ settle เต็ม')
  assert.deepEqual(r.notified, [])
  assert.deepEqual(mailed, [])
  // control: the same box with the NAS queue empty IS fast-eligible — the hold above is the parked rule, not the fixture
  reset(); trees.LANDING = mkCard(); statuses = {}; bookings = fastEligible()
  const ctl = await fr.runFootageReadyScan()
  assert.deepEqual(ctl.fast.map(f => [f.code, f.ok]), [[CODE, true]])
  assert.deepEqual(ctl.notified, [CODE])
  assert.equal(audits.find(a => a.action === 'booking.auto_notified_ready')?.changes.readyPath, 'mediapro')
})

test('review r2: ค้างบน NAS → แจ้ง (settle, audit มี nasParked) → รอบถัดไป watch ไม่เตือน "ไฟล์มาเพิ่ม"', async () => {
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.notified, [CODE])
  const row = audits.find(a => a.action === 'booking.auto_notified_ready')
  assert.equal(row?.changes.readyPath, 'settle')
  assert.equal(row?.changes.nasParked, 'ไฟล์ค้างบน NAS 2 ไฟล์ อยู่บน Drive ครบแล้ว (ชื่อ+ขนาด)', 'ร่องรอยถาวร: แจ้งไปทั้งที่ NAS ยังรายงานไฟล์ค้าง')
  bookings = [] // stamped readyNotifiedAt → out of the sweep; the NAS still lists the same 2 files
  const next = await fr.runFootageReadyScan()
  assert.deepEqual(next.fastMore, [])
  assert.deepEqual(alerts, [])
})

test('review r2: watch — ไฟล์ชุดเดิมค้างบน NAS ตั้งแต่ก่อนแจ้งทางลัด ≠ ไฟล์มาเพิ่ม · เขียนหลังแจ้ง / ยังไม่นิ่ง / บอกไม่ได้ = ยังเตือน', async () => {
  bookings = []
  const C = (i: number) => `KND-TMH-26114${i}-01`
  const cases: Array<[number, any]> = [
    [1, { lastWrite: secondsAgo(5 * HOUR) }],              // parked since long before the notice (1 h ago) → not more footage
    [2, { lastWrite: secondsAgo(30 * MIN) }],              // written after the notice → more footage
    [3, { lastWrite: secondsAgo(70 * MIN) }],              // before the notice but not quiet a settle: a card the scan had not seen yet
    [4, { lastWrite: undefined }],                         // agent without lastWrite → cannot tell
    [5, { truncated: true }],                              // cut-off walk → its lastWrite is cut too
  ]
  manifest.folders = cases.map(([i, extra]) => nasFolder(`Talk (${C(i)})`, extra))
  statuses = Object.fromEntries([1, 2, 3, 4, 5, 6].map(i => [C(i), { lastPending: 2 }])) // 6: no NAS folder in the scan
  audits = [1, 2, 3, 4, 5, 6].map(i => ({ action: 'booking.auto_notified_ready', entityId: `w${i}`, bookingCode: C(i), at: new Date(Date.now() - HOUR), changes: { readyPath: 'mediapro' } }))
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.fastMore.map(m => m.code).sort(), [2, 3, 4, 5, 6].map(C))
  assert.ok(r.fastMore.every(m => /NAS กำลังส่งของ .* อีก 2 ไฟล์/.test(m.detail)))
  assert.deepEqual(alerts.map(a => a.key).sort(), [2, 3, 4, 5, 6].map(i => `ready-fast-more:${C(i)}`))
})

test('review r2: ฉบับตามกล้อง — NAS ค้างแต่ไฟล์อยู่บน Drive ครบ = ไม่ถูกถือตลอดไป · ทาง settle เท่านั้น (ไม่ใช้ทางลัด) + audit มี nasParked', async () => {
  bookings = []
  followBooking = mkBooking({ id: 'fu1', cameraCount: 2 })
  audits = [{ action: 'booking.auto_notified_ready', entityId: 'fu1', bookingCode: CODE, at: new Date(Date.now() - DAY),
    changes: { readyPath: 'settle', cameraGap: 'มีไฟล์ภาพ 1/2 กล้อง (CAM-A)', cameraCams: ['CAM-A'] } }]
  const cards = (ago_: number) => [...sonyCard('CAM-A', ['A001C001_261117XF'], ago_), ...sonyCard('CAM-B', ['B001C001_261117XF'], ago_)]
  // CAM-B reached Drive 30 min ago, MEDIAPRO vouches for both cards: without the NAS queue this is the short wait
  trees.LANDING = cards(30 * MIN)
  manifest.folders = [nasFolder(NAS_NAME, { files: nasFilesOf(trees.LANDING) })]
  const young = await fr.runFootageReadyScan()
  assert.deepEqual(young.followedUp, [])
  assert.deepEqual(young.followUpWaiting, [{ code: CODE, detail: 'ไฟล์ยังทยอยเข้า — รอให้นิ่ง' }], 'ค้างบน NAS = รอ settle เต็ม ไม่ใช่ 20 นาที')
  // a whole settle later: sent — before r2 it waited "NAS ยังส่งไม่หมด" for as long as Cloud Sync's copy stayed
  trees.LANDING = cards(5 * HOUR)
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.followedUp, [CODE])
  const row = audits.find(a => a.action === 'booking.ready_followup')
  assert.equal(row?.changes.readyPath, 'settle', 'watch ไม่เฝ้า')
  assert.match(row?.changes.nasParked || '', /อยู่บน Drive ครบแล้ว/)
  assert.deepEqual(alerts, [])
})

test('review r2: ฉบับตามกล้อง — NAS ยังเขียน = รอโดยไม่เทียบ Drive · นิ่งแต่ไฟล์ไม่ครบบน Drive = รอ + เตือน ops (บอกว่าดูถึงเมื่อไร) · dry-run ไม่เตือน', async () => {
  bookings = []
  const notice = (id: string, code: string) => ({ action: 'booking.auto_notified_ready', entityId: id, bookingCode: code, at: new Date(Date.now() - DAY),
    changes: { readyPath: 'settle', cameraGap: 'มีไฟล์ภาพ 1/2 กล้อง (CAM-A)', cameraCams: ['CAM-A'] } })
  followBooking = mkBooking({ id: 'fu2', cameraCount: 2 })
  audits = [notice('fu2', CODE)]
  manifest.folders = [nasFolder(NAS_NAME, { lastWrite: secondsAgo(10 * MIN) })]
  const writing = await fr.runFootageReadyScan()
  assert.match(writing.followUpWaiting[0]?.detail || '', /^NAS ยังส่งไม่หมด \(ค้าง 2 ไฟล์ · NAS เขียนไฟล์ล่าสุด 8 นาทีก่อนสแกนรอบล่าสุด\)$/)
  assert.equal(driveCalls, 0, 'ไม่เดิน Drive')

  followBooking = mkBooking({ id: 'fu3', cameraCount: 2 })
  audits = [notice('fu3', CODE)]
  manifest.folders = [nasFolder(NAS_NAME)]
  trees.LANDING = [driveFile(['CAM-A'], 'GX010001.MP4', 1000)] // GX010002 never reached Drive
  const dry = await fr.runFootageReadyScan({ dryRun: true })
  assert.match(dry.followUpWaiting[0]?.detail || '', /นิ่งแล้ว · ไฟล์ค้างบน NAS 1\/2 ไฟล์ไม่มีบน Drive/)
  assert.equal(alerts.length, 0, 'dry-run ไม่เตือน')
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.followedUp, [])
  assert.match(r.followUpWaiting[0]?.detail || '', /นิ่งแล้ว · ไฟล์ค้างบน NAS 1\/2 ไฟล์ไม่มีบน Drive/)
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].key, `nas-parked-missing-followup:${CODE}`)
  assert.match(alerts[0].text, /CAM-A\/GX010002\.MP4/)
  assert.match(alerts[0].text, /ฉบับ "Footage ครบแล้ว"/)
  assert.match(alerts[0].text, /เท่านั้น/)

  driveDown = true // cannot compare = held AND loud
  const down = await fr.runFootageReadyScan()
  assert.match(down.followUpWaiting[0]?.detail || '', /เทียบไฟล์ค้างบน NAS กับ Drive ไม่ได้/)
  assert.ok(down.errors.some(e => e.code === CODE && /nas-parked/.test(e.error)))
})
