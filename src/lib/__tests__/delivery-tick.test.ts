// v1.162 — auto-tick ชีท footage log: pin การจับคู่แถว↔booking และกติกา
// "ไม่ทับของเดิม" (ชีทเป็นของปุ๊ก — ระบบเติมได้อย่างเดียว ห้ามแก้/ลบ)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchDeliveredRows, fmtTick, deliveryTickSheetId } from '../delivery-tick'

// แถวชีทตามโครงจริง 15 คอลัมน์: A=Folder ID … H=Production ID … O=Episode IDs
function row(folderId: string, productionId = '', tick?: string): string[] {
  const r = [folderId, 'folder name', 'url', 'TSS', 'show', '2026-05-01', 'pat', productionId,
    'c', 'u', '10', '5.2', 'someone', '2026-05-21', 'EP-1']
  if (tick !== undefined) r[15] = tick
  return r
}
const D = (code: string, boxId: string | null = null) =>
  ({ code, boxId, tick: `✅ tick-${code}` })

test('จับคู่ด้วย Production ID (คอลัมน์ H) — case-insensitive + rowIndex เริ่มที่ 2', () => {
  const out = matchDeliveredRows(
    [row('f1', 'agn-260708-01'), row('f2', 'TSS-260101-01'), row('f3', '')],
    [D('AGN-260708-01')],
  )
  assert.deepEqual(out, [{ rowIndex: 2, value: '✅ tick-AGN-260708-01', code: 'AGN-260708-01' }])
})

test('จับคู่ด้วย Folder ID ↔ box id (id-first) เมื่อไม่มี Production ID ในแถว', () => {
  const out = matchDeliveredRows(
    [row('box-abc', ''), row('box-xyz', '')],
    [D('LIFE-260201-01', 'box-xyz')],
  )
  assert.deepEqual(out, [{ rowIndex: 3, value: '✅ tick-LIFE-260201-01', code: 'LIFE-260201-01' }])
})

test('แถวที่มีติ๊กอยู่แล้ว (คนติ๊กมือ/รอบก่อน) ต้องไม่ถูกทับ', () => {
  const out = matchDeliveredRows(
    [row('f1', 'AGN-260708-01', '✅ เดิม'), row('f2', 'AGN-260708-01')],
    [D('AGN-260708-01')],
  )
  assert.deepEqual(out.map(m => m.rowIndex), [3])
})

test('แถวยุคเก่าไม่มีทั้ง Production ID และ box id ที่รู้จัก → ไม่ถูกแตะเลย', () => {
  const out = matchDeliveredRows(
    [row('old-folder-1'), row('old-folder-2')],
    [D('AGN-260708-01', 'box-abc')],
  )
  assert.deepEqual(out, [])
})

test('booking ไม่มี boxId (null) ต้องไม่ไปจับแถวที่ Folder ID ว่าง', () => {
  const out = matchDeliveredRows([row('', '')], [D('X-01', null)])
  assert.deepEqual(out, [])
})

test('fmtTick: วันเวลา th-TH gregory (กัน พ.ศ. หลุดเข้าชีท — บทเรียน v1.134) + คนส่ง', () => {
  const t = fmtTick(new Date('2026-08-04T05:30:00Z'), 'crew@thestandard.co')
  assert.match(t, /^✅ /)
  assert.match(t, /2026/)          // ค.ศ. ไม่ใช่ 2569
  assert.match(t, /12:30/)         // UTC+7
  assert.match(t, /crew@thestandard\.co$/)
  assert.doesNotMatch(t, /2569/)
})

test('sheet id: default = ชีทปุ๊ก, override ได้ด้วย env', () => {
  const saved = process.env.DELIVERY_TICK_SHEET_ID
  delete process.env.DELIVERY_TICK_SHEET_ID
  assert.equal(deliveryTickSheetId(), '1KMmbPjbRnd6Deb-ct253YMmoINuLgTDnS4Id2lPA5VI')
  process.env.DELIVERY_TICK_SHEET_ID = 'other-sheet'
  assert.equal(deliveryTickSheetId(), 'other-sheet')
  if (saved === undefined) delete process.env.DELIVERY_TICK_SHEET_ID
  else process.env.DELIVERY_TICK_SHEET_ID = saved
})
