/**
 * ตัวตัดสิน "ไฟล์ใน drop ลบได้ไหม" (v1.224)
 *
 * กฎเดียวที่สำคัญที่สุด: **เดาผิดข้างไหนก็ไม่เท่ากัน**
 *   - บอกว่า "ลบได้" ทั้งที่ไม่ได้ → ฟุตเทจต้นฉบับหาย กู้ไม่ได้
 *   - บอกว่า "ลบไม่ได้" ทั้งที่ได้  → โฟลเดอร์ค้างอีกวัน
 * ทุกความไม่แน่นอนจึงต้องออกมาเป็น `undecidable` / `not-merged` ห้ามเป็น
 * `safe-to-delete` เด็ดขาด
 *
 * ที่มาของกฎนี้คือเคสจริง `TSS-WYS-260824-01`: 585 ไฟล์ตรงกันด้วย "ชื่อ+ขนาด"
 * แต่ DSC04216.ARW เนื้อในคนละไฟล์ — ตัวในกล่องเสีย ตัวใน drop เป็นต้นฉบับ
 * ชุดเดียวที่เหลือ ⇒ ชื่อ+ขนาดไม่ใช่ตัวตนของไฟล์ ต้องใช้ checksum เท่านั้น
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

type F = { id: string; name: string; size: number | null; md5: string | null }
let trees: Record<string, F[] | Error> = {}
let folders: Array<{ id: string; name: string; parents: string[] }> | Error = []

mock.module('../google-drive', {
  namedExports: {
    listFilesRecursive: async (id: string) => {
      const t = trees[id]
      if (t instanceof Error) throw t
      return (t || []).map(f => ({ ...f, mimeType: 'video/mp4', parents: [id], webViewLink: null, createdTime: null, modifiedTime: null, folderPath: [], topFolderId: null }))
    },
    findFoldersByCode: async () => {
      if (folders instanceof Error) throw folders
      return folders
    },
  },
})

let verifyLandingDuplicates: typeof import('../landing-duplicates').verifyLandingDuplicates
before(async () => { ({ verifyLandingDuplicates } = await import('../landing-duplicates')) })

const f = (name: string, md5: string | null, size = 100): F => ({ id: 'f-' + name, name, size, md5 })

beforeEach(() => { trees = {}; folders = [{ id: 'box', name: 'X (C-1)', parents: [] }] })

test('ทุกไฟล์มี checksum ตรงกันในกล่อง → ลบได้', async () => {
  trees = { land: [f('a.mxf', 'aaa'), f('b.mxf', 'bbb')], box: [f('a.mxf', 'aaa'), f('b.mxf', 'bbb'), f('c.mxf', 'ccc')] }
  const v = await verifyLandingDuplicates('C-1', 'land')
  assert.equal(v.verdict, 'safe-to-delete')
  assert.equal(v.duplicated, 2)
  assert.equal(v.onlyHere, 0)
})

test('ชื่อ+ขนาดตรงกันแต่ checksum ต่าง → ห้ามลบ (เคส DSC04216.ARW)', async () => {
  trees = {
    land: [f('DSC04216.ARW', 'raw-จริง', 26000000)],
    box:  [f('DSC04216.ARW', 'jpeg-เสีย', 26000000)],   // ชื่อ+ขนาดเท่ากันเป๊ะ
  }
  const v = await verifyLandingDuplicates('C-1', 'land')
  assert.equal(v.verdict, 'not-merged', 'ชื่อ+ขนาดตรงกันต้องไม่ทำให้ตัดสินว่าลบได้')
  assert.equal(v.onlyHere, 1)
})

test('บางไฟล์ยังไม่ได้ย้าย → not-merged พร้อมบอกจำนวน', async () => {
  trees = { land: [f('a.mxf', 'aaa'), f('new.mxf', 'zzz')], box: [f('a.mxf', 'aaa')] }
  const v = await verifyLandingDuplicates('C-1', 'land')
  assert.equal(v.verdict, 'not-merged')
  assert.equal(v.duplicated, 1)
  assert.equal(v.onlyHere, 1)
})

test('อ่านกล่องไม่ได้ → undecidable ไม่ใช่ safe-to-delete', async () => {
  trees = { land: [f('a.mxf', 'aaa')], box: new Error('Drive 500') }
  const v = await verifyLandingDuplicates('C-1', 'land')
  assert.equal(v.verdict, 'undecidable')
  assert.match(v.reason, /อ่านกล่องไม่ครบ/)
})

test('อ่านโฟลเดอร์ drop ไม่ได้ → undecidable', async () => {
  trees = { land: new Error('boom') }
  const v = await verifyLandingDuplicates('C-1', 'land')
  assert.equal(v.verdict, 'undecidable')
})

test('หาโฟลเดอร์กล่องไม่เจอ = ยังไม่ได้ย้าย ไม่ใช่ลบได้', async () => {
  trees = { land: [f('a.mxf', 'aaa')] }
  folders = []
  const v = await verifyLandingDuplicates('C-1', 'land')
  assert.equal(v.verdict, 'not-merged')
  assert.equal(v.onlyHere, 1)
})

test('ไฟล์ที่ Drive ไม่ให้ checksum → undecidable ไม่เหมาว่าซ้ำ', async () => {
  trees = { land: [f('a.mxf', 'aaa'), f('note.gdoc', null)], box: [f('a.mxf', 'aaa')] }
  const v = await verifyLandingDuplicates('C-1', 'land')
  assert.equal(v.verdict, 'undecidable')
  assert.equal(v.noChecksum, 1)
})

test('โฟลเดอร์ว่างแล้ว → ลบได้', async () => {
  trees = { land: [] }
  const v = await verifyLandingDuplicates('C-1', 'land')
  assert.equal(v.verdict, 'safe-to-delete')
})

test('ไม่นับโฟลเดอร์ drop ตัวเองเป็น "กล่อง" (ไม่งั้นจะซ้ำกับตัวเองเสมอ)', async () => {
  trees = { land: [f('a.mxf', 'aaa')] }
  folders = [{ id: 'land', name: 'X (C-1)', parents: [] }]   // เจอแต่ตัวเอง
  const v = await verifyLandingDuplicates('C-1', 'land')
  assert.equal(v.verdict, 'not-merged', 'ตัวเองไม่ใช่กล่อง')
})

test('นับไบต์ที่จะได้คืนเฉพาะไฟล์ที่ซ้ำจริง', async () => {
  trees = { land: [f('a.mxf', 'aaa', 1_073_741_824), f('b.mxf', 'zzz', 500)], box: [f('a.mxf', 'aaa', 1_073_741_824)] }
  const v = await verifyLandingDuplicates('C-1', 'land')
  assert.equal(v.duplicatedBytes, 1_073_741_824, 'ไฟล์ที่ยังไม่ซ้ำต้องไม่ถูกนับเป็นพื้นที่ที่จะได้คืน')
})
