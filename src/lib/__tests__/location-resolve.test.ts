/**
 * v1.195 — ทุกเคสในไฟล์นี้เป็น **ข้อความจริงบนพรอด** (ตรวจ 2026-08-25) ไม่ใช่ตัวอย่างสมมติ
 * เพราะปลายทางของ resolver คือการไปจองห้องจริงในระบบกลาง — แมปผิด = ยึดห้องคนอื่น
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLocationId, isInHouseRoom, isPlaceholderLocation } from '../location-resolve'

test('ชื่อเต็มที่ BookingWizard เขียน → id', () => {
  assert.equal(resolveLocationId('Studio 1 (TSD)'), 'tsd-studio-1')          // 65 ใบ
  assert.equal(resolveLocationId('Studio 2 (TSD, 1/F)'), 'tsd-studio-2')     // 56 ใบ
  assert.equal(resolveLocationId('A · War Room (TSD, 4/F)'), 'tsd-a-war-4f') // 27 ใบ
  assert.equal(resolveLocationId('A · Pod 1 (TSD, 5/F)'), 'tsd-a-pod1-5f')   // 20 ใบ
  assert.equal(resolveLocationId('B · 1 (TSD, 5/F)'), 'tsd-b-1-5f')          // 6 ใบ
  assert.equal(resolveLocationId('A · Hall (TSD, 1/F)'), 'tsd-a-hall-1f')
  assert.equal(resolveLocationId('A · Meeting Room 1 (TSD, 5/F)'), 'tsd-a-mr1-5f')
  assert.equal(resolveLocationId('A · Lounge (TSD, 2/F)'), 'tsd-a-lounge-2f')
})

test('ข้อความไทยจาก RoutinePlanner → id (ค่าที่เยอะที่สุดในระบบ)', () => {
  assert.equal(resolveLocationId('สตูดิโอ 1'), 'tsd-studio-1')   // 129 ใบ — มากกว่าชื่ออังกฤษ
  assert.equal(resolveLocationId('สตูดิโอ 2'), 'tsd-studio-2')
  assert.equal(resolveLocationId('สตู 1'), 'tsd-studio-1')
  assert.equal(resolveLocationId('สตู2'), 'tsd-studio-2')
})

test('ชื่อสั้น / คนละตัวพิมพ์ / มีชั้นต่อท้าย', () => {
  assert.equal(resolveLocationId('Studio 1'), 'tsd-studio-1')
  assert.equal(resolveLocationId('Studio 2'), 'tsd-studio-2')
  assert.equal(resolveLocationId('War Room'), 'tsd-a-war-4f')
  assert.equal(resolveLocationId('war room ชั้น 4'), 'tsd-a-war-4f')
  assert.equal(resolveLocationId('War Room ชั้น 4'), 'tsd-a-war-4f')
  assert.equal(resolveLocationId('ห้อง pod 1'), 'tsd-a-pod1-5f')
})

test('รูปแบบ `ชื่อเต็ม — ข้อความเพิ่ม` ของ BookingWizard → ตัดส่วนขยายก่อน', () => {
  assert.equal(resolveLocationId('On Location — ออฟฟิศลูกค้า (รอลิ้งค์โลเคชั่น)'), 'external-on-location')
  assert.equal(resolveLocationId('Studio 1 (TSD) — เซ็ตไฟพิเศษ'), 'tsd-studio-1')
})

// ⚠️ เคสอันตรายที่สุด: RCA เป็นสตูดิโอนอกตึก ไม่ใช่ Studio 1 ของ TSD
test('"Studio 1 RCA" ต้องไม่แมปเป็น Studio 1 ในตึก', () => {
  assert.equal(resolveLocationId('Studio 1 RCA'), null)
})

test('สถานที่นอกตึก / มีลิงก์ → null', () => {
  assert.equal(resolveLocationId('https://maps.app.goo.gl/MPsyYfp2wWDXb99z7'), null)
  assert.equal(resolveLocationId('บ้านอยู่ดี แบริ่ง สตูดิโอ by ชอบใจ https://maps.app.goo.gl/LxaxVfB5tZicT8WbA'), null)
  assert.equal(resolveLocationId('ศูนย์การประชุมแห่งชาติสิริกิติ์ (QSNCC)'), null)
  assert.equal(resolveLocationId('Trout Lake, Washington State, U.S.A.'), null)
  assert.equal(resolveLocationId('เมืองมุมไบ ประเทศอินเดีย'), null)
})

test('ยังไม่รู้สถานที่ → null (ไม่ใช่ห้อง)', () => {
  for (const v of ['TBC', 'tbc', 'อัพเดตอีกครั้ง', 'รอรายละเอียดอีกครั้ง', 'อัพเดตโลเคชั่นอีกครั้ง', '', null, undefined]) {
    assert.equal(resolveLocationId(v as any), null, `ค่า ${JSON.stringify(v)} ไม่ควรแมปเป็นห้อง`)
    assert.equal(isPlaceholderLocation(v as any), true)
  }
  // "จังหวัดภูเก็ต (TBC)" มีสถานที่จริงอยู่ ไม่ใช่ placeholder ล้วน แต่ก็ไม่ใช่ห้องในตึก
  assert.equal(resolveLocationId('จังหวัดภูเก็ต (TBC)'), null)
})

test('isInHouseRoom แยกห้องในตึกออกจากนอกตึก', () => {
  assert.equal(isInHouseRoom('tsd-studio-1'), true)
  assert.equal(isInHouseRoom('tsd-a-lounge-2f'), true)
  assert.equal(isInHouseRoom('external-on-location'), false)
  assert.equal(isInHouseRoom('external-remote'), false)
  assert.equal(isInHouseRoom(null), false)
  assert.equal(isInHouseRoom('ไม่มีห้องนี้'), false)
})
