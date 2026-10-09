import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'

// v1.263 — notify-feed คือสิ่งเดียวที่ relay ของ Hermes เห็น: ล็อกการแปลงแถว audit → event
// (เดิมไม่มีเทส · v1.263 เพิ่มแถว ops.alert ที่ entityId เป็น key ของคำเตือน ไม่ใช่ booking id)
let auditRows: any[] = []
let bookings: any[] = []
let bookingWhere: any = null
mock.module('../db', {
  namedExports: {
    prisma: {
      auditLog: { findMany: async () => auditRows },
      booking: { findMany: async ({ where }: any) => { bookingWhere = where; return bookings } },
    },
  },
})
mock.module('../session', { namedExports: { getSession: async () => null } })
mock.module('../nas-sync', {
  namedExports: {
    latestNasState: async () => ({ manifest: { at: '2026-10-09T08:00:00Z' } }),
    nasManifestAge: () => ({ ageMinutes: 5, stale: false }),
  },
})

let GET: (r: any) => Promise<Response>
before(async () => {
  process.env.FOOTAGE_READY_SECRET = 'feed-secret'
  ;({ GET } = await import('../../app/api/internal/notify-feed/route'))
})
const req = (qs: string, secret = 'feed-secret') =>
  new Request(`https://probook.test/api/internal/notify-feed?${qs}`, { headers: { 'x-footage-ready-secret': secret } }) as any

test('ไม่มี secret = 401 · since ผิด = 400', async () => {
  assert.equal((await GET(req('since=2026-10-09T00:00:00Z', 'wrong'))).status, 401)
  assert.equal((await GET(req('since=nope'))).status, 400)
})

test('แถว audit 3 ชนิด → event ที่ relay ใช้ · ops.alert ไม่ถูกเอา key ไปค้นเป็น booking id', async () => {
  const at = new Date('2026-10-09T10:00:00Z')
  auditRows = [
    { id: 'a1', at, action: 'booking.auto_notified_ready', actorEmail: 'system', entityId: 'b1', bookingCode: 'NWS-KYM-261009-01',
      changes: { fileCount: 12, recipients: ['p@x.co', 'admin-digest'], mediapro: 'MEDIAPRO ครบ' } },
    { id: 'a2', at, action: 'nas.folder_drained', actorEmail: 'nas-sync', entityId: 'Key Message (NWS-KYM-261009-01)', bookingCode: 'NWS-KYM-261009-01',
      changes: { folder: 'Key Message (NWS-KYM-261009-01)', driveFiles: 3, driveBytes: 2048 } },
    { id: 'a3', at, action: 'ops.alert', actorEmail: 'ops-alert', entityId: 'sync-storm:POP-PIV-261007-02', bookingCode: null,
      changes: { subject: '⚠️ โฟลเดอร์ชื่อซ้ำ', text: 'บรรทัดแรก\nบรรทัดสอง', discord: false, lark: false, email: true } },
  ]
  bookings = [{ id: 'b1', bookingCode: 'NWS-KYM-261009-01', projectName: 'Key Message', driveFolders: { box: 'BOXID' }, program: null, episodes: [] }]
  const res = await GET(req('since=2026-10-09T00:00:00Z'))
  assert.equal(res.status, 200)
  const body: any = await res.json()
  assert.deepEqual(bookingWhere.OR[0].id.in, ['b1'], 'เฉพาะแถว booking.* ที่ใช้ entityId ค้น booking')
  const [ready, nas, ops] = body.events
  assert.equal(ready.kind, 'footage-ready')
  assert.equal(ready.people, 1, 'admin-digest ไม่ใช่คน')
  assert.equal(ready.files, 12)
  assert.equal(ready.boxUrl, 'https://drive.google.com/drive/folders/BOXID')
  assert.equal(nas.kind, 'nas-drained')
  assert.equal(nas.files, 3)
  assert.equal(nas.bytes, 2048)
  assert.equal(ops.kind, 'ops-alert')
  assert.equal(ops.code, 'sync-storm:POP-PIV-261007-02')
  assert.equal(ops.title, '⚠️ โฟลเดอร์ชื่อซ้ำ')
  assert.equal(ops.text, 'บรรทัดแรก\nบรรทัดสอง')
  assert.equal(ops.url, null)
  assert.equal(ops.emailed, true, 'relay ชี้ไปที่เมลได้เฉพาะเมื่อเมลออกจริง')
  assert.equal(ready.emailed, null)
  assert.equal(ready.text, null)
  assert.equal(body.nas.stale, false)
})
