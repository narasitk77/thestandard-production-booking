/**
 * v1.289 — "Other ในออฟฟิศ" (Studio / Event ในออฟฟิศ แต่ไม่ใช่ห้องในระบบจองห้องประชุม)
 * ต้องไม่ถูกเอาไปจองห้อง ไม่ขึ้นป้าย "ต้องจองห้องเอง" และต้องบังคับให้พิมพ์ระบุพื้นที่
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OFFICE_OTHER_ID, findLocation, locationNeedsManualText } from '../locations'
import { resolveLocationId, isInHouseRoom } from '../location-resolve'
import { roomTargetForBooking, roomIdForLocation } from '../room-booking'
import { checkRoomAvailability } from '../room-availability'
import { roomBadge } from '../room-badge'

test('Other ในออฟฟิศ: ไม่ใช่ห้อง ไม่จอง ไม่ขึ้นป้าย', async () => {
  const loc = findLocation(OFFICE_OTHER_ID)
  assert.ok(loc, 'office-other ต้องมีใน LOCATIONS')
  assert.equal(locationNeedsManualText(OFFICE_OTHER_ID), true)
  assert.equal(isInHouseRoom(OFFICE_OTHER_ID), false)
  assert.equal(roomIdForLocation(OFFICE_OTHER_ID), null)
  const t = roomTargetForBooking({ locationId: OFFICE_OTHER_ID, shootDate: '2026-11-20', callTime: '09:00' })
  assert.deepEqual(t, { skip: 'external' })
  // skip 'external' = ไม่ขึ้นป้าย (ต่างจาก no-room-mapping ที่ขึ้น "ต้องจองห้องเอง")
  assert.equal(roomBadge('SKIPPED', 'skip: external'), null)
  const avail = await checkRoomAvailability({ locationId: OFFICE_OTHER_ID, shootDate: '2026-11-20', callTime: '09:00' } as any)
  assert.equal(avail.state, 'not-a-room')
})

test('ข้อความที่ wizard เขียน → แปลงกลับเป็น office-other (ฟอร์มแก้ไขใช้ทางนี้)', () => {
  assert.equal(resolveLocationId(`${findLocation(OFFICE_OTHER_ID)!.fullName} — ลานจอดรถชั้น 1`), OFFICE_OTHER_ID)
})
