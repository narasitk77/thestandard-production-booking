/**
 * dry-run ต้องเดิน Drive เหมือนรอบจริง (v1.265)
 *
 * บั๊กที่ล็อกออกไป: dryRun อ่าน footageCache อย่างเดียว ("ถ้าว่างให้ refresh" เรียก
 * อ่าน cache ซ้ำตัวเดิม) — 11 ต.ค. 2569 dry-run ตอบ KND-KNF-260916-01 ว่า `no-footage`
 * ทั้งที่กล่องมี 152 GB แต่รอบจริง (refresh เสมอ) ส่งเมลไป · preview ที่ไม่ตรงของจริง
 * = แย่กว่าไม่มี preview
 *
 * และ dry-run ต้องไม่เขียนอะไร — getCachedFootagePayload เขียน cache ทุกครั้งที่ walk
 * จึงห้ามเรียกจากฝั่ง dryRun
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const STALE_EMPTY = { found: 0, fileCount: 0, folders: [], bookingFolderUrl: null, soundStagingUrl: null, cached: true, cachedAt: '2026-10-01T00:00:00.000Z' }
const ON_DRIVE = {
  found: 1, fileCount: 41,
  folders: [{ label: 'EP01 · CAM-A', url: 'https://drive.google.com/drive/folders/box', fileCount: 41, totalBytes: 152_640_000_000 }],
  bookingFolderUrl: 'https://drive.google.com/drive/folders/box', soundStagingUrl: null,
}

let calls: string[] = []

mock.module('../footage-folders', {
  namedExports: {
    // the cache can be stale-empty; a refresh re-walks Drive AND writes the cache
    getCachedFootagePayload: async (_b: unknown, opts: { refresh?: boolean } = {}) => {
      calls.push(opts.refresh ? 'cached:refresh(writes)' : 'cached:read')
      return opts.refresh ? { ...ON_DRIVE, cached: false, cachedAt: '2026-10-11T06:00:00.000Z' } : STALE_EMPTY
    },
    // fresh walk, persists nothing
    computeFootagePayload: async () => { calls.push('compute'); return ON_DRIVE },
  },
})

let sweepFootagePayload: typeof import('../footage-ready').sweepFootagePayload
before(async () => { ({ sweepFootagePayload } = await import('../footage-ready')) })
beforeEach(() => { calls = [] })

const booking = { id: 'b1', bookingCode: 'KND-KNF-260916-01' } as any

test('dry-run sees what is on Drive, not a stale-empty cache — เคส KND-KNF-260916-01', async () => {
  const p = await sweepFootagePayload(booking, true)
  assert.equal(p.fileCount, 41, 'stale-empty cache must not turn into `no-footage`')
})

test('dry-run writes nothing (never the cache-writing path)', async () => {
  await sweepFootagePayload(booking, true)
  assert.deepEqual(calls, ['compute'])
})

test('live run refreshes the cache (unchanged behaviour)', async () => {
  const p = await sweepFootagePayload(booking, false)
  assert.equal(p.fileCount, 41)
  assert.deepEqual(calls, ['cached:refresh(writes)'])
})

test('dry-run and live run decide on the same footage', async () => {
  const dry = await sweepFootagePayload(booking, true)
  const live = await sweepFootagePayload(booking, false)
  assert.equal(dry.fileCount, live.fileCount)
  assert.deepEqual(dry.folders, live.folders)
})
