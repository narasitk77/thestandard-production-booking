/**
 * v1.195 — ส่วนคำนวณล้วน ๆ ของการเชื่อมระบบจองห้อง (ไม่ยิงเน็ต)
 * เคสเวลาทั้งหมดอ้างอิงเวลาไทย UTC+7 ไม่มี DST
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  roomIdForLocation, bangkokToUtcIso, roomTargetForBooking,
  overlaps, utcRangeToBangkokDates, LOCATION_TO_ROOM_ID,
} from '../room-booking'
import { LOCATIONS } from '../locations'

test('แมปห้องด้วย id เท่านั้น และทุก id ในตารางต้องมีจริงใน locations.ts', () => {
  assert.equal(roomIdForLocation('tsd-studio-1'), 15)
  assert.equal(roomIdForLocation('tsd-b-1-5f'), 17)   // ชื่อในระบบเขาคือ "1 (5/F)"
  assert.equal(roomIdForLocation('tsd-b-hall-5f'), 20) // ชื่อในระบบเขาคือ "Hall B (5/F)"
  for (const id of Object.keys(LOCATION_TO_ROOM_ID)) {
    assert.ok(LOCATIONS.some(l => l.id === id), `${id} ไม่มีใน locations.ts`)
  }
  // roomId ต้องไม่ซ้ำกัน — ซ้ำ = สองห้องของเราไปยึดห้องเดียวกันของเขา
  const ids = Object.values(LOCATION_TO_ROOM_ID)
  assert.equal(new Set(ids).size, ids.length)
})

test('Lounge (2/F) ไม่มีในระบบกลาง → ข้าม ไม่เดา', () => {
  assert.equal(roomIdForLocation('tsd-a-lounge-2f'), null)
  const r = roomTargetForBooking({ locationId: 'tsd-a-lounge-2f', shootDate: '2026-09-01', callTime: '09:00' })
  assert.deepEqual(r, { skip: 'no-room-mapping' })
})

test('เวลาไทย → UTC ISO (สิ่งที่ check-conflict/room-slots ใช้จริง)', () => {
  assert.equal(bangkokToUtcIso('2026-08-27', '13:00'), '2026-08-27T06:00:00.000Z')
  assert.equal(bangkokToUtcIso('2026-09-01', '00:30'), '2026-08-31T17:30:00.000Z')
  assert.equal(bangkokToUtcIso('2026-09-01', 'บ่ายสาม' as any), null)
  assert.equal(bangkokToUtcIso('1/9/2026', '09:00'), null)
})

test('งานปกติ → เป้าหมายการจองครบ', () => {
  const r = roomTargetForBooking({
    locationId: 'tsd-studio-1', shootDate: '2026-09-01', callTime: '09:00', estimatedWrap: '18:00',
  })
  assert.deepEqual(r, { target: { roomId: 15, startAt: '2026-09-01T02:00:00.000Z', endAt: '2026-09-01T11:00:00.000Z' } })
})

test('ไม่มี wrap → บวก 4 ชั่วโมงเหมือน ot-sync', () => {
  const r = roomTargetForBooking({ locationId: 'tsd-studio-2', shootDate: '2026-09-01', callTime: '09:00' }) as any
  assert.equal(r.target.endAt, '2026-09-01T06:00:00.000Z') // 13:00 BKK = 09:00 + 4 ชม.
})

test('ถ่ายข้ามคืน (wrap <= call) → จบวันถัดไป', () => {
  const r = roomTargetForBooking({
    locationId: 'tsd-studio-1', shootDate: '2026-09-01', callTime: '20:00', estimatedWrap: '02:00',
  }) as any
  assert.equal(r.target.startAt, '2026-09-01T13:00:00.000Z')
  assert.equal(r.target.endAt, '2026-09-01T19:00:00.000Z') // 2 ก.ย. 02:00 BKK
})

test('เหตุผลที่ข้าม ต้องบอกได้เสมอ', () => {
  assert.deepEqual(roomTargetForBooking({ locationId: null, shootDate: '2026-09-01', callTime: '09:00' }), { skip: 'no-location' })
  assert.deepEqual(roomTargetForBooking({ locationId: 'external-on-location', shootDate: '2026-09-01', callTime: '09:00' }), { skip: 'external' })
  assert.deepEqual(roomTargetForBooking({ locationId: 'tsd-studio-1', shootDate: '2026-09-01', callTime: null }), { skip: 'no-times' })
})

test('overlaps: ปลายชนปลายไม่ถือว่าทับ', () => {
  const a = ['2026-09-01T02:00:00.000Z', '2026-09-01T03:00:00.000Z'] as const
  assert.equal(overlaps(a[0], a[1], '2026-09-01T03:00:00.000Z', '2026-09-01T04:00:00.000Z'), false)
  assert.equal(overlaps(a[0], a[1], '2026-09-01T01:00:00.000Z', '2026-09-01T02:00:00.000Z'), false)
  assert.equal(overlaps(a[0], a[1], '2026-09-01T02:30:00.000Z', '2026-09-01T04:00:00.000Z'), true)
  assert.equal(overlaps(a[0], a[1], '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'), true)
})

test('ช่วง UTC → วันไทยที่พาดผ่าน (ต้องถามช่องว่างให้ครบทุกวัน)', () => {
  assert.deepEqual(utcRangeToBangkokDates('2026-09-01T02:00:00.000Z', '2026-09-01T11:00:00.000Z'), ['2026-09-01'])
  // 1 ก.ย. 20:00 → 2 ก.ย. 02:00 เวลาไทย
  assert.deepEqual(utcRangeToBangkokDates('2026-09-01T13:00:00.000Z', '2026-09-01T19:00:00.000Z'), ['2026-09-01', '2026-09-02'])
})

// ── v1.200 ฝั่งเขียน ──────────────────────────────────────────────────────────
import {
  buildRoomBookingPayload, classifyRoomBookingResponse,
  buildRoomBookingTitle, roomBookingMarker,
} from '../room-booking'

const BASE = {
  roomId: 15, bookingCode: 'TSS-TSS-260907-01', showName: 'The Secret Sauce',
  shootDate: '2026-09-07', callTime: '09:00', estimatedWrap: '18:00',
  producerName: 'แพร', producerEmail: 'ingtawan.s@thestandard.co',
}

test('payload ใช้เวลาไทยตรง ๆ ไม่แปลงเป็น UTC (คนละแบบกับ check-conflict)', () => {
  const r = buildRoomBookingPayload(BASE) as any
  assert.equal(r.payload.startDate, '2026-09-07')
  assert.equal(r.payload.startTime, '09:00')   // ไม่ใช่ 02:00Z
  assert.equal(r.payload.endTime, '18:00')
  assert.equal(r.payload.roomId, 15)
  assert.equal(r.payload.department, 'Production')
})

test('title ฝัง marker ไว้ trace + อ่านกลับได้', () => {
  const r = buildRoomBookingPayload(BASE) as any
  assert.equal(r.payload.title, '[PB-TSS-TSS-260907-01] The Secret Sauce')
  assert.ok(r.payload.title.includes(roomBookingMarker('TSS-TSS-260907-01')))
  assert.equal(buildRoomBookingTitle('A-01', ''), '[PB-A-01]')
})

test('ไม่มี wrap → +8 ชม. ตามที่ระบบใช้อยู่', () => {
  const r = buildRoomBookingPayload({ ...BASE, estimatedWrap: null }) as any
  assert.equal(r.payload.endTime, '17:00')
})

test('ถ่ายข้ามคืน → endDate เป็นวันถัดไป', () => {
  const r = buildRoomBookingPayload({ ...BASE, callTime: '20:00', estimatedWrap: '02:00' }) as any
  assert.equal(r.payload.startDate, '2026-09-07')
  assert.equal(r.payload.endDate, '2026-09-08')
})

test('กติกาของระบบกลาง — กันไว้ก่อนยิง ไม่ใช่ไปเจอปลายทาง', () => {
  // เกิน 10 วัน
  const long = buildRoomBookingPayload({ ...BASE, shootEndDate: '2026-09-30' }) as any
  assert.ok(long.error.includes('10 วัน'))
  // อีเมลนอกโดเมน (ระบบเขาตอบ 500 ซึ่งอ่านเหมือน error ชั่วคราว)
  const gmail = buildRoomBookingPayload({ ...BASE, producerEmail: 'someone@gmail.com' }) as any
  assert.ok(gmail.error.includes('@thestandard.co'))
  const noEmail = buildRoomBookingPayload({ ...BASE, producerEmail: null }) as any
  assert.ok(noEmail.error.includes('ว่าง'))
  // wrap เท่ากับ call เป๊ะ = น่าจะกรอกผิด — ต้องไม่กลายเป็นยึดห้อง 24 ชม.
  const zero = buildRoomBookingPayload({ ...BASE, callTime: '09:00', estimatedWrap: '09:00' }) as any
  assert.ok(zero.error, 'wrap = call ต้องเป็น error ไม่ใช่จองข้ามคืน 24 ชม.')
})

test('ไม่มีข้อจำกัดเวลาทำการ — ถ่ายตี 5 จองได้ (IT ยืนยัน 08:00–21:00 เป็นแค่ฟอร์ม)', () => {
  const r = buildRoomBookingPayload({ ...BASE, callTime: '05:00', estimatedWrap: '23:30' }) as any
  assert.equal(r.payload.startTime, '05:00')
  assert.equal(r.payload.endTime, '23:30')
})

// ⚠️ เคสที่ตัดสินว่าจะจองซ้ำหรือไม่ — ระบบเขาไม่มี idempotency
test('แยก "ห้ามยิงซ้ำ" ออกจาก "ไม่รู้ผล" ให้ขาด', () => {
  assert.deepEqual(
    classifyRoomBookingResponse(200, { success: true, bookingNo: 'BK-0412', id: 412 }),
    { kind: 'ok', bookingNo: 'BK-0412', id: 412 })

  // ห้องเต็มตอบ **500** ไม่ใช่ 409 — เหมา 5xx = ชั่วคราวแล้ว retry จะยิงซ้ำไม่จบ
  const full = classifyRoomBookingResponse(500, { error: 'ห้องนี้ถูกจองในช่วงเวลาดังกล่าวแล้วครับ' })
  assert.equal(full.kind, 'conflict')

  const badEmail = classifyRoomBookingResponse(500, { error: 'กรุณาใช้อีเมลพนักงานของคุณ' })
  assert.equal(badEmail.kind, 'invalid')

  assert.equal(classifyRoomBookingResponse(401, { error: 'Invalid service key' }).kind, 'invalid')
  assert.equal(classifyRoomBookingResponse(400, { error: 'จองได้สูงสุด 10 วัน' }).kind, 'invalid')

  // 5xx อื่น / ตอบแปลก = ไม่รู้ผล → ต้องอ่านกลับก่อน ห้ามยิงใหม่ทันที
  assert.equal(classifyRoomBookingResponse(502, {}).kind, 'unknown')
  assert.equal(classifyRoomBookingResponse(200, { success: true }).kind, 'unknown')
})

// v1.202 — ชื่อตอนที่เป็น "-" คือ "ยังไม่ตั้งชื่อ" ไม่ใช่ชื่อจริง
// (เจอตอน dry-run ของจริง: title กลายเป็น "[PB-NWS-GLF-260825-01] NWS · -")
test('ชื่อตอน "-" ต้องตกไปใช้ชื่อรายการแทน', () => {
  const dash = buildRoomBookingTitle('NWS-GLF-260825-01', 'NWS · -')
  // ตัว title เองไม่รู้จักกฎนี้ — ผู้ประกอบ showName ต้องกันมาก่อน
  assert.equal(dash, '[PB-NWS-GLF-260825-01] NWS · -')
  const good = buildRoomBookingTitle('NWS-GLF-260825-01', 'NWS · Global Focus')
  assert.equal(good, '[PB-NWS-GLF-260825-01] NWS · Global Focus')
})

// v1.202.3 — ล็อกว่า "ตัวประกอบเดียวกัน" ยังไม่พอ ถ้า select ต่างกัน preview ก็ยังโกหก
// (ของจริง 2026-08-25: dry-run ได้ "POP · 7 THINGS WE LOVE ABOUT..." แต่ที่จองจริง
//  ได้ "POP · OG EP.1 / OG EP.2" เพราะเส้นทางจริงไม่ได้ดึง program ของแต่ละตอน)
test('ROOM_BOOKING_SELECT ต้องมีทุกฟิลด์ที่ชื่อการจองพึ่งพา', async () => {
  const { ROOM_BOOKING_SELECT } = await import('../room-booking-sync')
  const sel: any = ROOM_BOOKING_SELECT
  assert.equal(sel.projectName, true, 'ขาด projectName → bookingDisplayName ตกไปใช้ชื่ออื่น')
  assert.ok(sel.episodes?.select?.program?.select?.name,
    'ขาด program ของแต่ละตอน → ได้ชื่อประเภทเนื้อหาแทนชื่อรายการ')
  assert.equal(sel.episodes.select.title, true)
  assert.equal(sel.episodes.select.episodeId, true)
})

// v1.204 — worker ต้องมีสเปคเหมือน worker ตัวอื่น: ปิดไว้เป็นค่าเริ่มต้น,
// อ่าน secret ชุดเดียวกัน, และ start.sh ต้องเลี้ยงมันจริง ไม่ใช่เขียนไฟล์ทิ้งไว้
test('room-booking worker ถูกลงทะเบียนครบทั้งสามที่', async () => {
  const { readFileSync, existsSync } = await import('fs')
  const worker = readFileSync('scripts/room-booking-worker.js', 'utf8')
  const start = readFileSync('start.sh', 'utf8')
  // .dockerignore ตัด docker-compose*.yml ออกจาก build context โดยตั้งใจ
  // (daemon/orchestrator อ่าน ไม่ใช่ตัวแอป) — แต่ `npm run build` รัน `npm test`
  // ข้างใน Docker ด้วย ถ้าอ่านตรง ๆ เทสนี้จะทำให้ image build ล้มทั้งใบ
  // (เกิดจริง v1.204/v1.205) → ตรวจเฉพาะตอนไฟล์มีอยู่ ซึ่งคือใน CI และเครื่อง dev
  // อันเป็นที่ที่การตรวจนี้มีความหมายจริง
  const compose = existsSync('docker-compose.portainer.yml')
    ? readFileSync('docker-compose.portainer.yml', 'utf8')
    : null

  // ปิดไว้เป็นค่าเริ่มต้น — worker ที่เปิดเองตั้งแต่ deploy แรกคือความเสี่ยง
  assert.ok(worker.includes('ROOM_BOOKING_WORKER_ENABLED'))
  assert.ok(/enabled !== '1'/.test(worker), 'ต้องออกเมื่อ flag ไม่ได้เปิด')
  // เรียก endpoint ด้วย dryRun=0 ไม่งั้นมันจะวนดูเฉย ๆ ไม่แก้อะไรเลย
  assert.ok(worker.includes('dryRun=0'), 'worker ต้องสั่งโหมดลงมือจริง')
  // supervisor เลี้ยงจริง
  assert.ok(start.includes('scripts/room-booking-worker.js'), 'start.sh ไม่ได้เลี้ยง worker นี้')
  // ตัวแปรถูกส่งเข้าคอนเทนเนอร์ (บทเรียน: stack env ไม่ไหลเข้าเอง)
  if (compose) {
    assert.ok(compose.includes('ROOM_BOOKING_WORKER_ENABLED:'), 'compose ไม่ได้ส่ง flag เข้าคอนเทนเนอร์')
    assert.ok(compose.includes('ROOM_BOOKING_SERVICE_KEY:'), 'compose ไม่ได้ส่ง service key เข้าคอนเทนเนอร์')
  }
})

// v1.206 — IT ยืนยัน: endpoint ยกเลิกใช้ `id` (primary key) ไม่ใช่ `bookingNo`
// และเพิ่ม id มาในคำตอบของ POST แล้ว → ต้องเก็บไว้ ไม่ใช่ไปไล่หาทีหลัง
test('เก็บเลข id จากคำตอบตอนจอง (คนละเลขกับ bookingNo)', () => {
  const ok = classifyRoomBookingResponse(200, { success: true, bookingNo: 'BK-0412', id: 412 })
  assert.deepEqual(ok, { kind: 'ok', bookingNo: 'BK-0412', id: 412 })

  // ระบบเก่าที่ยังไม่ส่ง id มา ต้องไม่พัง — คืน null แล้วให้ไปหาจากปฏิทินแทน
  const noId = classifyRoomBookingResponse(200, { success: true, bookingNo: 'BK-0412' })
  assert.deepEqual(noId, { kind: 'ok', bookingNo: 'BK-0412', id: null })

  const junk = classifyRoomBookingResponse(200, { success: true, bookingNo: 'BK-1', id: 'ไม่ใช่ตัวเลข' })
  assert.equal((junk as any).id, null)
})

// v1.207 — reconciler ต้องยืนยันว่าห้องที่เราคิดว่าจองไว้ยังอยู่จริง
// เดิมตรวจแค่ "ห้องที่ไม่ควรถูกยึด" → ถ้ามีคนยกเลิกฝั่งพอร์ทัล เราจะเชื่อว่ายังมีห้อง
// ตลอดไป ทั้งที่ห้องว่างและกองไม่มีที่ถ่าย ไม่มีอะไรจับได้จนถึงวันถ่าย
test('reconciler มีการตรวจ "หายไปจากระบบกลาง"', async () => {
  const { readFileSync } = await import('fs')
  const src = readFileSync('src/lib/room-booking-reconcile.ts', 'utf8')
  assert.ok(src.includes('vanished'), 'ไม่มีการตรวจว่าการจองหายไป')
  assert.ok(src.includes('listRoomBookings'), 'ต้องดึงรายเดือนทีเดียว ไม่ถามทีละใบ (rate limit 20/5 นาที)')
  // อ่านไม่ได้ = ตัดสินไม่ได้ ห้ามสรุปว่าหาย ไม่งั้นจะจองซ้ำ
  assert.ok(/return null/.test(src) && src.includes('ห้ามสรุปว่าหาย'),
    'ต้องกันเคสอ่านปฏิทินไม่ได้ ไม่ให้ตีความว่าการจองหายไป')
})
