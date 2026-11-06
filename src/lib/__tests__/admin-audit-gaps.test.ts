import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// v1.281 — ช่องที่ตรวจรายงานการใช้งาน (5 พ.ย. 2569) เจอ: ใบที่อนุมัติแล้ว 762 ใบ รู้ผู้อนุมัติ 170
// และขั้น REQUESTED → ASSIGNED ไม่มีใน audit_logs เลยตั้งแต่ 22 พ.ค. เพราะ:
//   1) /api/admin/[id]/assign ไม่เขียน audit
//   2) assign ไม่กันใบ CANCELLED (ยิง API ตรง = CANCELLED → ASSIGNED + ส่งเมลหาทีม)
//   3) /restore ล้าง approvedAt/approvedByEmail ทิ้งโดยไม่เก็บค่าเดิม
//   4) /api/admin/users เปลี่ยน role/active/position โดยไม่มีร่องรอย
// เทสต์เรียก route handler ตัวจริง — mock แค่ DB / session / Google / อีเมล
// (relative specifier ตามกฎใน mcp-readonly.test.ts)

const audits: any[] = []
const bookingWrites: any[] = []
let bookingRow: any // what the DB holds right now
let readSnapshot: any = null // what the route's first read sees (null = same as bookingRow)
let users: Record<string, any> = {}
let session: any

const p2025 = () => Object.assign(new Error('Record to update not found.'), { code: 'P2025' })

mock.module('../db', { namedExports: { prisma: {
  auditLog: { create: async ({ data }: any) => { audits.push(data); return data } },
  booking: {
    findUnique: async () => (readSnapshot ? { ...readSnapshot } : bookingRow ? { ...bookingRow } : null),
    // emulates Prisma 5 extended unique where: extra filters must match or P2025
    update: async (args: any) => {
      const w = args.where
      if (!bookingRow || w.id !== bookingRow.id) throw p2025()
      if ('status' in w && w.status !== bookingRow.status) throw p2025()
      if ('deletedAt' in w && w.deletedAt === null && bookingRow.deletedAt) throw p2025()
      bookingWrites.push(args)
      bookingRow = { ...bookingRow, ...args.data }
      return { ...bookingRow }
    },
    updateMany: async () => ({ count: 1 }),
  },
  user: {
    findUnique: async ({ where }: any) => {
      const u = where.id ? users[where.id] : Object.values(users).find((x: any) => x.email === where.email)
      return u ? { ...u } : null
    },
    update: async ({ where, data }: any) => {
      users[where.id] = { ...users[where.id], ...data }
      return { ...users[where.id] }
    },
    upsert: async ({ where, update, create }: any) => {
      const hit = Object.values(users).find((x: any) => x.email === where.email) as any
      if (hit) { users[hit.id] = { ...hit, ...update }; return { ...users[hit.id] } }
      const row = { id: `u-${Object.keys(users).length + 1}`, active: true, producerOutlets: [], ...create }
      users[row.id] = row
      return { ...row }
    },
  },
} } })
mock.module('../session', { namedExports: {
  requireConsole: async () => session,
  getSession: async () => session,
} })
mock.module('../google-token', { namedExports: { getValidGoogleAccessToken: async () => null } })
mock.module('../google-sheets', { namedExports: { updateBookingRow: async () => {} } })
mock.module('../google-calendar', { namedExports: {
  buildEventDescription: () => '',
  createCalendarEvent: async () => null,
  deleteCalendarEvent: async () => {},
  getCalendarImpersonateSubject: () => null,
  getCalendarEventLink: async () => null,
  updateCalendarEventAttendees: async () => true,
} })
mock.module('../ot-sync', { namedExports: { syncBookingOT: async () => {} } })
const mailed: string[] = []
mock.module('../email', { namedExports: {
  sendAssignmentEmail: async (m: any) => { mailed.push(m.to) },
  buildEmailErrorHint: () => '',
} })
mock.module('next-auth/jwt', { namedExports: { getToken: async () => null } })

type Handler = (req: any, ctx?: any) => Promise<Response>
let assign: Handler
let restore: Handler
let usersRoute: { PATCH: Handler; POST: Handler; DELETE: Handler }
before(async () => {
  ;({ POST: assign } = await import('../../app/api/admin/[id]/assign/route'))
  ;({ POST: restore } = await import('../../app/api/admin/[id]/restore/route'))
  usersRoute = await import('../../app/api/admin/users/route') as any
})

const COORD = { email: 'coord@thestandard.co', role: 'COORDINATOR', id: 'u-coord' }
const ADMIN = { email: 'admin@thestandard.co', role: 'ADMIN', id: 'u-admin' }

const baseBooking = (o: any = {}) => ({
  id: 'b1', bookingCode: 'NWS-KYM-261105-01', status: 'REQUESTED', deletedAt: null,
  assignedEmails: [], adminNotes: null, mainVideographerEmail: null, freelancers: null,
  calendarEventId: null, sheetRowIndex: null, approvedAt: null, approvedByEmail: null,
  producer: 'P', producerEmail: 'p@thestandard.co', coProducerEmail: null,
  directorEmail: null, director2Email: null, director3Email: null,
  shootDate: new Date('2026-11-20'), shootEndDate: null, callTime: '09:00', estimatedWrap: '18:00',
  shootType: 'ONSITE', locationName: 'X', notes: null,
  outlet: { code: 'NWS', name: 'News' }, program: { code: 'KYM', name: 'Prog' }, episodes: [],
  ...o,
})

const post = (body: unknown) =>
  new Request('https://probook.test/api', { method: 'POST', body: JSON.stringify(body) }) as any
const send = (method: string, body: unknown) =>
  new Request('https://probook.test/api/admin/users', { method, body: JSON.stringify(body) }) as any
const ctx = { params: { id: 'b1' } }

beforeEach(() => {
  audits.length = 0; bookingWrites.length = 0; mailed.length = 0
  bookingRow = baseBooking(); readSnapshot = null; users = {}
  session = COORD
})

// ── 2) CANCELLED guard ──────────────────────────────────────────────────────

test('assign: ใบ CANCELLED → 409 ไม่เขียน ไม่ส่งเมล ไม่มี audit (เดิมกลายเป็น ASSIGNED)', async () => {
  bookingRow = baseBooking({ status: 'CANCELLED' })
  const res = await assign(post({ assignedEmails: ['a@thestandard.co'], sendEmail: true }), ctx)
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /cancelled/i)
  assert.equal(bookingWrites.length, 0)
  assert.equal(bookingRow.status, 'CANCELLED')
  assert.deepEqual(mailed, [])
  assert.equal(audits.length, 0)
})

test('assign: ใบถูกยกเลิกระหว่างอ่านกับเขียน → 409 ไม่ทับเป็น ASSIGNED', async () => {
  readSnapshot = baseBooking({ status: 'REQUESTED' })
  bookingRow = baseBooking({ status: 'CANCELLED' })
  const res = await assign(post({ assignedEmails: ['a@thestandard.co'], sendEmail: true }), ctx)
  assert.equal(res.status, 409)
  assert.equal(bookingRow.status, 'CANCELLED')
  assert.deepEqual(mailed, [])
  assert.equal(audits.length, 0)
})

// ── 1) assign audit ─────────────────────────────────────────────────────────

test('assign: REQUESTED → ASSIGNED เขียน booking.assign พร้อมผู้กด สถานะ และ diff ทีม', async () => {
  const res = await assign(post({ assignedEmails: ['b@thestandard.co', 'a@thestandard.co'], sendEmail: false }), ctx)
  assert.equal(res.status, 200)
  assert.equal(audits.length, 1)
  const a = audits[0]
  assert.equal(a.action, 'booking.assign')
  assert.equal(a.entityType, 'Booking')
  assert.equal(a.entityId, 'b1')
  assert.equal(a.bookingCode, 'NWS-KYM-261105-01')
  assert.equal(a.actorEmail, COORD.email)
  assert.equal(a.fromStatus, 'REQUESTED')
  assert.equal(a.toStatus, 'ASSIGNED')
  assert.deepEqual(a.changes.assignedEmails, { from: [], to: ['a@thestandard.co', 'b@thestandard.co'] })
  assert.equal(a.changes.emailRequested, false)
  assert.ok(!('status' in a.changes), 'status อยู่ใน fromStatus/toStatus แล้ว ไม่ซ้ำใน changes')
  assert.ok(!('freelancers' in a.changes), 'ห้ามมีเบอร์ฟรีแลนซ์ในแถวที่ทุกคนเห็น')
})

test('assign: เปลี่ยนทีมใบ CONFIRMED ยังเป็น CONFIRMED และมีแถว audit (ส่งเมลซ้ำก็นับ)', async () => {
  bookingRow = baseBooking({ status: 'CONFIRMED', assignedEmails: ['a@thestandard.co'], calendarEventId: 'ev1' })
  const res = await assign(post({ assignedEmails: ['a@thestandard.co'], sendEmail: true }), ctx)
  assert.equal(res.status, 200)
  assert.equal(bookingRow.status, 'CONFIRMED')
  assert.equal(audits.length, 1)
  assert.equal(audits[0].fromStatus, 'CONFIRMED')
  assert.equal(audits[0].toStatus, 'CONFIRMED')
  assert.equal(audits[0].changes.emailRequested, true)
  assert.ok(!('assignedEmails' in audits[0].changes), 'ทีมไม่เปลี่ยน = ไม่มี diff ทีม')
})

// ── 3) restore audit ────────────────────────────────────────────────────────

test('restore: เก็บผู้อนุมัติ/เวลาอนุมัติเดิมไว้ใน audit ก่อนล้าง', async () => {
  const approvedAt = new Date('2026-10-01T03:00:00Z')
  bookingRow = baseBooking({ status: 'CANCELLED', approvedAt, approvedByEmail: 'approver@thestandard.co', calendarEventId: 'ev-old' })
  const res = await restore(post({}), ctx)
  assert.equal(res.status, 200)
  assert.equal(bookingRow.status, 'REQUESTED')
  assert.equal(bookingRow.approvedByEmail, null)
  assert.equal(audits.length, 1)
  const a = audits[0]
  assert.equal(a.action, 'booking.restore')
  assert.equal(a.actorEmail, COORD.email)
  assert.equal(a.fromStatus, 'CANCELLED')
  assert.equal(a.toStatus, 'REQUESTED')
  assert.deepEqual(a.changes.approvedByEmail, { from: 'approver@thestandard.co', to: null })
  assert.deepEqual(a.changes.approvedAt, { from: approvedAt.toISOString(), to: null })
  assert.deepEqual(a.changes.calendarEventId, { from: 'ev-old', to: null })
})

test('restore: ใบที่ไม่ใช่ CANCELLED → 400 ไม่มี audit', async () => {
  const res = await restore(post({}), ctx)
  assert.equal(res.status, 400)
  assert.equal(audits.length, 0)
})

// ── 4) user role / access audit ─────────────────────────────────────────────

const someone = (o: any = {}) => ({ id: 'u-9', email: 'x@thestandard.co', role: 'USER', active: true,
  thaiName: null, employeeId: null, position: null, producerOutlets: [], ...o })

test('users PATCH: เปลี่ยน role เขียน user.update พร้อมค่าเดิม/ใหม่ และผู้กด', async () => {
  session = ADMIN
  users = { 'u-9': someone() }
  const res = await usersRoute.PATCH(send('PATCH', { id: 'u-9', role: 'COORDINATOR' }))
  assert.equal(res.status, 200)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action, 'user.update')
  assert.equal(audits[0].entityType, 'User')
  assert.equal(audits[0].entityId, 'u-9')
  assert.equal(audits[0].actorEmail, ADMIN.email)
  assert.deepEqual(audits[0].changes, { email: 'x@thestandard.co', role: { from: 'USER', to: 'COORDINATOR' } })
})

test('users PATCH: position ที่มีคำว่า manager (= สิทธิ์อนุมัติ OT) ก็มีร่องรอย', async () => {
  session = ADMIN
  users = { 'u-9': someone() }
  await usersRoute.PATCH(send('PATCH', { id: 'u-9', position: 'Production Manager' }))
  assert.deepEqual(audits[0].changes.position, { from: null, to: 'Production Manager' })
})

test('users PATCH: กดบันทึกโดยไม่มีอะไรเปลี่ยน → ไม่เขียนแถวขยะ', async () => {
  session = ADMIN
  users = { 'u-9': someone({ role: 'COORDINATOR' }) }
  const res = await usersRoute.PATCH(send('PATCH', { id: 'u-9', role: 'COORDINATOR', active: true }))
  assert.equal(res.status, 200)
  assert.equal(audits.length, 0)
})

test('users PATCH: ถูกปฏิเสธสิทธิ์ (403) → ไม่มี audit', async () => {
  session = COORD
  users = { 'u-9': someone() }
  const res = await usersRoute.PATCH(send('PATCH', { id: 'u-9', role: 'ADMIN' }))
  assert.equal(res.status, 403)
  assert.equal(users['u-9'].role, 'USER')
  assert.equal(audits.length, 0)
})

test('users POST: เพิ่มคนใหม่ = user.add · อีเมลเดิมแต่ยก role = user.update', async () => {
  session = ADMIN
  await usersRoute.POST(send('POST', { email: 'New@thestandard.co', role: 'COORDINATOR' }))
  assert.equal(audits[0].action, 'user.add')
  assert.deepEqual(audits[0].changes, { email: 'new@thestandard.co', role: { from: null, to: 'COORDINATOR' } })

  users = { 'u-9': someone({ active: false }) }
  audits.length = 0
  await usersRoute.POST(send('POST', { email: 'x@thestandard.co', role: 'MANAGER' }))
  assert.equal(audits[0].action, 'user.update')
  assert.deepEqual(audits[0].changes.role, { from: 'USER', to: 'MANAGER' })
  assert.deepEqual(audits[0].changes.active, { from: false, to: true })
})

test('users DELETE: ปิดบัญชีมีร่องรอย active true → false', async () => {
  session = ADMIN
  users = { 'u-9': someone() }
  const res = await usersRoute.DELETE(send('DELETE', { id: 'u-9' }))
  assert.equal(res.status, 200)
  assert.equal(audits[0].action, 'user.update')
  assert.deepEqual(audits[0].changes.active, { from: true, to: false })
})
