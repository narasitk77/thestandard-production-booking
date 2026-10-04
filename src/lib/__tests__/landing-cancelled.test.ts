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
let cancelledRows: Array<{ bookingCode: string; driveFolders: any }> = []
let items: Record<string, { name: string; trashed?: boolean } | Error | undefined> = {}
let sharing: Record<string, number> = {}
let walkError: string | null = null
let reconfirmed: string[] = []

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        // the create pass filters on status IN (CONFIRMED, COMPLETED) + a date window; nothing to create in these tests
        findMany: async ({ where }: any) => (where?.status === 'CANCELLED' ? cancelledRows : where?.status ? [] : bookings),
        count: async ({ where }: any) => sharing[where?.driveFolders?.equals] ?? 1,
        findFirst: async ({ where }: any) => ({ status: reconfirmed.includes(where?.bookingCode) ? 'CONFIRMED' : 'CANCELLED' }),
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
    listEverythingUnder: async (id: string) => {
      if (walkError === id) throw new Error('Drive 500')
      const names = contents[id] || []
      return { names, truncated: names.length >= 200 }
    },
    getDriveItemState: async (id: string) => {
      const it = items[id]
      if (it instanceof Error) throw it
      return it ? { id, name: it.name, mimeType: 'folder', trashed: !!it.trashed, trashedTime: null, driveId: 'd' } : null
    },
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
  cancelledRows = []; items = {}; sharing = {}; walkError = null; reconfirmed = []
})

// ── v1.259 — กล่องงาน / staging / รูป ของงานที่ยกเลิก ─────────────────────────

test('v1.259: กล่องว่าง (มีแต่ _SHOOT.txt / _FOOTAGE-CHECK) ของงานยกเลิก → ทิ้ง · staging ว่าง → ทิ้ง', async () => {
  cancelledRows = [{ bookingCode: 'TSS-TSC-260925-01', driveFolders: { box: 'b1', staging: 's1', landing: 'gone' } }]
  items = { b1: { name: 'The Secret Short Clip · Whyology EP.3 (TSS-TSC-260925-01)' }, s1: { name: 'Whyology EP.3 (TSS-TSC-260925-01)' } }
  contents.b1 = ['_SHOOT.txt', '_FOOTAGE-CHECK', '.DS_Store']; contents.s1 = []
  const r = await lc.trashCancelledBookingFolders({ dryRun: false })
  assert.deepEqual(trashed.sort(), ['b1', 's1'])
  assert.deepEqual(r.trashed.map(t => t.kind).sort(), ['box', 'staging'])
})

test('v1.259: มีไฟล์ (รวม Google Doc ที่คนวางไว้) → เก็บ + รายงาน · ชื่อไม่ใช่ของคิว / กล่องใช้ร่วม / อยู่ในถังแล้ว / อ่านไม่ได้ → ไม่ทิ้ง', async () => {
  cancelledRows = [
    { bookingCode: 'NWS-KYM-260928-01', driveFolders: { box: 'withFiles' } },
    { bookingCode: 'NWS-TWD-260714-01', driveFolders: { box: 'withDoc' } },
    { bookingCode: 'AGN-260929-02', driveFolders: { box: 'projectBox' } },
    { bookingCode: 'AGN-260929-03', driveFolders: { box: 'shared' } },
    { bookingCode: 'AGN-260929-04', driveFolders: { box: 'already' } },
    { bookingCode: 'AGN-260929-05', driveFolders: { box: 'broken' } },
    { bookingCode: 'AGN-260929-06', driveFolders: { box: 'walkfail' } },
  ]
  items = {
    withFiles: { name: 'Key Message · อาชญากรรมเด็ก (NWS-KYM-260928-01)' },
    withDoc: { name: 'The World Dialogue (NWS-TWD-260714-01)' },
    projectBox: { name: 'GDH x 8 Minute History (PP-26-034)' },
    shared: { name: 'X (AGN-260929-03)' },
    already: { name: 'X (AGN-260929-04)', trashed: true },
    broken: new Error('rateLimitExceeded'),
    walkfail: { name: 'X (AGN-260929-06)' },
  }
  contents.withFiles = ['MEDIAPRO.XML', 'SONYCARD.IND']
  contents.withDoc = ['บทสัมภาษณ์']      // a Google Doc — listFilesRecursive would not see it
  contents.shared = []
  sharing.shared = 2
  walkError = 'walkfail'
  const r = await lc.trashCancelledBookingFolders({ dryRun: false })
  assert.deepEqual(trashed, [])
  assert.deepEqual(r.keptWithFiles.map(k => [k.code, k.kind]), [['NWS-KYM-260928-01', 'box'], ['NWS-TWD-260714-01', 'box']])
  assert.deepEqual(r.skipped.map(s => s.code), ['AGN-260929-02', 'AGN-260929-03'])
  assert.equal(r.errors, 2)
  assert.match(lc.cancelledLandingText(r.keptWithFiles), /กล่องงาน · VIDEO/)
})

test('v1.259: dry-run ตัดสินเหมือนจริงแต่ไม่ทิ้ง · ไฟล์เกินเพดาน = ถือว่าไม่ว่าง', async () => {
  cancelledRows = [{ bookingCode: 'TSS-TSC-260925-01', driveFolders: { box: 'b1', staging: 'big' } }]
  items = { b1: { name: 'X (TSS-TSC-260925-01)' }, big: { name: 'Y (TSS-TSC-260925-01)' } }
  contents.b1 = []
  contents.big = Array.from({ length: 200 }, () => '_SHOOT.txt')
  const r = await lc.trashCancelledBookingFolders({ dryRun: true })
  assert.deepEqual(trashed, [])
  assert.deepEqual(r.trashed.map(t => t.kind), ['box'])
  assert.deepEqual(r.keptWithFiles.map(k => k.kind), ['staging'])
})

test('รอบ 19:00: งานยกเลิกที่ว่าง → ทิ้ง (แม้เป็นงานพรุ่งนี้) · ยกเลิกแต่มีไฟล์ → เก็บ + รายงาน · งานจริงที่กล่องยังไม่มีฟุตเทจ → เก็บเหมือนเดิม', async () => {
  const r = await lc.manageLandingFolders({ dryRun: false })
  assert.deepEqual(trashed.sort(), ['tmr', 'why'])
  assert.deepEqual(r.cancelledWithFiles, [{ name: folders[2].name, code: 'TSS-TSC-260930-01', id: 'misdrop', kind: 'landing' }])
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

test('v1.259 รีวิว: ใบที่กลับมายืนยันระหว่างรอบ (อ่านสถานะซ้ำก่อนทิ้ง) → ไม่ทิ้ง', async () => {
  cancelledRows = [{ bookingCode: 'AGN-261010-01', driveFolders: { box: 'b9' } }]
  items = { b9: { name: 'X (AGN-261010-01)' } }
  contents.b9 = []
  reconfirmed = ['AGN-261010-01']
  const r = await lc.trashCancelledBookingFolders({ dryRun: false })
  assert.deepEqual(trashed, [])
  assert.match(r.skipped[0].reason, /สถานะเปลี่ยนระหว่างรอบ/)
})
