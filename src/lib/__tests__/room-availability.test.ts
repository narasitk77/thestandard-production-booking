/**
 * ตัวตรวจ "ห้องว่างไหม" (v1.223)
 *
 * กฎที่ไฟล์นี้ล็อกไว้ เรียงตามความเจ็บถ้าพัง:
 *
 * 1. **ไม่มีสถานะ "ว่าง"** — มีได้แค่ `no-conflict-known` การตรวจตอนกรอกฟอร์ม
 *    รับประกันอะไรไม่ได้ เพราะคนอื่นกดส่งตัดหน้าได้ระหว่างที่ยังกรอกอยู่
 * 2. **อ่านระบบกลางไม่ได้ ≠ ว่าง** — ต้องติด `externalError` ไปด้วยเสมอ
 *    เพื่อให้หน้าเว็บบอกผู้ใช้ได้ว่าตรวจได้ไม่ครบ
 * 3. **ห้ามเผยหัวข้อประชุมของแผนกอื่น** — ฟีดของ IT แถม title/email/department
 *    มาครบ ต้องตัดที่ server ไม่ใช่ซ่อนที่ client
 * 4. **ไม่นับใบของโปรบุ๊คเองสองรอบ** — ใบเดียวกันมีทั้งใน DB เราและในระบบเขา
 * 5. **เวลาที่ประกอบไม่ได้ = unknown** ไม่ใช่เงียบแล้วปล่อยผ่าน
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const findMany = mock.fn(async () => [] as any[])
mock.module('../db', { namedExports: { prisma: { booking: { findMany } } } })

let listRows: any[] | Error = []
let monthsAsked: string[] = []
mock.module('../room-booking', {
  namedExports: {
    roomIdForLocation: (id: string) => (id === 'tsd-studio-1' ? 15 : id === 'tsd-studio-2' ? 1 : null),
    listRoomBookings: async (y: number, m: number) => {
      monthsAsked.push(`${y}-${m}`)
      if (listRows instanceof Error) throw listRows
      return listRows
    },
  },
})

// ต้อง import หลัง mock.module และต้องอยู่ใน before() — top-level await
// ทำให้ esbuild แปลงไฟล์เทสไม่ผ่าน (แบบเดียวกับ video-merge-mirror.test.ts)
let checkRoomAvailability: typeof import('../room-availability').checkRoomAvailability
let __clearRoomAvailabilityCache: typeof import('../room-availability').__clearRoomAvailabilityCache
before(async () => {
  ;({ checkRoomAvailability, __clearRoomAvailabilityCache } = await import('../room-availability'))
})

const BASE = {
  locationId: 'tsd-studio-1',
  shootDate: '2026-09-17',
  callTime: '16:00',
  estimatedWrap: '18:00',
}

beforeEach(() => {
  findMany.mock.resetCalls()
  findMany.mock.mockImplementation(async () => [])
  listRows = []
  monthsAsked = []
  __clearRoomAvailabilityCache()
})

const booking = (over: any = {}) => ({
  bookingCode: 'NWS-TWD-260917-01',
  callTime: '16:00',
  estimatedWrap: '16:30',
  shootDate: new Date('2026-09-17T00:00:00Z'),
  shootEndDate: null,
  projectName: 'The World Dialogue',
  program: { name: 'TWD' },
  outlet: { code: 'NWS' },
  ...over,
})

test('ไม่มีใครจอง → no-conflict-known · ไม่มีคำว่า "ว่าง" ในผลลัพธ์', async () => {
  const r = await checkRoomAvailability(BASE) as any
  assert.equal(r.state, 'no-conflict-known')
  assert.ok(!JSON.stringify(r).includes('ว่าง'), 'ห้ามมีคำว่า "ว่าง" — รับประกันไม่ได้')
})

test('คิวถ่ายอีกใบในห้องเดียวกันเวลาทับ → busy พร้อมบอกว่าใคร', async () => {
  findMany.mock.mockImplementation(async () => [booking()])
  const r = await checkRoomAvailability(BASE) as any
  assert.equal(r.state, 'busy')
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].source, 'probook')
  assert.equal(r.conflicts[0].code, 'NWS-TWD-260917-01')
  assert.match(r.conflicts[0].label, /NWS/)
})

test('เวลาไม่ทับกัน (ชนขอบพอดี) → ไม่นับว่าชน', async () => {
  findMany.mock.mockImplementation(async () => [booking({ callTime: '18:00', estimatedWrap: '19:00' })])
  const r = await checkRoomAvailability(BASE) as any
  assert.equal(r.state, 'no-conflict-known')
})

test('งานหลายวันถือว่ากินทั้งวัน', async () => {
  findMany.mock.mockImplementation(async () => [booking({
    callTime: '09:00', estimatedWrap: '10:00',
    shootEndDate: new Date('2026-09-19T00:00:00Z'),
  })])
  const r = await checkRoomAvailability(BASE) as any
  assert.equal(r.state, 'busy')
  assert.match(r.conflicts[0].time, /ทั้งวัน/)
})

test('อ่านระบบกลางไม่ได้ → ยังตอบจาก DB ได้ แต่ต้องติด externalError มาด้วย', async () => {
  listRows = new Error('Cannot reach database server at db:3306')
  const r = await checkRoomAvailability(BASE) as any
  assert.equal(r.state, 'no-conflict-known')
  assert.equal(r.externalChecked, false)
  assert.match(r.externalError, /db:3306/)
})

test('การจองของแผนกอื่นนับเป็น conflict — แต่หัวข้อประชุมต้องไม่หลุดออกมา', async () => {
  listRows = [{
    id: 1, bookingNo: 'BK-9', live: true, isProbook: false, roomId: 15,
    title: 'สัมภาษณ์พนักงาน HR — เรื่องเงินเดือน', // ← ห้ามหลุด
    startAt: '2026-09-17T09:30:00.000Z',            // 16:30 ไทย
    endAt: '2026-09-17T10:30:00.000Z',              // 17:30 ไทย
  }]
  const r = await checkRoomAvailability(BASE) as any
  assert.equal(r.state, 'busy')
  assert.equal(r.externalChecked, true)
  const other = r.conflicts.find((c: any) => c.source === 'other')
  assert.ok(other, 'ต้องเจอ conflict ของแผนกอื่น')
  const dumped = JSON.stringify(r)
  assert.ok(!dumped.includes('HR'), 'หัวข้อประชุมของแผนกอื่นต้องไม่หลุด')
  assert.ok(!dumped.includes('เงินเดือน'), 'หัวข้อประชุมของแผนกอื่นต้องไม่หลุด')
})

test('ใบของโปรบุ๊คเองในระบบกลางต้องไม่ถูกนับซ้ำ', async () => {
  findMany.mock.mockImplementation(async () => [booking()])
  listRows = [{
    id: 2, bookingNo: 'BK-10', live: true, isProbook: true, roomId: 15,
    title: '[PB-NWS-TWD-260917-01] NWS · The World Dialogue',
    startAt: '2026-09-17T09:00:00.000Z', endAt: '2026-09-17T09:30:00.000Z',
  }]
  const r = await checkRoomAvailability(BASE) as any
  assert.equal(r.conflicts.length, 1, 'ใบเดียวกันต้องนับครั้งเดียว')
  assert.equal(r.conflicts[0].source, 'probook')
})

test('งานนอกตึก / ยังไม่เลือกห้อง → not-a-room ไม่ต้องรบกวนผู้ใช้', async () => {
  assert.equal(((await checkRoomAvailability({ ...BASE, locationId: null })) as any).state, 'not-a-room')
  assert.equal(((await checkRoomAvailability({ ...BASE, locationId: 'on-location' })) as any).state, 'not-a-room')
})

test('ยังไม่กรอกเวลา → unknown ไม่ใช่ "ไม่มีใครจอง"', async () => {
  const r = await checkRoomAvailability({ ...BASE, callTime: null }) as any
  assert.equal(r.state, 'unknown')
})

test('เวลาเลิกมาก่อนเวลาเริ่มในวันเดียวกัน → unknown ไม่ใช่เงียบแล้วผ่าน', async () => {
  // ช่วงกลับหัวทำให้การเทียบทับซ้อนตอบ "ไม่ชนใคร" เสมอ = โกหกว่าห้องว่าง
  const r = await checkRoomAvailability({
    ...BASE, callTime: '16:00', estimatedWrap: '09:00', shootEndDate: '2026-09-17',
  }) as any
  assert.equal(r.state, 'unknown')
})

test('ตอนแก้ใบเดิม ต้องไม่บอกว่าชนกับตัวเอง', async () => {
  await checkRoomAvailability({ ...BASE, excludeBookingId: 'abc' })
  const where = ((findMany.mock.calls as any[])[0].arguments[0] as any).where
  assert.deepEqual(where.id, { not: 'abc' })
})

test('นับเฉพาะคิวที่ยังจะถ่ายจริง — ยกเลิก/ลบแล้วต้องไม่ยึดห้อง', async () => {
  await checkRoomAvailability(BASE)
  const where = ((findMany.mock.calls as any[])[0].arguments[0] as any).where
  assert.deepEqual(where.status, { in: ['REQUESTED', 'ASSIGNED', 'CONFIRMED'] })
  assert.equal(where.deletedAt, null)
  assert.equal(where.locationId, 'tsd-studio-1')
})

test('ห้องที่ระบบกลางไม่มี (Lounge) → ข้ามชั้นนอก แต่ยังตรวจ DB ให้', async () => {
  findMany.mock.mockImplementation(async () => [booking()])
  const r = await checkRoomAvailability({ ...BASE, locationId: 'tsd-a-lounge-2f' }) as any
  assert.equal(r.state, 'busy')
  assert.equal(r.externalChecked, false)
  assert.equal(r.externalError, undefined, 'ไม่ได้ตรวจ ≠ ตรวจแล้วล้ม')
})


// ── v1.223.4 ────────────────────────────────────────────────────────────────

test('รับ locationName ได้ (ฟอร์มแก้ไขเก็บชื่อ ไม่ใช่ id) — แปลงที่ server ที่เดียว', async () => {
  findMany.mock.mockImplementation(async () => [booking()])
  const r = await checkRoomAvailability({
    locationName: 'Studio 1 (TSD)', shootDate: '2026-09-17', callTime: '16:00', estimatedWrap: '18:00',
  }) as any
  assert.equal(r.state, 'busy')
  const where = ((findMany.mock.calls as any[])[0].arguments[0] as any).where
  assert.equal(where.locationId, 'tsd-studio-1', 'ต้องแปลงชื่อเป็น id ให้ถูกห้อง')
})

test('ชื่อไทยที่ RoutinePlanner เคยพิมพ์เองก็ต้องแปลงได้', async () => {
  await checkRoomAvailability({ locationName: 'สตูดิโอ 1', shootDate: '2026-09-17', callTime: '16:00' })
  const where = ((findMany.mock.calls as any[])[0].arguments[0] as any).where
  assert.equal(where.locationId, 'tsd-studio-1')
})

test('ชื่อสถานที่นอกตึก → not-a-room ไม่ใช่ "ไม่มีใครจอง"', async () => {
  // เคสอันตรายที่เคยมีจริง: "Studio 1 RCA" เป็นสตูดิโอนอกตึก ห้ามแมปเป็น tsd-studio-1
  const r = await checkRoomAvailability({
    locationName: 'Tiffany & Co. สาขาสยามพารากอน', shootDate: '2026-09-17', callTime: '16:00',
  }) as any
  assert.equal(r.state, 'not-a-room')
  assert.equal(findMany.mock.calls.length, 0, 'ไม่ควรไปถาม DB เลย')
})

test('งานข้ามเดือนต้องดู snapshot ของทุกเดือนที่ช่วงถ่ายพาดผ่าน', async () => {
  await checkRoomAvailability({
    ...BASE, shootDate: '2026-09-30', shootEndDate: '2026-10-02',
  })
  assert.deepEqual(monthsAsked.sort(), ['2026-10', '2026-9'],
    'เดิมดึงแค่เดือนของ shootDate → มองไม่เห็นการจองของแผนกอื่นในเดือนถัดไป')
})

test('งานวันเดียวยังยิงเดือนเดียว — ไม่เผลอเพิ่มภาระ rate limit', async () => {
  await checkRoomAvailability(BASE)
  assert.deepEqual(monthsAsked, ['2026-9'])
})

test('อ่านเดือนใดเดือนหนึ่งไม่ได้ = ถือว่าตรวจชั้นนอกไม่ครบ ไม่ใช่ตรวจผ่าน', async () => {
  listRows = new Error('boom')
  const r = await checkRoomAvailability({
    ...BASE, shootDate: '2026-09-30', shootEndDate: '2026-10-02',
  }) as any
  assert.equal(r.externalChecked, false)
  assert.ok(r.externalError)
})
