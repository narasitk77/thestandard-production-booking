/**
 * "กล่องมีฟุตเทจแล้วหรือยัง" — ตัวกันไม่ให้ทิ้งโฟลเดอร์ drop ผิดจังหวะ (v1.225)
 *
 * บั๊กที่ล็อกออกไป: `landing-lifecycle` อ่าน "โฟลเดอร์ drop ว่าง" ว่า "ฟุตเทจถูกย้าย
 * เข้ากล่องเรียบร้อยแล้ว" — แต่โฟลเดอร์ที่ฟุตเทจ **ไม่เคยมาถึง** ก็ว่างเหมือนกัน
 * ทุกประการ
 *
 * เคสจริง 2026-09-18 (POP-7TG-260916-01): IT ปิด NAS · วิดีโอไม่เคยขึ้น Drive ·
 * กล่องมีแต่ไฟล์เสียง 2 ไฟล์ที่มาทางสายเสียงคนละทาง (_SOUND-STAGING) ระบบจึงทิ้ง
 * โฟลเดอร์ drop ไปตอน 10:27 น. ทั้งที่ยังไม่มีวิดีโอสักไฟล์ และไม่มีใครถูกแจ้ง
 *
 * ⇒ ไฟล์เสียงต้อง **ไม่นับ** เป็นหลักฐานว่าส่งงานแล้ว และทุกความไม่แน่นอนต้อง
 *   ออกมาเป็น `unknown`/`no-footage` ซึ่งทั้งคู่แปลว่า "ห้ามทิ้ง"
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

type F = { name: string; folderPath: string[]; size?: number | null }
let trees: Record<string, F[] | Error> = {}
let folders: Array<{ id: string; name: string; parents: string[] }> | Error = []
/** classifyFootageTreeFolder per folder id — unset = 'in-tree' (the box) */
let treeOf: Record<string, 'in-tree' | 'not-in-tree' | 'unknown'> = {}

mock.module('../google-drive', {
  namedExports: {
    listFilesRecursive: async (id: string) => {
      const t = trees[id]
      if (t instanceof Error) throw t
      return (t || []).map(x => ({
        id: 'x', name: x.name, mimeType: 'video/mp4', parents: [id], webViewLink: null,
        size: 'size' in x ? x.size : 1, createdTime: null, modifiedTime: null, md5: 'm', folderPath: x.folderPath, topFolderId: null,
      }))
    },
    findFoldersByCode: async () => {
      if (folders instanceof Error) throw folders
      return folders
    },
    classifyFootageTreeFolder: async (id: string) => treeOf[id] ?? 'in-tree',
  },
})

let boxFootageState: typeof import('../landing-duplicates').boxFootageState
before(async () => { ({ boxFootageState } = await import('../landing-duplicates')) })

beforeEach(() => { trees = {}; treeOf = {}; folders = [{ id: 'box', name: 'X (C-1)', parents: [] }] })

test('กล่องมีไฟล์กล้อง → has-footage (ทิ้งโฟลเดอร์ drop ได้)', async () => {
  trees = { box: [{ name: 'A001C001.MXF', folderPath: ['EP01', 'CAM-A', 'Clip'] }] }
  const r = await boxFootageState('C-1') as any
  assert.equal(r.state, 'has-footage')
  assert.equal(r.files, 1)
})

test('กล่องมีแต่ไฟล์เสียง → no-footage (ห้ามทิ้ง) — เคส POP-7TG-260916-01', async () => {
  trees = { box: [
    { name: '20260916 7THINGS 0900 pt1 rec.wav', folderPath: ['EP01 · OG Alie BlackCobra', 'AUDIO'] },
    { name: '20260916 7THINGS 0900 pt2 rec.wav', folderPath: ['EP02 · AD Van Cleef', 'AUDIO'] },
    { name: '_SHOOT.txt', folderPath: [] },
  ] }
  const r = await boxFootageState('C-1') as any
  assert.equal(r.state, 'no-footage', 'เสียง + stub ไม่ใช่หลักฐานว่าวิดีโอมาถึงแล้ว')
})

test('_SHOOT.txt อย่างเดียว → no-footage', async () => {
  trees = { box: [{ name: '_SHOOT.txt', folderPath: [] }] }
  assert.equal(((await boxFootageState('C-1')) as any).state, 'no-footage')
})

test('AUDIO ตัวพิมพ์เล็ก/มีช่องว่าง ก็ต้องไม่ถูกนับ', async () => {
  trees = { box: [{ name: 'x.wav', folderPath: ['EP01', ' audio '] }] }
  assert.equal(((await boxFootageState('C-1')) as any).state, 'no-footage')
})

test('ไม่มีโฟลเดอร์ในกล่องเลย → no-footage ไม่ใช่ has-footage', async () => {
  folders = []
  assert.equal(((await boxFootageState('C-1')) as any).state, 'no-footage')
})

test('อ่านกล่องไม่ได้ → unknown (ซึ่งก็แปลว่าห้ามทิ้งเหมือนกัน)', async () => {
  trees = { box: new Error('Drive 500') }
  const r = await boxFootageState('C-1') as any
  assert.equal(r.state, 'unknown')
  assert.match(r.reason, /อ่านกล่องไม่ครบ/)
})

test('หาโฟลเดอร์ไม่ได้ (Drive ล่ม) → unknown ไม่ใช่ no-footage', async () => {
  folders = new Error('search failed')
  assert.equal(((await boxFootageState('C-1')) as any).state, 'unknown')
})

test('ไม่นับโฟลเดอร์ drop ตัวเองเป็นกล่อง', async () => {
  folders = [{ id: 'land', name: 'X (C-1)', parents: [] }]
  trees = { land: [{ name: 'A001.MXF', folderPath: ['CAM-A'] }] }
  const r = await boxFootageState('C-1', { excludeFolderId: 'land' }) as any
  assert.equal(r.state, 'no-footage', 'ไฟล์ที่ยังอยู่ใน drop ไม่ใช่หลักฐานว่าส่งเข้ากล่องแล้ว')
})

test('กล่องหลายโฟลเดอร์ (AGN มีทั้ง box และ project) → รวมกัน', async () => {
  folders = [{ id: 'b1', name: 'X (C-1)', parents: [] }, { id: 'b2', name: 'X (C-1)', parents: [] }]
  trees = { b1: [{ name: 'a.wav', folderPath: ['AUDIO'] }], b2: [{ name: 'b.MXF', folderPath: ['CAM-B'] }] }
  const r = await boxFootageState('C-1') as any
  assert.equal(r.state, 'has-footage')
  assert.equal(r.files, 1)
})

test('v1.251 มี Sub + XML แต่ต้นฉบับ MXF ยังไม่มา → originals-pending (ห้ามทิ้ง) — เคส PP-26-034 29 ก.ย.', async () => {
  trees = { box: [
    { name: 'B022C001_2609297HS03.MP4', folderPath: ['PP-26-034-L01 · EP.1', 'CAM-B', 'B022', 'XDROOT', 'Sub'] },
    { name: 'B022C001_2609297HM01.XML', folderPath: ['PP-26-034-L01 · EP.1', 'CAM-B', 'B022', 'XDROOT', 'Clip'] },
  ] }
  const r = await boxFootageState('C-1') as any
  assert.equal(r.state, 'originals-pending')
  assert.deepEqual(r.pending, ['B022C001_2609297H'])
  assert.match(r.reason, /ต้นฉบับยังมาไม่ครบ 1 คลิป: B022C001_2609297H/)
})

test('v1.251 ต้นฉบับมาครบแล้ว → has-footage ตามเดิม', async () => {
  trees = { box: [
    { name: 'B022C001_2609297HS03.MP4', folderPath: ['EP.1', 'CAM-B', 'XDROOT', 'Sub'] },
    { name: 'B022C001_2609297HM01.XML', folderPath: ['EP.1', 'CAM-B', 'XDROOT', 'Clip'] },
    { name: 'B022C001_2609297H.MXF', folderPath: ['EP.1', 'CAM-B', 'XDROOT', 'Clip'] },
  ] }
  assert.equal(((await boxFootageState('C-1')) as any).state, 'has-footage')
})

test('ผู้ตรวจ 3: กล่องใหญ่ชนเพดาน = unknown (ห้ามทิ้ง) ไม่ใช่ has-footage จากรายการที่ถูกตัดท้าย', async () => {
  trees = { box: Array.from({ length: 5 }, (_, i) => ({ name: `A00${i}C001_260101AAS03.MP4`, folderPath: ['EP', 'CAM-A', 'XDROOT', 'Sub'] })) }
  const r = await boxFootageState('C-1', { maxFiles: 5 }) as any
  assert.equal(r.state, 'unknown')
  assert.match(r.reason, /เกินเพดาน/)
})

// ── maint 2026-11-08 — โฟลเดอร์ที่ชื่อมี (CODE) แต่ไม่ใช่กล่อง ─────────────────────
// findFoldersByCode ค้นทุกไดรฟ์ → ได้ _SOUND-STAGING ของงานมาด้วย (ชื่อ "(CODE)" แบบเดียวกัน) · WAV ที่ราก staging
// ไม่มี segment AUDIO จึงเคยถูกนับเป็นฟุตเทจกล้อง → 'has-footage' → ทิ้งโฟลเดอร์ drop ทั้งที่วิดีโอยังไม่มา

test('maint: WAV ใน _SOUND-STAGING (ชื่อมี CODE) ไม่ใช่หลักฐานว่ากล่องมีฟุตเทจ → no-footage (ห้ามทิ้ง)', async () => {
  folders = [{ id: 'staging', name: 'Show · Job (C-1)', parents: ['cat'] }]
  treeOf = { staging: 'not-in-tree' }
  trees = { staging: [{ name: '20261107 rec pt1.wav', folderPath: [] }] }
  const r = await boxFootageState('C-1', { excludeFolderId: 'land' }) as any
  assert.equal(r.state, 'no-footage')
})

test('maint: staging + กล่องจริงที่มีกล้อง → has-footage นับเฉพาะไฟล์ในกล่อง', async () => {
  folders = [{ id: 'staging', name: 'Show · Job (C-1)', parents: [] }, { id: 'box', name: 'Show · Job (C-1)', parents: [] }]
  treeOf = { staging: 'not-in-tree' }
  trees = { staging: [{ name: 'a.wav', folderPath: [] }], box: [{ name: 'A001C001.MXF', folderPath: ['EP01', 'CAM-A', 'Clip'] }] }
  const r = await boxFootageState('C-1') as any
  assert.equal(r.state, 'has-footage')
  assert.equal(r.files, 1)
})

test('maint: ตรวจไม่ได้ว่าโฟลเดอร์อยู่ไดรฟ์ไหน → unknown (ห้ามทิ้ง) ไม่ใช่นับเป็นกล่อง', async () => {
  folders = [{ id: 'staging', name: 'Show · Job (C-1)', parents: [] }]
  treeOf = { staging: 'unknown' }
  trees = { staging: [{ name: 'A001C001.MXF', folderPath: [] }] }
  const r = await boxFootageState('C-1') as any
  assert.equal(r.state, 'unknown')
  assert.match(r.reason, /ไดรฟ์ VIDEO/)
})

// ── v1.285 — งานเสียงล้วน: ไฟล์เสียงจริงในกล่องคือหลักฐานว่าส่งแล้ว ─────────────────────────────
// 11 พ.ย. 2569: โฟลเดอร์ drop ของงานเสียงล้วน 6 ใบถูกเก็บถาวรเพราะกล่องไม่มีวันมี "ฟุตเทจกล้อง" · แต่ 3 ใน 6
// กล่องไม่มีไฟล์เสียงสักไฟล์ (มีแต่ _SHOOT.txt) = เสียงยังไม่มาถึง = ต้องเก็บ ไม่ใช่ทิ้งหมดทั้ง 6

test('v1.285 งานเสียงล้วน: มีไฟล์เสียงใต้ AUDIO → has-footage (ทิ้งโฟลเดอร์ drop ได้)', async () => {
  trees = { box: [
    { name: 'Bookmark pt1 rec.wav', folderPath: ['EP01 · Bookmark', 'AUDIO'] },
    { name: '_SHOOT.txt', folderPath: [] },
  ] }
  const r = await boxFootageState('C-1', { soundOnly: true }) as any
  assert.equal(r.state, 'has-footage')
  assert.equal(r.files, 1)
})

test('v1.285 งานเสียงล้วน: กล่องมีแต่ stub (ไม่มีไฟล์เสียงเลย) → no-footage (ห้ามทิ้ง) — เสียงยังไม่มาถึง', async () => {
  trees = { box: [{ name: '_SHOOT.txt', folderPath: [] }] }
  const r = await boxFootageState('C-1', { soundOnly: true }) as any
  assert.equal(r.state, 'no-footage')
  assert.match(r.reason, /งานเสียงล้วน — กล่องยังไม่มีไฟล์เสียง/)
})

test('v1.285 งานเสียงล้วน: ไม่มีโฟลเดอร์ในกล่องเลย → no-footage', async () => {
  folders = []
  assert.equal(((await boxFootageState('C-1', { soundOnly: true })) as any).state, 'no-footage')
})

test('v1.285 งานเสียงล้วน: ไฟล์เสียง 0 ไบต์ (ก็อปค้าง) หรือไม่มีขนาด ไม่นับ', async () => {
  trees = { box: [
    { name: 'a.wav', folderPath: ['EP01', 'AUDIO'], size: 0 },
    { name: 'b.wav', folderPath: ['EP01', 'AUDIO'], size: null },
  ] }
  assert.equal(((await boxFootageState('C-1', { soundOnly: true })) as any).state, 'no-footage')
})

test('v1.285 งานเสียงล้วน: ไฟล์ที่ไม่ใช่เสียงใต้ AUDIO (notes.txt, .DS_Store) ไม่นับเป็นเสียงที่ส่งแล้ว', async () => {
  trees = { box: [
    { name: 'notes.txt', folderPath: ['EP01', 'AUDIO'] },
    { name: '.DS_Store', folderPath: ['EP01', 'AUDIO'] },
  ] }
  assert.equal(((await boxFootageState('C-1', { soundOnly: true })) as any).state, 'no-footage')
})

test('v1.285 งานเสียงล้วน: WAV ใน _SOUND-STAGING (ชื่อมี CODE แต่ไม่ใช่กล่อง) ไม่นับ', async () => {
  folders = [{ id: 'staging', name: 'Show · Job (C-1)', parents: ['cat'] }]
  treeOf = { staging: 'not-in-tree' }
  trees = { staging: [{ name: 'rec.wav', folderPath: ['AUDIO'] }] }
  assert.equal(((await boxFootageState('C-1', { soundOnly: true })) as any).state, 'no-footage')
})

test('v1.285 งานกล้อง (ไม่ใช่ soundOnly): มีแต่ไฟล์เสียงใต้ AUDIO → no-footage เหมือนเดิม — เคส POP-7TG-260916-01', async () => {
  trees = { box: [{ name: 'rec.wav', folderPath: ['EP01', 'AUDIO'] }] }
  assert.equal(((await boxFootageState('C-1')) as any).state, 'no-footage')
  assert.equal(((await boxFootageState('C-1', { soundOnly: false })) as any).state, 'no-footage')
})

test('v1.285 งานเสียงล้วนที่กล่องมีไฟล์กล้องด้วย → ใช้กฎกล้องตามเดิม (ต้นฉบับยังไม่ครบ = originals-pending)', async () => {
  trees = { box: [
    { name: 'rec.wav', folderPath: ['EP01', 'AUDIO'] },
    { name: 'B022C001_2609297HS03.MP4', folderPath: ['EP.1', 'CAM-B', 'XDROOT', 'Sub'] },
    { name: 'B022C001_2609297HM01.XML', folderPath: ['EP.1', 'CAM-B', 'XDROOT', 'Clip'] },
  ] }
  assert.equal(((await boxFootageState('C-1', { soundOnly: true })) as any).state, 'originals-pending')
})

test('v1.285 อ่านกล่องไม่ได้ → unknown แม้เป็นงานเสียงล้วน (ห้ามตีเป็นส่งแล้ว)', async () => {
  trees = { box: new Error('Drive 500') }
  assert.equal(((await boxFootageState('C-1', { soundOnly: true })) as any).state, 'unknown')
})

// ── v1.285 รอบรีวิว — ไฟล์ขยะข้างเสียง / AppleDouble ────────────────────────────────

test('v1.285 งานเสียงล้วน: AppleDouble `._take01.wav` (~4 KB ที่ macOS สร้างข้างไฟล์จริง) ไม่นับเป็นเสียง', async () => {
  trees = { box: [
    { name: '._take01.wav', folderPath: ['EP01', 'AUDIO'], size: 4096 },
    { name: '_SHOOT.txt', folderPath: [] },
  ] }
  const r = await boxFootageState('C-1', { soundOnly: true }) as any
  assert.equal(r.state, 'no-footage')
  assert.match(r.reason, /งานเสียงล้วน/)
})

test('v1.285 งานเสียงล้วน: ไม่มีเสียงจริง แต่มีไฟล์อื่นนอก AUDIO (WAV วางที่ราก, WAV 0 ไบต์, โน้ต, .DS_Store) → no-footage ทุกแบบ', async () => {
  for (const stray of [
    { name: 'loose.wav', folderPath: [] as string[] },
    { name: 'empty.wav', folderPath: ['EP01'], size: 0 },
    { name: 'notes.txt', folderPath: ['EP01'] },
    { name: '.DS_Store', folderPath: ['EP01'] },
  ]) {
    trees = { box: [stray, { name: '_SHOOT.txt', folderPath: [] }] }
    const r = await boxFootageState('C-1', { soundOnly: true }) as any
    assert.equal(r.state, 'no-footage', `${stray.name} นอก AUDIO ต้องไม่ทำให้งานเสียงล้วนเป็น "ส่งแล้ว"`)
  }
})

test('v1.285 งานเสียงล้วน: เสียงจริงมาแล้ว → has-footage แม้มีไฟล์ขยะอื่นข้าง ๆ (ขยะไม่บล็อก)', async () => {
  trees = { box: [
    { name: 'take01.wav', folderPath: ['EP01', 'AUDIO'] },
    { name: '._take01.wav', folderPath: ['EP01', 'AUDIO'], size: 4096 },
    { name: '.DS_Store', folderPath: ['EP01'] },
    { name: 'notes.txt', folderPath: ['EP01'] },
  ] }
  const r = await boxFootageState('C-1', { soundOnly: true }) as any
  assert.equal(r.state, 'has-footage')
  assert.equal(r.files, 1, 'files = จำนวนไฟล์เสียงที่เป็นหลักฐาน ไม่ใช่ไฟล์ขยะที่อยู่ข้าง ๆ')
})

