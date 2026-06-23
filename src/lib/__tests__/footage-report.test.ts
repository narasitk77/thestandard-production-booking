/**
 * v1.89 — footage-report formatters feed the on-page table + the delivery email,
 * so the duration/size rendering must be right (a wrong duration misreports the
 * footage to the Producer).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDuration, formatBytes } from '../footage-report'

test('formatDuration: m:ss and h:mm:ss', () => {
  assert.equal(formatDuration(null), '—')
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(9000), '0:09')
  assert.equal(formatDuration(328319), '5:28')      // the real test MP4 (328.3s)
  assert.equal(formatDuration(65 * 1000), '1:05')
  assert.equal(formatDuration(3661 * 1000), '1:01:01')
})

test('formatBytes: scales B → TB', () => {
  assert.equal(formatBytes(null), '—')
  assert.equal(formatBytes(0), '—')
  assert.equal(formatBytes(160), '160 B')
  assert.equal(formatBytes(800 * 1024 * 1024), '800 MB')
  assert.equal(formatBytes(5.7 * 1024 * 1024 * 1024), '5.7 GB')
})
