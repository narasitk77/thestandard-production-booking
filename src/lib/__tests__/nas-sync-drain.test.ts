import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// v1.262 — นัท 9 ต.ค. 2569: "ไม่มีแจ้งเตือนเมื่อฟุตเทจพร้อมมานานแล้ว ... worker ก็ไม่มีแล้ว"
// NAS agent เงียบ 87 วัน (14 ก.ค. → 9 ต.ค.) ขณะที่หน้า NAS ยังโชว์ manifest 14 ก.ค. เหมือนของสด
// และ "คิว NAS ระบายหมด" มีแค่เมลส่งหาตัวเอง (ไม่เคยเข้า Inbox) + Discord — ไม่มีบันทึกให้ใครตามอ่าน

let prevStatus: any = null
let audits: any[] = []
let chats: string[] = []
mock.module('../db', {
  namedExports: {
    prisma: {
      nasSyncState: {
        findUnique: async () => (prevStatus ? { status: prevStatus } : null),
        upsert: async () => ({}),
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

test('คิว NAS ระบายหมด → บันทึก nas.folder_drained (พร้อมจำนวนไฟล์บน Drive) + แชต · ยังมีไฟล์ค้าง = ไม่บันทึก', async () => {
  prevStatus = { folders: { 'NWS-KYM-261009-01': { lastPending: 3, maxSeen: 3 } } }
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [folder(0)] })
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action, 'nas.folder_drained')
  assert.equal(audits[0].bookingCode, 'NWS-KYM-261009-01')
  assert.deepEqual(audits[0].changes, { folder: 'Key Message · ทดสอบ (NWS-KYM-261009-01)', driveFiles: 1, driveBytes: 2048 })
  assert.equal(chats.length, 1)

  audits = []; chats = []
  prevStatus = { folders: { 'NWS-KYM-261009-01': { lastPending: 3, maxSeen: 3 } } }
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [folder(2)] })
  assert.equal(audits.length, 0, 'ยังส่งไม่ครบ ไม่ใช่ข่าว')
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
