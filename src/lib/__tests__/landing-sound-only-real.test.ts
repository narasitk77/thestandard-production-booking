/**
 * v1.285 — ทั้งสาย "ใบจอง → soundOnly → boxFootageState → ทิ้ง/เก็บ" โดย **ไม่จำลองตัวตัดสิน**
 *
 * ทำไมต้องมีไฟล์นี้: landing-sound-only.test.ts จำลอง boxFootageState จึงเห็นแค่ว่าธงถูกส่งถูก — รอบรีวิวพบว่า
 * ธงที่หลวม (`!expectsCameraVideo`) ทำให้ใบ Block Shot (cameraCount null, ไม่ใส่ทีม) ที่มีไฟล์เสียงไฟล์เดียวในกล่อง
 * ถูกทิ้งโฟลเดอร์ drop ทั้งที่วิดีโอยังไม่มาเลย (เหตุ POP-7TG-260916-01 อีกรอบ) · เดโมนั้นรันกับของจริงทั้งสายเท่านั้นถึงเห็น
 *
 * ที่นี่จำลองแค่ DB กับ Drive (ต้นไม้ไฟล์ของโฟลเดอร์ drop = ว่าง · ต้นไม้ของกล่อง = ตามเคส)
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

type B = { bookingCode: string; shootDate: Date; shootEndDate: Date | null; status: string; cameraCount: number | null; crewRequired: string[]; isBlockShot: boolean }
type F = { name: string; folderPath: string[]; size?: number | null }
let bookings: B[] = []
let folders: Array<{ id: string; name: string }> = []
let boxTree: Record<string, F[]> = {} // by booking code
let trashed: string[] = []

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
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
    // landing folders ("f-<code>") are empty; box folders ("box-<code>") hold the case's tree
    listFilesRecursive: async (id: string) => (boxTree[id.replace(/^box-/, '')] && id.startsWith('box-') ? boxTree[id.replace(/^box-/, '')] : []).map(x => ({
      id: 'x', name: x.name, mimeType: 'application/octet-stream', parents: [id], webViewLink: null,
      size: 'size' in x ? x.size : 1000, createdTime: null, modifiedTime: null, md5: 'm', folderPath: x.folderPath, topFolderId: null,
    })),
    trashDriveItem: async (id: string) => { trashed.push(id) },
    ensureFlatShootFolders: async () => ({ bookingFolderId: 'x' }),
    findFoldersByCode: async (code: string) => [{ id: `box-${code}`, name: `Show (${code})`, parents: [] }],
    classifyFootageTreeFolder: async () => 'in-tree',
    isFootageTreeFolder: async () => true,
    listEverythingUnder: async () => ({ names: [], truncated: false }),
    getDriveItemState: async () => null,
  },
})
mock.module('../drive-links', { namedExports: { rememberDriveLinks: async () => {} } })

let lc: typeof import('../landing-lifecycle')
before(async () => { lc = await import('../landing-lifecycle') })

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000)
const job = (bookingCode: string, cameraCount: number | null, crewRequired: string[], isBlockShot = false): B =>
  ({ bookingCode, shootDate: day(-9), shootEndDate: null, status: 'COMPLETED', cameraCount, crewRequired, isBlockShot })
const AUDIO_ONLY: F[] = [{ name: 'take1.wav', folderPath: ['EP01', 'AUDIO'] }, { name: '_SHOOT.txt', folderPath: [] }]
const STUBS_ONLY: F[] = [{ name: '_SHOOT.txt', folderPath: [] }]
const CAMERA: F[] = [{ name: 'A001C001_260101AA.MXF', folderPath: ['EP01', 'CAM-A', 'Clip'] }, { name: '_SHOOT.txt', folderPath: [] }]

beforeEach(() => {
  trashed = []
  bookings = [
    job('SND-1', 0, ['Sound']),                     // sound-only, audio in the box          → trash
    job('SND-2', 0, ['Sound']),                     // sound-only, box has only stubs         → keep
    job('NUL-1', null, []),                         // gear never filled in (the reviewer's replay) → keep
    job('BLK-1', null, [], true),                   // Block Shot                              → keep
    job('PHO-1', 0, ['Photographer']),              // photographer only                        → keep
    job('LGT-1', 0, ['Lighting']),                  //                                          → keep
    job('MIX-1', 0, ['Sound', 'Videographer']),     // a video role is booked                   → keep
    job('VID-1', 3, ['Videographer']),              // camera job, audio only in the box — POP-7TG-260916-01 → keep
    job('VID-2', 3, ['Videographer']),              // camera job, camera footage in the box   → trash (normal path)
  ]
  folders = bookings.map(b => ({ id: `f-${b.bookingCode}`, name: `Show (${b.bookingCode})` }))
  boxTree = {
    'SND-1': AUDIO_ONLY, 'SND-2': STUBS_ONLY, 'NUL-1': AUDIO_ONLY, 'BLK-1': AUDIO_ONLY, 'PHO-1': AUDIO_ONLY,
    'LGT-1': AUDIO_ONLY, 'MIX-1': AUDIO_ONLY, 'VID-1': AUDIO_ONLY, 'VID-2': CAMERA,
  }
})

const WANT_TRASHED = ['f-SND-1', 'f-VID-2']

test('รอบ 19:00 (ของจริงทั้งสาย): ทิ้งเฉพาะงานเสียงล้วนที่เสียงมาแล้ว + งานกล้องที่มีวิดีโอ — ใบข้อมูลไม่ครบ/ไม่ใช่เสียงล้วนถูกเก็บ', async () => {
  const r = await lc.manageLandingFolders({ dryRun: false })
  assert.deepEqual(trashed.sort(), WANT_TRASHED)
  assert.deepEqual(r.keptNoFootage.map(k => k.code).sort(), ['BLK-1', 'LGT-1', 'MIX-1', 'NUL-1', 'PHO-1', 'SND-2', 'VID-1'])
})

test('รอบเที่ยง (ของจริงทั้งสาย): ผลเหมือนรอบ 19:00', async () => {
  const r = await lc.pruneLandingToToday({ dryRun: false })
  assert.deepEqual(trashed.sort(), WANT_TRASHED)
  assert.deepEqual(r.keptNoFootage.map(k => k.code).sort(), ['BLK-1', 'LGT-1', 'MIX-1', 'NUL-1', 'PHO-1', 'SND-2', 'VID-1'])
})

test('เหตุผลที่เก็บบอกชัด: งานเสียงล้วนที่เสียงไม่มา = "งานเสียงล้วน — กล่องยังไม่มีไฟล์เสียง" · งานกล้องที่มีแต่เสียง = ข้อความเดิม', async () => {
  const r = await lc.manageLandingFolders({ dryRun: true })
  const why = (code: string) => r.keptNoFootage.find(k => k.code === code)?.reason
  assert.match(why('SND-2') || '', /งานเสียงล้วน — กล่องยังไม่มีไฟล์เสียง/)
  assert.match(why('VID-1') || '', /กล่องมีแต่ไฟล์เสียง\/stub — ยังไม่มีฟุตเทจกล้อง/)
  assert.deepEqual(trashed, [], 'dry-run ไม่ทิ้งอะไร')
})
