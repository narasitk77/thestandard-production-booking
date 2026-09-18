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

type F = { name: string; folderPath: string[] }
let trees: Record<string, F[] | Error> = {}
let folders: Array<{ id: string; name: string; parents: string[] }> | Error = []

mock.module('../google-drive', {
  namedExports: {
    listFilesRecursive: async (id: string) => {
      const t = trees[id]
      if (t instanceof Error) throw t
      return (t || []).map(x => ({
        id: 'x', name: x.name, mimeType: 'video/mp4', parents: [id], webViewLink: null,
        size: 1, createdTime: null, modifiedTime: null, md5: 'm', folderPath: x.folderPath, topFolderId: null,
      }))
    },
    findFoldersByCode: async () => {
      if (folders instanceof Error) throw folders
      return folders
    },
  },
})

let boxFootageState: typeof import('../landing-duplicates').boxFootageState
before(async () => { ({ boxFootageState } = await import('../landing-duplicates')) })

beforeEach(() => { trees = {}; folders = [{ id: 'box', name: 'X (C-1)', parents: [] }] })

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
