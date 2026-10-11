/**
 * v1.253 — the daily footage check, end to end with Drive and Prisma faked.
 *
 * What these pin:
 *   • paging covers EVERY booking (the old `take: 60` left 127 of 187 unchecked)
 *     and `nextOffset` counts what was actually processed
 *   • dry run walks the exact same reads/decisions as the real run and parts only
 *     at the write (a preview that differs from the run is a recurring bug here)
 *   • a person's own `_FOOTAGE-CHECK`, a shared project box, or a box that is not
 *     this booking's never gets written to
 *   • an unreadable box is "could not check", never "complete"
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

type Row = {
  id: string; bookingCode: string; projectId: string | null; projectName: string | null; shootDate: Date; shootEndDate?: Date | null; driveFolders: any
  readyNotifiedAt?: Date | null; deliveredAt?: Date | null; footageCache?: unknown; footageCacheAt?: Date | null
}
let rows: Row[] = []
let located: Record<string, string> = {}
let lastWhere: any = null
let sharing = 1
let boxNames: Record<string, string> = {}
let boxFiles: Record<string, any[] | Error> = {}
let docs: Record<string, Array<{ id: string; ours: boolean; hash: string | null; writtenAt: string | null; webViewLink: string | null }>> = {}
let writes: any[] = []
let trashed: string[] = []
let tree: 'in-tree' | 'not-in-tree' | 'unknown' = 'in-tree'
let trashFolders: Array<{ id: string; name: string; trashedTime: string | null }> = []
let trashTrees: Record<string, any[] | Error> = {}
let drp: { buf: Buffer; modifiedTime: string } | null = null

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        count: async ({ where }: any) => (where.driveFolders ? sharing : rows.length),
        findMany: async ({ where, skip, take }: any) => { lastWhere = where; return rows.slice(skip, skip + take) },
      },
    },
  },
})

mock.module('../google-drive', {
  namedExports: {
    hasDriveCredentials: () => true,
    getDriveItemState: async (id: string) => (boxNames[id] ? { id, name: boxNames[id], mimeType: 'folder', trashed: false, trashedTime: null, driveId: 'd' } : null),
    listFilesRecursive: async (id: string) => {
      const t = boxFiles[id]
      if (t instanceof Error) throw t
      return (t || []).map((x, i) => ({
        id: x.idSuffix ? `${id}-${x.idSuffix}` : `${id}-${i}`, name: x.name, mimeType: 'video/mp4', parents: [x.parent || 'p'], webViewLink: null,
        size: x.size ?? 1, createdTime: null, modifiedTime: null, md5: null, folderPath: x.folderPath, topFolderId: null,
      }))
    },
    findTrashedFoldersByCode: async () => trashFolders,
    listFolderTreeIncludingTrashed: async (id: string) => {
      const t = trashTrees[id]
      if (t instanceof Error) throw t
      return { files: t || [], truncated: false }
    },
    findFootageCheckDocs: async (id: string) => docs[id] || [],
    writeFootageCheckDoc: async (input: any) => { writes.push(input); return input.existingId || 'new-doc' },
    trashDriveItem: async (id: string) => { trashed.push(id) },
    findLatestDrp: async () => (drp ? { id: 'drp1', name: 'PP-26-034_DaVinci_2026-09-29.drp', size: drp.buf.length, modifiedTime: drp.modifiedTime, webViewLink: null } : null),
    // v1.254 — MEDIAPRO.XML files (ids ending in -MEDIAPRO) come back as a card index listing the box's clip
    downloadDriveFile: async (id: string) => (id.endsWith('MEDIAPRO') ? Buffer.from(mediaproXml) : drp!.buf),
    classifyFootageTreeFolder: async () => tree,
    locateFileByName: async (name: string) => located[name] ?? null,
  },
})

// v1.266 — the cache repair: a fresh walk (what Drive holds) and the write that stores it
let walked: string[] = []
let stored: Array<{ id: string; fileCount: number }> = []
let storeFails: Error | null = null
let walkCount = 41
mock.module('../footage-folders', {
  namedExports: {
    computeFootagePayload: async (b: any) => {
      walked.push(b.bookingCode)
      return { found: 1, fileCount: walkCount, folders: [], bookingFolderUrl: null, soundStagingUrl: null }
    },
    storeFootageCache: async (id: string, p: any) => {
      if (storeFails) throw storeFails
      stored.push({ id, fileCount: p.fileCount })
    },
  },
})

let fi: typeof import('../footage-integrity')
before(async () => { fi = await import('../footage-integrity') })

const NOW = new Date('2026-09-30T06:00:00Z') // 13:00 BKK
const clip = (name: string, kind = 'Clip') => ({ name, folderPath: ['EP.1', 'CAM-A', 'XDROOT', kind] })
let mediaproXml = ''
const MEDIAPRO = { name: 'MEDIAPRO.XML', folderPath: ['EP.1', 'CAM-A', 'XDROOT'], idSuffix: 'MEDIAPRO' }
const indexFor = (...clips: string[]) => `<MediaProfile>${clips.map(c =>
  `<Material uri="./Clip/${c}.MXF" dur="100" fps="25p" videoType="AVC"><RelevantInfo uri="./Clip/${c}M01.XML"/></Material>`).join('')}</MediaProfile>`
function booking(i: number, over: Partial<Row> = {}): Row {
  const code = `AGN-2609${String(10 + (i % 18)).padStart(2, '0')}-${String(i).padStart(2, '0')}`
  const box = `box${i}`
  boxNames[box] = `GDH (${code})`
  boxFiles[box] = [clip('A001C001_260901AA.MXF'), clip('A001C001_260901AAM01.XML'), MEDIAPRO]
  mediaproXml = indexFor('A001C001_260901AA')
  return { id: `id${String(i).padStart(3, '0')}`, bookingCode: code, projectId: null, projectName: null, shootDate: new Date('2026-09-20'), driveFolders: { box }, ...over }
}

beforeEach(() => {
  rows = []; sharing = 1; boxNames = {}; boxFiles = {}; docs = {}; writes = []; trashed = []; tree = 'in-tree'
  trashFolders = []; trashTrees = {}; drp = null
  walked = []; stored = []; storeFails = null; walkCount = 41
})

test('60 ใบ หน้าละ 25 → 25, 50, null · ครบทุกใบ', async () => {
  rows = Array.from({ length: 60 }, (_, i) => booking(i))
  const seen: string[] = []
  let offset: number | null = 0
  const nexts: Array<number | null> = []
  while (offset != null) {
    const p = await fi.scanFootagePage({ offset, limit: 25, now: NOW })
    seen.push(...p.boxes.map(b => b.bookingCode))
    nexts.push(p.nextOffset)
    offset = p.nextOffset
  }
  assert.deepEqual(nexts, [25, 50, null])
  assert.equal(new Set(seen).size, 60)
})

test('ชนเส้นตาย → nextOffset = offset + ที่ทำจริง (ไม่มีใบหล่น)', async () => {
  rows = Array.from({ length: 10 }, (_, i) => booking(i))
  const p = await fi.scanFootagePage({ offset: 0, limit: 10, deadlineMs: -1, now: NOW })
  assert.equal(p.boxes.length, 1, 'ทำอย่างน้อยหนึ่งใบเสมอ — ไม่มีวันติดอยู่ที่เดิม')
  assert.equal(p.nextOffset, 1)
})

test('dry run กับของจริงตัดสินเหมือนกัน · dry run ไม่เขียน · ของจริงเขียนครั้งเดียว แล้วรอบถัดไปไม่เปลี่ยน', async () => {
  rows = [booking(1)]
  const dry = await fi.scanFootagePage({ now: NOW })
  assert.equal(dry.boxes[0].state, 'ok')
  assert.equal(dry.boxes[0].doc.action, 'would-create')
  assert.equal(writes.length, 0)

  const real = await fi.scanFootagePage({ docs: true, now: NOW })
  assert.equal(real.boxes[0].doc.action, 'created')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].folderId, 'box1')
  assert.match(writes[0].html, /ตรวจฟุตเทจ · AGN-260911-01/)

  docs.box1 = [{ id: 'new-doc', ours: true, hash: writes[0].hash, writtenAt: NOW.toISOString(), webViewLink: 'u' }]
  const again = await fi.scanFootagePage({ docs: true, now: NOW })
  assert.equal(again.boxes[0].doc.action, 'unchanged')
  assert.equal(writes.length, 1)

  const weekLater = await fi.scanFootagePage({ docs: true, now: new Date(NOW.getTime() + 8 * 86_400_000) })
  assert.equal(weekLater.boxes[0].doc.action, 'refreshed', 'เนื้อหาเดิมแต่เก่ากว่า 7 วัน → เขียนเวลาใหม่')
})

test('เอกสารที่คนสร้างเอง / กล่องใช้ร่วม / ชื่อกล่องไม่ใช่ของคิว / นอกไดรฟ์ฟุตเทจ → ไม่เขียน', async () => {
  rows = [booking(1)]
  docs.box1 = [{ id: 'h', ours: false, hash: null, writtenAt: null, webViewLink: 'u' }]
  assert.equal((await fi.scanFootagePage({ docs: true, now: NOW })).boxes[0].doc.action, 'skipped')

  docs = {}; sharing = 2
  const shared = (await fi.scanFootagePage({ docs: true, now: NOW })).boxes[0].doc
  assert.equal(shared.action, 'skipped')
  assert.match(shared.note!, /ผูกกับ 2 ใบจอง/)

  sharing = 1; boxNames.box1 = 'GDH x 8 Minute History (PP-26-034)'
  assert.match((await fi.scanFootagePage({ docs: true, now: NOW })).boxes[0].doc.note!, /ไม่ใช่ของคิวนี้/)

  boxNames.box1 = 'GDH (AGN-260911-01)'; tree = 'unknown'
  const outside = (await fi.scanFootagePage({ docs: true, now: NOW })).boxes[0].doc
  assert.equal(outside.action, 'skipped')
  assert.match(outside.note!, /ไม่อยู่ในไดรฟ์ฟุตเทจ/)
  assert.equal(writes.length, 0)
})

test('เอกสารของเราซ้ำสองฉบับ → อัปเดตตัวใหม่สุด ทิ้งตัวเก่า', async () => {
  rows = [booking(1)]
  docs.box1 = [
    { id: 'old', ours: true, hash: 'x', writtenAt: NOW.toISOString(), webViewLink: 'u1' },
    { id: 'new', ours: true, hash: 'y', writtenAt: NOW.toISOString(), webViewLink: 'u2' },
  ]
  const d = (await fi.scanFootagePage({ docs: true, now: NOW })).boxes[0].doc
  assert.equal(d.action, 'updated')
  assert.equal(writes[0].existingId, 'new')
  assert.deepEqual(trashed, ['old'])
})

test('อ่านกล่องไม่ได้ → unreadable (ไม่ใช่ครบ) และเอกสารบอกว่าตรวจไม่ได้ · ไม่มี box = noBox', async () => {
  rows = [booking(1), booking(2, { driveFolders: {} })]
  boxFiles.box1 = new Error('Drive 500')
  const p = await fi.scanFootagePage({ docs: true, now: NOW })
  assert.equal(p.noBox, 1)
  assert.equal(p.boxes[0].state, 'unreadable')
  assert.match(p.boxes[0].errors[0], /Drive 500/)
  assert.match(writes[0].html, /ตรวจไม่ได้รอบนี้ — ห้ามถือว่าครบ/)
})

test('ถ่ายเมื่อวาน + ต้นฉบับยังไม่มา → waiting (ไม่ขึ้นแชต) · ผ่านไป 3 วัน → issues', async () => {
  rows = [booking(1, { shootDate: new Date('2026-09-29') })]
  boxFiles.box1 = [clip('B022C001_2609297HS03.MP4', 'Sub'), clip('B022C001_2609297HM01.XML')]
  assert.equal((await fi.scanFootagePage({ now: NOW })).boxes[0].state, 'waiting')
  rows = [booking(1, { shootDate: new Date('2026-09-26') })]
  boxFiles.box1 = [clip('B022C001_2609297HS03.MP4', 'Sub'), clip('B022C001_2609297HM01.XML')]
  assert.equal((await fi.scanFootagePage({ now: NOW })).boxes[0].state, 'issues')
})

test('รีวิว: งานถ่ายหลายวัน — นับผ่อนผันจากวันสุดท้าย ไม่ใช่วันแรก', async () => {
  rows = [booking(1, { shootDate: new Date('2026-09-27'), shootEndDate: new Date('2026-09-29') })]
  boxFiles.box1 = [clip('B022C001_2609297HS03.MP4', 'Sub'), clip('B022C001_2609297HM01.XML')]
  const b = (await fi.scanFootagePage({ now: NOW })).boxes[0]
  assert.equal(b.waiting, true)
  assert.equal(b.state, 'waiting')
})

test('รีวิว: เอกสารของเราซ้ำ + เนื้อหาไม่เปลี่ยน → ยังทิ้งตัวซ้ำ (ไม่รอ 7 วัน)', async () => {
  rows = [booking(1)]
  await fi.scanFootagePage({ docs: true, now: NOW })
  const hash = writes[0].hash
  writes = []
  docs.box1 = [
    { id: 'old', ours: true, hash, writtenAt: NOW.toISOString(), webViewLink: 'u1' },
    { id: 'new', ours: true, hash, writtenAt: NOW.toISOString(), webViewLink: 'u2' },
  ]
  const d = (await fi.scanFootagePage({ docs: true, now: NOW })).boxes[0].doc
  assert.equal(d.action, 'unchanged')
  assert.deepEqual(trashed, ['old'])
  assert.equal(writes.length, 0)
})

test('รีวิว: โฟลเดอร์ drop ในถังสองอัน อันหนึ่งอ่านไม่ได้ → ไฟล์ค้างจากอีกอันยังถูกรายงาน', async () => {
  rows = [booking(1)]
  trashFolders = [{ id: 't1', name: 'x (AGN-260911-01)', trashedTime: '2026-09-25T05:00:00Z' }, { id: 't2', name: 'y (AGN-260911-01)', trashedTime: null }]
  trashTrees = { t1: [{ id: 'm1', name: 'B005C001_2609114B.MXF', size: 100e9, md5: 'zz', folderPath: ['EP.1', 'CAM-B'], webViewLink: null }], t2: new Error('Drive 500') }
  const b = (await fi.scanFootagePage({ now: NOW })).boxes[0]
  assert.equal(b.state, 'issues')
  assert.deepEqual(b.stranded, { files: 1, bytes: 100e9, purgeAfter: '2026-10-25T05:00:00.000Z' })
  assert.match(b.errors.join(' '), /Drive 500/)
})

test('รีวิว: Media Pool ใช้ Sub ที่ต้นฉบับยังอัปอยู่ → รอ (ถ่ายเมื่อวาน) · ผ่าน 4 วัน → ต้องตาม', async () => {
  const { deflateRawSync } = await import('zlib')
  const xml = `<x><Sm2MpVideoClip DbId="a"><FieldsBlob>0</FieldsBlob><Name>B022C001_2609297HS03.MP4</Name></Sm2MpVideoClip></x>`
  const name = Buffer.from('MediaPool/Master/000_1_FOOTAGE/000_2026-09-29 · AGN-260911-01/MpFolder.xml')
  const data = deflateRawSync(Buffer.from(xml)), raw = Buffer.from(xml)
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26)
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28)
  const cd = Buffer.concat([ch, name]); const off = 30 + name.length + data.length
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(off, 16)
  drp = { buf: Buffer.concat([lh, name, data, cd, eo]), modifiedTime: '2026-09-29T12:00:00Z' }

  rows = [booking(1, { projectId: 'PP-26-034', shootDate: new Date('2026-09-29') })]
  boxFiles.box1 = [clip('B022C001_2609297HS03.MP4', 'Sub'), clip('B022C001_2609297HM01.XML')]
  const early = (await fi.scanFootagePage({ now: NOW })).boxes[0]
  assert.equal(early.counts['mediapool-pending'], 1)
  assert.equal(early.state, 'waiting')
  assert.equal(early.mediaPool?.status, 'partial')

  const late = (await fi.scanFootagePage({ now: new Date(NOW.getTime() + 3 * 86_400_000) })).boxes[0]
  assert.equal(late.state, 'issues')
})

test('รีวิว: ใบที่ไม่มีกล่องผูก (ไม่ใช่งานรูป) ถูกนับและบอกรหัส', async () => {
  rows = [booking(1, { driveFolders: {} }), booking(2, { driveFolders: { photo: 'p1' } })]
  const p = await fi.scanFootagePage({ now: NOW })
  assert.equal(p.noBox, 1)
  assert.deepEqual(p.noBoxCodes, [rows[0].bookingCode])
})

test('ตรวจตาม Production ID ไม่เอางานที่ยังไม่ถ่าย (ถึงเมื่อวาน) · ตรวจตามรหัสคิวเอาตามที่สั่ง', async () => {
  rows = [booking(1)]
  await fi.scanFootagePage({ projects: ['PP-26-034'], now: NOW })
  assert.deepEqual(lastWhere.shootDate, { lte: new Date('2026-09-29') })
  assert.equal(lastWhere.OR, undefined)
  await fi.scanFootagePage({ codes: ['AGN-261003-01'], now: NOW })
  assert.equal(lastWhere.shootDate, undefined)
  await fi.scanFootagePage({ now: NOW })
  assert.deepEqual(lastWhere.OR[0], { shootDate: { gte: new Date('2026-08-31'), lte: new Date('2026-09-29') } })
})

test('v1.254: การ์ด XDROOT ที่ไม่มี MEDIAPRO.XML ตรวจความครบไม่ได้ → ไม่ใช่ "ครบ" · MEDIAPRO ระบุคลิปที่ไม่มีในกล่อง → ขาด', async () => {
  rows = [booking(1)]
  boxFiles.box1 = [clip('A001C001_260901AA.MXF'), clip('A001C001_260901AAM01.XML')]
  const noIndex = (await fi.scanFootagePage({ now: NOW })).boxes[0]
  assert.equal(noIndex.state, 'issues')
  assert.equal(noIndex.counts['mediapro-absent'], 1)

  // clips are dated 1 Sep (…_260901…) — the shoot day, so a listed clip that is not there is MISSING
  rows = [booking(2, { shootDate: new Date('2026-09-01') })]
  mediaproXml = indexFor('A001C001_260901AA', 'A001C002_260901BB')
  const short = (await fi.scanFootagePage({ now: NOW })).boxes[0]
  assert.equal(short.counts['mediapro-missing'], 2, 'MXF + M01.XML ของคลิปที่สอง')
  assert.match(short.issues.find(i => i.kind === 'mediapro-missing')!.detail, /A001C002_260901BB/)

  // v1.260 — the same card index under a booking shot 20 Sep: the absent 1 Sep clip was left on an
  // unformatted card by an earlier shoot (AGN-260713-02: 416 such "missing" files) → a note, not an issue
  rows = [booking(3)]
  mediaproXml = indexFor('A001C001_260901AA', 'A001C002_260901BB')
  located = { 'A001C002_260901BB.MXF': 'Other show (NWS-X-260901-01)/EP01/CAM-A/XDROOT/Clip', 'A001C002_260901BBM01.XML': 'Other show (NWS-X-260901-01)/EP01/CAM-A/XDROOT/Clip' }
  const stale = (await fi.scanFootagePage({ now: NOW, docs: true })).boxes[0]
  assert.equal(stale.counts['mediapro-missing'], undefined)
  assert.equal(stale.state, 'ok')
  assert.equal(stale.notes.length, 1)
  assert.match(writes[writes.length - 1].html, /ข้ามคลิปก่อนวันถ่าย 2 ไฟล์ \(2026-09-01 — น่าจะการ์ดไม่ได้ format[^)]*\) · A001C002_260901BB\.MXF, A001C002_260901BBM01\.XML/, 'เอกสารยังบอกชื่อไฟล์ที่ข้าม — ถ้าวันถ่ายในใบผิด คนอ่านยังเห็น')

  // รีวิว: "เป็นของงานก่อน" คือข้อสันนิษฐาน — ถ้าชื่อนั้นไม่มีที่ไหนบน Drive เลย ก็กลับมาเป็น "ขาด" พร้อมเหตุผล
  rows = [booking(4)]
  mediaproXml = indexFor('A001C001_260901AA', 'A001C002_260901BB')
  located = {}
  const nowhere = (await fi.scanFootagePage({ now: NOW })).boxes[0]
  assert.equal(nowhere.counts['mediapro-missing'], 2)
  assert.match(nowhere.issues.find(i => i.kind === 'mediapro-missing')!.detail, /ลงวันที่ 2026-09-01 ก่อนวันถ่าย.*ไม่พบไฟล์ชื่อนี้ที่ไหนบน Drive/)
})

test('v1.258: ไฟล์ที่ MEDIAPRO บอกว่าขาด ถ้าเจอชื่อเดียวกันที่อื่นบน Drive → บอกว่าอยู่ไหน (เคส Osotspa → โฟลเดอร์ drop ของงานยกเลิก)', async () => {
  rows = [booking(3)]
  mediaproXml = indexFor('A001C001_260901AA', 'A024C003_261001MM')
  located = { 'A024C003_261001MM.MXF': 'The Secret Short Clip · Whyology EP.3 (TSS-TSC-260925-01)/EP01 · Whyology EP.3/CAM-A/CLIP' }
  const b = (await fi.scanFootagePage({ now: NOW })).boxes[0]
  const hit = b.issues.find(i => i.kind === 'mediapro-missing' && i.detail.includes('A024C003_261001MM.MXF'))!
  assert.match(hit.hint!, /^The Secret Short Clip · Whyology EP\.3 \(TSS-TSC-260925-01\)/)
  assert.doesNotMatch(hit.detail, /พบไฟล์/, 'คำใบ้แยกจาก detail — ไม่เข้า issueKey (ค้นได้ผลต่างกันทุกวัน)')
  const xml = b.issues.find(i => i.kind === 'mediapro-missing' && i.detail.includes('M01.XML'))!
  assert.equal(xml.hint, undefined, 'ไม่เจอ = ไม่เดา')
  located = {}
})

test('v1.258 รีวิว: ชื่อ C0001 (เริ่มนับใหม่ทุกการ์ด) ไม่ถูกค้นทั้ง Drive — เจอที่อื่นก็เป็นคลิปของงานอื่น', async () => {
  rows = [booking(4)]
  mediaproXml = indexFor('A001C001_260901AA', 'C0003')
  located = { 'C0003.MXF': 'Other show (NWS-X-260901-01)/EP01/CAM-B/M4ROOT/CLIP' }
  const b = (await fi.scanFootagePage({ now: NOW })).boxes[0]
  const miss = b.issues.filter(i => i.kind === 'mediapro-missing')
  assert.ok(miss.some(i => i.detail.includes('C0003.MXF')))
  assert.ok(miss.every(i => i.hint === undefined))
  located = {}
})

// ── v1.266 cache repair: footage that arrived after the footage-ready lookback ──
// KND-KNF-260916-01 / AGN-260904-01 / EVT-EVF-260901-01 (11 ต.ค. 2569): ฟุตเทจมาถึงหลังหน้าต่างแจ้งอัตโนมัติปิด
// cache ค้าง fileCount 0 → /footage-ready/stats ไม่เคยขึ้นว่า agedOut จนตรวจด้วยมือเจอ

const EMPTY_CACHE = { footageCache: { found: 0, fileCount: 0, folders: [] }, footageCacheAt: new Date('2026-09-20T16:43:00Z') }

test('cacheBehindBox: มีฟุตเทจในกล่อง + cache ว่าง/ถูกล้าง/ตามไม่ทัน + ยังไม่ได้แจ้ง → ต้องเดินใหม่', () => {
  assert.equal(fi.cacheBehindBox(EMPTY_CACHE, 41), true, 'cache ว่างค้าง (เคส KND)')
  assert.equal(fi.cacheBehindBox({ footageCache: { fileCount: 9 }, footageCacheAt: null }, 41), true, 'upload complete ล้าง cache (footageCacheAt=null) = ไม่รู้ ไม่ใช่มี')
  assert.equal(fi.cacheBehindBox({}, 41), true, 'ไม่เคยมี cache')
  assert.equal(fi.cacheBehindBox({ footageCache: 'junk', footageCacheAt: new Date() }, 41), true, 'cache พัง ≠ มีฟุตเทจ')
  // review v1.266: ฟุตเทจมาเป็นชุด — ซ่อมแค่ตอน 0 = cache ค้างที่ชุดแรก แล้ว 📣 ส่งรายการไม่ครบ (CAM-A ไม่มี B/C)
  assert.equal(fi.cacheBehindBox({ footageCache: { fileCount: 41 }, footageCacheAt: new Date() }, 120), true, 'cache ตามกล่องไม่ทัน')
})

test('cacheBehindBox: ไม่ต้องเดิน — กล่องไม่มีฟุตเทจ / แจ้งแล้ว / ส่งงานแล้ว / cache เห็นครบแล้ว', () => {
  assert.equal(fi.cacheBehindBox(EMPTY_CACHE, 0), false)
  assert.equal(fi.cacheBehindBox({ ...EMPTY_CACHE, readyNotifiedAt: new Date() }, 41), false)
  assert.equal(fi.cacheBehindBox({ ...EMPTY_CACHE, deliveredAt: new Date() }, 41), false)
  assert.equal(fi.cacheBehindBox({ footageCache: { fileCount: 41 }, footageCacheAt: new Date() }, 41), false)
  assert.equal(fi.cacheBehindBox({ footageCache: { fileCount: 44 }, footageCacheAt: new Date() }, 41), false, 'cache นับ landing/staging ด้วย จึงมากกว่ากล่องได้')
})

test('dry run บอกว่าจะเดิน cache ใหม่ แต่ไม่เดินไม่เขียน · ของจริงเดินแล้วเขียน cache ของใบนั้น', async () => {
  rows = [booking(1, EMPTY_CACHE)]
  const dry = await fi.scanFootagePage({ now: NOW })
  assert.equal(dry.boxes[0].cache, 'would-refresh')
  assert.deepEqual(walked, [])
  assert.deepEqual(stored, [])

  const real = await fi.scanFootagePage({ docs: true, now: NOW })
  assert.equal(real.boxes[0].cache, 'refreshed 41')
  assert.deepEqual(walked, ['AGN-260911-01'])
  assert.deepEqual(stored, [{ id: 'id001', fileCount: 41 }])
  assert.equal(real.boxes[0].state, dry.boxes[0].state, 'ผลตรวจกล่องเหมือนเดิมทั้งสองรอบ')
})

test('แจ้งแล้ว / cache เห็นฟุตเทจแล้ว / กล่องมีแต่ _SHOOT.txt → ไม่แตะ cache', async () => {
  rows = [
    booking(1, { ...EMPTY_CACHE, readyNotifiedAt: new Date('2026-09-21') }),
    booking(2, { footageCache: { fileCount: 3 }, footageCacheAt: new Date('2026-09-21') }),
    booking(3, EMPTY_CACHE),
  ]
  boxFiles.box3 = [{ name: '_SHOOT.txt', folderPath: [] }]
  const p = await fi.scanFootagePage({ docs: true, now: NOW })
  assert.deepEqual(p.boxes.map(b => b.cache), [undefined, undefined, undefined])
  assert.deepEqual(walked, [])
  assert.deepEqual(stored, [])
})

test('เขียน cache ไม่ได้ → บอกว่าล้ม (ไม่รายงานว่าแก้แล้ว) และไม่ปนเข้าผลตรวจฟุตเทจ/เอกสาร', async () => {
  rows = [booking(1, EMPTY_CACHE)]
  storeFails = new Error('DB down')
  const p = await fi.scanFootagePage({ docs: true, now: NOW })
  assert.match(p.boxes[0].cache!, /^refresh failed: DB down/)
  assert.deepEqual(p.boxes[0].errors, [], 'ไม่ใช่ปัญหาของฟุตเทจ — ห้ามขึ้นในเอกสาร _FOOTAGE-CHECK')
  assert.equal(p.boxes[0].state, 'ok')
})

test('กล่องใช้ร่วม / ชื่อกล่องไม่ใช่ของคิว → ไม่ซ่อม cache (จะเอาฟุตเทจใบอื่นมาเป็นของใบนี้) · บอกว่าข้าม', async () => {
  rows = [booking(1, EMPTY_CACHE)]
  sharing = 2
  const shared = await fi.scanFootagePage({ docs: true, now: NOW })
  assert.match(shared.boxes[0].cache!, /^skipped: .*ผูกกับ 2 ใบจอง/)

  sharing = 1; boxNames.box1 = 'GDH x 8 Minute History (PP-26-034)'
  const misLinked = await fi.scanFootagePage({ docs: true, now: NOW })
  assert.match(misLinked.boxes[0].cache!, /^skipped: .*ไม่ใช่ของคิวนี้/)
  assert.deepEqual(walked, [])
  assert.deepEqual(stored, [])
})

test('เดินแล้วได้น้อยกว่าที่กล่องมี (Drive error ที่ถูกกลืน) → ไม่เขียน cache · บอกว่าไม่ตรง · สรุปรายวันพูดถึง', async () => {
  rows = [booking(1, EMPTY_CACHE)]
  walkCount = 0
  const p = await fi.scanFootagePage({ docs: true, now: NOW })
  assert.match(p.boxes[0].cache!, /^refresh disagrees: box \d+ · walk 0/)
  assert.deepEqual(stored, [], 'ห้ามประทับ cache ใหม่ด้วยค่าที่รู้ว่าผิด')
  assert.match(fi.formatRunSummary({ boxes: p.boxes, docs: true }), /ซ่อม cache ฟุตเทจไม่ได้ 1 ใบ .*AGN-260911-01/)
})

test('ซ่อมสำเร็จอย่างเดียว ไม่ทำให้สรุปรายวันพูด (ไม่มีอะไรต้องทำ)', async () => {
  rows = [booking(1, EMPTY_CACHE)]
  docs.box1 = [{ id: 'd', ours: true, hash: null, writtenAt: null, webViewLink: 'u' }]
  const p = await fi.scanFootagePage({ docs: true, now: NOW })
  assert.equal(p.boxes[0].cache, 'refreshed 41')
  const quiet = p.boxes.map(b => ({ ...b, doc: { ...b.doc, announced: b.issueKey } }))
  assert.equal(fi.formatRunSummary({ boxes: quiet, docs: true }), '')
})
