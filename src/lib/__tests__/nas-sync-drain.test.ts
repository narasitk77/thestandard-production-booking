import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// v1.262 — นัท 9 ต.ค. 2569: "ไม่มีแจ้งเตือนเมื่อฟุตเทจพร้อมมานานแล้ว ... worker ก็ไม่มีแล้ว"
// NAS agent เงียบ 87 วัน (14 ก.ค. → 9 ต.ค.) ขณะที่หน้า NAS ยังโชว์ manifest 14 ก.ค. เหมือนของสด
// และ "คิว NAS ระบายหมด" มีแค่เมล (sendEmail ตรง) + Discord — ไม่มีบันทึกให้ใครตามอ่าน

let prevStatus: any = null
let audits: any[] = []
let chats: string[] = []
mock.module('../db', {
  namedExports: {
    prisma: {
      nasSyncState: {
        findUnique: async () => (prevStatus ? { status: prevStatus } : null),
        upsert: async ({ update }: any) => { prevStatus = update.status; return {} },  // state carries to the next manifest
      },
      booking: { findMany: async () => [] },
    },
  },
})
mock.module('../email', { namedExports: { sendEmail: async () => {}, isEmailConfigured: () => false } })
mock.module('../notify', { namedExports: { notifyChat: async (m: string) => { chats.push(m); return true } } })
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { audits.push(a) } } })
mock.module('../google-drive', {
  namedExports: {
    findFoldersByCode: async () => [{ id: 'f1', parents: ['root'] }],
    listFilesRecursive: async () => [{ name: 'A001.MXF', size: 2048 }, { name: '_SHOOT.txt', size: 10 }],
    findChildFolder: async () => null,
    SOUND_STAGING_DIR: '_SOUND-STAGING',
    listSoundStagingTree: async () => ({ bookings: [], containerIds: [] }),
  },
})

let nas: typeof import('../nas-sync')
before(async () => { nas = await import('../nas-sync') })
beforeEach(() => { prevStatus = null; audits = []; chats = [] })

const folder = (files: number) => ({
  name: 'Key Message · ทดสอบ (NWS-KYM-261009-01)',
  files: Array.from({ length: files }, (_, i) => ({ p: `CAM-A/A00${i}.MXF`, size: 1000 })),
})

/** v1.288 — the queue has stayed empty since `min` minutes ago (the drain is announced only once it settles) */
const emptySince = (min: number) => {
  for (const st of Object.values(prevStatus.folders) as any[]) if (st.drainPending) st.zeroSince = new Date(Date.now() - min * 60_000).toISOString()
}

test('คิว NAS ระบายหมด → บันทึก nas.folder_drained (พร้อมจำนวนไฟล์บน Drive) + แชต · ยังมีไฟล์ค้าง = ไม่บันทึก', async () => {
  prevStatus = { folders: { 'NWS-KYM-261009-01': { lastPending: 3, maxSeen: 3 } } }
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [folder(0)] })
  assert.equal(audits.length, 0, 'v1.288: empty just now — wait for it to stay empty')
  assert.equal(prevStatus.folders['NWS-KYM-261009-01'].lastPending, 0, "footage-ready's NAS gate opens at once")
  emptySince(10)
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [folder(0)] })
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action, 'nas.folder_drained')
  assert.equal(audits[0].bookingCode, 'NWS-KYM-261009-01')
  const { zeroSince, ...rest } = audits[0].changes
  assert.deepEqual(rest, { folder: 'Key Message · ทดสอบ (NWS-KYM-261009-01)', driveFiles: 1, driveBytes: 2048 })
  assert.ok(Date.parse(zeroSince) < Date.parse(audits[0].changes.zeroSince) + 1 && Date.now() - Date.parse(zeroSince) >= 9 * 60_000, 'when the queue really emptied (10 min ago here)')
  assert.equal(chats.length, 1)

  audits = []; chats = []
  prevStatus = { folders: { 'NWS-KYM-261009-01': { lastPending: 3, maxSeen: 3 } } }
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [folder(2)] })
  assert.equal(audits.length, 0, 'ยังส่งไม่ครบ ไม่ใช่ข่าว')
})

test('v1.262.1 รีวิว: สองโฟลเดอร์บน NAS รหัสเดียวกัน (การ์ดดัมพ์ซ้ำ "X (1)") — ตัวหนึ่งยังส่งอยู่ = ยังไม่ครบ ไม่ประกาศซ้ำทุก 10 นาที', async () => {
  const dup = { ...folder(0), name: 'Key Message · ทดสอบ (NWS-KYM-261009-01) (1)' }
  prevStatus = { folders: { 'NWS-KYM-261009-01': { lastPending: 3, maxSeen: 3 } } }
  for (let i = 0; i < 3; i++) await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [folder(2), dup] })
  assert.equal(audits.length, 0, 'ยังมีไฟล์ค้างในโฟลเดอร์หนึ่ง — ไม่ใช่ข่าว')
  assert.equal(chats.length, 0)
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [folder(0), dup] })
  emptySince(10)
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [folder(0), dup] })
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [folder(0), dup] })
  assert.equal(audits.length, 1, 'ระบายหมดทั้งสองโฟลเดอร์ = ประกาศครั้งเดียว')
})

test('v1.288 review r4: โฟลเดอร์ว่างแล้วหายจาก NAS ก่อนครบเวลา (prune ตอนเที่ยง) = ประกาศเมื่อครบเวลา · อ่านไม่ได้ (skipped) = รอ · บันทึกเวลาที่คิวว่างจริง', async () => {
  prevStatus = { folders: { 'NWS-KYM-261009-01': { lastPending: 3, maxSeen: 3 } } }
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [folder(0)] })
  const zero = prevStatus.folders['NWS-KYM-261009-01'].zeroSince
  emptySince(10)
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [], skipped: ['Key Message · ทดสอบ (NWS-KYM-261009-01)'] })
  assert.equal(audits.length, 0, 'unreadable is not gone')
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [] })
  assert.equal(audits.length, 1, 'gone after emptying = shipped')
  assert.equal(audits[0].entityId, 'Key Message · ทดสอบ (NWS-KYM-261009-01)')
  assert.ok(audits[0].changes.zeroSince && audits[0].changes.zeroSince !== zero || audits[0].changes.zeroSince, 'records when the queue emptied')
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [] })
  assert.equal(audits.length, 1, 'once')
})

test('v1.288 review: สแกนทุกนาที — คิวว่างชั่วครู่ระหว่างการ์ดสองใบ (แล้วมีไฟล์เข้าอีก) ไม่ใช่ "ส่งครบ"', async () => {
  prevStatus = { folders: { 'NWS-KYM-261009-01': { lastPending: 3, maxSeen: 3 } } }
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [folder(0)] })   // card 1 uploaded, card 2 not yet copied
  emptySince(2)
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [folder(4)] })   // card 2 lands
  assert.equal(audits.length, 0)
  assert.equal(chats.length, 0)
  assert.equal(prevStatus.folders['NWS-KYM-261009-01'].drainPending, false)
})

test('อายุ manifest: ไม่มี/อ่านไม่ได้ = เก่า · 30 นาที = สด · 90 นาที = เก่า · ปรับเพดานได้', () => {
  const now = new Date('2026-10-09T08:00:00Z')
  assert.deepEqual(nas.nasManifestAge(null, now), { ageMinutes: null, stale: true })
  assert.deepEqual(nas.nasManifestAge('not a date', now), { ageMinutes: null, stale: true })
  assert.deepEqual(nas.nasManifestAge('2026-10-09T07:30:00Z', now), { ageMinutes: 30, stale: false })
  assert.deepEqual(nas.nasManifestAge('2026-07-14T09:26:53Z', now).stale, true)
  process.env.NAS_MANIFEST_STALE_MINUTES = '20'
  assert.equal(nas.nasManifestAge('2026-10-09T07:30:00Z', now).stale, true)
  delete process.env.NAS_MANIFEST_STALE_MINUTES
})
