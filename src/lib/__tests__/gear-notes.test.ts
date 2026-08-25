/**
 * v1.197 — สรุประดับใบจองเป็น "ค่าที่คำนวณมา" จากโน้ตราย Production ID
 * เทสพวกนี้ล็อกไว้ว่าใบที่มี ID เดียว (84% ของงานจริง) หน้าตาต้องไม่เปลี่ยนเลย
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeGearNotes, buildGearExportText, formatProductionIds } from '../gear-notes'

test('ใบที่มี Production ID เดียว → ข้อความเดิมเป๊ะ ไม่มีคำนำหน้า', () => {
  const eps = [{ episodeId: 'TSS-TSS-260907-01', equipmentNote: 'FX3 x2 · ขาตั้ง' }]
  assert.equal(summarizeGearNotes(eps, 'equipmentNote'), 'FX3 x2 · ขาตั้ง')
})

test('ไม่มีใครกรอก → null (เหมือนเดิม ไม่ใช่ข้อความว่าง)', () => {
  assert.equal(summarizeGearNotes([{ episodeId: 'A' }, { episodeId: 'B' }], 'equipmentNote'), null)
  assert.equal(summarizeGearNotes([{ episodeId: 'A', equipmentNote: '   ' }], 'equipmentNote'), null)
  assert.equal(summarizeGearNotes([], 'equipmentNote'), null)
})

test('ทุก ID ข้อความเหมือนกัน → ไม่เขียนซ้ำ (กันปฏิทินรก)', () => {
  const eps = [
    { episodeId: 'A-01', equipmentNote: 'FX3 x2' },
    { episodeId: 'A-02', equipmentNote: 'FX3 x2' },
  ]
  assert.equal(summarizeGearNotes(eps, 'equipmentNote'), 'FX3 x2')
})

test('ต่างกัน → บรรทัดละ ID', () => {
  const eps = [
    { episodeId: 'A-01', equipmentNote: 'FX3 x2' },
    { episodeId: 'A-02', equipmentNote: 'FX30 + ไฟ' },
  ]
  assert.equal(summarizeGearNotes(eps, 'equipmentNote'), 'A-01: FX3 x2\nA-02: FX30 + ไฟ')
})

test('กรอกแค่ ID เดียวจากหลาย ID → ไม่ต้องมีคำนำหน้าเช่นกัน', () => {
  const eps = [
    { episodeId: 'A-01', equipmentNote: 'FX3 x2' },
    { episodeId: 'A-02' },
  ]
  assert.equal(summarizeGearNotes(eps, 'equipmentNote'), 'FX3 x2')
})

test('เช่า กับ อุปกรณ์ แยกกันจริง', () => {
  const eps = [
    { episodeId: 'A-01', equipmentNote: 'FX3', rentalGearNote: 'เลนส์ 24-70' },
    { episodeId: 'A-02', equipmentNote: 'FX3' },
  ]
  assert.equal(summarizeGearNotes(eps, 'equipmentNote'), 'FX3')
  assert.equal(summarizeGearNotes(eps, 'rentalGearNote'), 'เลนส์ 24-70')
})

test('ข้อความส่งบอท — หนึ่งบล็อกต่อหนึ่งกอง', () => {
  const text = buildGearExportText({
    heading: '📅 อุปกรณ์ · 25–31 ส.ค.',
    rows: [
      { productionIds: ['TSS-TSS-260907-01'], title: 'The Secret Sauce', time: '09:00 → 18:00',
        crew: ['ซัง', 'ไนซ์'], equipment: 'FX3 x2\nขาตั้ง', rental: null },
    ],
  })
  assert.ok(text.includes('━━ TSS-TSS-260907-01  🕐 09:00 → 18:00  The Secret Sauce'))
  // ขึ้นบรรทัดใหม่ในช่องกรอก → " / " เพื่อให้วางในแชตแล้วไม่แตก
  assert.ok(text.includes('อุปกรณ์: FX3 x2 / ขาตั้ง'))
  assert.ok(text.includes('ทีม: ซัง, ไนซ์'))
  // operator: "ตอนส่งให้ช่างภาพเอาอันนี้ออก" — ของเช่าไม่ใช่เรื่องของช่างภาพ
  assert.ok(!text.includes('เช่า'), 'ข้อความส่งบอทต้องไม่มีช่องเช่า')
})

test('filledOnly ตัดกองที่ยังไม่กรอกออก', () => {
  const rows = [
    { productionIds: ['A-01'], equipment: 'FX3' },
    { productionIds: ['A-02'] },
  ]
  const all = buildGearExportText({ heading: 'h', rows })
  const only = buildGearExportText({ heading: 'h', rows, filledOnly: true })
  assert.ok(all.includes('A-02'))
  assert.ok(!only.includes('A-02'))
  assert.ok(only.includes('A-01'))
})

test('ไม่มีอะไรให้ส่ง → บอกว่าไม่มี ไม่ใช่ข้อความเปล่า', () => {
  assert.ok(buildGearExportText({ heading: 'h', rows: [] }).includes('(ไม่มีงานในช่วงนี้)'))
  assert.ok(buildGearExportText({ heading: 'h', rows: [{ productionIds: ['A'] }], filledOnly: true })
    .includes('(ยังไม่มีกองที่กรอกอุปกรณ์)'))
})

// v1.198 — กองเดียว 2 ID เบิกชุดเดียว: ต้องโชว์ ID คู่กัน ไม่แตกเป็นสองบล็อก
test('กองเดียวหลาย Production ID → บล็อกเดียว โชว์ ID ทุกตัว', () => {
  const text = buildGearExportText({
    heading: 'h',
    rows: [{
      productionIds: ['PP-26-034-L01', 'PP-26-034-L02', 'PP-26-034-L03', 'PP-26-034-L04'],
      title: 'AGN · EP.1–4', time: '31 Aug 09:00 → 13:00',
      crew: ['ภูริเดช'], equipment: 'FX3 x2', rental: null,
    }],
  })
  assert.ok(text.includes('PP-26-034-L01 + PP-26-034-L02 + PP-26-034-L03 + PP-26-034-L04'))
  // บล็อกเดียว = มีคำว่า "อุปกรณ์:" ครั้งเดียว
  assert.equal(text.split('อุปกรณ์:').length - 1, 1)
})

test('formatProductionIds — เต็มทุกตัว ไม่ย่อ ไม่ซ้ำ ตัดค่าว่างทิ้ง', () => {
  assert.equal(formatProductionIds(['A-01']), 'A-01')
  assert.equal(formatProductionIds(['A-01', 'A-02']), 'A-01 + A-02')
  assert.equal(formatProductionIds(['A-01', 'A-01']), 'A-01')
  assert.equal(formatProductionIds([' A-01 ', '', 'A-02']), 'A-01 + A-02')
  assert.equal(formatProductionIds([]), '')
})

// เช่าอยู่ในข้อมูลได้ แต่ต้องไม่หลุดไปในข้อความที่ส่งช่างภาพ
test('กรอกแต่เช่า ไม่กรอกอุปกรณ์ → filledOnly ต้องไม่หยิบมา', () => {
  const rows = [{ productionIds: ['A-01'], rental: 'เลนส์ 24-70' }]
  const only = buildGearExportText({ heading: 'h', rows, filledOnly: true })
  assert.ok(only.includes('(ยังไม่มีกองที่กรอกอุปกรณ์)'))
  const all = buildGearExportText({ heading: 'h', rows })
  assert.ok(all.includes('อุปกรณ์: —'))
  assert.ok(!all.includes('เลนส์ 24-70'), 'ของเช่าต้องไม่หลุดไปในข้อความ')
})
