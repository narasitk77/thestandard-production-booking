import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// v1.288 — นัท 12 พ.ย. 2569: ใส่ ✅ หน้าชื่องานและลิงก์กล่องใน event ปฏิทินตอนแจ้ง Footage พร้อม
// แตะแค่ชื่อ + รายละเอียด (ไม่แตะเวลา/สถานที่/แขก/ที่คนแก้มือ) · sendUpdates 'none' (ทีมได้เมลฟุตเทจแล้ว) · ทำซ้ำได้ไม่เพี้ยน

let event: any = null
let getError: any = null
let patches: any[] = []
let callOpts: any[] = []
let calendarReadable = true
const fakeCalendar = {
  calendars: { get: async () => { if (!calendarReadable) throw Object.assign(new Error('Not Found'), { code: 404 }); return { data: {} } } },
  events: {
    get: async (_: any, opts: any) => { callOpts.push(opts); if (getError) throw getError; return { data: event } },
    patch: async (args: any, opts: any) => { callOpts.push(opts); patches.push(args); return { data: {} } },
  },
}
mock.module('googleapis', { namedExports: { google: { calendar: () => fakeCalendar, auth: { JWT: class { constructor(_: any) {} } } } } })

let gc: typeof import('../google-calendar')
before(async () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@x.iam', private_key: 'k' })
  gc = await import('../google-calendar')
})
beforeEach(() => { event = null; getError = null; patches = []; callOpts = []; calendarReadable = true })

const AT = new Date('2026-11-12T07:20:00Z') // 14:20 BKK
const BOX = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'

test('footageReadyLine: เวลาไทย + ลิงก์กล่อง · ไม่มี id กล่อง = ไม่มีลิงก์', () => {
  assert.equal(gc.footageReadyLine(AT, BOX), `📁 ฟุตเทจพร้อม 12 พ.ย. 14:20 — https://drive.google.com/drive/folders/${BOX}`)
  assert.equal(gc.footageReadyLine('2026-12-31T17:05:00Z', null), '📁 ฟุตเทจพร้อม 1 ม.ค. 00:05')
})

test('withReadyMark / withReadyLine: ทำซ้ำไม่ซ้อน · บรรทัดเดิมถูกแทนที่ · คำอธิบายแบบ HTML ใช้ <br>', () => {
  assert.equal(gc.withReadyMark('🚐 [TSS] Show'), '✅ 🚐 [TSS] Show')
  assert.equal(gc.withReadyMark('✅ 🚐 [TSS] Show'), '✅ 🚐 [TSS] Show')
  const line = gc.footageReadyLine(AT, BOX)
  const once = gc.withReadyLine('Production Booking\nCrew: x', line)
  assert.equal(once, `${line}\n\nProduction Booking\nCrew: x`)
  assert.equal(gc.withReadyLine(once, line), once, 'idempotent')
  const later = gc.footageReadyLine(new Date('2026-11-13T01:00:00Z'), BOX)
  assert.equal(gc.withReadyLine(once, later), `${later}\n\nProduction Booking\nCrew: x`, 'refreshed in place, not stacked')
  const html = 'Production Booking<br>Crew: x<br><b>note</b>'
  const h1 = gc.withReadyLine(html, line)
  assert.equal(h1, `${line}<br><br>${html}`)
  assert.equal(gc.withReadyLine(h1, later), `${later}<br><br>${html}`, 'the HTML after the line survives a refresh')
  assert.equal(gc.withReadyLine('', line), line)
  // review v1.288: Google's editor wraps the pasted URL in <a> — a refresh replaces it, never leaves two links
  const url = `https://drive.google.com/drive/folders/${BOX}`
  const edited = `📁 ฟุตเทจพร้อม 12 พ.ย. 14:20 — <a href="${url}">${url}</a><br><br>Production Booking<br>Crew: x`
  assert.equal(gc.withReadyLine(edited, later), `${later}<br><br>Production Booking<br>Crew: x`)
  // a plain description that merely contains an address in <> is not HTML
  assert.equal(gc.withReadyLine('Notes: ส่งไฟล์ให้ <kai@x.com>', line), `${line}\n\nNotes: ส่งไฟล์ให้ <kai@x.com>`)
})

const booking = {
  id: 'b1', bookingCode: 'TSS-EXE-261112-01', shootType: 'ON_LOCATION', producer: 'แพร', crewRequired: ['Videographer'],
  cameraCount: 2, micCount: 1, vanCount: 1,
  outlet: { code: 'TSS', name: 'The Secret Sauce' }, program: { code: 'EXE', name: 'Executive Espresso' },
  episodes: [{ episodeId: 'EP01', title: 'โปรเจกต์ผ้าไทย' }],
}

test('builders: ใบที่แจ้งแล้ว = ✅ นำหน้าชื่อ + บรรทัดฟุตเทจพร้อมนำคำอธิบาย (แก้ใบทีหลังไม่หาย) · ยังไม่แจ้ง = เหมือนเดิม', () => {
  const plain = gc.buildEventTitle(booking)
  assert.ok(!plain.startsWith('✅'))
  assert.equal(gc.buildEventTitle({ ...booking, readyNotifiedAt: AT }), `✅ ${plain}`)
  const desc = gc.buildEventDescription({ ...booking, readyNotifiedAt: AT, driveFolders: { box: BOX } }, [])
  assert.ok(desc.startsWith(`📁 ฟุตเทจพร้อม 12 พ.ย. 14:20 — https://drive.google.com/drive/folders/${BOX}\n\nProduction Booking`))
  assert.ok(gc.buildEventDescription(booking, []).startsWith('Production Booking'))
})

test('markCalendarFootageReady: แก้แค่ชื่อ + คำอธิบาย · sendUpdates none · เวลา/สถานที่/แขกไม่ถูกส่งไป', async () => {
  event = { summary: '🚐 [TSS] Executive Espresso', description: 'Production Booking\nCrew: x', location: 'Jim Thompson', start: { dateTime: 'x' }, attendees: [{ email: 'a@x' }], etag: '"e1"' }
  assert.equal(await gc.markCalendarFootageReady('ev1', AT, BOX), 'marked')
  assert.equal(patches.length, 1)
  assert.equal(patches[0].sendUpdates, 'none')
  assert.equal(patches[0].eventId, 'ev1')
  assert.deepEqual(Object.keys(patches[0].requestBody).sort(), ['description', 'summary'])
  assert.equal(patches[0].requestBody.summary, '✅ 🚐 [TSS] Executive Espresso')
  assert.ok(patches[0].requestBody.description.startsWith('📁 ฟุตเทจพร้อม 12 พ.ย. 14:20 — https://drive.google.com/drive/folders/'))
  assert.deepEqual(callOpts[0], { timeout: 10_000, retry: false }, 'bounded, no silent retries — the 📣 request waits on it')
  assert.deepEqual(callOpts[1], { timeout: 10_000, retry: false, headers: { 'If-Match': '"e1"' } }, 'an edit made since our read is never undone')
})

test('markCalendarFootageReady dryRun: อ่านอย่างเดียว ตอบแบบเดียวกับรอบจริง (ไม่ patch)', async () => {
  event = { summary: '[TSS] X', description: 'Production Booking' }
  assert.equal(await gc.markCalendarFootageReady('ev1', AT, BOX, { dryRun: true }), 'marked')
  assert.equal(patches.length, 0)
  event = { summary: '✅ [TSS] X', description: `${gc.footageReadyLine(AT, BOX)}\n\nProduction Booking` }
  assert.equal(await gc.markCalendarFootageReady('ev1', AT, BOX, { dryRun: true }), 'already')
})

test('markCalendarFootageReady: มีครบแล้ว = already (ไม่ยิง patch) · event ถูกลบ (410/cancelled · 404 ที่ปฏิทินยังอ่านได้) = gone · 404 ที่อ่านปฏิทินไม่ได้ / Google ล้ม = throw (ห้ามจำว่าเสร็จ)', async () => {
  const line = gc.footageReadyLine(AT, BOX)
  event = { summary: '✅ [TSS] X', description: `${line}\n\nProduction Booking` }
  assert.equal(await gc.markCalendarFootageReady('ev1', AT, BOX), 'already')
  assert.equal(patches.length, 0)
  event = { status: 'cancelled', summary: 'x' }
  assert.equal(await gc.markCalendarFootageReady('ev1', AT, BOX), 'gone')
  getError = Object.assign(new Error('Not Found'), { code: 404 })
  assert.equal(await gc.markCalendarFootageReady('ev1', AT, BOX), 'gone', 'the calendar is readable → the event is really gone')
  calendarReadable = false
  await assert.rejects(gc.markCalendarFootageReady('ev1', AT, BOX), /Not Found/, 'lost access to the calendar — not "gone"')
  getError = Object.assign(new Error('Resource has been deleted'), { code: 410 })
  assert.equal(await gc.markCalendarFootageReady('ev1', AT, BOX), 'gone')
  getError = Object.assign(new Error('Backend Error'), { code: 500 })
  await assert.rejects(gc.markCalendarFootageReady('ev1', AT, BOX), /Backend Error/)
  assert.equal(patches.length, 0)
})
