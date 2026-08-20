// v1.183 — Co-Producer ประจำ outlet (คำสั่ง operator 2026-08-20:
// "งานของ TSS ทุกงานหลังจากนี้ ให้ยิงแก้ว co-po TSS ในคิวด้วย")

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { applyDefaultCoProducer, defaultCoProducerFor, BUILT_IN_DEFAULT_COPRODUCERS } from '../outlet-coproducer'

const KAEW = BUILT_IN_DEFAULT_COPRODUCERS.TSS

afterEach(() => {
  delete process.env.AUTO_COPRODUCER
  delete process.env.AUTO_COPRODUCER_TSS
  delete process.env.AUTO_COPRODUCER_NWS
})

test('แก้วต้องเป็นคนเดียวกับ seed ของ TSS ใน outlet-producers', () => {
  assert.deepEqual(KAEW, { nickname: 'แก้ว', email: 'phoemsiri.p@thestandard.co' })
})

test('งาน TSS ที่ไม่ได้เลือก Co-Producer → ระบบใส่แก้วให้', () => {
  const r = applyDefaultCoProducer({
    outletCode: 'TSS', coProducer: null, coProducerEmail: null, producerEmail: 'ingtawan.s@thestandard.co',
  })
  assert.deepEqual(r, { coProducer: 'แก้ว', coProducerEmail: 'phoemsiri.p@thestandard.co', autoFilled: true })
})

test('คนจองเลือก Co-Producer คนอื่นไว้แล้ว → ห้ามทับ (กติกาที่ operator ยืนยัน)', () => {
  const r = applyDefaultCoProducer({
    outletCode: 'TSS', coProducer: 'เติร์ก', coProducerEmail: 'techanan.w@thestandard.co', producerEmail: null,
  })
  assert.deepEqual(r, { coProducer: 'เติร์ก', coProducerEmail: 'techanan.w@thestandard.co', autoFilled: false })
})

test('เลือกมาเฉพาะชื่อ (ไม่มีอีเมล) ก็ยังนับว่าเลือกแล้ว', () => {
  const r = applyDefaultCoProducer({
    outletCode: 'TSS', coProducer: 'เติร์ก', coProducerEmail: null, producerEmail: null,
  })
  assert.equal(r.autoFilled, false)
  assert.equal(r.coProducer, 'เติร์ก')
})

test('แก้วเป็น Producer ของงานอยู่แล้ว → ไม่ต้องใส่ซ้ำเป็น Co-Producer', () => {
  const r = applyDefaultCoProducer({
    outletCode: 'TSS', coProducer: null, coProducerEmail: null, producerEmail: 'PHOEMSIRI.P@thestandard.co',
  })
  assert.equal(r.autoFilled, false)
  assert.equal(r.coProducer, null)
})

test('outlet อื่นไม่โดนผลกระทบ', () => {
  for (const code of ['NWS', 'AGN', 'POP', 'PM', '', null, undefined]) {
    const r = applyDefaultCoProducer({
      outletCode: code as any, coProducer: null, coProducerEmail: null, producerEmail: null,
    })
    assert.equal(r.autoFilled, false, String(code))
    assert.equal(r.coProducer, null, String(code))
  }
})

test('รหัส outlet ตัวพิมพ์เล็กก็ยังจับได้', () => {
  assert.deepEqual(defaultCoProducerFor('tss'), KAEW)
  assert.deepEqual(defaultCoProducerFor(' TSS '), KAEW)
})

test('kill switch AUTO_COPRODUCER=0 ปิดได้ทั้งระบบโดยไม่ต้อง deploy', () => {
  process.env.AUTO_COPRODUCER = '0'
  assert.equal(defaultCoProducerFor('TSS'), null)
  assert.equal(applyDefaultCoProducer({
    outletCode: 'TSS', coProducer: null, coProducerEmail: null, producerEmail: null,
  }).autoFilled, false)
})

test('AUTO_COPRODUCER_TSS override: เปลี่ยนคน / ตั้งชื่อเล่น / ปิดเฉพาะ outlet', () => {
  process.env.AUTO_COPRODUCER_TSS = 'someone.x@thestandard.co|ซัม'
  assert.deepEqual(defaultCoProducerFor('TSS'), { nickname: 'ซัม', email: 'someone.x@thestandard.co' })

  process.env.AUTO_COPRODUCER_TSS = 'someone.x@thestandard.co'
  assert.deepEqual(defaultCoProducerFor('TSS'), { nickname: 'แก้ว', email: 'someone.x@thestandard.co' })

  process.env.AUTO_COPRODUCER_TSS = ''
  assert.equal(defaultCoProducerFor('TSS'), null)
})

test('AUTO_COPRODUCER_<CODE> เปิดให้ outlet ที่ยังไม่มีในตารางได้', () => {
  process.env.AUTO_COPRODUCER_NWS = 'newbie@thestandard.co|น้องใหม่'
  assert.deepEqual(defaultCoProducerFor('NWS'), { nickname: 'น้องใหม่', email: 'newbie@thestandard.co' })
})
