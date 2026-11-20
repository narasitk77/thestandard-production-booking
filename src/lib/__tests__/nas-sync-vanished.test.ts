import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// v1.290 — 20 พ.ย. 2569: 11 รหัสค้าง lastPending>0 ถาวร (POP-7TG-261116-01 = 5, TSS-TSL-261019-01 = 104, บางตัวตั้งแต่ ก.ค.)
// เพราะโฟลเดอร์หายจาก NAS ทั้งที่ยังค้างไฟล์ — ingest วนแค่โฟลเดอร์ที่อยู่ใน manifest ปัจจุบัน → ด่าน NAS (d) ของ footage-ready ปิดตลอดไป
// หายนาน DRAIN_SETTLE_MS = ปลดด่าน (ไม่ใช่ "ส่งครบ": ไม่มีเมล ✅ ไม่เขียน nas.folder_drained) + เตือน ops รวบเดียว

let row: any = null
let audits: any[] = []
let alerts: any[] = []
let emails: any[] = []
let chats: string[] = []
mock.module('../db', {
  namedExports: {
    prisma: {
      nasSyncState: {
        findUnique: async () => row,
        upsert: async ({ update }: any) => { row = { status: update.status, manifest: update.manifest }; return {} },
      },
      booking: { findMany: async () => [] },
    },
  },
})
mock.module('../email', { namedExports: { sendEmail: async (e: any) => { emails.push(e) }, isEmailConfigured: () => true } })
mock.module('../notify', { namedExports: { notifyChat: async (m: string) => { chats.push(m); return true } } })
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { audits.push(a) } } })
mock.module('../ops-alert', { namedExports: { alertOps: async (key: string, subject: string, text: string, everyMs?: number) => { alerts.push({ key, subject, text, everyMs }); return { attempted: true, delivered: true } } } })
mock.module('../google-drive', {
  namedExports: {
    findFoldersByCode: async () => [{ id: 'f1', parents: ['root'] }],
    listFilesRecursive: async () => [{ name: 'A001.MXF', size: 2048 }],
    findChildFolder: async () => null,
    SOUND_STAGING_DIR: '_SOUND-STAGING',
    listSoundStagingTree: async () => ({ bookings: [], containerIds: [] }),
  },
})

let nas: typeof import('../nas-sync')
before(async () => { process.env.REMINDER_ADMIN_EMAIL = 'ops@example.test'; nas = await import('../nas-sync') })
beforeEach(() => { row = null; audits = []; alerts = []; emails = []; chats = [] })

const T = 'POP-7TG-261116-01'
const U = 'NWS-GLF-261117-01'
const OLD = 'TSS-TSL-261019-01'
const dir = (name: string, n: number, size = 5_000_000) => ({ name, files: Array.from({ length: n }, (_, i) => ({ p: `CAM-A/C000${i}.MP4`, size: size + i })) })
const t = (n: number) => dir(`7 THINGS · ทดสอบ (${T})`, n)
const u = (n: number) => dir(`Gulf · ทดสอบ (${U})`, n)
const others = [dir('A (NWS-AAA-261101-01)', 0), dir('B (NWS-BBB-261101-01)', 0), dir('C (NWS-CCC-261101-01)', 0)]
const ingest = (folders: any[], extra: any = {}) => nas.ingestNasManifest({ at: new Date().toISOString(), folders, ...extra })
const st = (code: string) => row.status.folders[code]
/** the folder has been gone since `min` minutes ago */
const goneFor = (min: number, ...codes: string[]) => { for (const c of codes) st(c).goneSince = new Date(Date.now() - min * 60_000).toISOString() }
const drainedMail = () => emails.filter(e => String(e.subject).includes('ส่งขึ้น Drive ครบ'))

test('หายครั้งแรก = จำเวลา+ไฟล์ ไม่ปลด · หายครบเวลา = ปลดทุกรหัสในเตือนเดียว · nas.folder_vanished ไม่ใช่ drained · ไม่มีเมล ✅', async (tc) => {
  row = { status: { folders: { [OLD]: { lastPending: 104, maxSeen: 104 } } } } // gone since before the deploy (no manifest of it)
  await ingest([t(5), u(1), ...others])
  await ingest(others)
  assert.equal(st(T).lastPending, 5, 'first time gone: not released')
  assert.equal(st(T).goneFiles.length, 5, 'files sampled from the previous scan')
  assert.deepEqual(st(OLD).goneFiles, [], 'never in a stored scan: nothing to sample')
  assert.equal(audits.length, 0)
  await ingest(others)
  assert.equal(st(T).lastPending, 5, 'still inside the settle')
  assert.equal(audits.length, 0)

  goneFor(10, T, U, OLD)
  await ingest(others)
  for (const [c, n] of [[T, 5], [U, 1], [OLD, 104]] as const) {
    assert.equal(st(c).lastPending, 0, `${c}: NAS gate opens`)
    assert.equal(st(c).vanishedPending, n)
    assert.ok(st(c).vanishedAt)
    assert.equal(st(c).goneSince, undefined)
    assert.equal(st(c).goneFiles, undefined)
  }
  assert.deepEqual(audits.map(a => a.action), ['nas.folder_vanished', 'nas.folder_vanished', 'nas.folder_vanished'])
  assert.deepEqual(audits.map(a => a.bookingCode).sort(), [OLD, U, T].sort())
  assert.equal(audits.find(a => a.bookingCode === T).changes.pending, 5)
  const v = alerts.filter(a => a.key === 'nas-vanished')
  assert.equal(v.length, 1, 'one alert for the whole round')
  for (const c of [T, U, OLD]) assert.ok(v[0].text.includes(c))
  assert.ok(v[0].text.includes('110 ไฟล์'))
  assert.equal(v[0].everyMs, 0, 'never throttled: a second batch is news too')
  assert.equal(drainedMail().length, 0, 'not a drain — nobody knows the files arrived')
  assert.equal(chats.length, 0)

  await ingest(others)
  assert.equal(audits.length, 3, 'released once')
  assert.equal(alerts.filter(a => a.key === 'nas-vanished').length, 1)

  // ปลดแล้ว = lastPending 0 → ไม่ใช่ผู้สมัครอีกเลย แม้นาฬิกาเดินผ่าน settle ไปหลายรอบ (ไม่เริ่มนาฬิกาใหม่ ไม่ปลดซ้ำ)
  const t0 = Date.now()
  tc.mock.timers.enable({ apis: ['Date'], now: t0 })
  for (const h of [6, 12]) {
    tc.mock.timers.setTime(t0 + h * 3600_000)
    await ingest(others)
  }
  for (const c of [T, U, OLD]) {
    assert.equal(st(c).lastPending, 0)
    assert.equal(st(c).goneSince, undefined, `${c}: lastPending 0 never starts a gone clock`)
  }
  assert.equal(audits.length, 3, 'still released once, hours past the settle')
  assert.equal(alerts.filter(a => a.key === 'nas-vanished').length, 1)
})

test('ระยะรอ = DRAIN_SETTLE_MS พอดี: ขาดไป 1 นาที = ยังปิด นาฬิกาเดิม · ครบพอดี = ปลด', async (tc) => {
  const t0 = Date.parse('2026-11-20T03:00:00Z')
  tc.mock.timers.enable({ apis: ['Date'], now: t0 })
  await ingest([t(5), ...others])
  await ingest(others) // gone from here
  assert.equal(Date.parse(st(T).goneSince), t0)
  tc.mock.timers.setTime(t0 + nas.DRAIN_SETTLE_MS - 60_000)
  await ingest(others)
  assert.equal(st(T).lastPending, 5, 'a minute short of the settle: held')
  assert.equal(Date.parse(st(T).goneSince), t0, 'the clock is not restarted')
  assert.equal(audits.length, 0)
  assert.equal(alerts.length, 0)
  tc.mock.timers.setTime(t0 + nas.DRAIN_SETTLE_MS)
  await ingest(others)
  assert.equal(st(T).lastPending, 0, 'gone exactly DRAIN_SETTLE_MS: released')
  assert.equal(st(T).vanishedPending, 5)
  assert.deepEqual(audits.map(a => a.action), ['nas.folder_vanished'])
  assert.equal(alerts.filter(a => a.key === 'nas-vanished').length, 1)
})

test('goneSince อ่านเป็นเวลาไม่ได้ = ไม่ปลด (fail closed) + เขียนเวลาใหม่เป็นตอนนี้', async () => {
  row = { status: { folders: { [T]: { lastPending: 5, goneSince: 'not-a-date' } } } }
  await ingest(others) // a real scan, T not in it
  assert.equal(st(T).lastPending, 5, 'a clock nobody can read does not open the gate')
  assert.equal(audits.length, 0)
  assert.equal(alerts.length, 0)
  const g = Date.parse(st(T).goneSince)
  assert.ok(Number.isFinite(g), `goneSince rewritten to a parseable time, got ${st(T).goneSince}`)
  assert.ok(Math.abs(Date.now() - g) < 60_000, 'the clock restarts from now')
})

test('ตัวอย่างไฟล์ไม่นับ _SHOOT.txt และไฟล์ 0 ไบต์: มีแค่สองอย่างนี้โผล่ที่โฟลเดอร์อื่น ≠ ย้ายไป', async () => {
  const marker = { p: '_SHOOT.txt', size: 312 } // every landing carries its own, often the same size
  const empty = { p: 'CAM-A/CLIPINF.TMP', size: 0 }
  await ingest([{ ...t(5), files: [...t(5).files, marker, empty] }, ...others])
  const other = { name: 'Other job (NWS-EEE-261118-01)', files: [marker, empty] }
  await ingest([other, ...others])
  assert.equal(st(T).goneFiles.length, 5, 'only the clips are sampled')
  assert.ok(!st(T).goneFiles.some((k: string) => k.startsWith('_SHOOT') || k.endsWith('|0')), st(T).goneFiles.join(', '))
  goneFor(10, T)
  await ingest([other, ...others])
  assert.equal(alerts.filter(a => a.key === `nas-moved:${T}`).length, 0, 'a marker / empty file is not the card moving')
  assert.equal(st(T).lastPending, 0)
  assert.deepEqual(audits.map(a => a.action), ['nas.folder_vanished'])
})

test('กลับมาบน NAS = ล้างนาฬิกา · หายรอบใหม่เริ่มนับใหม่', async () => {
  await ingest([t(5), ...others])
  await ingest(others)
  goneFor(10, T)
  await ingest([t(5), ...others])
  assert.equal(st(T).goneSince, undefined)
  assert.equal(st(T).goneFiles, undefined)
  assert.equal(st(T).lastPending, 5)
  await ingest(others)
  assert.equal(st(T).lastPending, 5, 'a new disappearance starts a new clock')
  assert.ok(Date.now() - Date.parse(st(T).goneSince) < 60_000)
  assert.equal(audits.length, 0)
})

test('ไฟล์ชุดเดิมไปอยู่โฟลเดอร์อื่น (เปลี่ยนชื่อจนรหัสหาย) = ยังปิดด่าน + เตือน · ไฟล์ชุดนั้นส่งหมดแล้ว = ปลด', async () => {
  await ingest([t(5), ...others])
  const renamed = { ...t(5), name: '7 THINGS ทดสอบ ไม่มีรหัส' }
  await ingest([renamed, ...others])
  goneFor(10, T)
  await ingest([renamed, ...others])
  assert.equal(st(T).lastPending, 5, 'held')
  assert.equal(audits.length, 0)
  const m = alerts.filter(a => a.key === `nas-moved:${T}`)
  assert.equal(m.length, 1)
  assert.ok(m[0].text.includes('7 THINGS ทดสอบ ไม่มีรหัส'))
  assert.equal(alerts.filter(a => a.key === 'nas-vanished').length, 0)

  await ingest([{ ...renamed, files: [] }, ...others]) // Cloud Sync uploaded + removed them
  assert.equal(st(T).lastPending, 0)
  assert.equal(audits[0].action, 'nas.folder_vanished')
})

test('ชื่อไฟล์ซ้ำแต่ขนาดต่าง = การ์ดของงานอื่น ไม่ใช่ไฟล์ที่ย้ายมา', async () => {
  await ingest([t(5), ...others])
  await ingest(others)
  goneFor(10, T)
  await ingest([dir('Other job (NWS-DDD-261118-01)', 5, 7_000_000), ...others]) // C0000.MP4… again, other sizes
  assert.equal(st(T).lastPending, 0)
  assert.equal(alerts.filter(a => a.key.startsWith('nas-moved:')).length, 0)
})

test('อ่านไม่ได้ (manifest.skipped) = ยังอยู่ ไม่ปลดเลย และล้างนาฬิกา', async () => {
  await ingest([t(5), ...others])
  for (let i = 0; i < 3; i++) await ingest(others, { skipped: [t(0).name] })
  assert.equal(st(T).goneSince, undefined, 'unreadable is not gone')
  assert.equal(st(T).lastPending, 5)
  st(T).goneSince = new Date(Date.now() - 60 * 60_000).toISOString() // even with an old clock
  await ingest(others, { skipped: [t(0).name] })
  assert.equal(st(T).lastPending, 5)
  assert.equal(st(T).goneSince, undefined)
  assert.equal(audits.length, 0)
})

test('สแกนว่างทั้ง NAS = ไม่ตัดสินอะไร', async () => {
  row = { status: { folders: { [T]: { lastPending: 5, goneSince: new Date(Date.now() - 60 * 60_000).toISOString(), goneFiles: [] } } } }
  await ingest([])
  assert.equal(st(T).lastPending, 5)
  assert.equal(audits.length, 0)
  assert.equal(alerts.length, 0)
})

test('โฟลเดอร์มีรหัสหายเกินครึ่งในรอบเดียว (เมานต์ไม่ครบ) = รอบนี้ไม่ตัดสิน + เตือน · รอบถัดไปตัดสินตามปกติ', async () => {
  await ingest([t(5), ...others])
  goneFor(60, T) // as if T had been gone long past the settle
  st(T).goneFiles = []
  await ingest([others[0]]) // 3 of 4 coded folders missing at once
  assert.equal(st(T).lastPending, 5, 'not released on a half view')
  assert.equal(audits.length, 0)
  assert.equal(alerts.filter(a => a.key === 'nas-view-drop').length, 1)
  assert.equal(alerts.filter(a => a.key === 'nas-vanished').length, 0)
  // ponytail ceiling: the next scan is compared with this one, so it decides again
  await ingest([others[0]])
  assert.equal(st(T).lastPending, 0)
})

test('เส้นทาง drainPending เดิมไม่เปลี่ยน: ว่างแล้วหายจาก NAS = nas.folder_drained + เมล ✅ ไม่ใช่ vanished', async () => {
  await ingest([t(5), ...others])
  await ingest([t(0), ...others])
  st(T).zeroSince = new Date(Date.now() - 10 * 60_000).toISOString()
  await ingest(others)
  assert.deepEqual(audits.map(a => a.action), ['nas.folder_drained'])
  assert.equal(drainedMail().length, 1)
  assert.equal(st(T).vanishedAt, undefined)
  await ingest(others)
  assert.equal(audits.length, 1)
  assert.equal(alerts.filter(a => a.key === 'nas-vanished').length, 0)
})
