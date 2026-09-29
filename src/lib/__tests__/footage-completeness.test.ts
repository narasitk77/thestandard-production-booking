import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pendingOriginals } from '../footage-completeness'

// v1.251 — เคสจริง PP-26-034: Sub/XML มาก่อน ต้นฉบับ MXF ตามมา 1–2 วัน · ทิ้งโฟลเดอร์ drop ตอนต้นฉบับยังไม่มา = ไฟล์ตกถังขยะ

const xd = (ep: string, cam: string, kind: 'Clip' | 'Sub', name: string, card?: string) =>
  ({ name, folderPath: [ep, cam, ...(card ? [card] : []), 'XDROOT', kind] })

test('FX6: มี Sub + XML แต่ยังไม่มี MXF → รายงานว่าต้นฉบับยังมาไม่ครบ (เคส 29 ก.ย. B022C001)', () => {
  const files = [
    xd('PP-26-034-L01 · EP.1', 'CAM-B', 'Sub', 'B022C001_2609297HS03.MP4', 'B022'),
    xd('PP-26-034-L01 · EP.1', 'CAM-B', 'Clip', 'B022C001_2609297HM01.XML', 'B022'),
    xd('PP-26-034-L01 · EP.1', 'CAM-A', 'Sub', 'A022C001_260929AAS03.MP4'),
    xd('PP-26-034-L01 · EP.1', 'CAM-A', 'Clip', 'A022C001_260929AAM01.XML'),
    xd('PP-26-034-L01 · EP.1', 'CAM-A', 'Clip', 'A022C001_260929AA.MXF'),
  ]
  assert.deepEqual(pendingOriginals(files), ['B022C001_2609297H'])
})

test('ครบสามอย่าง / ไม่มีคลิปกล้อง / มีแต่ต้นฉบับ → ไม่มีอะไรค้าง', () => {
  assert.deepEqual(pendingOriginals([
    xd('EP.1', 'CAM-A', 'Sub', 'A009R001_2609151TS03.MP4', 'Card 1'),
    xd('EP.1', 'CAM-A', 'Clip', 'A009R001_2609151TM01.XML', 'Card 1'),
    xd('EP.1', 'CAM-A', 'Clip', 'A009R001_2609151T.MXF', 'Card 1'),
  ]), [])
  assert.deepEqual(pendingOriginals([{ name: 'take1.wav', folderPath: ['EP.1', 'AUDIO'] }, { name: '_SHOOT.txt' }]), [])
  assert.deepEqual(pendingOriginals([xd('EP.1', 'CAM-A', 'Clip', 'A001C001.MXF')]), [], 'ต้นฉบับอย่างเดียว ไม่ใช่ "ค้าง"')
  assert.deepEqual(pendingOriginals([{ name: 'Final_Export.mp4', folderPath: ['EXPORT'] }]), [], 'MP4 ที่ไม่ใช่ชื่อกล้อง ไม่ถูกนับ')
})

test('M4ROOT: C0001 ของกล้อง A ครบ ไม่ได้ทำให้ C0001 ของกล้อง B (ขาดต้นฉบับ) ดูครบไปด้วย', () => {
  const m4 = (cam: string, kind: 'CLIP' | 'SUB', name: string) => ({ name, folderPath: ['EP.1', cam, 'PRIVATE', 'M4ROOT', kind] })
  assert.deepEqual(pendingOriginals([
    m4('CAM-A', 'CLIP', 'C0001.MP4'), m4('CAM-A', 'SUB', 'C0001S03.MP4'),
    m4('CAM-B', 'SUB', 'C0001S03.MP4'),
  ]), ['C0001'])
})
