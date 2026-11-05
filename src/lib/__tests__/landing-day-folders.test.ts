/**
 * v1.280 — โฟลเดอร์รายวันของงานหลายวัน (EP/CAM-X/D<n>-<yymmdd>)
 *
 * AGN-261104-01 ถ่าย 4–6 พ.ย. EP เดียว: การ์ดทุกวันถูกเทลง EP/CAM-X เดียวกัน → video-merge (dedup ชื่อ|ขนาด
 * ต่อโฟลเดอร์) วาง MEDIAPRO.XML ของวันที่ 2 ข้างของวันที่ 1 หรือทิ้ง SONYCARD.IND ค้างใน landing ตลอดไป
 *
 * สิ่งที่ล็อกไว้ที่นี่: แผนชั้นวัน (อ่านอย่างเดียว) รันก่อนสร้างอะไร **เหมือนกันทั้ง dryRun และรอบจริง** → พรีวิวตรงของจริง ·
 * landing แบบ v1.279 (ช่องกล้อง + ลิงก์) ก่อนชั้นวันเสมอ แล้วชั้นวัน **กล่องก่อน** ค่อย landing
 * (กล่อง CAM-X ที่ไม่ว่าง = merge ลงไปทีละวัน) · งานวันเดียวเรียก Drive **เหมือนเดิมทุกตัวอักษร** ·
 * LANDING_DAY_FOLDERS=0 ปิดได้ · ฝั่งกล่องไม่ครบ / เลื่อนวัน / delivered-check ล้ม = ไม่มีโฟลเดอร์วันใน landing + เตือน ไม่ใช่เงียบ ·
 * approve: landing รอ pre-create กล่องก่อน (ensureLandingAfterBox)
 */
import { test, mock, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { landingBookingFolderName } from '../outlet-folders'

type Row = Record<string, any>
let booking: Row
let calls: Array<[string, any]> = []
let live: 'alive' | 'dead' | 'unknown' = 'alive'
let camKids: Array<{ id: string; name: string }> = []
let missingEpisodes: string[] = []
let boxMissingAtCreate: string[] = []
let boxThrows = false
let planThrows = false
let landingDaysThrow = false
let deliveredThrows = false
let existingLanding: string | null = null // a landing already on Drive (the reschedule guard reads its first camera slot)
let remembered: any[] = []
let lookups = 0

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findFirst: async () => { lookups++; return booking },
        // create pass (status IN …) → this booking · cleanup pass → nothing to clean
        findMany: async ({ where }: any) => (where?.status?.in ? [booking] : []),
      },
    },
  },
})
mock.module('../google-drive', {
  namedExports: {
    hasDriveCredentials: () => true,
    findFoldersByCode: async () => { if (deliveredThrows) throw new Error('Drive 503'); return [] },
    isFootageTreeFolder: async () => true,
    listFilesRecursive: async () => [],
    // the landing's first camera slot (reschedule guard) is logged; the sweep's Production Team listing is not
    listChildFolders: async (id: string) => { if (id.startsWith('cam-')) { calls.push(['listChildFolders', id]); return camKids } return [] },
    folderLiveness: async (id: string) => { calls.push(['folderLiveness', id]); return live },
    // read-only lookups of the plan: the existing landing → its EP → its first camera slot; the box's EPs
    findChildFolderByCode: async (_root: string, code: string) => { calls.push(['findChildFolderByCode', code]); return existingLanding },
    findEpisodeFolders: async (parent: string, names: string[]) => {
      calls.push(['findEpisodeFolders', [parent, names]])
      if (planThrows) throw new Error('Drive 503')
      if (parent === existingLanding) return { ids: names.map(() => 'ep-l1'), missing: [] }
      return { ids: names.filter(n => !missingEpisodes.includes(n)).map(() => 'ep-b1'), missing: names.filter(n => missingEpisodes.includes(n)) }
    },
    findChildFolder: async (parent: string, name: string) => { calls.push(['findChildFolder', [parent, name]]); return parent === 'ep-l1' ? 'cam-1' : null },
    ensureBoxDayFolders: async (input: any) => {
      calls.push(['ensureBoxDayFolders', input])
      if (boxThrows) throw new Error('rateLimitExceeded')
      return { missingEpisodes: boxMissingAtCreate }
    },
    ensureDayFolders: async (cams: string[], days: string[]) => {
      calls.push(['ensureDayFolders', [cams, days]])
      if (landingDaysThrow) throw new Error('Drive 500')
    },
    ensureFlatShootFolders: async (input: any) => { calls.push(['ensureFlatShootFolders', input]); return { bookingFolderId: 'landing-1', cameraFolderIds: CAM_IDS } },
  },
})
mock.module('../landing-duplicates', { namedExports: { boxFootageState: async () => ({ state: 'no-footage', files: 0, reason: 'test' }) } })
mock.module('../drive-links', {
  namedExports: {
    rememberDriveLinks: async (id: string, links: any) => { remembered.push([id, links]) },
    getDriveLink: (df: any, k: string) => (df && typeof df[k] === 'string' ? df[k] : null),
  },
})

let lc: typeof import('../landing-lifecycle')
before(async () => { lc = await import('../landing-lifecycle') })

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const DAYS = ['D1-261104', 'D2-261105', 'D3-261106']
const CAM_IDS = ['cam-1', 'cam-2', 'cam-3']
const original = process.env.LANDING_DAY_FOLDERS
beforeEach(() => {
  delete process.env.LANDING_DAY_FOLDERS
  calls = []; live = 'alive'; camKids = []; missingEpisodes = []; boxMissingAtCreate = []; boxThrows = false; planThrows = false
  landingDaysThrow = false; deliveredThrows = false; existingLanding = null; remembered = []; lookups = 0
  booking = {
    id: 'b1', bookingCode: 'AGN-261104-01', status: 'CONFIRMED', cameraCount: 2, micCount: 1,
    shootDate: d('2026-11-04'), shootEndDate: d('2026-11-06'), callTime: '08:00', estimatedWrap: '19:30',
    driveFolders: { box: 'box-folder-id-1' }, projectName: 'Event', outlet: { code: 'AGN' },
    program: { code: 'AGN', name: 'Content Agency' },
    episodes: [{ episodeId: 'PP-26-040-L01', sequence: 1, title: 'Event', program: { code: 'AGN', name: 'Content Agency' } }],
  }
})
afterEach(() => {
  if (original === undefined) delete process.env.LANDING_DAY_FOLDERS
  else process.env.LANDING_DAY_FOLDERS = original
})

/** the exact ensureFlatShootFolders input every booking got before v1.280 */
const v1279Landing = () => ({
  rootFolderId: process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA',
  bookingCode: 'AGN-261104-01', bookingFolderName: landingBookingFolderName(booking as any),
  cameras: ['CAM-A', 'CAM-B', 'AUDIO'], episodeFolderNames: ['PP-26-040-L01 · Event'],
})

const EP = 'PP-26-040-L01 · Event'
/** fresh landing: plan (no landing yet · box alive · box EPs) → v1.279 landing → box days → landing days */
const DAY_CALLS = ['findChildFolderByCode', 'folderLiveness', 'findEpisodeFolders', 'ensureFlatShootFolders', 'ensureBoxDayFolders', 'ensureDayFolders']
const CREATES = new Set(['ensureFlatShootFolders', 'ensureBoxDayFolders', 'ensureDayFolders'])
const callNames = () => calls.map(c => c[0])
const call = (name: string) => calls.find(c => c[0] === name)

test('multi-day, one EP: read-only plan, then the v1.279 landing, then day folders in the BOX, then the landing', async () => {
  const r = await lc.ensureLandingForBooking('AGN-261104-01')
  assert.equal(r.ok, true)
  assert.deepEqual(r.dayFolders, DAYS)
  assert.equal(r.warnings, undefined)
  assert.deepEqual(callNames(), DAY_CALLS)
  assert.deepEqual(call('findEpisodeFolders')![1], ['box-folder-id-1', [EP]])          // plan: every EP is in the box
  assert.deepEqual(call('ensureFlatShootFolders')![1], v1279Landing())                 // camera slots exactly as before — no day key
  assert.deepEqual(call('ensureBoxDayFolders')![1], { boxFolderId: 'box-folder-id-1', episodeFolderNames: [EP], cameras: ['CAM-A', 'CAM-B', 'AUDIO'], dayFolders: DAYS })
  assert.deepEqual(call('ensureDayFolders')![1], [CAM_IDS, DAYS])
  assert.deepEqual(remembered, [['b1', { landing: 'landing-1' }]])
})

test('single-day booking: exactly the v1.279 Drive calls — no box probe, no day folders', async () => {
  booking.shootEndDate = null
  const r = await lc.ensureLandingForBooking('AGN-261104-01')
  assert.deepEqual(r, { ok: true, dryRun: false, bookingCode: 'AGN-261104-01', created: landingBookingFolderName(booking as any), folderId: 'landing-1', url: 'https://drive.google.com/drive/folders/landing-1' })
  assert.deepEqual(calls, [['ensureFlatShootFolders', v1279Landing()]])
})

test('LANDING_DAY_FOLDERS=0 turns the day layer off: a multi-day booking gets the v1.279 calls', async () => {
  process.env.LANDING_DAY_FOLDERS = '0'
  const r = await lc.ensureLandingForBooking('AGN-261104-01')
  assert.equal(r.dayFolders, undefined)
  assert.deepEqual(calls, [['ensureFlatShootFolders', v1279Landing()]])
})

/** the box-short / reschedule cases: [label, arrange, the warning] — the plan sees each before anything is created */
const SHORT: Array<[string, () => void, RegExp]> = [
  ['no box link', () => { booking.driveFolders = {} }, /driveFolders\.box/],
  ['box trashed', () => { live = 'dead' }, /ไม่อยู่แล้ว/],
  ['Drive unsure', () => { live = 'unknown' }, /ตรวจกล่องไม่ได้ \(Drive\)/],
  ['EP missing', () => { missingEpisodes = [EP] }, /กล่องไม่มี EP PP-26-040-L01/],
  ['plan read error', () => { planThrows = true }, /ตรวจโฟลเดอร์วันไม่ได้ \(Drive\): Drive 503/],
  ['rescheduled', () => { existingLanding = 'landing-1'; camKids = [{ id: 'x1', name: 'D1-261103' }, { id: 'x2', name: 'D2-261104' }] }, /D1-261103, D2-261104.*เปลี่ยนชื่อ/],
]
const resetCase = () => {
  calls = []; remembered = []; live = 'alive'; missingEpisodes = []; boxMissingAtCreate = []; boxThrows = false; planThrows = false
  existingLanding = null; camKids = []; booking.driveFolders = { box: 'box-folder-id-1' }
}

test('plan says no (no box / dead / Drive unsure / EP missing / read error / rescheduled) → NO day folders on EITHER side, a warning, the v1.279 landing', async () => {
  for (const [label, arrange, want] of SHORT) {
    resetCase(); arrange()
    const r = await lc.ensureLandingForBooking('AGN-261104-01')
    assert.equal(r.ok, true, label)
    assert.equal(r.dayFolders, undefined, label)
    assert.equal(r.warnings?.length, 1, label)
    assert.match(r.warnings![0], want, label)
    assert.match(r.warnings![0], /ไม่สร้างโฟลเดอร์วัน/, label)
    assert.ok(!calls.some(c => c[0] === 'ensureBoxDayFolders' || c[0] === 'ensureDayFolders'), `${label}: no day folder may be made`)
    assert.deepEqual(call('ensureFlatShootFolders'), ['ensureFlatShootFolders', v1279Landing()], label) // the drop slots still exist
    assert.deepEqual(remembered, [['b1', { landing: 'landing-1' }]], label)                         // and the landing link is kept
  }
})

test('G3: dryRun answers exactly what the real run does — happy path and every plan-says-no case — and creates nothing', async () => {
  for (const [label, arrange] of [['happy path', () => {}] as [string, () => void], ...SHORT.map(([l, a]) => [l, a] as [string, () => void])]) {
    resetCase(); arrange()
    const real = await lc.ensureLandingForBooking('AGN-261104-01')
    resetCase(); arrange()
    const dry = await lc.ensureLandingForBooking('AGN-261104-01', { dryRun: true })
    assert.deepEqual({ dayFolders: dry.dayFolders, warnings: dry.warnings }, { dayFolders: real.dayFolders, warnings: real.warnings }, label)
    assert.ok(!calls.some(c => CREATES.has(c[0])), `${label}: dryRun must not create`)
  }
})

test('rescheduled after the landing existed: the guard reads the EXISTING landing (EP → first camera slot) before anything is created', async () => {
  existingLanding = 'landing-1'
  camKids = [{ id: 'x1', name: 'D1-261103' }, { id: 'x2', name: 'D2-261104' }]
  const r = await lc.ensureLandingForBooking('AGN-261104-01')
  assert.deepEqual(callNames(), ['findChildFolderByCode', 'findEpisodeFolders', 'findChildFolder', 'listChildFolders', 'ensureFlatShootFolders'])
  assert.deepEqual(call('findEpisodeFolders')![1], ['landing-1', [EP]])
  assert.deepEqual(call('findChildFolder')![1], ['ep-l1', 'CAM-A'])
  assert.equal(r.dayFolders, undefined)

  // the SAME set already there (a re-run on the next night) is not a reschedule
  calls = []; camKids = [{ id: 'x1', name: 'D1-261104' }, { id: 'x9', name: 'Card 2' }]
  const again = await lc.ensureLandingForBooking('AGN-261104-01')
  assert.deepEqual(callNames(), ['findChildFolderByCode', 'findEpisodeFolders', 'findChildFolder', 'listChildFolders', 'folderLiveness', 'findEpisodeFolders', ...DAY_CALLS.slice(3)])
  assert.equal(again.warnings, undefined)
  assert.deepEqual(again.dayFolders, DAYS)
})

test('create step still guards itself: box write error / an EP gone since the plan → no landing day folders, a warning', async () => {
  for (const [label, arrange, want] of [
    ['box error', () => { boxThrows = true }, /ทำโฟลเดอร์วันฝั่งกล่องไม่สำเร็จ: rateLimitExceeded/],
    ['EP vanished after the plan', () => { boxMissingAtCreate = [EP] }, /กล่องไม่มี EP PP-26-040-L01/],
  ] as Array<[string, () => void, RegExp]>) {
    resetCase(); arrange()
    const r = await lc.ensureLandingForBooking('AGN-261104-01')
    assert.equal(r.dayFolders, undefined, label)
    assert.match(r.warnings![0], want, label)
    assert.ok(!calls.some(c => c[0] === 'ensureDayFolders'), label)
    assert.deepEqual(remembered, [['b1', { landing: 'landing-1' }]], label)
  }
})

test('delivered-check throws → the v1.279 landing, no day folders, and a warning (dryRun says the same)', async () => {
  deliveredThrows = true
  const r = await lc.ensureLandingForBooking('AGN-261104-01')
  assert.equal(r.ok, true)
  assert.equal(r.dayFolders, undefined)
  assert.equal(r.warnings?.length, 1)
  assert.deepEqual(calls, [['ensureFlatShootFolders', v1279Landing()]])
  const dry = await lc.ensureLandingForBooking('AGN-261104-01', { dryRun: true })
  assert.equal(dry.dayFolders, undefined)
  assert.deepEqual(dry.warnings, r.warnings)
})

test('landing day pass fails → camera slots and the landing link are already there; the warning says so', async () => {
  landingDaysThrow = true
  const r = await lc.ensureLandingForBooking('AGN-261104-01')
  assert.equal(r.ok, true)
  assert.equal(r.folderId, 'landing-1')
  assert.deepEqual(remembered, [['b1', { landing: 'landing-1' }]])
  assert.match(r.warnings![0], /landing ไม่ครบ/)
  assert.equal(r.dayFolders, undefined)
})

test('dryRun plans the day folders (read-only) without creating anything', async () => {
  const r = await lc.ensureLandingForBooking('AGN-261104-01', { dryRun: true })
  assert.deepEqual(r.dayFolders, DAYS)
  assert.deepEqual(callNames(), DAY_CALLS.slice(0, 3))
})

test('nightly sweep: plan, v1.279 landing, then box days, then landing days; a short box half counts as a create error (loud)', async () => {
  const ok = await lc.manageLandingFolders({ dryRun: false })
  assert.equal(ok.created, 1)
  assert.equal(ok.createErrors, 0)
  assert.deepEqual(callNames(), DAY_CALLS)
  assert.deepEqual(call('ensureFlatShootFolders')![1], v1279Landing())
  assert.deepEqual(call('ensureDayFolders')![1], [CAM_IDS, DAYS])
  assert.ok(ok.actions[0].includes('D1-261104, D2-261105, D3-261106'))

  calls = []; live = 'unknown'
  const warned = await lc.manageLandingFolders({ dryRun: false })
  assert.equal(warned.created, 1)
  assert.equal(warned.createErrors, 1)
  assert.ok(warned.actions.some(a => a.includes('WARN day folders AGN-261104-01') && a.includes('ตรวจกล่องไม่ได้ (Drive)')))
  assert.ok(!warned.actions[0].includes('โฟลเดอร์วัน')) // the create line no longer promises day folders
  assert.ok(!calls.some(c => c[0] === 'ensureDayFolders' || c[0] === 'ensureBoxDayFolders'))
})

test('G3: the sweep dryRun prints the real run\'s lines — "+ โฟลเดอร์วัน" only when the plan says they will be made', async () => {
  for (const [label, arrange] of [['happy path', () => {}] as [string, () => void], ...SHORT.map(([l, a]) => [l, a] as [string, () => void])]) {
    resetCase(); arrange()
    const real = await lc.manageLandingFolders({ dryRun: false })
    resetCase(); arrange()
    const dry = await lc.manageLandingFolders({ dryRun: true })
    assert.deepEqual({ created: dry.created, createErrors: dry.createErrors, actions: dry.actions }, { created: real.created, createErrors: real.createErrors, actions: real.actions }, label)
    assert.ok(!calls.some(c => CREATES.has(c[0])), `${label}: dryRun must not create`)
    assert.equal(real.actions[0].includes('+ โฟลเดอร์วัน'), label === 'happy path', label)
  }
})

test('nightly sweep, single-day booking: the v1.279 call and action line', async () => {
  booking.shootEndDate = null
  const r = await lc.manageLandingFolders({ dryRun: false })
  assert.deepEqual(calls, [['ensureFlatShootFolders', v1279Landing()]])
  assert.equal(r.actions[0], `create landing "${landingBookingFolderName(booking as any)}" (2026-11-04)`)
})

test('G6 approve: the imminent landing waits for the box pre-create (box first); a failed pre-create never blocks it', async () => {
  let release!: () => void
  const boxPrecreate = new Promise<void>(res => { release = res })
  const pending = lc.ensureLandingAfterBox(boxPrecreate, 'AGN-261104-01')
  for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res))
  assert.equal(lookups, 0, 'the landing must not even read the booking before the box pre-create is done')
  assert.deepEqual(calls, [])
  release()
  const r = await pending
  assert.equal(r.ok, true)
  assert.deepEqual(r.dayFolders, DAYS)
  assert.deepEqual(callNames(), DAY_CALLS)

  calls = []
  const failed = await lc.ensureLandingAfterBox(Promise.reject(new Error('box pre-create 500')), 'AGN-261104-01')
  assert.equal(failed.ok, true)
  assert.deepEqual(call('ensureFlatShootFolders'), ['ensureFlatShootFolders', v1279Landing()])
})
