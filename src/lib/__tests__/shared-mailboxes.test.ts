// v1.191 — กล่องกลางของทีมไม่ใช่คน: ตัดออกจาก OT แต่ห้ามตัดออกจากการแจ้งข่าว

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSharedMailbox, excludeSharedMailboxes, sharedMailboxes, DEFAULT_SHARED_MAILBOXES,
} from '../shared-mailboxes'

afterEach(() => { delete process.env.SHARED_MAILBOXES })

test('จับกล่องกลางที่มีจริงบนพรอดได้ครบ', () => {
  for (const e of ['video@thestandard.co', 'sound@thestandard.co', 'podcast@thestandard.co',
                   'event@thestandard.co', 'photo@thestandard.co', 'webmaster@thestandard.co']) {
    assert.equal(isSharedMailbox(e), true, e)
  }
})

test('ไม่ตัดคนจริง — รวมคนที่ local-part ไม่มีจุด', () => {
  // นี่คือเหตุผลที่ใช้รายชื่อชัดเจนแทน heuristic: bickboon เป็นคนจริงบนพรอด
  // ถ้าเดาจาก "ไม่มีจุด = กล่องกลาง" จะตัดเขาออกจาก OT เงียบ ๆ
  for (const e of ['bickboon@thestandard.co', 'narasit.k@thestandard.co',
                   'krittapon.j@thestandard.co', 'ingtawan.s@thestandard.co']) {
    assert.equal(isSharedMailbox(e), false, e)
  }
})

test('ไม่สนตัวพิมพ์และช่องว่าง', () => {
  for (const e of ['VIDEO@thestandard.co', ' Sound@Thestandard.co ']) {
    assert.equal(isSharedMailbox(e), true, e)
  }
})

test('ค่าว่าง/พิการ = ไม่ใช่กล่องกลาง (ไม่ throw)', () => {
  for (const e of ['', '   ', null, undefined, 'ไม่ใช่อีเมล']) {
    assert.equal(isSharedMailbox(e as any), false, String(e))
  }
})

test('excludeSharedMailboxes เก็บคนไว้ ตัดกล่องออก คงลำดับเดิม', () => {
  assert.deepEqual(
    excludeSharedMailboxes([
      'video@thestandard.co', 'thanakorn.s@thestandard.co',
      'sound@thestandard.co', 'bickboon@thestandard.co', '', null,
    ]),
    ['thanakorn.s@thestandard.co', 'bickboon@thestandard.co'],
  )
})

test('คิวที่มีแต่กล่องกลาง → เหลือศูนย์ (จะไม่สร้างร่าง OT เลย)', () => {
  assert.deepEqual(excludeSharedMailboxes(['video@thestandard.co', 'sound@thestandard.co']), [])
})

test('env override แทนที่ทั้งชุด และค่าพิการตกกลับเป็น default', () => {
  process.env.SHARED_MAILBOXES = 'ops@thestandard.co, desk@thestandard.co'
  assert.deepEqual(sharedMailboxes(), ['ops@thestandard.co', 'desk@thestandard.co'])
  assert.equal(isSharedMailbox('video@thestandard.co'), false, 'ถูกแทนที่แล้ว')
  assert.equal(isSharedMailbox('ops@thestandard.co'), true)

  process.env.SHARED_MAILBOXES = '   ,,  '
  assert.deepEqual(sharedMailboxes(), [...DEFAULT_SHARED_MAILBOXES], 'ค่าพิการ = ใช้ default ไม่ใช่ตัดทุกคนออก')
})
