import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EPISODE_ORDER } from '../episode-order'

// maint r2 2026-11-08 — bug class 9: การเรียง EP มีที่เดียว (EPISODE_ORDER) และต้องเป็นลำดับรวม
// เคสจริง: ใบหลายรายการที่ทุก EP sequence=1 → episodes[0] สลับทุกรอบ → folder-integrity rename กล่องไปมาทุกชม.

type Row = { id: string; episodeId: string; sequence: number; title: string }
type Order = ReadonlyArray<object> // ใช้ได้ทั้ง EPISODE_ORDER (ชนิด Prisma) และ literal

// จำลอง ORDER BY ของ Postgres: คีย์ที่เสมอกันหมด = ลำดับขึ้นกับว่าแถวออกมาจากดิสก์ยังไง (ที่นี่ = ลำดับ input)
function orderRows(rows: Row[], orderBy: Order): Row[] {
  return [...rows].sort((a, b) => {
    for (const clause of orderBy) {
      const [k, dir] = Object.entries(clause)[0] as [keyof Row, 'asc' | 'desc']
      if (a[k] < b[k]) return dir === 'asc' ? -1 : 1
      if (a[k] > b[k]) return dir === 'asc' ? 1 : -1
    }
    return 0
  })
}

const rows: Row[] = [
  { id: 'c3', episodeId: 'WLT-OTH-261113-01', sequence: 1, title: 'รายการ B' },
  { id: 'c1', episodeId: 'WLT-OTH-261113-01', sequence: 1, title: 'รายการ A' }, // episodeId ซ้ำได้ (ไม่ unique)
  { id: 'c2', episodeId: 'WLT-MNW-261113-01', sequence: 1, title: 'รายการ C' },
  { id: 'c0', episodeId: 'WLT-ZZZ-261113-02', sequence: 2, title: 'รายการ D' },
]
const permutations = [rows, [...rows].reverse(), [rows[2], rows[0], rows[3], rows[1]], [rows[1], rows[3], rows[2], rows[0]]]

test('EP ที่ sequence เท่ากันออกมาลำดับเดียวกันเสมอ ไม่ว่า DB จะคืนแถวมาแบบไหน', () => {
  const ids = permutations.map(p => orderRows(p, EPISODE_ORDER).map(r => r.id).join(','))
  assert.deepEqual(new Set(ids).size, 1, ids.join(' | '))
  assert.equal(ids[0], 'c2,c1,c3,c0') // sequence → episodeId → id
})

test('sequence อย่างเดียวไม่พอ (นี่คือบั๊กเดิม) — episodes[0] เปลี่ยนตามลำดับที่ DB คืน', () => {
  const firsts = new Set(permutations.map(p => orderRows(p, [{ sequence: 'asc' }])[0].title))
  assert.ok(firsts.size > 1)
})

test('EPISODE_ORDER ปิดท้ายด้วย id (PK) — episodeId ไม่ unique จึงไม่พอเป็นตัวตัดสินสุดท้าย', () => {
  assert.deepEqual(EPISODE_ORDER, [{ sequence: 'asc' }, { episodeId: 'asc' }, { id: 'asc' }])
})

test('class 9: ไม่มีไฟล์ไหนใน src/ เรียง EP ด้วย sequence เอง — ต้องใช้ EPISODE_ORDER', () => {
  const src = join(__dirname, '..', '..')
  const own = /orderBy:\s*\[?\s*\{\s*sequence\s*:/
  const offenders = (readdirSync(src, { recursive: true }) as string[])
    .filter(f => /\.(ts|tsx)$/.test(f) && !f.includes('__tests__') && !f.endsWith('episode-order.ts'))
    .filter(f => own.test(readFileSync(join(src, f), 'utf8')))
  assert.deepEqual(offenders, [])
})
