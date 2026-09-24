// v1.235 — กล่องทีมประจำที่ผูกกับ crew + ตัวทำความสะอาดลิสต์อีเมลที่ใช้ร่วมกัน
//
// ที่มา: ใบที่ /admin/routine สร้างเกิดมา assignedEmails ว่าง ⇒ แขกปฏิทินเหลือ
// producer คนเดียว ⇒ ทีมวิดีโอ/เสียงไม่เห็นงานบนปฏิทินตัวเอง (พบจริง 2026-09-24
// กับใบ Now ต.ค.–ธ.ค. 59 ใบ เทียบกับชุด ส.ค./ก.ย. ที่มี video@ + Sound@ ครบทุกใบ)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamMailboxesForCrew } from '../shared-mailboxes'
import { cleanEmailList } from '../email-list'

test('crew ของงาน Now (Videographer + Sound) ได้กล่องทีมสองกล่อง เรียงตาม crew', () => {
  assert.deepEqual(teamMailboxesForCrew(['Videographer', 'Sound']),
    ['video@thestandard.co', 'sound@thestandard.co'])
})

test('บทบาทที่ไม่มีกล่องประจำคืนค่าว่าง — ตั้งใจ ไม่ใช่ลืม', () => {
  assert.deepEqual(teamMailboxesForCrew(['Switcher', 'DIT', 'Lighting']), [])
})

test('ไม่มี crew เลย / null / undefined ต้องไม่พัง', () => {
  assert.deepEqual(teamMailboxesForCrew([]), [])
  assert.deepEqual(teamMailboxesForCrew(null), [])
  assert.deepEqual(teamMailboxesForCrew(undefined), [])
})

test('crew ซ้ำไม่ทำให้กล่องซ้ำ', () => {
  assert.deepEqual(teamMailboxesForCrew(['Sound', 'Sound']), ['sound@thestandard.co'])
})

test('SHARED_MAILBOXES เป็นคำตอบสุดท้าย — ปิดกล่องไหนกล่องนั้นต้องหายไปด้วย', () => {
  const prev = process.env.SHARED_MAILBOXES
  process.env.SHARED_MAILBOXES = 'video@thestandard.co'
  try {
    assert.deepEqual(teamMailboxesForCrew(['Videographer', 'Sound']), ['video@thestandard.co'])
  } finally {
    if (prev === undefined) delete process.env.SHARED_MAILBOXES
    else process.env.SHARED_MAILBOXES = prev
  }
})

test('cleanEmailList ตัดช่องว่าง ทิ้งค่าว่าง และตัดซ้ำแบบไม่สนตัวพิมพ์', () => {
  // ของจริงบนพรอดมีทั้ง Sound@ และ sound@ — Google มองเป็นคนเดียวกัน
  // ถ้าไม่ตัดซ้ำตรงนี้ ปฏิทินจะได้แขกซ้ำสองรายการที่ต่างกันแค่ตัวพิมพ์
  assert.deepEqual(
    cleanEmailList([' video@thestandard.co ', '', 'Sound@thestandard.co', 'sound@thestandard.co', null, 7]),
    ['video@thestandard.co', 'Sound@thestandard.co'])
})

test('cleanEmailList ไม่แปลงตัวพิมพ์ของตัวที่เก็บไว้ — ไม่งั้นใบเก่าจะเกิด diff ปลอม', () => {
  assert.deepEqual(cleanEmailList(['Sound@thestandard.co']), ['Sound@thestandard.co'])
})

test('cleanEmailList รับค่าที่ไม่ใช่ array ได้', () => {
  assert.deepEqual(cleanEmailList(undefined), [])
  assert.deepEqual(cleanEmailList('video@thestandard.co'), [])
})

// ── เส้นแบ่งสิทธิ์: ทีมงานต้องมาจากผู้เรียกฝั่งเซิร์ฟเวอร์ ไม่ใช่จาก body ───────
//
// `/api/bookings` (ฟอร์ม /new) เปิดให้ผู้ใช้ที่ล็อกอิน **ทุกคน** สร้างใบจอง และมัน
// ส่ง `body` ดิบเข้า createBookingFromPayload ตรง ๆ ส่วนการจัดทีมงานเป็นสิทธิ์
// คอนโซล (`/api/admin/[id]/assign` = requireConsole) ถ้า create-booking หยิบ
// `assignedEmails` ออกจาก body เมื่อไหร่ ผู้ใช้ทั่วไปจะตั้งทีมงานให้ตัวเองได้ทันที
// โดยไม่มีใครเห็น — เทสนี้อ่านซอร์สเพราะการเรียกฟังก์ชันจริงต้องต่อ DB
// (แบบเดียวกับ compose-env-coverage.test.ts)
import { readFileSync } from 'fs'
import { join } from 'path'

const createBookingSrc = readFileSync(
  join(process.cwd(), 'src/lib/create-booking.ts'), 'utf8')

test('create-booking ต้องไม่ดึง assignedEmails ออกจาก body ของ client', () => {
  const end = createBookingSrc.indexOf('} = body || {}')
  assert.ok(end > 0, 'หา body destructure ไม่เจอ — เทสนี้ตรวจอะไรไม่ได้แล้ว')
  // Math.max กันค่าติดลบ: JS ตีความ slice(ติดลบ) ว่านับจากท้ายไฟล์ แล้วคืนสตริงว่าง
  // = เทสที่ผ่านตลอดกาล (เจอตอนลองใส่บั๊กกลับเข้าไปดูว่ามันฟ้องจริงไหม 2026-09-24)
  const destructure = createBookingSrc.slice(Math.max(0, end - 4000), end)
  assert.ok(destructure.includes('routineGroupId'),
    'slice ไม่ครอบ destructure จริง — เทสนี้ตรวจอะไรไม่ได้')
  assert.ok(!/^\s*assignedEmails\s*,\s*$/m.test(destructure),
    'assignedEmails หลุดกลับเข้าไปใน body destructure = ผู้ใช้ทั่วไปตั้งทีมงานได้เอง')
})

test('create-booking อ่านทีมงานจาก opts เท่านั้น', () => {
  assert.match(createBookingSrc, /cleanEmailList\(opts\.assignedEmails\)/,
    'ทีมงานต้องมาจาก opts ที่ผู้เรียกฝั่งเซิร์ฟเวอร์กำหนด')
})

test('ผู้เรียกที่ไม่ได้ผ่านด่านคอนโซลต้องไม่ส่ง assignedEmails เข้ามา', () => {
  const openRoute = readFileSync(
    join(process.cwd(), 'src/app/api/bookings/route.ts'), 'utf8')
  const mcp = readFileSync(join(process.cwd(), 'src/lib/mcp/tools.ts'), 'utf8')
  for (const [name, src] of [['api/bookings', openRoute], ['mcp/tools', mcp]] as const) {
    const call = src.slice(src.indexOf('createBookingFromPayload('))
    assert.ok(!call.slice(0, 200).includes('assignedEmails'),
      `${name} ส่ง assignedEmails เข้า createBookingFromPayload — เส้นทางนี้ไม่ได้ผ่าน requireConsole`)
  }
})
