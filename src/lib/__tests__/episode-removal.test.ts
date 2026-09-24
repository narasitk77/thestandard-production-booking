// v1.236 — กฎการลดจำนวนตอน
//
// เหตุผลของแต่ละกฎอยู่ในหัวไฟล์ episode-removal.ts — ตัวเลขที่อ้างมาจากพรอดจริง
// (FK uploads.episodeId เป็น SET NULL ไม่ใช่ cascade · 7 ตอนมีไฟล์ 1,861 ไฟล์)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planEpisodeRemoval, type RemovableEpisode } from '../episode-removal'

const ep = (n: number, over: Partial<RemovableEpisode> = {}): RemovableEpisode => ({
  id: `e${n}`, episodeId: `KND-ENU-260923-0${n}`, title: `English Unlock EP.${n + 4}`,
  sequence: n, uploadCount: 0, programName: 'English Unlock', ...over,
})

const FOUR = [ep(1), ep(2), ep(3), ep(4)]

test('ลบตอนท้ายสองตอนได้ เหลือสอง', () => {
  const p = planEpisodeRemoval(FOUR, ['e3', 'e4'], 'Long-form')
  assert.deepEqual(p.remove.map(e => e.episodeId), ['KND-ENU-260923-03', 'KND-ENU-260923-04'])
  assert.equal(p.remaining.length, 2)
  assert.deepEqual(p.blocked, [])
})

test('ตอนที่มีไฟล์อัปโหลดอยู่ ห้ามลบ — ไฟล์จะกำพร้าถาวร (FK เป็น SET NULL)', () => {
  const withFiles = [ep(1), ep(2, { uploadCount: 412 })]
  const p = planEpisodeRemoval(withFiles, ['e2'], 'Long-form')
  assert.deepEqual(p.remove, [])
  assert.equal(p.blocked.length, 1)
  assert.match(p.blocked[0].reason, /412 ไฟล์/)
  assert.equal(p.remaining.length, 2, 'ของที่ลบไม่ได้ต้องยังอยู่ครบ')
})

test('ลบยกใบไม่ได้ ต้องเหลืออย่างน้อย 1 ตอน', () => {
  const p = planEpisodeRemoval(FOUR, ['e1', 'e2', 'e3', 'e4'], 'Long-form')
  assert.deepEqual(p.remove, [], 'ต้องไม่ลบสักตอน ไม่ใช่ลบสามเหลือหนึ่ง')
  assert.equal(p.remaining.length, 4)
  assert.equal(p.blocked.length, 4)
  assert.match(p.blocked[0].reason, /อย่างน้อย 1 ตอน/)
})

test('ส่ง id ที่ไม่ใช่ของใบนี้มา ต้องถูกปฏิเสธ ไม่ใช่เงียบ ๆ ข้าม', () => {
  const p = planEpisodeRemoval(FOUR, ['e1', 'ของใบอื่น'], 'Long-form')
  assert.deepEqual(p.remove.map(e => e.id), ['e1'])
  assert.equal(p.blocked.length, 1)
  assert.match(p.blocked[0].reason, /ไม่ใช่ตอนของใบจองนี้/)
})

test('ตอนที่ลบได้บางส่วน: ลบเท่าที่ลบได้ และรายงานตัวที่ติด', () => {
  const mixed = [ep(1), ep(2, { uploadCount: 3 }), ep(3)]
  const p = planEpisodeRemoval(mixed, ['e2', 'e3'], 'Long-form')
  assert.deepEqual(p.remove.map(e => e.id), ['e3'])
  assert.equal(p.blocked.length, 1)
  assert.deepEqual(p.remaining.map(e => e.id), ['e1', 'e2'])
})

test('ลบรายการสุดท้ายของชื่อรายการหนึ่งออก = ชื่อโฟลเดอร์จะถูกเปลี่ยนโดย folder-integrity', () => {
  const two = [ep(1, { programName: 'English Unlock' }), ep(2, { programName: 'Morning Wealth' })]
  const p = planEpisodeRemoval(two, ['e2'], 'Long-form')
  assert.equal(p.folderNameWillChange, true)
})

test('ลบตอนที่รายการซ้ำกับตอนอื่น = ชื่อโฟลเดอร์ไม่เปลี่ยน', () => {
  const p = planEpisodeRemoval(FOUR, ['e4'], 'Long-form')
  assert.equal(p.folderNameWillChange, false)
})

test('ไม่ส่ง id มาเลย = ไม่ทำอะไร และไม่ใช่การ "ลบหมด"', () => {
  const p = planEpisodeRemoval(FOUR, [], 'Long-form')
  assert.deepEqual(p.remove, [])
  assert.deepEqual(p.blocked, [])
  assert.equal(p.remaining.length, 4)
  assert.equal(p.folderNameWillChange, false)
})

test('id ซ้ำในคำขอ ต้องไม่ทำให้นับผิดจนคิดว่าเหลือ 0', () => {
  const two = [ep(1), ep(2)]
  const p = planEpisodeRemoval(two, ['e1', 'e1', 'e1'], 'Long-form')
  assert.deepEqual(p.remove.map(e => e.id), ['e1'])
  assert.equal(p.remaining.length, 1)
})
