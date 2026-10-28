/**
 * ส่งฟุตเทจจากหน้างาน (v1.277) — กฎที่ห้ามพัง:
 *   - การ์ดที่ล้ม/ตาย (ORPHANED) ต้องยัง "ถือ" footage พร้อมไว้ — FAILED (คนปลดเอง) เท่านั้นที่ปล่อย
 *   - park ตั้งใจ (proxies-ok / quota-wait) ไม่ใช่ stale
 *   - complete ปฏิเสธเมื่อชื่อซ้ำ / จำนวนไม่ตรง / check ไม่ผ่าน
 *   - start ปฏิเสธการ์ดที่ไม่ใช่ Sony ทั้งใบ, ใบที่ส่งอยู่ทางอื่น, โควตาไม่พอ
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cardFileName, isCardRow, hashTicket, newTicket, parseNotes, isStaleCard, cardHoldsNotice,
  decideStart, decideComplete, budgetBytes, QUOTA_BYTES, QUOTA_MARGIN_BYTES, STALE_MS, HEARTBEAT_PHASES,
} from '../ingest'

const sony = { files: 7, bytes: 1.5e9, videos: 1, wavs: 0, sonyTree: true, mediapro: true }
const okCtx = { isAgency: false, hasBox: true, landingHasFiles: false, nasPending: 0, otherUploaderInFlight: false, usedBytes24h: 0 }

test('card row name carries camera + Bangkok date + id tail, and is recognised', () => {
  const name = cardFileName('cam-a', 'cmxabcdefg123456', new Date('2026-10-26T18:30:00Z')) // 01:30 BKK on the 27th
  assert.equal(name, 'CARD_CAM-A_261027_123456')
  assert.ok(isCardRow(name))
  assert.ok(!isCardRow('C0001.MP4'))
})

test('ticket is random and only its hash is stored', () => {
  const t1 = newTicket(), t2 = newTicket()
  assert.notEqual(t1, t2)
  assert.match(hashTicket(t1), /^[0-9a-f]{64}$/)
  assert.notEqual(hashTicket(t1), hashTicket(t2))
})

test('notes parse safely', () => {
  assert.equal(parseNotes(null), null)
  assert.equal(parseNotes('not json'), null)
  assert.equal(parseNotes('{"x":1}'), null)
  assert.equal(parseNotes('{"phase":"pass1","bytes":5}')?.bytes, 5)
})

test('stale = UPLOADING, not parked, silent past STALE_MS', () => {
  const now = new Date('2026-10-27T10:00:00Z')
  const old = new Date(now.getTime() - STALE_MS - 1)
  assert.ok(isStaleCard({ status: 'UPLOADING', updatedAt: old, notes: '{"phase":"pass1"}' }, now))
  assert.ok(!isStaleCard({ status: 'UPLOADING', updatedAt: new Date(now.getTime() - 60_000), notes: '{"phase":"pass1"}' }, now))
  assert.ok(!isStaleCard({ status: 'UPLOADING', updatedAt: old, notes: '{"phase":"proxies-ok"}' }, now), 'parked is not stale')
  assert.ok(!isStaleCard({ status: 'UPLOADING', updatedAt: old, notes: '{"phase":"quota-wait"}' }, now))
  assert.ok(!isStaleCard({ status: 'ORPHANED', updatedAt: old, notes: null }, now), 'already orphaned')
  assert.ok(!isStaleCard({ status: 'COMPLETE', updatedAt: old, notes: null }, now))
})

test('a heartbeat can never park or close a card (that would silence the stale alert)', () => {
  for (const p of ['pass1', 'check1', 'pass2', 'check2']) assert.ok(HEARTBEAT_PHASES.has(p))
  for (const p of ['proxies-ok', 'quota-wait', 'complete', 'failed', 'start']) assert.ok(!HEARTBEAT_PHASES.has(p), p)
})

test('ORPHANED and UPLOADING cards hold the notice; FAILED / COMPLETE release it', () => {
  assert.ok(cardHoldsNotice([{ fileName: 'CARD_CAM-A_261027_abc', status: 'ORPHANED' }]), 'a dead run must never release')
  assert.ok(cardHoldsNotice([{ fileName: 'CARD_CAM-A_261027_abc', status: 'UPLOADING' }]))
  assert.ok(!cardHoldsNotice([{ fileName: 'CARD_CAM-A_261027_abc', status: 'FAILED' }]), 'ADMIN → FAILED is the release')
  assert.ok(!cardHoldsNotice([{ fileName: 'CARD_CAM-A_261027_abc', status: 'COMPLETE' }]))
  assert.ok(!cardHoldsNotice([{ fileName: 'C0001.MXF', status: 'ORPHANED' }]), 'browser rows are gate (c), not this')
})

test('start refusals, in order', () => {
  assert.equal((decideStart(sony, { ...okCtx, isAgency: true }) as any).code, 'AGN_PHASE3')
  assert.equal((decideStart(sony, { ...okCtx, hasBox: false }) as any).code, 'NO_BOX')
  assert.equal((decideStart({ ...sony, videos: 0, wavs: 0 }, okCtx) as any).code, 'NO_MEDIA')
  assert.equal((decideStart({ ...sony, sonyTree: false }, okCtx) as any).code, 'NON_SONY')
  assert.equal((decideStart({ ...sony, mediapro: false }, okCtx) as any).code, 'NO_MEDIAPRO')
  assert.equal((decideStart(sony, { ...okCtx, landingHasFiles: true }) as any).code, 'LANDING_HAS_FILES')
  assert.equal((decideStart(sony, { ...okCtx, nasPending: 3 }) as any).code, 'NAS_SENDING')
  assert.equal((decideStart(sony, { ...okCtx, otherUploaderInFlight: true }) as any).code, 'OTHER_UPLOADER')
  assert.equal((decideStart({ ...sony, bytes: 800e9 }, okCtx) as any).code, 'QUOTA')
  const ok = decideStart(sony, { ...okCtx, usedBytes24h: 100e9 })
  assert.ok(ok.ok)
  assert.equal((ok as any).budgetBytes, QUOTA_BYTES - QUOTA_MARGIN_BYTES - 100e9)
  assert.equal(budgetBytes(10e12), 0, 'never negative')
})

test('complete: twins, count mismatch and failed checks are refused', () => {
  const paths = ['XDROOT/MEDIAPRO.XML', 'XDROOT/Sub/A.MP4', 'XDROOT/Thmbnl/A.JPG']
  assert.ok(decideComplete({ matching: 3, differences: 0 }, { paths }, 3).ok)
  assert.equal((decideComplete({ matching: 3, differences: 0 }, { paths: [...paths, 'XDROOT/Thmbnl/A.JPG'] }, 3) as any).code, 'DUP_NAMES',
    'kill → rerun made two identical JPGs; rclone check said "ignoring" and passed')
  assert.equal((decideComplete({ matching: 3, differences: 0 }, { paths: paths.slice(0, 2) }, 3) as any).code, 'COUNT_MISMATCH')
  assert.equal((decideComplete({ matching: 2, differences: 0 }, { paths }, 3) as any).code, 'COUNT_MISMATCH')
  assert.equal((decideComplete({ matching: 2, differences: 1 }, { paths }, 3) as any).code, 'CHECK_FAILED')
  assert.equal((decideComplete({ matching: 0, differences: 0 }, { paths: [] }, 0) as any).code, 'CHECK_EMPTY')
  assert.equal((decideComplete({ matching: NaN, differences: 0 }, { paths }, 3) as any).code, 'CHECK_MISSING')
})
