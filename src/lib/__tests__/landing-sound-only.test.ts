/**
 * v1.285 — โฟลเดอร์ drop ของ "งานเสียงล้วน" (นัทสั่ง 11 พ.ย. 2569: "ให้ worker ทิ้งโฟลเดอร์งานเสียงล้วนได้")
 *
 * กฎ v1.225 "ว่าง ≠ ส่งงานแล้ว" ทิ้งโฟลเดอร์ว่างเฉพาะเมื่อกล่องมีฟุตเทจ **กล้อง** — งานเสียงล้วนไม่มีวันมี
 * จึงค้างถาวร (6 ใบ ณ 11 พ.ย. · มีเสียงในกล่องจริงแค่ 3 ใบ อีก 3 ใบกล่องมีแต่ stub)
 *
 * ไฟล์นี้ล็อก "การต่อสาย" ระหว่างใบจองกับตัวตัดสิน: ใบที่เป็นงานเสียงล้วนด้วยหลักฐานบวก (isSoundOnlyBooking)
 * ส่ง `soundOnly: true` · ใบอื่นทั้งหมด (รวมใบข้อมูลไม่ครบ) ส่ง false · และผลทิ้ง/เก็บตามคำตัดสินของ boxFootageState ทั้งรอบ 19:00
 * และรอบเที่ยง (ตัวตัดสินเองมีเทสต์ใน box-footage-state.test.ts)
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

type B = { bookingCode: string; shootDate: Date; shootEndDate: Date | null; status: string; cameraCount: number | null; crewRequired: string[]; isBlockShot?: boolean }
let bookings: B[] = []
let folders: Array<{ id: string; name: string }> = []
let trashed: string[] = []
let boxState: Record<string, 'has-footage' | 'no-footage' | 'unknown'> = {}
let calls: Array<{ code: string; soundOnly: boolean | undefined }> = []

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        // the create pass filters on status IN (CONFIRMED, COMPLETED) + a date window — nothing to create here;
        // the cleanup/prune pass reads every booking (no status filter)
        findMany: async ({ where }: any) => (where?.status ? [] : bookings),
        count: async () => 1,
        findFirst: async () => ({ status: 'COMPLETED' }),
      },
    },
  },
})
mock.module('../google-drive', {
  namedExports: {
    hasDriveCredentials: () => true,
    listChildFolders: async () => folders,
    listFilesRecursive: async () => [], // every drop folder is empty
    trashDriveItem: async (id: string) => { trashed.push(id) },
    ensureFlatShootFolders: async () => ({ bookingFolderId: 'x' }),
    findFoldersByCode: async () => [],
    isFootageTreeFolder: async () => true,
    listEverythingUnder: async () => ({ names: [], truncated: false }),
    getDriveItemState: async () => null,
  },
})
mock.module('../landing-duplicates', {
  namedExports: {
    boxFootageState: async (code: string, opts: { soundOnly?: boolean } = {}) => {
      calls.push({ code, soundOnly: opts.soundOnly })
      const state = boxState[code] || 'no-footage'
      return state === 'has-footage' ? { state, files: 3 } : { state, reason: `test: ${state}` }
    },
  },
})
mock.module('../drive-links', { namedExports: { rememberDriveLinks: async () => {} } })

let lc: typeof import('../landing-lifecycle')
before(async () => { lc = await import('../landing-lifecycle') })

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000)
const past = (bookingCode: string, cameraCount: number | null, crewRequired: string[], isBlockShot = false): B =>
  ({ bookingCode, shootDate: day(-9), shootEndDate: null, status: 'COMPLETED', cameraCount, crewRequired, isBlockShot })
const soundOf = (code: string) => calls.find(c => c.code === code)?.soundOnly

beforeEach(() => {
  trashed = []; calls = []; boxState = {}
  bookings = [
    past('SND-1', 0, ['Sound']),                    // sound-only, audio in the box
    past('SND-2', 0, ['Sound']),                    // sound-only, box has only stubs
    past('VID-1', 3, ['Videographer', 'Sound']),    // camera job, box has no video yet
    past('VID-2', 3, ['Videographer']),             // camera job, box has video
    past('VID-3', 0, ['Videographer']),             // no cameras booked but a video crew role → still expects video
  ]
  folders = [
    { id: 'f-snd1', name: 'Bookmark x A (SND-1)' }, { id: 'f-snd2', name: 'Bookmark x B (SND-2)' },
    { id: 'f-vid1', name: 'Show · One (VID-1)' }, { id: 'f-vid2', name: 'Show · Two (VID-2)' }, { id: 'f-vid3', name: 'Show · Three (VID-3)' },
  ]
})

test('รอบ 19:00: งานเสียงล้วนที่กล่องมีไฟล์เสียง → ทิ้ง · ที่กล่องมีแต่ stub → เก็บ + keptNoFootage', async () => {
  boxState = { 'SND-1': 'has-footage', 'SND-2': 'no-footage', 'VID-1': 'no-footage', 'VID-2': 'has-footage', 'VID-3': 'no-footage' }
  const r = await lc.manageLandingFolders({ dryRun: false })
  assert.deepEqual(trashed.sort(), ['f-snd1', 'f-vid2'])
  assert.deepEqual(r.keptNoFootage.map(k => k.code).sort(), ['SND-2', 'VID-1', 'VID-3'])
  assert.equal(r.removedPastEmpty, 2)
})

test('รอบ 19:00: ธง soundOnly ถูกต้อง — งานเสียงล้วน true · งานกล้อง/มีทีมวิดีโอ false', async () => {
  await lc.manageLandingFolders({ dryRun: true })
  assert.equal(soundOf('SND-1'), true)
  assert.equal(soundOf('SND-2'), true)
  assert.equal(soundOf('VID-1'), false)
  assert.equal(soundOf('VID-2'), false)
  assert.equal(soundOf('VID-3'), false, 'กล้อง 0 แต่มีทีมวิดีโอ = ยังคาดหวังวิดีโอ ไม่ใช่งานเสียงล้วน')
})

test('รอบเที่ยง (prune): ผลทิ้ง/เก็บตามคำตัดสิน และธง soundOnly ถูกต้องเหมือนรอบ 19:00', async () => {
  boxState = { 'SND-1': 'has-footage', 'SND-2': 'no-footage', 'VID-1': 'no-footage', 'VID-2': 'has-footage', 'VID-3': 'no-footage' }
  const r = await lc.pruneLandingToToday({ dryRun: false })
  assert.deepEqual(trashed.sort(), ['f-snd1', 'f-vid2'])
  assert.deepEqual(r.keptNoFootage.map(k => k.code).sort(), ['SND-2', 'VID-1', 'VID-3'])
  assert.equal(soundOf('SND-1'), true)
  assert.equal(soundOf('SND-2'), true)
  assert.equal(soundOf('VID-1'), false)
  assert.equal(soundOf('VID-3'), false)
})

test('อ่านกล่องไม่ได้ (unknown) → เก็บ แม้เป็นงานเสียงล้วน (ห้ามตีเป็นส่งแล้ว) ทั้งสองรอบ', async () => {
  boxState = { 'SND-1': 'unknown', 'SND-2': 'unknown', 'VID-1': 'unknown', 'VID-2': 'unknown', 'VID-3': 'unknown' }
  await lc.manageLandingFolders({ dryRun: false })
  await lc.pruneLandingToToday({ dryRun: false })
  assert.deepEqual(trashed, [])
})

test('dry-run ไม่ทิ้งอะไร แต่แผนบอกว่าจะทิ้งงานเสียงล้วนตัวไหน', async () => {
  boxState = { 'SND-1': 'has-footage' }
  const r = await lc.manageLandingFolders({ dryRun: true })
  assert.deepEqual(trashed, [])
  assert.ok(r.actions.some(a => a.includes('trash past-empty landing "Bookmark x A (SND-1)"')), r.actions.join('\n'))
})

// ── รอบรีวิว: "ไม่คาดหวังวิดีโอ" ≠ "เสียงล้วน" — ใบที่ข้อมูลไม่ครบต้องไม่ถูกอ่านเป็นเสียงล้วน ─────────────────
// prod 11 พ.ย. 2569: !expectsCameraVideo ตรง 66 ใบ แต่เสียงล้วนจริง 41 — อีก 25 ใบคือ Block Shot (cameraCount null),
// ไม่ใส่ทีม, ช่างภาพ/ไฟ/DIT/Switcher อย่างเดียว · ถ้าอ่านพวกนี้เป็นเสียงล้วน เสียงไฟล์เดียวก็ทิ้งโฟลเดอร์ของงานวิดีโอได้ (7TG)
import { isSoundOnlyBooking } from '../mediapro'

test('isSoundOnlyBooking ต้องมีหลักฐานบวกครบทุกข้อ: กล้อง = 0 ชัดเจน · ไม่ใช่ Block Shot · ทุกบทบาทคือ Sound', () => {
  const yes = (b: Parameters<typeof isSoundOnlyBooking>[0]) => assert.equal(isSoundOnlyBooking(b), true, JSON.stringify(b))
  const no = (b: Parameters<typeof isSoundOnlyBooking>[0]) => assert.equal(isSoundOnlyBooking(b), false, JSON.stringify(b))
  yes({ cameraCount: 0, crewRequired: ['Sound'] })
  yes({ cameraCount: 0, crewRequired: [' sound '] })
  no({ cameraCount: null, crewRequired: [] })                       // ข้อมูลไม่ครบ
  no({ cameraCount: null, crewRequired: ['Sound'] })                // กล้องไม่ได้ระบุ ≠ 0
  no({ cameraCount: undefined, crewRequired: ['Sound'] })
  no({ cameraCount: 0, crewRequired: [] })                          // ไม่ระบุทีม
  no({ cameraCount: 0, crewRequired: null })
  no({ cameraCount: 0, crewRequired: ['Sound'], isBlockShot: true })
  no({ cameraCount: null, crewRequired: [], isBlockShot: true })    // Block Shot ไม่ได้ pin อุปกรณ์
  no({ cameraCount: 0, crewRequired: ['Photographer'] })
  no({ cameraCount: 0, crewRequired: ['Lighting'] })
  no({ cameraCount: 0, crewRequired: ['DIT'] })
  no({ cameraCount: 0, crewRequired: ['Switcher'] })
  no({ cameraCount: 0, crewRequired: ['Virtual Production'] })
  no({ cameraCount: 0, crewRequired: ['Sound', 'Videographer'] })   // มีบทบาทอื่นปน
  no({ cameraCount: 0, crewRequired: ['Sound', 'Lighting'] })
  no({ cameraCount: 2, crewRequired: ['Sound'] })
})

test('ใบข้อมูลไม่ครบ/ไม่ใช่เสียงล้วน ส่ง soundOnly=false ทั้งสองรอบ (ไม่ถูกอ่านเป็นงานเสียงล้วน)', async () => {
  bookings = [
    past('NUL-1', null, []), past('BLK-1', null, [], true), past('BLK-2', 0, ['Sound'], true),
    past('PHO-1', 0, ['Photographer']), past('LGT-1', 0, ['Lighting']), past('MIX-1', 0, ['Sound', 'Videographer']),
    past('OK-1', 0, ['Sound']),
  ]
  folders = bookings.map(b => ({ id: `f-${b.bookingCode}`, name: `Show (${b.bookingCode})` }))
  await lc.manageLandingFolders({ dryRun: true })
  const night = new Map(calls.map(c => [c.code, c.soundOnly]))
  calls = []
  await lc.pruneLandingToToday({ dryRun: true })
  const noon = new Map(calls.map(c => [c.code, c.soundOnly]))
  for (const m of [night, noon]) {
    for (const code of ['NUL-1', 'BLK-1', 'BLK-2', 'PHO-1', 'LGT-1', 'MIX-1']) assert.equal(m.get(code), false, `${code} ต้องไม่ใช่ soundOnly`)
    assert.equal(m.get('OK-1'), true)
  }
})
