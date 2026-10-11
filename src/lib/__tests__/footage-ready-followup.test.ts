import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// v1.268 — นัท 11 ต.ค. 2569 "ทำแจ้งซ้ำตอนกล้องตามมาครบด้วย": ใบที่ถูกแจ้งพร้อม "⚠️ มีไฟล์ภาพ 2/3 กล้อง" ต้องได้ฉบับที่สอง
// เมื่อกล้องที่ขาดขึ้น Drive ครบ · ไฟล์ยังทยอยเข้า / ยังขาด = รอ · ส่งแล้วไม่ส่งซ้ำ · dry run ไม่ส่งแต่บอกว่าจะส่ง

const HOUR = 3_600_000
let audits: any[] = []          // rows the code reads (booking.auto_notified_ready / booking.ready_followup)
let written: any[] = []         // logAudit calls
let mailed: string[] = []
let chats: string[] = []
let files: any[] = []
let inFlight = 0
let createFails = false
const booking = {
  id: 'b1', bookingCode: 'TSS-TSS-261009-01', status: 'COMPLETED', driveFolders: { box: 'BOX' },
  projectId: null, projectName: 'ออมสิน', category: null, crewRequired: ['Videographer'],
  producer: 'แพร', producerEmail: 'ingtawan.s@thestandard.co', coProducerEmail: null, createdByEmail: 'ingtawan.s@thestandard.co',
  assignedEmails: ['video@thestandard.co'], directorEmail: null, director2Email: null, director3Email: null, cameraCount: 3,
  callTime: '09:00', shootDate: new Date('2026-10-09T00:00:00Z'), shootEndDate: null, estimatedWrap: null,
  readySnapshot: null, readyCheckedAt: null,
  outlet: { code: 'TSS', name: 'The Secret Sauce' }, program: { name: 'The Secret Sauce', code: 'TSS' }, episodes: [],
}

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findMany: async () => [],                       // no NEW candidates — the follow-up must still run
        findFirst: async () => booking,
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
      auditLog: {
        findMany: async ({ where }: any) => audits.filter(a => (typeof where.action === 'string' ? a.action === where.action : where.action.in.includes(a.action))
          && (!where.entityId || where.entityId.in.includes(a.entityId))),
        create: async ({ data }: any) => { if (createFails) throw new Error('pool exhausted'); written.push(data); return data },
      },
      upload: { groupBy: async () => [], count: async () => inFlight },
      user: { findMany: async () => [] },
    },
  },
})
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { written.push(a) } } })
mock.module('../email', { namedExports: { sendEmail: async (m: any) => { mailed.push(...[].concat(m.to)) ; return {} }, isEmailConfigured: () => true } })
mock.module('../notify', {
  namedExports: {
    notifyChatDetailed: async (t: string) => { chats.push(t); return { discord: true, lark: false, any: true } },
    notifyEmailDigest: async () => true,
  },
})
mock.module('../nas-sync', { namedExports: { latestNasState: async () => ({ manifest: null, statuses: {} }), nasManifestAge: () => ({ ageMinutes: null, stale: true }) } })
mock.module('../footage-folders', { namedExports: { getCachedFootagePayload: async () => ({ folders: [], fileCount: 0 }), computeFootagePayload: async () => ({ folders: [], fileCount: 0 }) } })
mock.module('../google-drive', {
  namedExports: {
    folderLiveness: async () => 'alive',
    findFoldersByCode: async () => [],
    listFilesRecursive: async () => files,
    downloadDriveFile: async () => { throw new Error('no MEDIAPRO in these fixtures') },
    listFolderFiles: async () => [],
    getDriveParentFolderId: async () => null,
  },
})

let fr: typeof import('../footage-ready')
before(async () => { process.env.FOOTAGE_READY_AUDIENCE = 'team'; fr = await import('../footage-ready') }) // prod runs 'team' — same audience as the first notice
beforeEach(() => { written = []; mailed = []; chats = []; inFlight = 0; createFails = false })

const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString()
const vid = (cam: string, name: string, createdH: number) => ({ id: name, name, size: 1000, folderPath: ['EP01', cam, 'Clip'], md5: `m-${name}`, createdTime: ago(createdH), modifiedTime: ago(createdH) })
const warned = { action: 'booking.auto_notified_ready', entityId: 'b1', bookingCode: 'TSS-TSS-261009-01', at: new Date(Date.now() - 20 * HOUR), changes: { cameraGap: 'มีไฟล์ภาพ 2/3 กล้อง (CAM-A, CAM-B)' } }

test('กล้องยังขาด = รอ (ไม่ส่ง ไม่บันทึก) · บอกว่ารออะไร', async () => {
  audits = [warned]
  files = [vid('CAM-A', 'A.MP4', 30), vid('CAM-B', 'B.MP4', 30)]
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.followedUp, [])
  assert.match(r.followUpWaiting[0].detail, /2\/3 กล้อง/)
  assert.equal(mailed.length, 0)
  assert.equal(written.length, 0)
})

test('กล้องครบแต่ไฟล์ยังทยอยเข้า (ใหม่กว่า settle) = รอ', async () => {
  audits = [warned]
  files = [vid('CAM-A', 'A.MP4', 30), vid('CAM-B', 'B.MP4', 30), vid('CAM-C', 'C.MP4', 0.5)]
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.followedUp, [])
  assert.match(r.followUpWaiting[0].detail, /ทยอย/)
  assert.equal(mailed.length, 0)
})

test('dry run: กล้องครบ + นิ่ง = บอกว่าจะส่ง แต่ไม่ส่ง ไม่บันทึก', async () => {
  audits = [warned]
  files = [vid('CAM-A', 'A.MP4', 30), vid('CAM-B', 'B.MP4', 30), vid('CAM-C', 'C.MP4', 10)]
  const r = await fr.runFootageReadyScan({ dryRun: true })
  assert.deepEqual(r.followedUp, ['TSS-TSS-261009-01'])
  assert.equal(mailed.length, 0)
  assert.equal(written.length, 0)
})

test('กล้องครบ + นิ่ง = ส่งฉบับที่สองให้ทีม + บันทึก ready_followup · รอบถัดไปไม่ส่งซ้ำ', async () => {
  audits = [warned]
  files = [vid('CAM-A', 'A.MP4', 30), vid('CAM-B', 'B.MP4', 30), vid('CAM-C', 'C.MP4', 10)]
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.followedUp, ['TSS-TSS-261009-01'])
  assert.deepEqual(mailed.sort(), ['ingtawan.s@thestandard.co', 'video@thestandard.co'])
  assert.equal(written.length, 1)
  assert.equal(written[0].action, 'booking.ready_followup')
  assert.deepEqual(written[0].changes.cams, ['CAM-A', 'CAM-B', 'CAM-C'])
  assert.equal(written[0].changes.cameraGapBefore, warned.changes.cameraGap)
  assert.match(chats.join('\n'), /กล้องตามมาครบ: TSS-TSS-261009-01/)
  // the row it wrote now exists → next sweep does nothing
  audits = [warned, { action: 'booking.ready_followup', entityId: 'b1', at: new Date() }]
  mailed = []
  const again = await fr.runFootageReadyScan()
  assert.deepEqual(again.followedUp, [])
  assert.equal(mailed.length, 0)
})

test('แจ้งครั้งแรกไม่มีคำเตือนกล้อง = ไม่มีอะไรต้องตาม · forced (?codes=) ไม่รันรอบตาม', async () => {
  audits = [{ ...warned, changes: { mediapro: 'ครบตาม MEDIAPRO' } }]
  files = [vid('CAM-A', 'A.MP4', 30)]
  assert.deepEqual((await fr.runFootageReadyScan()).followUpWaiting, [])
  audits = [warned]
  files = [vid('CAM-A', 'A.MP4', 30), vid('CAM-B', 'B.MP4', 30), vid('CAM-C', 'C.MP4', 10)]
  const forced = await fr.runFootageReadyScan({ codes: ['TSS-TSS-261009-01'] })
  assert.deepEqual(forced.followedUp, [])
  assert.equal(mailed.length, 0)
})

test('newestFileAt: ใช้เวลาใหม่สุดของ createdTime/modifiedTime · ค่าเพี้ยนไม่นับ', () => {
  assert.equal(fr.newestFileAt([{ createdTime: '2026-10-10T00:00:00Z', modifiedTime: '2026-10-09T00:00:00Z' }, { createdTime: 'nope', modifiedTime: null }]), Date.parse('2026-10-10T00:00:00Z'))
  assert.equal(fr.newestFileAt([]), 0)
})

// ── review v1.268 ─────────────────────────────────────────────────────────────

let seq = 100 // above the ids earlier tests already followed up (b1)
const fresh = (extra: any = {}) => ({ ...warned, entityId: `b${++seq}`, bookingCode: `TSS-TSS-2610${seq}-01`, ...extra })

test('สองแถวแจ้งของใบเดียว = ฉบับตามฉบับเดียว · แจ้งมือ (📣) ทีหลัง = ไม่ต้องตาม', async () => {
  const w = fresh()
  audits = [w, { ...w, at: new Date(Date.now() - 10 * HOUR) }]
  files = [vid('CAM-A', 'A.MP4', 30), vid('CAM-B', 'B.MP4', 30), vid('CAM-C', 'C.MP4', 10)]
  const r = await fr.runFootageReadyScan()
  assert.equal(r.followedUp.length, 1)
  assert.equal(mailed.length, 2, 'คนละฉบับ ไม่ใช่สองเท่า')
  const m = fresh()
  audits = [m, { action: 'booking.notified_ready', entityId: m.entityId, bookingCode: m.bookingCode, at: new Date(Date.now() - 5 * HOUR), changes: {} }]
  mailed = []
  assert.deepEqual((await fr.runFootageReadyScan()).followedUp, [])
  assert.equal(mailed.length, 0)
})

test('ไม่ใช่ "กล้องมาครบ" จริง = ไม่ส่ง: นับกล้องไม่ได้ · จำนวนกล้องในใบถูกลดแต่ไม่มีกล้องใหม่', async () => {
  audits = [fresh()]
  files = [vid('CAM-A', 'A.MP4', 30), vid('CAM-B', 'B.MP4', 30), { ...vid('x', 'EXPORT.MP4', 10), folderPath: ['EP01', 'Selects'] }]
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.followedUp, [])
  assert.match(r.followUpWaiting.map(w => w.detail).join(' | '), /นับกล้องไม่ได้|2\/3/)
  audits = [fresh({ changes: { cameraGap: 'มีไฟล์ภาพ 2/3 กล้อง (CAM-A, CAM-B)', cameraCams: ['CAM-A', 'CAM-B'] } })]
  files = [vid('CAM-A', 'A.MP4', 30), vid('CAM-B', 'B.MP4', 30)]
  const saved = booking.cameraCount
  booking.cameraCount = 2 // producer corrected the booking after the warning
  try {
    const r2 = await fr.runFootageReadyScan()
    assert.deepEqual(r2.followedUp, [])
    assert.match(r2.followUpWaiting[0].detail, /ไม่มีกล้องใหม่/)
  } finally { booking.cameraCount = saved }
  assert.equal(mailed.length, 0)
})

test('ยังอัปโหลดอยู่ = รอ (ด่านเดียวกับฉบับแรก)', async () => {
  audits = [fresh()]
  files = [vid('CAM-A', 'A.MP4', 30), vid('CAM-B', 'B.MP4', 30), vid('CAM-C', 'C.MP4', 10)]
  inFlight = 1
  const r = await fr.runFootageReadyScan()
  assert.deepEqual(r.followedUp, [])
  assert.match(r.followUpWaiting[0].detail, /อัปโหลด/)
})

test('แถวของ v1.267 (คำเตือนอยู่ใน mediapro เท่านั้น) ก็ได้ฉบับตาม', async () => {
  audits = [fresh({ changes: { mediapro: 'ไม่มีการ์ด Sony (ไม่มี MEDIAPRO ให้เทียบ) · ⚠️ มีไฟล์ภาพ 2/3 กล้อง (CAM-A, CAM-B)' } })]
  files = [vid('CAM-A', 'A.MP4', 30), vid('CAM-B', 'B.MP4', 30), vid('CAM-C', 'C.MP4', 10)]
  const r = await fr.runFootageReadyScan()
  assert.equal(r.followedUp.length, 1)
  assert.equal(written[0].changes.cameraGapBefore, 'มีไฟล์ภาพ 2/3 กล้อง (CAM-A, CAM-B)')
})

test('ส่งแล้วแต่บันทึกลง DB ไม่ได้ = ร้องดัง + ไม่ส่งซ้ำรอบถัดไป (ในโปรเซสเดียวกัน)', async () => {
  const w = fresh()
  audits = [w]
  files = [vid('CAM-A', 'A.MP4', 30), vid('CAM-B', 'B.MP4', 30), vid('CAM-C', 'C.MP4', 10)]
  createFails = true
  const r = await fr.runFootageReadyScan()
  assert.equal(r.followedUp.length, 1)
  assert.match(r.errors.map(e => e.error).join(' | '), /บันทึกไม่ลง/)
  mailed = []
  createFails = false
  const again = await fr.runFootageReadyScan()
  assert.deepEqual(again.followedUp, [])
  assert.equal(mailed.length, 0, 'ไม่ส่งซ้ำ ทั้งที่ไม่มีแถว ready_followup')
})

test('ใบที่ไม่มีวันครบไม่กินคิวตลอดไป — ผลัดกันตรวจ (5 ใบ/รอบ)', async () => {
  const stuck = Array.from({ length: 5 }, () => fresh())
  const later = fresh()
  audits = [...stuck, later]
  files = [vid('CAM-A', 'A.MP4', 30)] // never completes
  const first = await fr.runFootageReadyScan()
  const second = await fr.runFootageReadyScan()
  const walked = [...first.followUpWaiting, ...second.followUpWaiting].map(w => w.code)
  assert.ok(walked.includes(later.bookingCode), 'ใบใหม่ได้ถูกตรวจภายในสองรอบ')
})

test('noticeGap: อ่านได้ทั้งแถวใหม่และแถว v1.267 · แจ้งปกติ = null', () => {
  assert.deepEqual(fr.noticeGap({ cameraGap: 'มีไฟล์ภาพ 1/3 กล้อง (CAM-A)', cameraCams: ['CAM-A'] }), { gap: 'มีไฟล์ภาพ 1/3 กล้อง (CAM-A)', cams: 1 })
  assert.deepEqual(fr.noticeGap({ mediapro: 'ครบตาม MEDIAPRO 2 การ์ด · 40 ไฟล์ · ⚠️ ยังไม่มีไฟล์ภาพจากกล้องเลย (มีแต่ไฟล์อื่น เช่น เสียง)' }), { gap: 'ยังไม่มีไฟล์ภาพจากกล้องเลย (มีแต่ไฟล์อื่น เช่น เสียง)', cams: 0 })
  assert.equal(fr.noticeGap({ mediapro: 'ครบตาม MEDIAPRO 2 การ์ด' }), null)
})
