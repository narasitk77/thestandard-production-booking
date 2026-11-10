import { test, mock, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// v1.284 — นัทสั่ง "เพิ่มสิทธิ์ลบตอนให้ตุ้ย": remove-episodes เปิดให้ ADMIN + รายคนใน
// EPISODE_REMOVER_EMAILS (ค่าเริ่มต้น tossapol.b@) เท่านั้น — ไม่เปิดทั้ง role COORDINATOR
// (กฤตพลก็เป็น COORDINATOR) · ปุ่มบนหน้า /admin/[id] อ่านกฎเดียวกันผ่าน /api/me
let sessUser: any = null
mock.module('next/headers', { namedExports: { headers: () => new Headers({}) } })
mock.module('next-auth', { namedExports: { getServerSession: async () => (sessUser ? { user: sessUser } : null) } })
mock.module('../auth', { namedExports: { authOptions: {} } })
mock.module('../db', { namedExports: { prisma: { booking: { findUnique: async () => null } } } })
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../calendar-reconcile', { namedExports: { pushCalendarDetails: async () => true } })
mock.module('../google-sheets', { namedExports: { updateBookingRow: async () => 'updated', joinEpisodeTitles: () => '' } })

let canRemoveEpisodes: (s: any) => boolean
let removeEps: (req: any, ctx: any) => Promise<Response>
before(async () => {
  ;({ canRemoveEpisodes } = await import('../session'))
  removeEps = (await import('../../app/api/admin/[id]/remove-episodes/route')).POST
})
afterEach(() => { delete process.env.EPISODE_REMOVER_EMAILS; sessUser = null })

const TUY = 'tossapol.b@thestandard.co'
const KRIT = 'krittapon.j@thestandard.co'

test('canRemoveEpisodes: ADMIN ได้ · ตุ้ย (COORDINATOR) ได้ · COORDINATOR คนอื่นไม่ได้ · USER ในลิสต์ไม่ได้', () => {
  assert.equal(canRemoveEpisodes({ email: 'x@thestandard.co', role: 'ADMIN' }), true)
  assert.equal(canRemoveEpisodes({ email: 'Tossapol.B@thestandard.co', role: 'COORDINATOR' }), true)
  assert.equal(canRemoveEpisodes({ email: KRIT, role: 'COORDINATOR' }), false)
  assert.equal(canRemoveEpisodes({ email: TUY, role: 'USER' }), false)
  assert.equal(canRemoveEpisodes(null), false)
})

test('canRemoveEpisodes: EPISODE_REMOVER_EMAILS แทนค่าเริ่มต้นได้ (ไม่ต้อง deploy)', () => {
  process.env.EPISODE_REMOVER_EMAILS = ' Someone@thestandard.co , '
  assert.equal(canRemoveEpisodes({ email: 'someone@thestandard.co', role: 'COORDINATOR' }), true)
  assert.equal(canRemoveEpisodes({ email: TUY, role: 'COORDINATOR' }), false)
})

const post = () => new Request('https://probook.test/api', { method: 'POST', body: JSON.stringify({ episodeRowIds: ['e1'], dryRun: true }) }) as any
const ctx = { params: { id: 'b1' } }

test('route: COORDINATOR ที่ไม่อยู่ในลิสต์ → 403 · ตุ้ยและ ADMIN ผ่านด่าน (ไปถึง 404 ใบไม่พบ)', async () => {
  sessUser = { email: KRIT, role: 'COORDINATOR', active: true }
  assert.equal((await removeEps(post(), ctx)).status, 403)
  sessUser = { email: TUY, role: 'COORDINATOR', active: true }
  assert.equal((await removeEps(post(), ctx)).status, 404)
  sessUser = { email: 'narasit.k@thestandard.co', role: 'ADMIN', active: true }
  assert.equal((await removeEps(post(), ctx)).status, 404)
  sessUser = null
  assert.equal((await removeEps(post(), ctx)).status, 403)
})
