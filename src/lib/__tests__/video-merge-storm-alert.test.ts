/**
 * v1.266.2 — เตือน sync-storm เฉพาะตอนชุดชื่อเปลี่ยน (ชุดเดิม = สัปดาห์ละครั้ง)
 *
 * เคสจริง: POP-PIV-261007-02 ซาก "(1)" 123 ชื่อชุดเดิม เตือนซ้ำ 8 ครั้งใน 2 วัน (9–11 ต.ค. 2569) ทุก 6 ชม.
 * ทั้งที่ต้นฉบับอยู่ในกล่องครบแล้ว — การเตือนซ้ำไม่ทำให้ใครถอดตัวอัปเร็วขึ้น มีแต่ทำให้เลิกอ่าน
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const HOUR = 3_600_000
let rows: Record<string, { key: string; at: Date; note: string | null }> = {}
let readFails = false
let now = Date.parse('2026-10-11T12:32:00Z')
const sent: Array<{ key: string; everyMs: number; text: string }> = []

mock.module('../db', {
  namedExports: {
    prisma: {
      systemHeartbeat: {
        findUnique: async ({ where }: any) => { if (readFails) throw new Error('db down'); return rows[where.key] ?? null },
        upsert: async ({ where, create, update }: any) => { rows[where.key] = { ...(rows[where.key] ?? create), ...update } },
      },
    },
  },
})
// alertOps' own throttle, faithfully: send unless the last attempt for this key is younger than everyMs
mock.module('../ops-alert', {
  namedExports: {
    OPS_ALERT_EVERY_MS: 6 * HOUR,
    alertOps: async (key: string, _subject: string, text: string, everyMs: number) => {
      const last = rows[`alert:${key}`]?.at
      if (last && now - last.getTime() < everyMs) return { attempted: false, delivered: false, discord: false, lark: false, email: false }
      rows[`alert:${key}`] = { key: `alert:${key}`, at: new Date(now), note: 'email=true' }
      sent.push({ key, everyMs, text })
      return { attempted: true, delivered: true, discord: false, lark: false, email: true }
    },
  },
})
mock.module('../google-drive', { namedExports: {} })

let vm: typeof import('../video-merge')
before(async () => { vm = await import('../video-merge') })
beforeEach(() => { rows = {}; readFails = false; sent.length = 0; now = Date.parse('2026-10-11T12:32:00Z') })

const names = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `C${String(i + from).padStart(4, '0')} (1).MXF`)
const at = (h: number) => { now = Date.parse('2026-10-11T12:32:00Z') + h * HOUR }

test('ชุดเดิม (เคส POP-PIV-261007-02) → เตือนครั้งเดียว แล้วเงียบจนครบ 7 วัน ไม่ใช่ทุก 6 ชม.', async () => {
  const set = names(123)
  await vm.reportConflicts('POP-PIV-261007-02', set)
  for (const h of [6.5, 13, 19.5, 26, 48, 100, 167]) { at(h); await vm.reportConflicts('POP-PIV-261007-02', [...set].reverse()) }
  assert.equal(sent.length, 1, 'ลำดับชื่อต่างกันไม่ใช่ชุดใหม่')
  at(168.5)
  await vm.reportConflicts('POP-PIV-261007-02', set)
  assert.equal(sent.length, 2, 'ครบสัปดาห์ = เตือนซ้ำหนึ่งครั้ง (ไม่เงียบถาวร)')
  assert.match(sent[0].text, /ชุดเดิมเตือนซ้ำสัปดาห์ละครั้ง/)
})

test('ชุดเปลี่ยน (ซิงก์ยังเขียนอยู่) = ข่าวใหม่ → เตือนที่ 6 ชม. ตามเดิม · ไม่ถี่กว่านั้น', async () => {
  await vm.reportConflicts('X-1', names(10))
  at(1); await vm.reportConflicts('X-1', names(12))
  assert.equal(sent.length, 1, 'ยังอยู่ในหน้าต่าง 6 ชม. ของรหัสนี้')
  at(6.5); await vm.reportConflicts('X-1', names(12))
  assert.equal(sent.length, 2, 'ชุดที่ยังไม่เคยเตือน → เตือนเมื่อพ้น 6 ชม.')
  at(13); await vm.reportConflicts('X-1', names(12))
  assert.equal(sent.length, 2, 'ชุดนั้นเตือนแล้ว → รอสัปดาห์')
})

test('อ่านชุดเดิมไม่ได้ → ถือเป็นชุดใหม่ (เตือนซ้ำดีกว่าเงียบ)', async () => {
  await vm.reportConflicts('X-2', names(5))
  readFails = true
  at(6.5); await vm.reportConflicts('X-2', names(5))
  assert.equal(sent.length, 2)
  assert.equal(sent[1].everyMs, 6 * HOUR)
})

test('ไม่มีซาก = ไม่ทำอะไร · ลายนิ้วมือไม่ขึ้นกับลำดับ แต่ขึ้นกับชื่อ', async () => {
  await vm.reportConflicts('X-3', [])
  assert.equal(sent.length, 0)
  assert.equal(vm.conflictSetKey(['b (1)', 'a (1)']), vm.conflictSetKey(['a (1)', 'b (1)']))
  assert.notEqual(vm.conflictSetKey(['a (1)']), vm.conflictSetKey(['a (1)', 'b (1)']))
})
