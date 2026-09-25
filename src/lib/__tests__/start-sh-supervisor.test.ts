// v1.238 — กับดักใน start.sh ที่ถอยกลับได้เงียบมาก
//
// start.sh รันด้วย `set -e` · คำสั่งเปล่า ๆ ในตัวลูปที่ออกไม่เป็นศูนย์จะฆ่า subshell
// ทันที ⇒ ถ้า supervise() เขียน `node "$script"` เปล่า ๆ ลูป restart จะรอดเฉพาะ
// การ exit 0 เท่านั้น worker ที่แครชจริงจะฆ่า supervisor ของตัวเองทิ้ง **เงียบ ๆ
// ไม่มี log สักบรรทัด** และไม่กลับมาอีกเลยตลอดอายุคอนเทนเนอร์
// (พิสูจน์ด้วยการรันจริง 2026-09-25 — ของเดิมเป็นแบบนั้นมาตลอด)
//
// เทสนี้อ่านซอร์สเพราะการพิสูจน์จริงต้องรัน shell + spawn node
// (แบบเดียวกับ compose-env-coverage.test.ts ที่รีโปนี้ใช้อยู่)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'

const startSh = readFileSync(join(process.cwd(), 'start.sh'), 'utf8')

function superviseBody(): string {
  const i = startSh.indexOf('supervise() {')
  assert.ok(i > 0, 'หา supervise() ใน start.sh ไม่เจอ — เทสนี้ตรวจอะไรไม่ได้แล้ว')
  const j = startSh.indexOf('\n}\n', i)
  assert.ok(j > i, 'หาท้ายฟังก์ชัน supervise() ไม่เจอ')
  return startSh.slice(i, j)
}

test('start.sh ยังใช้ set -e อยู่ (ถ้าเลิกใช้ เทสข้างล่างก็ไม่จำเป็นแล้ว)', () => {
  assert.match(startSh, /^set -e$/m)
})

test('supervise() ต้องดักรหัสออกด้วย `|| code=$?` ไม่ใช่เรียก node เปล่า ๆ', () => {
  const body = superviseBody()
  assert.match(body, /node "\$script" \|\| code=\$\?/,
    'เรียก node เปล่า ๆ ใต้ set -e = worker ที่แครชจะฆ่า supervisor ตัวเองทิ้งเงียบ ๆ')
  assert.ok(!/^\s*node "\$script"\s*$/m.test(body),
    'ยังมีบรรทัด `node "$script"` เปล่า ๆ อยู่')
})

test('supervise() หยุดปลุกเมื่อ worker บอกว่าถูกปิดไว้ (exit 78)', () => {
  const body = superviseBody()
  assert.match(body, /-eq 78/, 'ต้องเช็กรหัส 78')
  assert.match(body, /break/, 'เจอ 78 แล้วต้องหยุดลูป ไม่งั้น log จะท่วมเหมือนเดิม')
})

test('ทุก worker ถูกปลุกผ่าน supervise() ตัวเดียว ไม่มีใครเขียนลูปเอง', () => {
  const calls = startSh.match(/^supervise "/gm) || []
  assert.ok(calls.length >= 15, `เรียก supervise แค่ ${calls.length} ครั้ง`)
  assert.ok(!/while true; do\n\s+node scripts\//.test(startSh),
    'ยังมีลูป restart ที่ก๊อปไว้เอง — กฎต้องอยู่ที่ supervise() ที่เดียว')
})
