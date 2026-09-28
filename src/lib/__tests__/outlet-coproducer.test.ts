// v1.183 — Co-Producer ประจำ outlet (คำสั่ง operator 2026-08-20:
// "งานของ TSS ทุกงานหลังจากนี้ ให้ยิงแก้ว co-po TSS ในคิวด้วย")
// v1.242 — แก้วออกจากทีม (28 ก.ย. 2569) ตารางค่าตั้งต้นว่าง กลไกทดสอบผ่าน env override แทน

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { applyDefaultCoProducer, defaultCoProducerFor, BUILT_IN_DEFAULT_COPRODUCERS } from '../outlet-coproducer'

const SOM = { nickname: 'ซัม', email: 'someone.x@thestandard.co' }
const withTss = () => { process.env.AUTO_COPRODUCER_TSS = `${SOM.email}|${SOM.nickname}` }

afterEach(() => {
  delete process.env.AUTO_COPRODUCER
  delete process.env.AUTO_COPRODUCER_TSS
  delete process.env.AUTO_COPRODUCER_NWS
})

test('v1.242 — ไม่มี Co-Producer ตั้งต้นในโค้ดแล้ว: ใบ TSS ใหม่ไม่ถูกเติมชื่อใครโดยอัตโนมัติ', () => {
  assert.deepEqual(BUILT_IN_DEFAULT_COPRODUCERS, {})
  assert.equal(defaultCoProducerFor('TSS'), null)
  const r = applyDefaultCoProducer({
    outletCode: 'TSS', coProducer: null, coProducerEmail: null, producerEmail: 'ingtawan.s@thestandard.co',
  })
  assert.deepEqual(r, { coProducer: null, coProducerEmail: null, autoFilled: false })
  // และต้องไม่มีอีเมลของคนที่ออกแล้วซ่อนอยู่ที่ไหนในโมดูลนี้
  assert.ok(!JSON.stringify(BUILT_IN_DEFAULT_COPRODUCERS).includes('phoemsiri'))
})

test('กลไกยังทำงาน: เปิดผ่าน env แล้วใบที่ไม่ได้เลือก Co-Producer → ระบบใส่ให้', () => {
  withTss()
  const r = applyDefaultCoProducer({
    outletCode: 'TSS', coProducer: null, coProducerEmail: null, producerEmail: 'ingtawan.s@thestandard.co',
  })
  assert.deepEqual(r, { coProducer: SOM.nickname, coProducerEmail: SOM.email, autoFilled: true })
})

test('คนจองเลือก Co-Producer คนอื่นไว้แล้ว → ห้ามทับ (กติกาที่ operator ยืนยัน)', () => {
  withTss()
  const r = applyDefaultCoProducer({
    outletCode: 'TSS', coProducer: 'เติร์ก', coProducerEmail: 'techanan.w@thestandard.co', producerEmail: null,
  })
  assert.deepEqual(r, { coProducer: 'เติร์ก', coProducerEmail: 'techanan.w@thestandard.co', autoFilled: false })
})

test('เลือกมาเฉพาะชื่อ (ไม่มีอีเมล) ก็ยังนับว่าเลือกแล้ว', () => {
  withTss()
  const r = applyDefaultCoProducer({
    outletCode: 'TSS', coProducer: 'เติร์ก', coProducerEmail: null, producerEmail: null,
  })
  assert.equal(r.autoFilled, false)
  assert.equal(r.coProducer, 'เติร์ก')
})

test('คนตั้งต้นเป็น Producer ของงานอยู่แล้ว → ไม่ต้องใส่ซ้ำเป็น Co-Producer', () => {
  withTss()
  const r = applyDefaultCoProducer({
    outletCode: 'TSS', coProducer: null, coProducerEmail: null, producerEmail: 'SOMEONE.X@thestandard.co',
  })
  assert.equal(r.autoFilled, false)
  assert.equal(r.coProducer, null)
})

test('outlet ที่ไม่มีกฎไม่โดนผลกระทบ แม้เปิดกฎให้ TSS', () => {
  withTss()
  for (const code of ['NWS', 'AGN', 'POP', 'PM', '', null, undefined]) {
    const r = applyDefaultCoProducer({
      outletCode: code as any, coProducer: null, coProducerEmail: null, producerEmail: null,
    })
    assert.equal(r.autoFilled, false, String(code))
    assert.equal(r.coProducer, null, String(code))
  }
})

test('รหัส outlet ตัวพิมพ์เล็ก/มีช่องว่างก็ยังจับได้', () => {
  withTss()
  assert.deepEqual(defaultCoProducerFor('tss'), SOM)
  assert.deepEqual(defaultCoProducerFor(' TSS '), SOM)
})

test('kill switch AUTO_COPRODUCER=0 ปิดได้ทั้งระบบโดยไม่ต้อง deploy (ชนะ override รายเจ้า)', () => {
  withTss()
  process.env.AUTO_COPRODUCER = '0'
  assert.equal(defaultCoProducerFor('TSS'), null)
  assert.equal(applyDefaultCoProducer({
    outletCode: 'TSS', coProducer: null, coProducerEmail: null, producerEmail: null,
  }).autoFilled, false)
})

test('AUTO_COPRODUCER_TSS override: ตั้งชื่อเล่น / อีเมลอย่างเดียว / ปิดเฉพาะ outlet', () => {
  process.env.AUTO_COPRODUCER_TSS = 'someone.x@thestandard.co|ซัม'
  assert.deepEqual(defaultCoProducerFor('TSS'), SOM)

  process.env.AUTO_COPRODUCER_TSS = 'someone.x@thestandard.co'
  const only = defaultCoProducerFor('TSS')
  assert.equal(only?.email, 'someone.x@thestandard.co')
  assert.ok(typeof only?.nickname === 'string' && only.nickname.length > 0, 'ไม่มีชื่อเล่นก็ต้องมีค่าให้แสดง')

  process.env.AUTO_COPRODUCER_TSS = ''
  assert.equal(defaultCoProducerFor('TSS'), null)
})

test('AUTO_COPRODUCER_<CODE> เปิดให้ outlet ที่ยังไม่มีในตารางได้', () => {
  process.env.AUTO_COPRODUCER_NWS = 'newbie@thestandard.co|น้องใหม่'
  assert.deepEqual(defaultCoProducerFor('NWS'), { nickname: 'น้องใหม่', email: 'newbie@thestandard.co' })
})
