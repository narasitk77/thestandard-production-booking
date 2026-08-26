import { test } from 'node:test'
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

function stubFetch(handler: (url: string, body: any) => { status: number; text: string }) {
  const calls: Call[] = []
  const prev = globalThis.fetch
  ;(globalThis as any).fetch = async (url: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ url: String(url), body })
    const { status, text } = handler(String(url), body)
    return { ok: status >= 200 && status < 300, status, text: async () => text } as any
  }
  return { calls, restore: () => { globalThis.fetch = prev } }
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

test('no webhook configured → false, and nothing is fetched', async () => {
  const f = stubFetch(() => { throw new Error('must not fetch') })
  await withEnv({ LARK_WEBHOOK_URL: undefined }, async () => {
    assert.equal(await notifyLark('hi'), false)
  })
  assert.equal(f.calls.length, 0)
  f.restore()
})

test('HTTP 200 with a non-zero code is NOT delivery', async () => {
  const f = stubFetch(() => ({ status: 200, text: '{"code":19021,"msg":"sign match fail"}' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK }, async () => {
    assert.equal(await notifyLark('🎬 footage พร้อม'), false)
  })
  assert.equal(f.calls.length, 1, 'it still tried')
  f.restore()
})

test('HTTP 200 with code 0 is delivery', async () => {
  const f = stubFetch(() => ({ status: 200, text: '{"code":0,"msg":"success"}' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK }, async () => {
    assert.equal(await notifyLark('🎬 footage พร้อม'), true)
  })
  assert.equal(f.calls[0].body.msg_type, 'text')
  assert.equal(f.calls[0].body.content.text, '🎬 footage พร้อม')
  f.restore()
})

test('a 200 body we cannot read fails closed', async () => {
  const f = stubFetch(() => ({ status: 200, text: '<html>proxy error</html>' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK }, async () => {
    assert.equal(await notifyLark('hi'), false)
  })
  f.restore()
})

test('LARK_WEBHOOK_SECRET signs the empty string with "<ts>\\n<secret>"', async () => {
  const f = stubFetch(() => ({ status: 200, text: '{"code":0}' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK, LARK_WEBHOOK_SECRET: 's3cr3t' }, async () => {
    assert.equal(await notifyLark('hi'), true)
  })
  const { timestamp, sign } = f.calls[0].body
  assert.ok(timestamp, 'timestamp is sent')
  const expected = createHmac('sha256', `${timestamp}\ns3cr3t`).update('').digest('base64')
  assert.equal(sign, expected)
  f.restore()
})

test('no secret → no timestamp/sign fields at all', async () => {
  const f = stubFetch(() => ({ status: 200, text: '{"code":0}' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK, LARK_WEBHOOK_SECRET: undefined }, async () => {
    await notifyLark('hi')
  })
  assert.equal('sign' in f.calls[0].body, false)
  assert.equal('timestamp' in f.calls[0].body, false)
  f.restore()
})

// Unlike Discord (footage-only since v1.152.2), the Lark group is a fresh
// alerts room, so ops chatter belongs there by default.
test('ops messages DO reach Lark by default', async () => {
  const f = stubFetch(() => ({ status: 200, text: '{"code":0}' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK, LARK_NOTIFY_SCOPE: undefined }, async () => {
    assert.equal(await notifyLark('worker หยุดทำงาน', 'ops'), true)
  })
  f.restore()
})

test('LARK_NOTIFY_SCOPE=footage narrows it the way Discord is narrowed', async () => {
  const f = stubFetch(() => ({ status: 200, text: '{"code":0}' }))
  await withEnv({ LARK_WEBHOOK_URL: HOOK, LARK_NOTIFY_SCOPE: 'footage' }, async () => {
    assert.equal(await notifyLark('worker หยุดทำงาน', 'ops'), false)
    assert.equal(await notifyLark('🎬 ไฟล์มาแล้ว', 'footage'), true)
  })
  assert.equal(f.calls.length, 1, 'the ops message never left')
  f.restore()
})

// The migration guarantee: adding Lark must not take Discord down with it,
// and one channel failing must not hide that the other one worked.
test('notifyChatDetailed reports each channel separately', async () => {
  const f = stubFetch(url =>
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
  f.restore()
})

test('both channels down → any=false, so email fallbacks still fire', async () => {
  const f = stubFetch(() => ({ status: 500, text: 'boom' }))
  await withEnv({
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y',
    LARK_WEBHOOK_URL: HOOK,
  }, async () => {
    const r = await notifyChatDetailed('🎬 ไฟล์มาแล้ว', 'footage')
    assert.deepEqual(r, { discord: false, lark: false, any: false })
  })
  f.restore()
})
