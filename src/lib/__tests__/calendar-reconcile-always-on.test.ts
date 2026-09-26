// v1.239 — calendar-reconcile ต้องไม่มีสวิตช์ปิด
//
// WHY. มันเป็น **ตัวเดียว** ที่เรียก maybeAlertStaleWorkers() ซึ่งเป็น dead-man check
// ของ worker ทั้ง 16 ตัว (src/app/api/internal/calendar/reconcile/route.ts)
// สวิตช์ปิดของมันจึงเท่ากับ env ตัวเดียวที่ดับการเฝ้าระวังทั้งระบบแบบเงียบ ๆ —
// ซึ่ง heartbeat.ts เขียนเตือนไว้เองว่าเป็น "the failure this whole file exists to prevent"
//
// เดิม docker-compose.portainer.yml ส่ง CALENDAR_RECONCILE_WORKER_ENABLED เข้าไป
// โดยไม่มีโค้ดไหนอ่าน = สัญญาว่ามีสวิตช์ที่ไม่มีอยู่จริง · ถอดออกที่ v1.239
// เทสชุดนี้กันไม่ให้ใครใส่กลับมาด้วยความหวังดี

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

test('dead-man check ยังมีผู้เรียกรายเดียว — ถ้ามีมากกว่านี้ เหตุผลของเทสชุดนี้เปลี่ยน', () => {
  const route = read('src/app/api/internal/calendar/reconcile/route.ts')
  assert.match(route, /maybeAlertStaleWorkers\(\)/,
    'calendar-reconcile ต้องยังเป็นตัวที่รัน dead-man check')
})

test('heartbeat ต้องฮาร์ดโค้ด enabled: true ให้ calendar-reconcile ไม่ใช่อ่าน env', () => {
  const hb = read('src/lib/heartbeat.ts')
  const spec = hb.slice(hb.indexOf("key: 'calendar-reconcile'"))
    .slice(0, hb.slice(hb.indexOf("key: 'calendar-reconcile'")).indexOf('}'))
  assert.match(spec, /enabled:\s*true/,
    'ถ้าให้มันอ่าน env จะปิดการเฝ้าระวังทั้งระบบได้ด้วยตัวแปรเดียว')
  assert.ok(!/CALENDAR_RECONCILE_WORKER_ENABLED/.test(spec),
    'heartbeat ต้องไม่อ่านสวิตช์ปิดของ calendar-reconcile')
})

test('ไม่มีโค้ดไหนอ่าน CALENDAR_RECONCILE_WORKER_ENABLED', () => {
  for (const f of ['scripts/calendar-reconcile-worker.js', 'src/lib/heartbeat.ts', 'start.sh']) {
    assert.ok(!read(f).includes('CALENDAR_RECONCILE_WORKER_ENABLED'), `${f} ไม่ควรอ่านตัวแปรนี้`)
  }
})

test('compose ต้องไม่ส่ง CALENDAR_RECONCILE_WORKER_ENABLED (นอกจากในคอมเมนต์อธิบาย)', () => {
  for (const f of ['docker-compose.portainer.yml', 'docker-compose.yml', 'docker-compose.staging.yml']) {
    let src: string
    try { src = read(f) } catch { continue }
    const live = src.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
    assert.ok(!live.includes('CALENDAR_RECONCILE_WORKER_ENABLED'),
      `${f} ส่งสวิตช์ที่ไม่มีอยู่จริง — ถ้าตั้งใจให้ปิดได้ ต้องย้าย dead-man check ไปที่อื่นก่อน`)
  }
})
