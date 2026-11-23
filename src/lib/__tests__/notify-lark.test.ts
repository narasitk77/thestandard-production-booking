import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'crypto'
import { notifyLark, notifyChatDetailed, notifyDiscord } from '../notify'

// v1.209 — Lark custom-bot webhook.
//
// The one thing worth locking here: **Lark answers HTTP 200 even when it
// refuses the message**, with the real status hidden in the JSON body's
// `code`. A naive `res.ok` check would report "sent" for messages nobody
// received — the same class of bug as the footage digest that claimed 85/85
// deliveries while the operator's inbox stayed empty (v1.186).

type Call = { url: string; body: any; signal: unknown }

// The restore is registered with t.after() rather than called at the end of the
// body ON PURPOSE: a failing assert throws past a trailing restore() and leaves
// globalThis.fetch patched for every later test in the file, turning one real
// failure into a cascade of fake ones.
// `n` = 1-based number of this fetch call; a handler that throws = a transport failure.
function stubFetch(t: TestContext, handler: (url: string, body: any, n: number) => { status: number; text: string; headers?: Record<string, string> }) {
  const calls: Call[] = []
  const prev = globalThis.fetch
  ;(globalThis as any).fetch = async (url: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ url: String(url), body, signal: init?.signal })
    const { status, text, headers } = handler(String(url), body, calls.length)
    return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), text: async () => text } as any
  }
  t.after(() => { globalThis.fetch = prev })
  return { calls }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k] as string
  }
  return fn().finally(() => {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k] as string
    }
  })
}

const HOOK = 'https://open.larksuite.com/open-apis/bot/v2/hook/test-token'

test('no webhook configured → false, and nothing is fetched', async (t) => {
  const f = stubFetch(t, () => { throw new Error('must not fetch') })
  await withEnv({ LARK_WEBHOOK_URL: undefined }, async () => {
    assert.equal(await notifyLark('hi'), false)
  })
  assert.equal(f.calls.length, 0)
})

test('HTTP 200 with a non-zero code is NOT delivery', async (t) => {
  const f = stubFetch(t, () => ({ status: 200, text: '{"code":19021,"msg":"sign match fail"}' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK }, async () => {
    assert.equal(await notifyLark('🎬 footage พร้อม'), false)
  })
  assert.equal(f.calls.length, 1, 'it still tried')
})

test('HTTP 200 with code 0 is delivery', async (t) => {
  const f = stubFetch(t, () => ({ status: 200, text: '{"code":0,"msg":"success"}' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK }, async () => {
    assert.equal(await notifyLark('🎬 footage พร้อม'), true)
  })
  assert.equal(f.calls[0].body.msg_type, 'text')
  assert.equal(f.calls[0].body.content.text, '🎬 footage พร้อม')
})

test('a 200 body we cannot read fails closed', async (t) => {
  const f = stubFetch(t, () => ({ status: 200, text: '<html>proxy error</html>' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK }, async () => {
    assert.equal(await notifyLark('hi'), false)
  })
})

test('LARK_WEBHOOK_SECRET signs the empty string with "<ts>\\n<secret>"', async (t) => {
  const f = stubFetch(t, () => ({ status: 200, text: '{"code":0}' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK, LARK_WEBHOOK_SECRET: 's3cr3t' }, async () => {
    assert.equal(await notifyLark('hi'), true)
  })
  const { timestamp, sign } = f.calls[0].body
  assert.ok(timestamp, 'timestamp is sent')
  const expected = createHmac('sha256', `${timestamp}\ns3cr3t`).update('').digest('base64')
  assert.equal(sign, expected)
})

test('no secret → no timestamp/sign fields at all', async (t) => {
  const f = stubFetch(t, () => ({ status: 200, text: '{"code":0}' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK, LARK_WEBHOOK_SECRET: undefined }, async () => {
    await notifyLark('hi')
  })
  assert.equal('sign' in f.calls[0].body, false)
  assert.equal('timestamp' in f.calls[0].body, false)
})

// Unlike Discord (footage-only since v1.152.2), the Lark group is a fresh
// alerts room, so ops chatter belongs there by default.
test('ops messages DO reach Lark by default', async (t) => {
  const f = stubFetch(t, () => ({ status: 200, text: '{"code":0}' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK, LARK_NOTIFY_SCOPE: undefined }, async () => {
    assert.equal(await notifyLark('worker หยุดทำงาน', 'ops'), true)
  })
})

test('LARK_NOTIFY_SCOPE=footage narrows it the way Discord is narrowed', async (t) => {
  const f = stubFetch(t, () => ({ status: 200, text: '{"code":0}' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK, LARK_NOTIFY_SCOPE: 'footage' }, async () => {
    assert.equal(await notifyLark('worker หยุดทำงาน', 'ops'), false)
    assert.equal(await notifyLark('🎬 ไฟล์มาแล้ว', 'footage'), true)
  })
  assert.equal(f.calls.length, 1, 'the ops message never left')
})

// The migration guarantee: adding Lark must not take Discord down with it,
// and one channel failing must not hide that the other one worked.
test('notifyChatDetailed reports each channel separately', async (t) => {
  const f = stubFetch(t, url =>
    url.includes('discord')
      ? { status: 500, text: 'boom' }
      : { status: 200, text: '{"code":0}' })
  await withEnv({
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y',
    LARK_WEBHOOK_URL: HOOK,
  }, async () => {
    const r = await notifyChatDetailed('🎬 ไฟล์มาแล้ว', 'footage')
    assert.deepEqual(r, { discord: false, lark: true, any: true })
  })
  // both channels were attempted · since 2026-11-23 a 5xx gets one retry (postWebhook), so Discord is POSTed twice
  assert.equal(f.calls.filter(c => c.url.includes('discord')).length, 2, 'Discord: 500, retried once, 500 again')
  assert.equal(f.calls.filter(c => !c.url.includes('discord')).length, 1, 'Lark took it first time — no retry')
})

test('both channels down → any=false, so email fallbacks still fire', async (t) => {
  const f = stubFetch(t, () => ({ status: 500, text: 'boom' }))
  await withEnv({
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y',
    LARK_WEBHOOK_URL: HOOK,
  }, async () => {
    const r = await notifyChatDetailed('🎬 ไฟล์มาแล้ว', 'footage')
    assert.deepEqual(r, { discord: false, lark: false, any: false })
  })
})

// v1.209.1 — the exact divergence that makes a collapsed boolean a LIE.
//
// Under prod defaults (Discord = footage-only, Lark = all) an 'ops' message is
// dropped by Discord before any POST and taken by Lark. So `notifyChat()`'s
// single boolean is TRUE while Discord delivered NOTHING. Any caller that
// records "which channel got it" must use notifyChatDetailed(); reminders.ts
// stored this in a field named `discord` and printed it as "Discord ✓" on
// /admin/reminders until this was caught.
test("prod defaults: an 'ops' message is Lark-only, so a single boolean misattributes it", async (t) => {
  const f = stubFetch(t, () => ({ status: 200, text: '{"code":0}' }))
  await withEnv({
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y',
    DISCORD_NOTIFY_SCOPE: undefined, // → 'footage'
    LARK_WEBHOOK_URL: HOOK,
    LARK_NOTIFY_SCOPE: undefined,    // → 'all'
  }, async () => {
    const r = await notifyChatDetailed('⏰ เตือนงานค้าง 3 รายการ', 'ops')
    assert.equal(r.discord, false, 'Discord drops ops under the default scope')
    assert.equal(r.lark, true, 'Lark takes it')
    assert.equal(r.any, true)
    // The trap: `any` is what notifyChat() returns. Storing it in a field
    // called `discord` would render "Discord ✓" for a message Discord refused.
    assert.notEqual(r.any, r.discord)
  })
  assert.equal(f.calls.length, 1, 'only Lark was actually POSTed to')
})

// 2026-11-23 — postWebhook: the one POST both chat channels share. Prod 14 + 15 Nov: `[notify] discord failed:
// fetch failed` once → the noon stale-landing report never reached the team room (it has no second round). Every
// attempt now has a 15 s deadline, and a network error / timeout / 5xx / 429 gets ONE retry; a 4xx does not.
// The wait is driven by mocked setTimeout, so "not before 2 s" is asserted without sleeping.
const DISCORD = 'https://discord.com/api/webhooks/x/y'
const settle = () => new Promise(r => setImmediate(r))

test('webhook: no answer within the deadline → one retry ~2 s later, and the retry counts as delivered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const deadline = t.mock.method(AbortSignal, 'timeout')
  const f = stubFetch(t, (_u, _b, n) => {
    if (n === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    return { status: 204, text: '' }
  })
  await withEnv({ DISCORD_WEBHOOK_URL: DISCORD }, async () => {
    const p = notifyDiscord('🎬 ไฟล์มาแล้ว')
    await settle()
    t.mock.timers.tick(1_999)
    await settle()
    assert.equal(f.calls.length, 1, 'does not retry before ~2 s')
    t.mock.timers.tick(1)
    assert.equal(await p, true)
  })
  assert.equal(f.calls.length, 2)
  assert.deepEqual(deadline.mock.calls.map(c => c.arguments[0]), [15_000, 15_000], 'every attempt has a 15 s deadline')
  assert.ok(f.calls.every(c => c.signal instanceof AbortSignal), 'and the deadline is actually passed to fetch')
})

test('webhook: a 4xx is not retried — it would say the same thing again', async (t) => {
  // real timers: a wrong retry shows up as a second call after 2 s, not as a hang
  const f = stubFetch(t, () => ({ status: 400, text: '{"message":"Cannot send an empty message"}' }))
  await withEnv({ DISCORD_WEBHOOK_URL: DISCORD }, async () => {
    assert.equal(await notifyDiscord('x'), false)
  })
  assert.equal(f.calls.length, 1)
})

test('webhook: fails twice (5xx, then the network) → false, exactly two attempts, never throws', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = stubFetch(t, (_u, _b, n) => {
    if (n === 1) return { status: 503, text: 'upstream connect error' }
    throw new TypeError('fetch failed')
  })
  await withEnv({ DISCORD_WEBHOOK_URL: DISCORD }, async () => {
    const p = notifyDiscord('🎬 ไฟล์มาแล้ว')
    await settle()
    t.mock.timers.tick(2_000)
    assert.equal(await p, false)
  })
  assert.equal(f.calls.length, 2)
})

test('webhook: 429 waits Retry-After before its retry, capped at 10 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const after = ['5', '3600']
  const f = stubFetch(t, (_u, _b, n) => n % 2
    ? { status: 429, text: 'rate limited', headers: { 'retry-after': after[(n - 1) / 2] } }
    : { status: 204, text: '' })
  await withEnv({ DISCORD_WEBHOOK_URL: DISCORD }, async () => {
    for (const [i, waitMs] of [5_000, 10_000].entries()) {
      const p = notifyDiscord('🎬')
      await settle()
      t.mock.timers.tick(waitMs - 1)
      await settle()
      assert.equal(f.calls.length, 2 * i + 1, `Retry-After ${after[i]} → still waiting at ${waitMs - 1} ms`)
      t.mock.timers.tick(1)
      assert.equal(await p, true)
      assert.equal(f.calls.length, 2 * i + 2)
    }
  })
})

test('webhook: Lark shares the retry (502 → retry → code 0 = delivered)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = stubFetch(t, (_u, _b, n) => n === 1 ? { status: 502, text: 'bad gateway' } : { status: 200, text: '{"code":0}' })
  await withEnv({ LARK_WEBHOOK_URL: HOOK }, async () => {
    const p = notifyLark('🎬 ไฟล์มาแล้ว')
    await settle()
    t.mock.timers.tick(2_000)
    assert.equal(await p, true)
  })
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[1].body, f.calls[0].body, 'the retry sends the same message')
})
