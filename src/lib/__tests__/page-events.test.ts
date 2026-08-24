// v1.190 — เก็บการเข้าหน้าแบบแคบ: allowlist + ตัด id + กันแถวเฟ้อ

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeTrackedPath, shouldRecordVisit, TRACKED_PATHS, VISIT_WINDOW_MS,
} from '../page-events'

test('เก็บเฉพาะหน้าที่อยู่ใน allowlist', () => {
  for (const p of TRACKED_PATHS) {
    assert.equal(normalizeTrackedPath(p), p, p)
  }
})

test('หน้าที่ไม่ได้อยู่ในลิสต์ = ไม่เก็บ (คืน null)', () => {
  for (const p of ['/', '/login', '/calendar', '/producer', '/feedback', '/changelog', '/manual']) {
    assert.equal(normalizeTrackedPath(p), null, p)
  }
})

test('/ot/admin ต้องไม่ถูกจับเป็น /ot (เทียบตัวยาวก่อน)', () => {
  assert.equal(normalizeTrackedPath('/ot/admin'), '/ot/admin')
  assert.equal(normalizeTrackedPath('/ot/admin/review/someone@x.co'), '/ot/admin')
  assert.equal(normalizeTrackedPath('/ot'), '/ot')
})

test('ตัด id ออก — อยากรู้ว่าเปิดหน้าอะไร ไม่ใช่เปิดงานใบไหน', () => {
  assert.equal(normalizeTrackedPath('/admin/cmt1m6y9w00206j1v8xymrofz'), '/admin')
  assert.equal(normalizeTrackedPath('/upload/abc123'), '/upload')
})

test('ไม่เก็บ query string / hash โดยเจตนา', () => {
  // query อาจมี bookingId หรือ token — ตัดตั้งแต่ต้นทาง ไม่ใช่ตอนบันทึก
  assert.equal(normalizeTrackedPath('/upload?bookingId=secret123'), '/upload')
  assert.equal(normalizeTrackedPath('/ot?month=2026-08#top'), '/ot')
})

test('trailing slash ไม่ทำให้กลายเป็นคนละหน้า', () => {
  assert.equal(normalizeTrackedPath('/ot/'), '/ot')
  assert.equal(normalizeTrackedPath('/new/'), '/new')
})

test('input พิการต้องคืน null ไม่ throw', () => {
  for (const bad of [null, undefined, '', '   ', 'ot', 'https://evil.com/ot', 42, {}, []]) {
    assert.equal(normalizeTrackedPath(bad as any), null, String(bad))
  }
})

test('กันแถวเฟ้อ: กด refresh ซ้ำใน 30 นาทีไม่บันทึกใหม่', () => {
  const now = new Date('2026-08-24T10:00:00Z')
  const ago = (ms: number) => new Date(now.getTime() - ms)
  assert.equal(shouldRecordVisit(null, now), true, 'ครั้งแรกเก็บเสมอ')
  assert.equal(shouldRecordVisit(ago(60_000), now), false, '1 นาทีที่แล้ว = ครั้งเดียวกัน')
  assert.equal(shouldRecordVisit(ago(VISIT_WINDOW_MS - 1), now), false)
  assert.equal(shouldRecordVisit(ago(VISIT_WINDOW_MS), now), true, 'ครบ 30 นาที = การเข้าครั้งใหม่')
  assert.equal(shouldRecordVisit(ago(86_400_000), now), true, 'เมื่อวาน = ครั้งใหม่แน่นอน')
})
