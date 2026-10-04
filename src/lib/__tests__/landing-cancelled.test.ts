/**
 * v1.258 — โฟลเดอร์ drop ของงานที่ยกเลิก (เคสจริง 4 ต.ค. 2569)
 *
 * TSS-TSC-260925-01 ยกเลิก 25 ก.ย. แต่โฟลเดอร์ drop ค้าง 9 วัน (กฎ "ทิ้งได้เมื่อกล่องมีฟุตเทจ" ไม่มีวันเป็นจริงกับงานที่ยกเลิก)
 * → 1 ต.ค. คลิปของ TSS-TSS-261001-01 ถูกลากลงโฟลเดอร์ชื่อคล้ายกันนี้ ไม่มีใครย้าย ไม่มีใครถูกเตือน
 * กฎ: งานยกเลิก + ว่าง = ทิ้ง (ทั้งรอบ 19:00 และรอบเที่ยง ไม่ว่าวันไหน) · งานยกเลิก + มีไฟล์ = ห้ามทิ้ง + ร้อง
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let bookings: Array<{ bookingCode: string; shootDate: Date; shootEndDate: Date | null; status: string }> = []
let folders: Array<{ id: string; name: string }> = []
let contents: Record<string, string[]> = {}
let trashed: string[] = []
let boxState: Record<string, string> = {}

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        // the create pass filters on status IN (CONFIRMED, COMPLETED) + a date window; nothing to create in these tests
        findMany: async ({ where }: any) => (where?.status ? [] : bookings),
      },
    },
  },
})
mock.module('../google-drive', {
  namedExports: {
    hasDriveCredentials: () => true,
    listChildFolders: async () => folders,
    listFilesRecursive: async (id: string) => (contents[id] || []).map(name => ({ id: `${id}/${name}`, name })),
    trashDriveItem: async (id: string) => { trashed.push(id) },
    ensureFlatShootFolders: async () => ({ bookingFolderId: 'x' }),
    findFoldersByCode: async () => [],
    isFootageTreeFolder: async () => true,
  },
})
mock.module('../landing-duplicates', {
  namedExports: { boxFootageState: async (code: string) => ({ state: boxState[code] || 'no-footage', files: 0, reason: 'test' }) },
})
mock.module('../drive-links', { namedExports: { rememberDriveLinks: async () => {} } })

let lc: typeof import('../landing-lifecycle')
before(async () => { lc = await import('../landing-lifecycle') })

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000)
beforeEach(() => {
  trashed = []
  boxState = {}
  bookings = [
    { bookingCode: 'TSS-TSC-260925-01', shootDate: day(-9), shootEndDate: null, status: 'CANCELLED' },  // the real case, empty
    { bookingCode: 'AGN-261005-01', shootDate: day(1), shootEndDate: null, status: 'CANCELLED' },      // tomorrow, cancelled
    { bookingCode: 'TSS-TSC-260930-01', shootDate: day(-4), shootEndDate: null, status: 'CANCELLED' },  // cancelled but files landed
    { bookingCode: 'TSS-TSS-261001-01', shootDate: day(-5), shootEndDate: null, status: 'COMPLETED' },  // live, past the 3-day grace, empty, box has no footage
  ]
  folders = [
    { id: 'why', name: 'The Secret Short Clip · Whyology EP.3 (TSS-TSC-260925-01)' },
    { id: 'tmr', name: 'GDH x 8 Minute History (AGN-261005-01)' },
    { id: 'misdrop', name: 'The Secret Short Clip · X (TSS-TSC-260930-01)' },
    { id: 'osot', name: 'The Secret Sauce · Osotspa (TSS-TSS-261001-01)' },
  ]
  contents = { why: ['_SHOOT.txt'], tmr: [], misdrop: ['A024C003_261001MM.MP4'], osot: [] }
})

test('รอบ 19:00: งานยกเลิกที่ว่าง → ทิ้ง (แม้เป็นงานพรุ่งนี้) · ยกเลิกแต่มีไฟล์ → เก็บ + รายงาน · งานจริงที่กล่องยังไม่มีฟุตเทจ → เก็บเหมือนเดิม', async () => {
  const r = await lc.manageLandingFolders({ dryRun: false })
  assert.deepEqual(trashed.sort(), ['tmr', 'why'])
  assert.deepEqual(r.cancelledWithFiles, [{ name: folders[2].name, code: 'TSS-TSC-260930-01', id: 'misdrop' }])
  assert.deepEqual(r.keptNoFootage.map(k => k.code), ['TSS-TSS-261001-01'], 'กฎ v1.225 ของงานจริงไม่เปลี่ยน')
})

test('รอบเที่ยง (prune=today): กฎเดียวกัน · ยกเลิกแต่มีไฟล์ ยังนับใน keptWithFiles ด้วย (ผู้อ่านเดิมไม่หลุด)', async () => {
  const r = await lc.pruneLandingToToday({ dryRun: false })
  assert.ok(trashed.includes('why') && trashed.includes('tmr'))
  assert.ok(!trashed.includes('misdrop'))
  assert.deepEqual(r.cancelledWithFiles.map(c => c.id), ['misdrop'])
  assert.ok(r.keptWithFiles.includes(folders[2].name))
})

test('dry-run ตัดสินเหมือนจริงแต่ไม่ทิ้งอะไร', async () => {
  const r = await lc.manageLandingFolders({ dryRun: true })
  assert.deepEqual(trashed, [])
  assert.ok(r.actions.some(a => a.includes('trash cancelled-booking landing') && a.includes('Whyology')))
})

test('ข้อความเตือนบอกลิงก์และสิ่งที่ต้องทำ · ว่าง = ไม่มีข้อความ', () => {
  assert.equal(lc.cancelledLandingText([]), '')
  const t = lc.cancelledLandingText([{ name: 'X (TSS-TSC-260930-01)', code: 'TSS-TSC-260930-01', id: 'abc' }])
  assert.match(t, /ยกเลิกแล้ว/)
  assert.match(t, /drive\.google\.com\/drive\/folders\/abc/)
  assert.match(t, /ห้ามลบ/)
})
