import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// v1.287 — นัท 12 พ.ย. 2569: "rule 4 ชม หลังไฟล์ไม่เข้ายังช้าอยู่ อยากให้เช็คได้เลยว่าไฟล์ครบไหมจาก Mediapro แล้วถ้าครบแล้ว
// แจ้งได้เลย แต่ถ้างานไหนไม่มี ก็ใช้กฎเดิม"
// ครบตาม MEDIAPRO + MEDIAPRO ครอบคลุมทุกอย่างที่ใบจองคาดหวัง → รอแค่รอบเดียว (20 นาที) · ไม่งั้น = กฎ 4 ชม. เดิม

const MIN = 60_000
const HOUR = 60 * MIN
const CODE = 'TSS-TSS-261110-01'
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

let n = 0
// default arrival: an hour ago = after the fixture booking's wrap (10 Nov 23:00 BKK, no estimatedWrap)
const file = (folderPath: string[], name: string, size = 1000, extra: any = {}) =>
  ({ id: `f${n++}`, name, size, folderPath, md5: `m-${folderPath.join('/')}/${name}`, mimeType: 'x', parents: [], webViewLink: null, createdTime: ago(HOUR), modifiedTime: ago(HOUR), topFolderId: null, ...extra })
const material = (clip: string) => `<Material uri="./Clip/${clip}.MXF" type="MXF" dur="1000" fps="25p" videoType="AVC" umid="u-${clip}">
  <Proxy uri="./Sub/${clip}S03.MP4" type="MP4"/><RelevantInfo uri="./Clip/${clip}M01.XML" type="XML"/><RelevantInfo uri="./Thmbnl/${clip}T01.JPG" type="JPG"/></Material>`
let xmls: Record<string, string> = {}
/** one Sony FX6 card in <cam>/XDROOT with its MEDIAPRO.XML · skip = file name endings left off Drive */
function sonyCard(cam: string, clips: string[], opts: { skip?: string[]; createdTime?: string } = {}) {
  const root = ['EP01', cam, 'XDROOT']
  const id = `mp-${cam}`
  xmls[id] = `<?xml version="1.0"?><MediaProfile><Contents>${clips.map(material).join('')}</Contents></MediaProfile>`
  const t = { createdTime: opts.createdTime ?? ago(HOUR), modifiedTime: opts.createdTime ?? ago(HOUR) }
  return [
    file(root, 'MEDIAPRO.XML', 500, { id, md5: `x-${cam}`, ...t }),
    ...clips.flatMap(c => [
      file([...root, 'Clip'], `${c}.MXF`, 1_000_000, t), file([...root, 'Sub'], `${c}S03.MP4`, 5000, t),
      file([...root, 'Clip'], `${c}M01.XML`, 10, t), file([...root, 'Thmbnl'], `${c}T01.JPG`, 10, t),
    ]),
  ].filter(f => !(opts.skip || []).some(s => f.name.endsWith(s)))
}

const PAYLOAD = { found: 1, fileCount: 9, folders: [{ label: 'EP01', url: 'u', fileCount: 9, totalBytes: 2_000_000 }], bookingFolderUrl: 'u', soundStagingUrl: null }
const settledFor = (ms: number) => ({ fileCount: PAYLOAD.fileCount, totalBytes: 2_000_000, at: ago(ms) })
const mkBooking = (extra: any = {}) => ({
  id: 'b1', bookingCode: CODE, status: 'COMPLETED', driveFolders: { box: 'BOX' },
  projectId: null, projectName: 'ออมสิน', category: null, crewRequired: ['Videographer'],
  producer: 'แพร', producerEmail: 'ingtawan.s@thestandard.co', coProducerEmail: null, createdByEmail: 'ingtawan.s@thestandard.co',
  assignedEmails: ['video@thestandard.co'], directorEmail: null, director2Email: null, director3Email: null, cameraCount: 1,
  callTime: '09:00', shootDate: new Date('2026-11-10T00:00:00Z'), shootEndDate: null, estimatedWrap: null,
  readySnapshot: settledFor(25 * MIN), readyCheckedAt: null,
  outlet: { code: 'TSS', name: 'The Secret Sauce' }, program: { name: 'The Secret Sauce', code: 'TSS' }, episodes: [],
  ...extra,
})

let bookings: any[] = []        // the sweep's candidates
let followBooking: any = null    // what the follow-up pass reads by id
let files: any[] = []
let audits: any[] = []
let liveness = 'alive'
let walks = 0
let updates: any[] = []
let written: any[] = []
let mailed: string[] = []

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findMany: async () => bookings,
        findFirst: async () => followBooking,
        update: async ({ data }: any) => { updates.push(data); return {} },
        updateMany: async () => ({ count: 1 }),
      },
      auditLog: {
        findMany: async ({ where }: any) => audits.filter(a => (typeof where.action === 'string' ? a.action === where.action : where.action.in.includes(a.action))
          && (!where.entityId || where.entityId.in.includes(a.entityId))),
        create: async ({ data }: any) => { written.push(data); return data },
      },
      upload: {
        groupBy: async () => [], count: async () => 0,
        // the sweep's card query has `fileName`; the watch's has `NOT.fileName` + `createdAt` — applied, not ignored (review r2)
        findMany: async ({ where }: any) => where?.fileName ? [] : uploadsAfter.filter(u =>
          !(where?.NOT?.fileName?.startsWith && u.fileName.startsWith(where.NOT.fileName.startsWith)) && (!where?.createdAt?.gte || u.createdAt >= where.createdAt.gte)),
      },
      user: { findMany: async () => [] },
    },
  },
})
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { written.push(a) } } })
mock.module('../email', { namedExports: { sendEmail: async (m: any) => { mailed.push([].concat(m.to)[0]); return {} }, isEmailConfigured: () => true } })
mock.module('../notify', { namedExports: { notifyChatDetailed: async () => ({ discord: true, lark: false, any: true }), notifyEmailDigest: async () => true } })
let alerts: Array<{ key: string; subject: string; text: string; everyMs?: number }> = []
mock.module('../ops-alert', { namedExports: { alertOps: async (key: string, subject: string, text: string, everyMs?: number) => { alerts.push({ key, subject, text, everyMs }); return { attempted: true, delivered: true, discord: true, lark: false, email: true } } } })
let nasAt: string | null = null // the NAS scanner's last manifest
let nasStatuses: Record<string, any> = {}
let uploadsAfter: any[] = []      // upload rows the fast-notice watch reads
mock.module('../nas-sync', {
  namedExports: {
    latestNasState: async () => ({ manifest: nasAt ? { at: nasAt, folders: [] } : null, statuses: nasStatuses }),
    nasManifestAge: (at: string | null) => { const m = at ? (Date.now() - Date.parse(at)) / MIN : NaN; return { ageMinutes: m, stale: !(m <= 60) } },
  },
})
mock.module('../footage-folders', { namedExports: { getCachedFootagePayload: async () => PAYLOAD, computeFootagePayload: async () => PAYLOAD } })
mock.module('../google-drive', {
  namedExports: {
    folderLiveness: async () => liveness,
    findFoldersByCode: async () => [],
    listFilesRecursive: async () => { walks++; return files },
    downloadDriveFile: async (id: string) => { if (!(id in xmls)) throw new Error(`Drive 500 for ${id}`); return Buffer.from(xmls[id]) },
  },
})

let fr: typeof import('../footage-ready')
before(async () => {
  process.env.FOOTAGE_READY_AUDIENCE = 'team'
  process.env.FOOTAGE_READY_SETTLE_MS = String(4 * HOUR) // what prod runs
  delete process.env.FOOTAGE_READY_VERIFIED_SETTLE_MS     // code default: 20 min
  fr = await import('../footage-ready')
})
beforeEach(() => {
  xmls = {}; bookings = [mkBooking()]; followBooking = null; files = sonyCard('CAM-A', ['A001C001_261110XF', 'A001C002_261110XF'])
  audits = []; liveness = 'alive'; walks = 0; updates = []; written = []; mailed = []; nasAt = ago(5 * MIN); nasStatuses = {}; uploadsAfter = []; alerts = [] // scanner alive, scanned after the first look
  delete process.env.FOOTAGE_READY_VERIFIED_SETTLE_MS
})
const sent = () => written.find(w => w.action === 'booking.auto_notified_ready')
/** readySnapshot writes only (every live walk also stamps readyCheckedAt — v1.179) */
const snaps = () => updates.filter(u => 'readySnapshot' in u).map(u => u.readySnapshot)

test('ครบตาม MEDIAPRO + กล้องครบ + นิ่งมาหนึ่งรอบ (25 นาที) = แจ้งเลย ไม่รอ 4 ชม.', async () => {
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.notified, [CODE])
  assert.deepEqual(r.settling, [])
  assert.deepEqual(r.fast.map(f => [f.code, f.ok, f.cached]), [[CODE, true, false]])
  assert.match(r.fast[0].detail, /ครบตาม MEDIAPRO 1 การ์ด/)
  assert.equal(sent().changes.readyPath, 'mediapro')
  assert.match(sent().changes.mediapro, /ครบตาม MEDIAPRO/)
  assert.deepEqual(mailed.sort(), ['ingtawan.s@thestandard.co', 'video@thestandard.co'])
  assert.equal(walks, 1, 'ด่าน MEDIAPRO เดิน Drive ครั้งเดียว — ไม่เดินซ้ำในทางปกติ')
})

test('เพิ่งเห็นครั้งแรก / ยังไม่ครบรอบ (10 นาที) = รอ · ไม่เดิน Drive เพิ่ม', async () => {
  bookings = [mkBooking({ readySnapshot: null })]
  const first = await fr.runFootageReadyScan()
  assert.deepEqual(first.settling, [CODE])
  assert.deepEqual(first.fast, [])
  assert.equal(walks, 0)
  assert.equal(snaps().length, 1)
  assert.deepEqual(Object.keys(snaps()[0]).sort(), ['at', 'fileCount', 'totalBytes'], 'ตั้งนาฬิกาเหมือนเดิม')
  bookings = [mkBooking({ readySnapshot: settledFor(10 * MIN) })]
  const young = await fr.runFootageReadyScan()
  assert.deepEqual(young.settling, [CODE])
  assert.deepEqual(young.fast, [])
  assert.equal(walks, 0)
  assert.equal(mailed.length, 0)
})

test('MEDIAPRO ยังขาด = กฎเดิม · จำคำตอบตามจำนวนไฟล์ รอบหน้าไม่เดิน Drive ซ้ำ · ไฟล์เปลี่ยน = ลืมคำตอบ', async () => {
  files = sonyCard('CAM-A', ['A001C001_261110XF', 'A001C002_261110XF'], { skip: ['A001C002_261110XF.MXF'] })
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.notified, [])
  assert.deepEqual(r.settling, [CODE])
  assert.equal(r.fast[0].ok, false)
  assert.match(r.fast[0].detail, /ขาด 1 ไฟล์ตาม MEDIAPRO/)
  assert.equal(mailed.length, 0)
  const snap = snaps().at(-1)
  assert.equal(snap.fileCount, PAYLOAD.fileCount, 'นาฬิกา settle เดิมยังอยู่ (ไม่รีเซ็ตกฎเดิม)')
  assert.equal(snap.at, bookings[0].readySnapshot.at)
  assert.match(snap.fast.detail, /ขาด/)
  assert.equal(snap.held, undefined, 'ยังไม่นิ่ง 4 ชม. = ไม่ใช่ "ถูกถือ" (held เป็นของทางปกติ)')

  walks = 0; updates = []
  bookings = [mkBooking({ readySnapshot: snap })]
  const again = await fr.runFootageReadyScan()
  assert.deepEqual(again.fast.map(f => [f.ok, f.cached]), [[false, true]])
  assert.equal(walks, 0, 'คำตอบเดิมของไฟล์ชุดเดิม — ไม่เดิน Drive')
  assert.equal(snaps().length, 0)

  bookings = [mkBooking({ readySnapshot: { ...snap, fileCount: 8 } })] // a file arrived since
  const moved = await fr.runFootageReadyScan()
  assert.deepEqual(moved.fast, [])
  assert.equal(snaps()[0].fast, undefined, 'นับใหม่ = เขียน snapshot ใหม่ทั้งก้อน')
})

test('งานไม่มี MEDIAPRO (กล้องไม่ใช่ Sony) = กฎ 4 ชม. เดิม — และกฎเดิมยังส่งได้เมื่อครบเวลา', async () => {
  files = [file(['EP01', 'CAM-A'], 'GX010001.MP4', 1_000_000)]
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.settling, [CODE])
  assert.match(r.fast[0].detail, /ไม่มี MEDIAPRO ให้เทียบ/)
  assert.equal(mailed.length, 0)
  bookings = [mkBooking({ readySnapshot: settledFor(4 * HOUR + MIN) })]
  const later = await fr.runFootageReadyScan()
  assert.deepEqual(later.notified, [CODE])
  assert.equal(sent().changes.readyPath, 'settle')
  assert.deepEqual(later.fast, [])
})

test('MEDIAPRO ครบแต่ไม่ครอบคลุมทั้งงาน = กฎเดิม: กล้องอื่นไม่มี MEDIAPRO · กล้องยังไม่มา · ใบไม่บอกจำนวนกล้อง · ภาพนอก CAM-x', async () => {
  const reason = async (b: any, fs: any[]) => {
    bookings = [mkBooking(b)]; files = fs; mailed = []
    const r = await fr.runFootageReadyScan({ dryRun: true })
    assert.deepEqual(r.notified, [], JSON.stringify(r.fast))
    return r.fast[0].detail
  }
  const a = () => sonyCard('CAM-A', ['A001C001_261110XF'])
  assert.match(await reason({ cameraCount: 2 }, [...a(), file(['EP01', 'CAM-B'], 'MVI_0001.MOV', 900_000)]), /ไฟล์ภาพที่ไม่มี MEDIAPRO 1 ไฟล์ \(MVI_0001\.MOV\)/)
  assert.match(await reason({}, [...a(), file(['EP01', 'DRONE'], 'DJI_0001.MP4', 900_000)]), /ไม่มี MEDIAPRO/, 'โดรนก็ต้องรอกฎเดิม')
  assert.match(await reason({ cameraCount: 2 }, a()), /มีไฟล์ภาพ 1\/2 กล้อง/)
  assert.match(await reason({ cameraCount: null }, a()), /ไม่ระบุจำนวนกล้อง/)
  const flat = sonyCard('CAM-A', ['A001C001_261110XF']).map(f => ({ ...f, folderPath: f.folderPath.filter((s: string) => s !== 'CAM-A') }))
  assert.match(await reason({}, flat), /นอกโฟลเดอร์ CAM-x/)
})

test('จองทีมเสียง: ยังไม่มีไฟล์เสียง = กฎเดิม · มี WAV แล้ว = แจ้งเลย', async () => {
  bookings = [mkBooking({ crewRequired: ['Videographer', 'Sound'] })]
  const r = await fr.runFootageReadyScan({ dryRun: true })
  assert.deepEqual(r.notified, [])
  assert.match(r.fast[0].detail, /ทีมเสียง/)
  files = [...files, file(['EP01', 'AUDIO'], 'REC-001.WAV', 50_000)]
  const ok = await fr.runFootageReadyScan({ dryRun: true })
  assert.deepEqual(ok.notified, [CODE])
})

test('dry run ตัดสินเหมือนรอบจริง แต่ไม่ส่ง ไม่เขียน', async () => {
  const r = await fr.runFootageReadyScan({ dryRun: true })
  assert.deepEqual(r.notified, [CODE])
  assert.deepEqual(r.fast.map(f => f.ok), [true])
  assert.equal(mailed.length, 0)
  assert.equal(written.length, 0)
  assert.equal(updates.length, 0)
  files = sonyCard('CAM-A', ['A001C001_261110XF'], { skip: ['S03.MP4'] })
  const no = await fr.runFootageReadyScan({ dryRun: true })
  assert.equal(no.fast[0].ok, false)
  assert.equal(updates.length, 0, 'dry run ไม่จำคำตอบ')
})

test('ปิดทางลัด: FOOTAGE_READY_VERIFIED_SETTLE_MS ≥ SETTLE_MS = พฤติกรรมเดิมทุกอย่าง', async () => {
  process.env.FOOTAGE_READY_VERIFIED_SETTLE_MS = String(4 * HOUR)
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.settling, [CODE])
  assert.deepEqual(r.fast, [])
  assert.equal(walks, 0)
  assert.equal(mailed.length, 0)
})

test('ตรวจไม่ได้ (Drive ตอบไม่ชัด / อ่าน MEDIAPRO ไม่ได้) = ไม่แจ้ง · ไม่จำคำตอบ — รอบหน้าลองใหม่ (ไม่ต้องรอ 4 ชม. เพราะ Drive สะดุดครั้งเดียว)', async () => {
  liveness = 'unknown'
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.notified, [])
  assert.deepEqual(r.fast.map(f => [f.ok, f.detail]), [[false, 'ตรวจกล่องไม่ได้ (Drive)']])
  assert.equal(snaps().length, 0)
  liveness = 'alive'
  delete xmls['mp-CAM-A'] // MEDIAPRO download fails
  const broken = await fr.runFootageReadyScan()
  assert.match(broken.fast[0].detail, /ตรวจ MEDIAPRO ไม่ได้/)
  assert.equal(snaps().length, 0, 'check:null = ตรวจไม่ได้ ≠ หลักฐานว่าไม่ครบ')
  files = sonyCard('CAM-A', ['A001C001_261110XF', 'A001C002_261110XF'])
  const ok = await fr.runFootageReadyScan()
  assert.deepEqual(ok.notified, [CODE])
  assert.equal(mailed.length, 2)
})

test('ตัวสแกน NAS เงียบ หรือยังไม่ได้สแกนหลังเห็นไฟล์ชุดนี้ = กฎเดิม (ด่าน NAS ปิดอยู่) · ไม่เดิน Drive ไม่จำคำตอบ', async () => {
  nasAt = null
  const silent = await fr.runFootageReadyScan()
  assert.deepEqual(silent.notified, [])
  assert.match(silent.fast[0].detail, /ตัวสแกน NAS/)
  assert.equal(walks, 0)
  assert.equal(snaps().length, 0)
  nasAt = ago(90 * MIN) // stale (> 60 min)
  assert.match((await fr.runFootageReadyScan()).fast[0].detail, /ตัวสแกน NAS/)
  nasAt = ago(40 * MIN) // fresh, but older than the first look at these counts (25 min ago)
  assert.match((await fr.runFootageReadyScan()).fast[0].detail, /ตัวสแกน NAS/)
  assert.equal(mailed.length, 0)
  nasAt = ago(3 * MIN)
  assert.deepEqual((await fr.runFootageReadyScan()).notified, [CODE])
})

test('review: คลิป Sony ตั้งชื่อเอง (ไม่ใช่ A001C001/C0001) อยู่ในการ์ดที่มี MEDIAPRO = ยังได้ทางลัด · ไฟล์ภาพนอกการ์ด = ไม่ได้', async () => {
  const root = ['EP01', 'CAM-A', 'M4ROOT']
  xmls['mp-x'] = `<?xml version="1.0"?><MediaProfile><Contents><Material uri="./CLIP/KND_0001.MP4" type="MP4" dur="1000" fps="25p" videoType="AVC" umid="u1"><RelevantInfo uri="./CLIP/KND_0001M01.XML" type="XML"/></Material></Contents></MediaProfile>`
  files = [file(root, 'MEDIAPRO.XML', 500, { id: 'mp-x', md5: 'x' }), file([...root, 'CLIP'], 'KND_0001.MP4', 900_000), file([...root, 'CLIP'], 'KND_0001M01.XML', 10)]
  const r = await fr.runFootageReadyScan({ dryRun: true })
  assert.deepEqual(r.notified, [CODE], JSON.stringify(r.fast))
  files = [...files, file(['EP01', 'CAM-A'], 'KND_0002.MP4', 900_000)]
  const loose = await fr.runFootageReadyScan({ dryRun: true })
  assert.match(loose.fast[0].detail, /ไม่มี MEDIAPRO 1 ไฟล์ \(KND_0002\.MP4\)/)
})

test('review: การ์ดใบเดียวกันถูกลงทั้ง CAM-A และ CAM-B (จองสองกล้อง) = นับกล้องไม่ได้ → กฎเดิม · สำเนาจาก sync ("CAM-A (1)") ไม่ถูกกัน', async () => {
  bookings = [mkBooking({ cameraCount: 2 })]
  const a = sonyCard('CAM-A', ['A001C001_261110XF'])
  const copy = (cam: string) => sonyCard(cam, ['A001C001_261110XF']).map(f => ({ ...f, id: f.name === 'MEDIAPRO.XML' ? 'mp-CAM-A' : f.id }))
  files = [...a, ...copy('CAM-B')]
  const r = await fr.runFootageReadyScan({ dryRun: true })
  assert.deepEqual(r.notified, [])
  assert.match(r.fast[0].detail, /การ์ดเดียวกันอยู่ในโฟลเดอร์กล้องสองตัว/)
  bookings = [mkBooking({ cameraCount: 1, ...W })]
  files = [...a, ...copy('CAM-A (1)')]
  assert.deepEqual((await fr.runFootageReadyScan({ dryRun: true })).notified, [CODE])
})

test('ฉบับตามกล้อง (v1.268): กล้องที่ขาดมาครบตาม MEDIAPRO = ส่งหลังนิ่ง 20 นาที ไม่ใช่ 4 ชม. · ไม่มี MEDIAPRO ยังรอ 4 ชม.', async () => {
  audits = [{ action: 'booking.auto_notified_ready', entityId: 'b1', bookingCode: CODE, at: new Date(Date.now() - 20 * HOUR),
    changes: { cameraGap: 'มีไฟล์ภาพ 1/2 กล้อง (CAM-A)', cameraCams: ['CAM-A'] } }]
  bookings = []                                   // no NEW candidates this sweep
  followBooking = mkBooking({ cameraCount: 2 })
  files = [...sonyCard('CAM-A', ['A001C001_261110XF'], { createdTime: ago(20 * HOUR) }),
    ...sonyCard('CAM-B', ['B001C001_261110XF'], { createdTime: ago(30 * MIN) })]
  const r = await fr.runFootageReadyScan({ dryRun: true })
  assert.deepEqual(r.followedUp, [CODE], JSON.stringify(r.followUpWaiting))

  files = [file(['EP01', 'CAM-A'], 'GX010001.MP4', 1_000_000, { createdTime: ago(20 * HOUR) }),
    file(['EP01', 'CAM-B'], 'GX020001.MP4', 1_000_000, { createdTime: ago(30 * MIN) })]
  const waiting = await fr.runFootageReadyScan({ dryRun: true })
  assert.deepEqual(waiting.followedUp, [])
  assert.match(waiting.followUpWaiting[0].detail, /ทยอย/)

  // review: the kill switch gives back the old wait — never a LONGER one than SETTLE_MS
  process.env.FOOTAGE_READY_VERIFIED_SETTLE_MS = String(24 * HOUR)
  files = [...sonyCard('CAM-A', ['A001C001_261110XF'], { createdTime: ago(20 * HOUR) }),
    ...sonyCard('CAM-B', ['B001C001_261110XF'], { createdTime: ago(5 * HOUR) })]
  assert.deepEqual((await fr.runFootageReadyScan({ dryRun: true })).followedUp, [CODE], 'เกิน SETTLE (4 ชม.) แล้ว = ส่งตามกฎเดิม')
  // NAS last reported BEFORE the newest file (40 min ago vs a card 30 min ago) → old wait (review r2)
  delete process.env.FOOTAGE_READY_VERIFIED_SETTLE_MS
  nasAt = ago(40 * MIN)
  files = [...sonyCard('CAM-A', ['A001C001_261110XF'], { createdTime: ago(20 * HOUR) }),
    ...sonyCard('CAM-B', ['B001C001_261110XF'], { createdTime: ago(30 * MIN) })]
  assert.deepEqual((await fr.runFootageReadyScan({ dryRun: true })).followedUp, [])
  // real run on the short wait records readyPath 'mediapro' (watched afterwards)
  nasAt = ago(5 * MIN)
  const sentFu = await fr.runFootageReadyScan()
  assert.deepEqual(sentFu.followedUp, [CODE])
  assert.equal(written.find(w => w.action === 'booking.ready_followup').changes.readyPath, 'mediapro')
  // NAS scanner silent → old wait
  audits = [audits[0]]; written = []
  nasAt = null
  files = [...sonyCard('CAM-A', ['A001C001_261110XF'], { createdTime: ago(20 * HOUR) }),
    ...sonyCard('CAM-B', ['B001C001_261110XF'], { createdTime: ago(30 * MIN) })]
  assert.deepEqual((await fr.runFootageReadyScan({ dryRun: true })).followedUp, [])
})

test('review (high): ไฟล์ภาพทั้งหมดขึ้น Drive ก่อนเลิกกอง = กฎเดิม — เทการ์ดตอนพักกลางวัน / งานหลายวันมีแต่ของวันแรก', async () => {
  // single day, wrap 17:00 BKK on 10 Nov = 10:00Z · cards uploaded at lunch (05:30Z)
  bookings = [mkBooking({ estimatedWrap: '17:00' })]
  files = sonyCard('CAM-A', ['A001C001_261110XF', 'A001C002_261110XF'], { createdTime: '2026-11-10T05:30:00Z' })
  const lunch = await fr.runFootageReadyScan({ dryRun: true })
  assert.deepEqual(lunch.notified, [])
  assert.match(lunch.fast[0].detail, /ก่อนเลิกกอง \(11-10 17:00\)/)
  // one more card lands after wrap → the evening dump happened → fast path open
  files = [...files, ...sonyCard('CAM-A (2)', ['A002C001_261110XF'], { createdTime: '2026-11-10T11:00:00Z' })]
  assert.deepEqual((await fr.runFootageReadyScan({ dryRun: true })).notified, [CODE])
  // multi-day: day-1 cards only, day-2 wrap 11 Nov 17:00
  bookings = [mkBooking({ shootEndDate: new Date('2026-11-11T00:00:00Z'), estimatedWrap: '17:00' })]
  files = sonyCard('CAM-A', ['A001C001_261110XF'], { createdTime: '2026-11-10T12:00:00Z' })
  assert.match((await fr.runFootageReadyScan({ dryRun: true })).fast[0].detail, /ก่อนเลิกกอง \(11-11 17:00\)/)
})

test('shootEndsAt = จังหวะที่ isShootOver เปลี่ยนเป็นจริง (กฎเดียวกัน) · เวลาเลิกผิดรูปแบบ = สิ้นวัน (ช้ากว่า ไม่เร็วกว่า)', async () => {
  const { shootEndsAt, isShootOver } = await import('../shoot-window')
  const d = (s: string) => new Date(`${s}T00:00:00Z`)
  for (const b of [
    { shootDate: d('2026-11-10'), shootEndDate: null, estimatedWrap: '17:00', callTime: '09:00' },
    { shootDate: d('2026-11-10'), shootEndDate: d('2026-11-12'), estimatedWrap: '18:30', callTime: '08:00' },
    { shootDate: d('2026-11-10'), shootEndDate: null, estimatedWrap: null, callTime: '09:00' },
    { shootDate: d('2026-11-10'), shootEndDate: null, estimatedWrap: '02:00', callTime: '20:00' }, // overnight
  ]) {
    const at = shootEndsAt(b).getTime()
    assert.equal(isShootOver(b, new Date(at - MIN)), false, JSON.stringify(b))
    assert.equal(isShootOver(b, new Date(at)), true, JSON.stringify(b))
  }
  assert.equal(shootEndsAt({ shootDate: d('2026-11-10'), shootEndDate: null, estimatedWrap: '9:00' }).toISOString(), '2026-11-10T17:00:00.000Z')
})

test('หลังแจ้งแบบทางลัด มีไฟล์ตามมา = เตือน ops ครั้งเดียวต่อใบ: NAS ส่งอยู่ · NAS ส่งจบระหว่างสองรอบ · การ์ดหน้างานเริ่มส่ง (ตั๋วออกก่อน) · อัปโหลดใหม่ · แจ้งแบบกฎเดิมไม่เฝ้า · dry run ไม่เตือน', async () => {
  bookings = []
  const mk = (id: string, code: string, readyPath: string, action = 'booking.auto_notified_ready', h = 2) =>
    ({ action, entityId: id, bookingCode: code, at: new Date(Date.now() - h * HOUR), changes: { readyPath } })
  const C = (i: number) => `TSS-TSS-2611${10 + i}-01`
  audits = [mk('b1', C(1), 'mediapro', undefined, 5), mk('b2', C(2), 'settle'), mk('b3', C(3), 'mediapro'), mk('b4', C(4), 'mediapro'), mk('b5', C(5), 'mediapro', 'booking.ready_followup')]
  const quiet = await fr.runFootageReadyScan()
  assert.deepEqual(quiet.fastMore, [])
  assert.equal(alerts.length, 0)

  nasStatuses = { [C(1)]: { lastPending: 7 }, [C(2)]: { lastPending: 3 } }                          // b2 = old rule → not watched
  audits.push(
    { action: 'nas.folder_drained', bookingCode: C(3), at: new Date(Date.now() - HOUR) },            // queued + drained between sweeps
    { action: 'nas.folder_drained', bookingCode: C(4), at: new Date(Date.now() - 3 * HOUR) },        // before the notice = its own cards
    { action: 'ingest.start', bookingCode: C(5), at: new Date(Date.now() - HOUR) },                   // field card started after (ticket older)
  )
  uploadsAfter = [
    { bookingId: 'b4', createdAt: new Date(Date.now() - HOUR), fileName: 'B002.MP4' },               // browser upload after the notice
    { bookingId: 'b4', createdAt: new Date(Date.now() - 3 * HOUR), fileName: 'old.MP4' },
    { bookingId: 'b3', createdAt: new Date(Date.now() - HOUR), fileName: 'CARD_B002' },              // CARD_ rows go by ingest.start
  ]
  const dry = await fr.runFootageReadyScan({ dryRun: true })
  assert.equal(dry.fastMore.length, 4)
  assert.equal(alerts.length, 0)
  const r = await fr.runFootageReadyScan()
  const by = Object.fromEntries(r.fastMore.map(m => [m.code, m.detail]))
  assert.deepEqual(Object.keys(by).sort(), [C(1), C(3), C(4), C(5)])
  assert.match(by[C(1)], /NAS กำลังส่งของ .* อีก 7 ไฟล์/)
  assert.match(by[C(3)], /NAS ส่งชุดใหม่ของ .* แล้ว 1 รอบ/)
  assert.doesNotMatch(by[C(3)], /อัปโหลดใหม่/, 'CARD_ row ไม่นับซ้ำทางอัปโหลด')
  assert.match(by[C(4)], /^อัปโหลดใหม่ 1 รายการ \(B002\.MP4\)$/, 'drain ก่อนแจ้ง = การ์ดชุดเดิม ไม่นับ')
  assert.match(by[C(5)], /ส่งการ์ดจากหน้างานเพิ่ม 1 ใบ/)
  assert.equal(alerts.length, 4)
  assert.equal(alerts[0].everyMs, fr.FAST_WATCH_DAYS * 24 * HOUR, 'ครั้งเดียวตลอดช่วงเฝ้า')
  assert.match(alerts.find(a => a.key === `ready-fast-more:${C(5)}`)!.subject, /ฉบับตามกล้อง/)
})

test('review r2: การ์ดใบที่สองของกล้องเดิมถูกลงใน CAM-B = ชื่อคลิปบอกว่ากล้องเดียว → กฎเดิม · กล้องคนละตัวจริง = ผ่าน', async () => {
  bookings = [mkBooking({ cameraCount: 2 })]
  files = [...sonyCard('CAM-A', ['A001C001_261110XF']), ...sonyCard('CAM-B', ['A002C001_261110XF'])]
  const r = await fr.runFootageReadyScan({ dryRun: true })
  assert.deepEqual(r.notified, [])
  assert.match(r.fast[0].detail, /กล้อง 1 ตัว \(A\) แต่จอง 2 ตัว/)
  files = [...sonyCard('CAM-A', ['A001C001_261110XF']), ...sonyCard('CAM-B', ['B001C001_261110XF'])]
  assert.deepEqual((await fr.runFootageReadyScan({ dryRun: true })).notified, [CODE])
})

test('review r2: สำเนา "(1)" ที่อัปซ้ำหลังเลิกกองของการ์ดที่ขึ้นก่อนเลิกกอง ไม่นับเป็นไฟล์ใหม่', async () => {
  bookings = [mkBooking({ estimatedWrap: '17:00' })]
  const lunch = sonyCard('CAM-A', ['A001C001_261110XF'], { createdTime: '2026-11-10T05:30:00Z' })
  const storm = lunch.filter(f => f.name.endsWith('.MXF')).map(f => ({ ...f, id: 'dup', name: f.name.replace('.MXF', ' (1).MXF'), createdTime: '2026-11-10T12:00:00Z' }))
  files = [...lunch, ...storm]
  assert.match((await fr.runFootageReadyScan({ dryRun: true })).fast[0].detail, /ก่อนเลิกกอง/)
})

test('review r2: คลิปตั้งชื่อเองที่ MEDIAPRO ไม่ได้ระบุ (แม้อยู่ใน M4ROOT) = ไม่มี MEDIAPRO รับรอง', async () => {
  const root = ['EP01', 'CAM-A', 'M4ROOT']
  xmls['mp-y'] = `<?xml version="1.0"?><MediaProfile><Contents><Material uri="./CLIP/KND_0001.MP4" type="MP4" dur="1000" fps="25p" videoType="AVC" umid="u1"><RelevantInfo uri="./CLIP/KND_0001M01.XML" type="XML"/></Material></Contents></MediaProfile>`
  files = [file(root, 'MEDIAPRO.XML', 500, { id: 'mp-y', md5: 'y' }), file([...root, 'CLIP'], 'KND_0001.MP4', 900_000), file([...root, 'CLIP'], 'KND_0001M01.XML', 10),
    file([...root, 'CLIP'], 'KND_0002.MP4', 900_000)]
  assert.match((await fr.runFootageReadyScan({ dryRun: true })).fast[0].detail, /ไม่มี MEDIAPRO 1 ไฟล์ \(KND_0002\.MP4\)/)
})

// ── pure ──────────────────────────────────────────────────────────────────────

const W = { shootDate: new Date('2026-11-10T00:00:00Z'), shootEndDate: null, estimatedWrap: null }
test('fastPathBlocker: ไม่มีผลตรวจ / ตรวจไม่ผ่าน = บอกเหตุผล · ไฟล์ในโฟลเดอร์ _แยกไว้ ไม่นับ', () => {
  assert.match(fr.fastPathBlocker(null, { cameraCount: 1, ...W }), /ตรวจกล่องไม่ได้/)
  assert.equal(fr.fastPathBlocker({ ok: false, text: 'ขาด 2 ไฟล์ตาม MEDIAPRO', check: null }, { cameraCount: 1, ...W }), 'ขาด 2 ไฟล์ตาม MEDIAPRO')
  const check = { cards: 1, listed: 4, missing: [], stale: [], zero: [], suspect: [], unverifiable: [], unverifiablePaths: [], twinCopies: [], mixed: [] }
  const good = sonyCard('CAM-A', ['A001C001_261110XF'])
  assert.equal(fr.fastPathBlocker({ ok: true, text: 'ครบ', check, files: good as any }, { cameraCount: 1, ...W }), '')
  const quarantined = file(['_แยกไว้ · ไฟล์เสีย', 'CAM-A'], 'MVI_0001.MOV')
  assert.equal(fr.fastPathBlocker({ ok: true, text: 'ครบ', check, files: [...good, quarantined] as any }, { cameraCount: 1, ...W }), '')
  assert.match(fr.fastPathBlocker({ ok: true, text: 'ครบ', check: { ...check, cards: 0 }, files: good as any }, { cameraCount: 1, ...W }), /ไม่มี MEDIAPRO/)
})

test('readFastNo: คืนเหตุผลเฉพาะเมื่อจำนวนไฟล์+ไบต์ตรง · ข้อมูลเพี้ยน = null', () => {
  const s = { fileCount: 9, totalBytes: 2, at: 'x', fast: { detail: 'ไม่มี MEDIAPRO ให้เทียบ', fileCount: 9, totalBytes: 2, at: 'x' } }
  assert.equal(fr.readFastNo(s, { fileCount: 9, totalBytes: 2 }), 'ไม่มี MEDIAPRO ให้เทียบ')
  assert.equal(fr.readFastNo(s, { fileCount: 9, totalBytes: 3 }), null)
  assert.equal(fr.readFastNo({ fast: { detail: 1, fileCount: 9, totalBytes: 2 } }, { fileCount: 9, totalBytes: 2 }), null)
  assert.equal(fr.readFastNo(null, { fileCount: 9, totalBytes: 2 }), null)
})
