import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pendingOriginals, missingSidecars, sonyClipPart, compareMediaPool, isQuarantined } from '../footage-completeness'

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

test('ผู้ตรวจ 1: ต้นฉบับชื่อแบบอื่นที่ครบ ไม่ค้าง · ไฟล์ export ลงท้าย S03 ที่ไม่อยู่ในโฟลเดอร์ Sub ไม่ใช่ proxy', () => {
  assert.deepEqual(pendingOriginals([
    { name: 'CAMA0001.MP4', folderPath: ['EP.1', 'CAM-A', 'PRIVATE', 'M4ROOT', 'CLIP'] },
    { name: 'CAMA0001S03.MP4', folderPath: ['EP.1', 'CAM-A', 'PRIVATE', 'M4ROOT', 'SUB'] },
    { name: 'CAMA0001M01.XML', folderPath: ['EP.1', 'CAM-A', 'PRIVATE', 'M4ROOT', 'CLIP'] },
    { name: 'Teaser_EPS03.mp4', folderPath: ['EXPORT'] },
  ]), [])
})

test('ผู้ตรวจ 2: ต้นฉบับ FX6 ที่ถูกวางคนละ path กับ Sub (เช่นกู้มาวางที่ CAM-B) ยังนับว่าครบ', () => {
  assert.deepEqual(pendingOriginals([
    xd('EP.1', 'CAM-B', 'Sub', 'B022C001_2609297HS03.MP4', 'B022'),
    xd('EP.1', 'CAM-B', 'Clip', 'B022C001_2609297HM01.XML', 'B022'),
    { name: 'B022C001_2609297H.MXF', folderPath: ['EP.1', 'CAM-B', 'recovered'] },
  ]), [])
})

test('ผู้ตรวจ 4: M4ROOT C0001 สองวันในกลุ่มเดียวกัน — ต้นฉบับวันแรกไม่ทำให้ Sub วันที่สองดูครบ', () => {
  const m = (kind: 'CLIP' | 'SUB', name: string) => ({ name, folderPath: ['EP01', 'CAM-A', 'PRIVATE', 'M4ROOT', kind] })
  assert.deepEqual(pendingOriginals([m('CLIP', 'C0001.MP4'), m('SUB', 'C0001S03.MP4'), m('SUB', 'C0001S03.MP4')]), ['C0001'])
  assert.deepEqual(pendingOriginals([m('CLIP', 'C0001.MP4'), m('CLIP', 'C0001.MP4'), m('SUB', 'C0001S03.MP4'), m('SUB', 'C0001S03.MP4')]), [])
})

test('M4ROOT: C0001 ของกล้อง A ครบ ไม่ได้ทำให้ C0001 ของกล้อง B (ขาดต้นฉบับ) ดูครบไปด้วย', () => {
  const m4 = (cam: string, kind: 'CLIP' | 'SUB', name: string) => ({ name, folderPath: ['EP.1', cam, 'PRIVATE', 'M4ROOT', kind] })
  assert.deepEqual(pendingOriginals([
    m4('CAM-A', 'CLIP', 'C0001.MP4'), m4('CAM-A', 'SUB', 'C0001S03.MP4'),
    m4('CAM-B', 'SUB', 'C0001S03.MP4'),
  ]), ['C0001'])
})

test('การ์ดที่ถูกคัดลอกสองรอบ (Card 2 + Card 2 (คอมดับ)) ได้ Sub/XML สองชุดต่อ MXF เดียว — ไม่ค้าง (เคสจริง 260915-02)', () => {
  assert.deepEqual(pendingOriginals([
    xd('EP.1', 'CAM-C', 'Sub', 'C009C001_260915M6S03.MP4', 'Card 2 (คอมดับ)'),
    xd('EP.1', 'CAM-C', 'Clip', 'C009C001_260915M6M01.XML', 'Card 2 (คอมดับ)'),
    xd('EP.1', 'CAM-C', 'Clip', 'C009C001_260915M6.MXF', 'Card 2 (คอมดับ)'),
    xd('EP.1', 'CAM-C', 'Sub', 'C009C001_260915M6S03.MP4', 'Card 2'),
    xd('EP.1', 'CAM-C', 'Clip', 'C009C001_260915M6M01.XML', 'Card 2'),
  ]), [])
})

// ── v1.253 — ตรวจรายวัน ──────────────────────────────────────────────────────

test('sonyClipPart: รู้จักต้นฉบับ/Sub/XML ของชื่อกล้อง Sony · ไฟล์ export และกล้องอื่นไม่ใช่คลิป', () => {
  assert.deepEqual(sonyClipPart('B022C001_2609297H.MXF'), { clip: 'B022C001_2609297H', part: 'orig' })
  assert.deepEqual(sonyClipPart('B022C001_2609297HS03.MP4'), { clip: 'B022C001_2609297H', part: 'sub' })
  assert.deepEqual(sonyClipPart('C0001M01.XML'), { clip: 'C0001', part: 'xml' })
  for (const n of ['Teaser_EPS03.mp4', 'Music_Final.mp4', 'IMG_0001.MOV', 'A001_C002_0101AB_CANON.MXF', 'CAMA0001.MP4', 'ZOOM0001.WAV']) {
    assert.equal(sonyClipPart(n), null, n)
  }
})

test('missingSidecars: ต้นฉบับ FX6 ไม่มี M01.XML → ขาด (เคส 260924-01: XML 8 ไฟล์ค้างในถังขยะ)', () => {
  assert.deepEqual(missingSidecars([
    xd('EP.2', 'CAM-B', 'Clip', 'B010C001_260924AA.MXF'),
    xd('EP.2', 'CAM-B', 'Clip', 'B010C002_260924BB.MXF'),
    xd('EP.2', 'CAM-B', 'Clip', 'B010C002_260924BBM01.XML'),
  ]), [{ clip: 'B010C001_260924AA', group: 'EP.2/CAM-B', key: 'B010C001_260924AA', missing: ['M01.XML'] }])
})

test('missingSidecars: Sub ไม่บังคับ — คลิป 100/120p และ S&Q ไม่มี proxy แม้การ์ดอัด proxy (Sony ทำแบบนี้เอง)', () => {
  const m4 = (card: string, kind: 'CLIP' | 'SUB', name: string) => ({ name, folderPath: ['EP01', 'CAM-A', card, 'PRIVATE', 'M4ROOT', kind] })
  assert.deepEqual(missingSidecars([
    m4('Card 1', 'CLIP', 'C0001.MP4'), m4('Card 1', 'CLIP', 'C0001M01.XML'), m4('Card 1', 'SUB', 'C0001S03.MP4'),
    m4('Card 1', 'CLIP', 'C0002.MP4'), m4('Card 1', 'CLIP', 'C0002M01.XML'),
  ]), [])
})

test('missingSidecars: C0001 ของสองการ์ด — XML ของการ์ด 1 ไม่ทำให้การ์ด 2 ดูครบ', () => {
  const m4 = (card: string, name: string) => ({ name, folderPath: ['EP01', 'CAM-A', card, 'PRIVATE', 'M4ROOT', 'CLIP'] })
  assert.deepEqual(missingSidecars([m4('Card 1', 'C0001.MP4'), m4('Card 1', 'C0001M01.XML'), m4('Card 2', 'C0001.MP4')]),
    [{ clip: 'C0001', group: 'EP01/CAM-A/CARD 2', key: 'EP01/CAM-A/CARD 2|C0001', missing: ['M01.XML'] }])
})

test('missingSidecars: กล้องอื่น / MOV ในโฟลเดอร์ชื่อ Clip / การ์ดคัดลอกซ้ำ / โฟลเดอร์ _แยกไว้ ไม่ติด', () => {
  assert.deepEqual(missingSidecars([
    { name: 'IMG_0001.MOV', folderPath: ['EP01', 'CAM-A', 'Clip'] },
    { name: 'A001_C002_0101AB_CANON.MXF', folderPath: ['EP01', 'CAM-B', 'CONTENTS', 'CLIPS001'] },
    { name: '0001AB.MXF', folderPath: ['EP01', 'CAM-C', 'CONTENTS', 'VIDEO'] },
    xd('EP.1', 'CAM-C', 'Clip', 'C009C001_260915M6.MXF', 'Card 2 (คอมดับ)'),
    xd('EP.1', 'CAM-C', 'Clip', 'C009C001_260915M6M01.XML', 'Card 2'),
    { name: 'A004R001_260911TJ.MXF', folderPath: ['_แยกไว้ · ไฟล์อัปไม่จบ (ย้ายออก 2026-09-30)'] },
  ]), [])
  assert.equal(isQuarantined({ name: 'x', folderPath: ['_แยกไว้ · ไฟล์อัปไม่จบ'] }), true)
  assert.equal(isQuarantined({ name: 'x', folderPath: ['EP.1', '_แยกไว้'] }), false, 'นับเฉพาะที่ root ของกล่อง')
})

// compareMediaPool — เคสเดียวกับ test_mediapool_check.py
const mp = (name: string, bookingCode: string | null = 'AGN-260915-02', kind: 'video' | 'audio' = 'video') => ({ name, kind, bookingCode })

test('compareMediaPool: ครบ / ขาดต้นฉบับ / หายทั้งชุด / WAV · เพลงและกราฟิกไม่ตรวจ', () => {
  const box = [
    xd('EP.1', 'CAM-A', 'Clip', 'B009C002_26091509.MXF'), xd('EP.1', 'CAM-A', 'Sub', 'B009C002_26091509S03.MP4'), xd('EP.1', 'CAM-A', 'Clip', 'B009C002_26091509M01.XML'),
    xd('EP.1', 'CAM-B', 'Sub', 'B022C001_2609297HS03.MP4'), xd('EP.1', 'CAM-B', 'Clip', 'B022C001_2609297HM01.XML'),
    { name: 'ZOOM0001.WAV', folderPath: ['EP.1', 'AUDIO'] },
  ]
  const r = compareMediaPool([
    mp('B009C002_26091509S03.MP4'), mp('B022C001_2609297HS03.MP4'), mp('A011C003_2609245QS03.MP4'),
    mp('ZOOM0001.WAV', 'AGN-260915-02', 'audio'), mp('ZOOM0002.WAV', 'AGN-260915-02', 'audio'),
    mp('Music_Final.mp4'), mp('Title.png'),
  ], 'AGN-260915-02', box)
  assert.equal(r.inPool, 5)
  assert.deepEqual(r.missing, [
    { name: 'A011C003_2609245Q', lacks: ['ต้นฉบับ', 'Sub', 'M01.XML'] },
    { name: 'B022C001_2609297H', lacks: ['ต้นฉบับ'] },
    { name: 'ZOOM0002.WAV', lacks: ['WAV'] },
  ])
  assert.deepEqual(r.notInPool, [])
})

test('compareMediaPool: REC-001 ของอีกคิวไม่นับว่าตรง · ทิศกลับข้าม _แยกไว้ · FX6 ที่อยู่ bin อื่นยังนับว่าอยู่ใน Media Pool', () => {
  const box = [
    { name: 'REC-001.WAV', folderPath: ['AUDIO'] },
    xd('EP.1', 'CAM-A', 'Clip', 'A001C001_260911QQ.MXF'),
    xd('EP.1', 'CAM-A', 'Clip', 'A001C002_260911RR.MXF'),
    { name: 'Z999C001_260911AA.MXF', folderPath: ['_แยกไว้ · ไฟล์อัปไม่จบ'] },
  ]
  const r = compareMediaPool([mp('REC-001.WAV', 'AGN-260907-01', 'audio'), mp('A001C001_260911QQS03.MP4', 'AGN-260912-01')], 'AGN-260911-02', box)
  assert.equal(r.inPool, 0, 'ไม่มีอะไรใน bin ของคิวนี้')
  assert.deepEqual(r.missing, [])
  assert.deepEqual(r.notInPool, ['A001C002_260911RR', 'REC-001.WAV'])
})

test('compareMediaPool: bin ที่ไม่ได้ตั้งชื่อตามคิว — WAV/C0001 นับว่าอยู่ใน Media Pool แต่ไม่ถูกหาว่าขาด', () => {
  const r = compareMediaPool([mp('REC-001.WAV', null, 'audio'), mp('C0001.MP4', null)], 'AGN-260911-02', [
    { name: 'REC-001.WAV', folderPath: ['AUDIO'] },
  ])
  assert.deepEqual(r, { inPool: 0, missing: [], notInPool: [] })
})
