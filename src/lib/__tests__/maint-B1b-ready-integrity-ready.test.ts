import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// maint 2026-11-08 (B1b) — footage-ready:
//  1. เมล "Footage พร้อม" ส่งไม่ถึงบางคน แต่ audit เคยบันทึกทุกคนเป็นผู้รับ + ประทับ readyNotifiedAt → คนที่ตกหล่นไม่มีใครรู้
//     (class 1 "a record is not delivery" ระดับรายคน) → recipients = เฉพาะที่ส่งผ่าน · failedRecipients · alertOps
//  2. รอบ ?codes= (forced) เดินทุกใบ แต่ deferredCodes เคยบอกว่า 3 ใบท้ายถูกเลื่อน

const CODE = 'TSS-TSS-261105-01'
const mkBooking = (id: string, bookingCode: string) => ({
  id, bookingCode, status: 'COMPLETED', driveFolders: { box: 'BOX' },
  projectId: null, projectName: 'ออมสิน', category: null, crewRequired: ['Videographer'],
  producer: 'แพร', producerEmail: 'ingtawan.s@thestandard.co', coProducerEmail: null, createdByEmail: 'ingtawan.s@thestandard.co',
  assignedEmails: ['video@thestandard.co'], directorEmail: null, director2Email: null, director3Email: null, cameraCount: 1,
  callTime: '09:00', shootDate: new Date('2026-11-01T00:00:00Z'), shootEndDate: null, estimatedWrap: null,
  readySnapshot: null, readyCheckedAt: null,
  outlet: { code: 'TSS', name: 'The Secret Sauce' }, program: { name: 'The Secret Sauce', code: 'TSS' }, episodes: [],
})

let bookings: any[] = []
let written: any[] = []
let mailed: string[] = []
let bounce = new Set<string>()
let alerts: Array<{ key: string; subject: string; text: string }> = []

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findMany: async () => bookings,
        findFirst: async () => null,
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
      auditLog: { findMany: async () => [], create: async ({ data }: any) => { written.push(data); return data } },
      upload: { groupBy: async () => [], findMany: async () => [], count: async () => 0 },
      user: { findMany: async () => [] },
    },
  },
})
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { written.push(a) } } })
mock.module('../email', {
  namedExports: {
    sendEmail: async (m: any) => {
      const to = [].concat(m.to)[0] as string
      if (bounce.has(to)) throw new Error('421 4.7.0 Try again later')
      mailed.push(to)
      return {}
    },
    isEmailConfigured: () => true,
  },
})
mock.module('../notify', {
  namedExports: {
    notifyChatDetailed: async () => ({ discord: true, lark: false, any: true }),
    notifyEmailDigest: async () => true,
  },
})
mock.module('../ops-alert', {
  namedExports: {
    alertOps: async (key: string, subject: string, text: string) => { alerts.push({ key, subject, text }); return { attempted: true, delivered: true, discord: true, lark: false, email: true } },
  },
})
mock.module('../nas-sync', { namedExports: { latestNasState: async () => ({ manifest: null, statuses: {} }), nasManifestAge: () => ({ ageMinutes: null, stale: true }) } })
const PAYLOAD = { found: 1, fileCount: 1, folders: [{ label: 'EP01 · CAM-A', url: 'u', fileCount: 1, totalBytes: 1000 }], bookingFolderUrl: 'u', soundStagingUrl: null }
mock.module('../footage-folders', { namedExports: { getCachedFootagePayload: async () => PAYLOAD, computeFootagePayload: async () => PAYLOAD } })
mock.module('../google-drive', {
  namedExports: {
    folderLiveness: async () => 'alive',
    findFoldersByCode: async () => [],
    listFilesRecursive: async () => [{ id: 'v', name: 'A.MP4', size: 1000, folderPath: ['EP01', 'CAM-A', 'Clip'], md5: 'm', createdTime: null, modifiedTime: null }],
    downloadDriveFile: async () => { throw new Error('no MEDIAPRO in these fixtures') },
  },
})

let fr: typeof import('../footage-ready')
before(async () => { process.env.FOOTAGE_READY_AUDIENCE = 'team'; fr = await import('../footage-ready') })
beforeEach(() => { bookings = [mkBooking('b1', CODE)]; written = []; mailed = []; bounce = new Set(); alerts = [] })

test('maint: เมลถึงบางคน → audit บันทึกเฉพาะคนที่ส่งผ่าน · failedRecipients บอกชื่อ · ops ได้ยินว่าใคร', async () => {
  bounce = new Set(['video@thestandard.co'])
  const r = await fr.runFootageReadyScan({ codes: [CODE] })
  assert.deepEqual(r.notified, [CODE], 'มีคนในงานได้รับ = ประทับว่าแจ้งแล้ว (send-once) เหมือนเดิม')
  const row = written.find(w => w.action === 'booking.auto_notified_ready')
  assert.ok(row)
  assert.ok(!row.changes.recipients.includes('video@thestandard.co'), 'คนที่เมลเด้งต้องไม่ถูกนับว่าได้รับ')
  assert.ok(row.changes.recipients.includes('ingtawan.s@thestandard.co'))
  assert.deepEqual(row.changes.failedRecipients, ['video@thestandard.co'])
  assert.match(row.changes.emailError, /1\/2 ส่งไม่สำเร็จ/)
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].key, `ready-mail-partial:${CODE}`)
  assert.match(alerts[0].text, /video@thestandard\.co/)
})

test('maint: เมลถึงทุกคน → ไม่มี failedRecipients ไม่เตือน ops (พฤติกรรมเดิม)', async () => {
  const r = await fr.runFootageReadyScan({ codes: [CODE] })
  assert.deepEqual(r.notified, [CODE])
  const row = written.find(w => w.action === 'booking.auto_notified_ready')
  assert.deepEqual(row.changes.recipients.filter((x: string) => x !== 'admin-digest').sort(), ['ingtawan.s@thestandard.co', 'video@thestandard.co'])
  assert.equal(row.changes.failedRecipients, undefined)
  assert.equal(alerts.length, 0)
})

test('maint: เมลไม่ถึงใครเลย → ไม่ประทับ (ลองใหม่รอบหน้า) · ไม่ใช่ "แจ้งบางส่วน"', async () => {
  bounce = new Set(['video@thestandard.co', 'ingtawan.s@thestandard.co'])
  const r = await fr.runFootageReadyScan({ codes: [CODE] })
  assert.deepEqual(r.notified, [])
  assert.equal(r.errors.length, 1)
  assert.equal(alerts.length, 0)
})

test('maint: รอบ ?codes= เดินทุกใบ → deferredCodes ว่าง (เดิมบอกว่าใบท้าย ๆ ถูกเลื่อนทั้งที่เดินแล้ว)', async () => {
  bookings = Array.from({ length: 8 }, (_, i) => mkBooking(`b${i}`, `TSS-TSS-2611${String(i).padStart(2, '0')}-01`))
  const r = await fr.runFootageReadyScan({ codes: bookings.map(b => b.bookingCode) })
  assert.equal(r.walked, 8)
  assert.equal(r.deferred, 0)
  assert.deepEqual(r.deferredCodes, [])
})

test('maint: รอบปกติชนเพดาน → deferredCodes = ใบที่ไม่ได้เดินจริง', async () => {
  bookings = Array.from({ length: 7 }, (_, i) => mkBooking(`n${i}`, `TSS-TSS-2612${String(i).padStart(2, '0')}-01`))
  const r = await fr.runFootageReadyScan({ dryRun: true })
  assert.equal(r.walked, 5)
  assert.equal(r.deferredCodes.length, 2)
  assert.equal(r.deferred, 2)
})

// maint r2 2026-11-08 — the gate passes callTime to isShootOver: an overnight single-day shoot (call 23:59, wrap
// 00:00) on TODAY is not over at any time of day; without callTime it read as over (wrap 00:00 ≤ now) all day.
test('r2: งานข้ามคืนที่ถ่ายวันนี้ยังไม่จบ → skip shoot-not-over (ไม่ใช่เดินหาฟุตเทจ)', async () => {
  const bkk = new Date(Date.now() + 7 * 3_600_000)
  const today = new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()))
  bookings = [{ ...mkBooking('night', CODE), shootDate: today, callTime: '23:59', estimatedWrap: '00:00' }]
  const r = await fr.runFootageReadyScan({ codes: [CODE], dryRun: true })
  assert.deepEqual(r.skipped, [{ code: CODE, reason: 'shoot-not-over' }])
  assert.equal(r.walked, 0)
})
