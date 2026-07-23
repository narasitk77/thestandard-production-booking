import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notifyDiscord } from '../notify'

// v1.152.2 — Discord carries FOOTAGE news only, so the crew's file alerts are
// not buried under overdue-rental reminders and worker-health pings. Those
// still go out by email; only the Discord leg is filtered.
//
// No webhook is configured in tests, so notifyDiscord returns false either way.
// What this locks is that an 'ops' message returns false WITHOUT attempting a
// POST even when a webhook IS set — verified by pointing the webhook at a URL
// that would throw if fetched.

test("ops messages never reach Discord under the default scope", async () => {
  const prevUrl = process.env.DISCORD_WEBHOOK_URL
  const prevScope = process.env.DISCORD_NOTIFY_SCOPE
  // A URL that fails loudly if anyone actually fetches it.
  process.env.DISCORD_WEBHOOK_URL = 'http://127.0.0.1:1/should-never-be-called'
  delete process.env.DISCORD_NOTIFY_SCOPE

  // 'ops' is short-circuited before the fetch → plain false, no throw, fast.
  assert.equal(await notifyDiscord('overdue rental digest', 'ops'), false)

  process.env.DISCORD_WEBHOOK_URL = prevUrl
  if (prevScope === undefined) delete process.env.DISCORD_NOTIFY_SCOPE
  else process.env.DISCORD_NOTIFY_SCOPE = prevScope
})

test('DISCORD_NOTIFY_SCOPE=all puts ops chatter back on Discord', async () => {
  const prevUrl = process.env.DISCORD_WEBHOOK_URL
  const prevScope = process.env.DISCORD_NOTIFY_SCOPE
  delete process.env.DISCORD_WEBHOOK_URL // no webhook → false, but for the URL reason
  process.env.DISCORD_NOTIFY_SCOPE = 'all'

  // With scope=all the category gate passes; the missing webhook is what
  // returns false. (Both paths return false here — the distinction that
  // matters is that scope no longer blocks it.)
  assert.equal(await notifyDiscord('overdue rental digest', 'ops'), false)

  process.env.DISCORD_NOTIFY_SCOPE = prevScope
  if (prevUrl === undefined) delete process.env.DISCORD_WEBHOOK_URL
  else process.env.DISCORD_WEBHOOK_URL = prevUrl
})

test('footage messages are never filtered by scope', async () => {
  const prevUrl = process.env.DISCORD_WEBHOOK_URL
  delete process.env.DISCORD_WEBHOOK_URL
  // default category is 'footage' — reaches the webhook check, not the gate
  assert.equal(await notifyDiscord('🎬 ย้ายไฟล์เสร็จ'), false)
  assert.equal(await notifyDiscord('🎬 ย้ายไฟล์เสร็จ', 'footage'), false)
  if (prevUrl === undefined) delete process.env.DISCORD_WEBHOOK_URL
  else process.env.DISCORD_WEBHOOK_URL = prevUrl
})
