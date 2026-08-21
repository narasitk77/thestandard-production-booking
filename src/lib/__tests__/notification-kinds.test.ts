// v1.184 — กระดิ่งแจ้งเตือน: ลำดับความสำคัญ, การนับ "ยังไม่ได้ดู", และ allowlist ของเจ้าของงาน

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sortItems, countUnread, isOwnerVisibleAction, describeUpdate, notificationScopes,
  KIND_PRIORITY, OWNER_OUTCOME_ACTIONS, type NotifItem,
} from '../notification-kinds'

const item = (over: Partial<NotifItem>): NotifItem => ({
  id: 'x', kind: 'booking_outcome', at: '2026-08-21T00:00:00.000Z',
  title: 't', href: '/', ...over,
})

test('ลำดับที่ operator สั่ง: ยกเลิก → แก้ไข → error → งานของฉัน', () => {
  assert.ok(KIND_PRIORITY.cancel_request < KIND_PRIORITY.edit_request)
  assert.ok(KIND_PRIORITY.edit_request < KIND_PRIORITY.system_error)
  assert.ok(KIND_PRIORITY.system_error < KIND_PRIORITY.booking_outcome)
})

test('เรียงกลุ่มก่อน แล้วใหม่สุดก่อนในกลุ่ม', () => {
  const out = sortItems([
    item({ id: 'own-new', kind: 'booking_outcome', at: '2026-08-21T10:00:00.000Z' }),
    item({ id: 'cancel-old', kind: 'cancel_request', at: '2026-08-01T00:00:00.000Z' }),
    item({ id: 'cancel-new', kind: 'cancel_request', at: '2026-08-20T00:00:00.000Z' }),
    item({ id: 'edit', kind: 'edit_request', at: '2026-08-19T00:00:00.000Z' }),
  ])
  assert.deepEqual(out.map(i => i.id), ['cancel-new', 'cancel-old', 'edit', 'own-new'])
})

test('รายการที่ไม่มีเวลาเกิด (worker ไม่เคย tick) ไปท้ายกลุ่มของมัน', () => {
  const out = sortItems([
    item({ id: 'never', kind: 'system_error', at: null }),
    item({ id: 'stale', kind: 'system_error', at: '2026-08-20T00:00:00.000Z' }),
  ])
  assert.deepEqual(out.map(i => i.id), ['stale', 'never'])
})

test('นับยังไม่ได้ดู = เกิดหลังเปิดกระดิ่งครั้งล่าสุด', () => {
  const items = [
    item({ id: 'a', at: '2026-08-21T10:00:00.000Z' }),
    item({ id: 'b', at: '2026-08-21T08:00:00.000Z' }),
    item({ id: 'c', at: '2026-08-19T00:00:00.000Z' }),
  ]
  assert.equal(countUnread(items, '2026-08-21T09:00:00.000Z'), 1)
  assert.equal(countUnread(items, null), 3, 'ไม่เคยเปิด = ใหม่ทั้งหมด')
  assert.equal(countUnread(items, '2026-08-22T00:00:00.000Z'), 0)
})

test('สภาพค้างที่ไม่มีเวลาเกิด ต้องไม่ทำให้ตัวเลขติดค้างตลอดไป', () => {
  // ถ้านับ at=null เป็น unread กระดิ่งจะไม่มีวันเป็น 0 แล้วคนจะเลิกมอง
  // (โรคเดียวกับ alert ที่เขียวอยู่ 5 สัปดาห์แล้วไม่มีใครอ่าน)
  const items = [item({ id: 'never', kind: 'system_error', at: null })]
  assert.equal(countUnread(items, '2026-08-21T00:00:00.000Z'), 0)
  assert.equal(countUnread(items, null), 0)
})

test('allowlist ของเจ้าของงานเป็น fail-closed', () => {
  for (const ok of ['approve', 'reject', 'booking.update', 'booking.status_change', 'booking.delivered']) {
    assert.equal(isOwnerVisibleAction(ok), true, ok)
  }
  // ของที่ต้องไม่หลุด: peer review (ตั้งใจไม่ระบุตัวตน), feedback ของคนอื่น, งานเบื้องหลัง
  for (const bad of [
    'review.submitted', 'review.invites_sent', 'feedback.reply', 'drive.folder_integrity',
    'calendar.approve_failed', 'booking.cancel_requested', 'audit.auto_email_sent', '', null, undefined,
  ]) {
    assert.equal(isOwnerVisibleAction(bad as any), false, String(bad))
  }
})

test('allowlist ไม่มี action ของ peer review ปนอยู่เลย', () => {
  assert.ok(!OWNER_OUTCOME_ACTIONS.some(a => a.startsWith('review.')))
})

test('booking.update บอกชื่อฟิลด์ที่แก้ ไม่บอกค่า', () => {
  const d = describeUpdate({ callTime: { from: '09:00', to: '10:00' }, locationName: { from: 'A', to: 'B' } })
  assert.equal(d.detail, 'แก้: เวลาเริ่ม, สถานที่')
  assert.ok(!/09:00|10:00/.test(d.detail || ''), 'ต้องไม่มีค่าในข้อความ')
})

test('booking.update ที่มีฟิลด์เยอะ ตัดเหลือ 3 + นับที่เหลือ', () => {
  const d = describeUpdate({ callTime: 1, locationName: 1, shootType: 1, notes: 1, micCount: 1 })
  assert.equal(d.detail, 'แก้: เวลาเริ่ม, สถานที่, รูปแบบถ่าย +2')
})

test('คำขอยกเลิกถูกปฏิเสธ อ่านเป็นภาษาคน ไม่ใช่ "แก้: cancelRequestedAt"', () => {
  assert.equal(describeUpdate({ cancelRequestedAt: { from: '2026-08-01', to: null } }).title,
    'คำขอยกเลิกถูกปฏิเสธ — เก็บงานไว้')
  assert.equal(describeUpdate({ cancelRequestedAt: null }).title,
    'คำขอยกเลิกถูกปฏิเสธ — เก็บงานไว้')
})

test('changes ที่พิการต้องไม่ทำให้พัง', () => {
  for (const bad of [null, undefined, 'string', 42, [], {}]) {
    assert.doesNotThrow(() => describeUpdate(bad as any), String(bad))
  }
  assert.equal(describeUpdate({}).detail, null)
  assert.equal(describeUpdate({ someUnknownField: 1 }).detail, null, 'ฟิลด์ที่ไม่มีชื่อไทย = ไม่โชว์ชื่อ raw')
})

test('scope: คิวยกเลิก/คิวแก้ไข = ทุก role ที่มี console', () => {
  for (const r of ['ADMIN', 'SUPPORT', 'MANAGER', 'COORDINATOR']) {
    assert.equal(notificationScopes(r).console, true, r)
  }
  assert.equal(notificationScopes('USER').console, false)
  assert.equal(notificationScopes(null).console, false)
  assert.equal(notificationScopes(undefined).console, false)
})

test('scope: error ระบบเป็นเรื่อง infra — เฉพาะ tier admin', () => {
  for (const r of ['ADMIN', 'SUPPORT', 'MANAGER']) {
    assert.equal(notificationScopes(r).systemErrors, true, r)
  }
  // coordinator/sound lead ทำคิวงาน ไม่ได้ดูแล container
  assert.equal(notificationScopes('COORDINATOR').systemErrors, false)
  assert.equal(notificationScopes('COORDINATOR', 'Senior Sound Engineer').systemErrors, false)
  assert.equal(notificationScopes('USER', 'Producer').systemErrors, false)
})

test('scope: role พิการ/ปลอม ต้องได้สิทธิ์แคบสุด ไม่ใช่กว้างสุด', () => {
  for (const bad of ['', 'admin', 'ADMINISTRATOR', 'root', 'SUPERUSER', 0, {}, []]) {
    const s = notificationScopes(bad as any)
    assert.equal(s.console, false, String(bad))
    assert.equal(s.systemErrors, false, String(bad))
  }
})
