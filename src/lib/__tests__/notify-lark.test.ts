import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'crypto'
import { notifyLark, notifyChatDetailed } from '../notify'

// v1.209 — Lark custom-bot webhook.
//
// The one thing worth locking here: **Lark answers HTTP 200 even when it
// refuses the message**, with the real status hidden in the JSON body's
// `code`. A naive `res.ok` check would report "sent" for messages nobody
// received — the same class of bug as the footage digest that claimed 85/85
// deliveries while the operator's inbox stayed empty (v1.186).

type Call = { url: string; body: any }

// The restore is registered with t.after() rather than called at the end of the
// body ON PURPOSE: a failing assert throws past a trailing restore() and leaves
// globalThis.fetch patched for every later test in the file, turning one real
// failure into a cascade of fake ones.
function stubFetch(t: TestContext, handler: (url: string, body: any) => { status: number; text: string }) {
  const calls: Call[] = []
  const prev = globalThis.fetch
  ;(globalThis as any).fetch = async (url: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ url: String(url), body })
    const { status, text } = handler(String(url), body)
    return { ok: status >= 200 && status < 300, status, text: async () => text } as any
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
  assert.equal(f.calls.length, 2, 'both channels were attempted')
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
