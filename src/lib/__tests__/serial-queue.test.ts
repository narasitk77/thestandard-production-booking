// v1.237 — คิว append: ห้ามทับกัน + เว้นจังหวะ
//
// บั๊กที่กันอยู่: values.append ที่ยิงพร้อมกันคืน updatedRange ที่ไม่ตรงแถวจริง
// ⇒ พรอด 2026-09-24 มี 39 ใบเก็บ sheetRowIndex ผิด (แถว 638 ถูกอ้างโดย 12 ใบ)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSerialQueue } from '../serial-queue'

test('งานไม่ทับกันเลย แม้จะต่อคิวเข้ามาพร้อมกันทั้งหมด', async () => {
  const q = makeSerialQueue(0, { jobTimeoutMs: 5_000 })
  let inFlight = 0, maxInFlight = 0
  const order: number[] = []
  await Promise.all([1, 2, 3, 4, 5].map(n => q.run(async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(r => setTimeout(r, 5))
    order.push(n); inFlight--
  })))
  assert.equal(maxInFlight, 1, 'ทับกันเมื่อไหร่ = updatedRange เชื่อไม่ได้')
  assert.deepEqual(order, [1, 2, 3, 4, 5], 'ต้องเรียงตามลำดับที่ต่อคิว')
})

test('เว้นจังหวะขั้นต่ำระหว่างงาน', async () => {
  const q = makeSerialQueue(40, { jobTimeoutMs: 5_000 })
  const t0 = Date.now()
  await Promise.all([1, 2, 3].map(() => q.run(async () => {})))
  // งานแรกไม่ต้องรอ (lastFinishedAt = 0) อีกสองงานเว้น 40ms ⇒ อย่างน้อย ~80ms
  assert.ok(Date.now() - t0 >= 70, `เร็วเกินไป (${Date.now() - t0}ms) = จังหวะไม่ทำงาน`)
})

test('งานที่ล้มต้องไม่ทำให้คิวที่เหลือค้าง', async () => {
  const q = makeSerialQueue(0, { jobTimeoutMs: 5_000 })
  const done: string[] = []
  const bad = q.run(async () => { throw new Error('พัง') })
  const good = q.run(async () => { done.push('ต่อคิวถัดไปได้') })
  await assert.rejects(bad, /พัง/)
  await good
  assert.deepEqual(done, ['ต่อคิวถัดไปได้'])
})

test('ผู้เรียกได้ค่าที่งานของตัวเองคืน ไม่ใช่ของงานอื่น', async () => {
  const q = makeSerialQueue(0, { jobTimeoutMs: 5_000 })
  const results = await Promise.all([10, 20, 30].map(n => q.run(async () => n * 2)))
  assert.deepEqual(results, [20, 40, 60])
})

test('งานที่ต่อคิวหลังคิวว่างแล้ว ยังทำงานได้ตามปกติ', async () => {
  const q = makeSerialQueue(0, { jobTimeoutMs: 5_000 })
  assert.equal(await q.run(async () => 'ก'), 'ก')
  assert.equal(await q.run(async () => 'ข'), 'ข')
})

test('งานที่ค้างไม่ยอมจบ ต้องไม่กันงานถัดไปตลอดกาล', async () => {
  // นี่คือความเสี่ยงใหม่ที่การต่อคิวสร้างขึ้น: ของเดิมยิงขนาน ค้างหนึ่งตัวเสียหนึ่งงาน
  // ต่อคิวแล้วค้างหนึ่งตัวเสีย **ทุกงานที่เหลือตลอดอายุโปรเซส** และเงียบสนิท
  const q = makeSerialQueue(0, { jobTimeoutMs: 60, label: 'test' })
  const stuck = q.run(() => new Promise(() => {}))   // ไม่ settle เลย
  let ranAfter = false
  const after = q.run(async () => { ranAfter = true; return 'ผ่าน' })
  await assert.rejects(stuck, /งานค้างเกิน 60ms/)
  assert.equal(await after, 'ผ่าน')
  assert.equal(ranAfter, true, 'คิวต้องเดินต่อหลังตัดงานที่ค้างทิ้ง')
})

test('งานที่จบทันเวลาไม่ถูกตัดทิ้ง', async () => {
  const q = makeSerialQueue(0, { jobTimeoutMs: 200 })
  assert.equal(await q.run(async () => { await new Promise(r => setTimeout(r, 20)); return 'ทัน' }), 'ทัน')
})
