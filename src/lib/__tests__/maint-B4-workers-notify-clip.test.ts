// 2026-11-08 maintenance — chat caps must cut LOUDLY.
//
// notifyDiscord did `.slice(0, 1990)` and returned true, so the tail of a long
// message (reminders' last sections, the noon landing report's 🚨 + checksum
// verdicts) disappeared without a mark. notifyLark capped at 20000 UTF-16 units,
// i.e. up to ~60 KB of Thai, over the custom-bot body limit.
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

mock.module('../email', { namedExports: { sendEmail: async () => ({}), isEmailConfigured: () => false } })

let notify: typeof import('../notify')
before(async () => { notify = await import('../notify') })

const quiet = <T>(fn: () => T): T => {
  const w = console.warn
  console.warn = () => {}
  try { return fn() } finally { console.warn = w }
}

test('short content passes through untouched', () => {
  assert.equal(notify.clipForChannel('สวัสดี', 1990, (s) => s.length), 'สวัสดี')
})

test('over the cap → fits, keeps the head, and says how much was cut', () => {
  const long = 'ก'.repeat(3000)
  const out = quiet(() => notify.clipForChannel(long, 1990, (s) => s.length))
  assert.ok(out.length <= 1990, `length ${out.length}`)
  assert.ok(out.startsWith('ก'.repeat(100)))
  const m = out.match(/ตัดท้ายออก (\d+) ตัวอักษร/)
  assert.ok(m, 'cut must be labelled')
  assert.equal(Number(m![1]) + (out.indexOf('\n…')), 3000, 'kept + dropped = original')
})

test('never splits an emoji (no lone surrogate)', () => {
  const out = quiet(() => notify.clipForChannel('🚨'.repeat(1500), 1990, (s) => s.length))
  assert.ok(out.length <= 1990)
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), 'lone high surrogate left behind')
})

test('byte budget (Lark): long Thai stays under the byte cap', () => {
  const out = quiet(() => notify.clipForChannel('ไทย'.repeat(10_000), 18_000, (s) => Buffer.byteLength(s)))
  assert.ok(Buffer.byteLength(out) <= 18_000, `${Buffer.byteLength(out)} bytes`)
  assert.match(out, /ตัดท้ายออก \d+ ตัวอักษร/)
})

test('notifyDiscord posts the labelled cut, not a silent slice', async () => {
  let body = ''
  const srv = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => { body = b; res.writeHead(204); res.end() })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as any).port
  const saved = process.env.DISCORD_WEBHOOK_URL
  process.env.DISCORD_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`
  try {
    const ok = await quiet(() => notify.notifyDiscord('x'.repeat(2500), 'footage'))
    assert.equal(ok, true)
    const content = JSON.parse(body).content as string
    assert.ok(content.length <= 1990)
    assert.match(content, /ตัดท้ายออก \d+ ตัวอักษร/)
  } finally {
    if (saved === undefined) delete process.env.DISCORD_WEBHOOK_URL
    else process.env.DISCORD_WEBHOOK_URL = saved
    srv.close()
  }
})
