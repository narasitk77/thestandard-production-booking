import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  larkFetch, larkTenantToken, resetLarkTokenCache, larkUploadFile,
  larkCreateRecords, LarkError, larkBaseUrl, larkAppConfigured,
  DRIVE_UPLOAD_ALL_LIMIT,
} from '../lark-client'

// v1.212 — the trap this file exists for, restated: **Lark answers HTTP 200 for
// requests it refused.** notify.ts already learned it for the webhook; this
// client walks through the same door with file and record writes, where a false
// "delivered" means an archive that reports success and holds nothing.

type Handler = (url: string, init: any) => { status: number; text: string }

function stubFetch(t: TestContext, handler: Handler) {
  const calls: { url: string; init: any }[] = []
  const prev = globalThis.fetch
  ;(globalThis as any).fetch = async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    const { status, text } = handler(String(url), init)
    return { ok: status >= 200 && status < 300, status, text: async () => text } as any
  }
  t.after(() => { globalThis.fetch = prev })
  return calls
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

const APP = { LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'sec_test' }
const TOKEN_OK = '{"code":0,"tenant_access_token":"t-abc","expire":7200}'

test('base URL defaults to Lark international, not Feishu', () => {
  // An app created in the larksuite.com console does not exist on feishu.cn.
  // Defaulting to the wrong one fails with an auth error that reads like bad
  // credentials, which is the most misleading possible symptom.
  assert.equal(larkBaseUrl(), 'https://open.larksuite.com')
})

test('larkAppConfigured is false without BOTH id and secret', async () => {
  await withEnv({ LARK_APP_ID: 'x', LARK_APP_SECRET: undefined }, async () => {
    assert.equal(larkAppConfigured(), false)
  })
})

test('no app credentials → a message that names the fix, not a generic 401', async (t) => {
  resetLarkTokenCache()
  stubFetch(t, () => { throw new Error('must not fetch') })
  await withEnv({ LARK_APP_ID: undefined, LARK_APP_SECRET: undefined }, async () => {
    await assert.rejects(() => larkTenantToken(), (e: any) => {
      assert.ok(e instanceof LarkError)
      assert.match(e.message, /self-built Lark app/)
      return true
    })
  })
})

test('HTTP 200 with a non-zero code is a FAILURE', async (t) => {
  resetLarkTokenCache()
  stubFetch(t, (url) => url.includes('tenant_access_token')
    ? { status: 200, text: TOKEN_OK }
    : { status: 200, text: '{"code":91403,"msg":"Forbidden"}' })
  await withEnv(APP, async () => {
    await assert.rejects(() => larkFetch('/open-apis/anything'), (e: any) => {
      assert.ok(e instanceof LarkError)
      assert.equal(e.code, 91403)
      assert.equal(e.httpStatus, 200, 'the HTTP status really was 200')
      return true
    })
  })
})

test('a body with no `code` at all is not proof of success either', async (t) => {
  resetLarkTokenCache()
  stubFetch(t, (url) => url.includes('tenant_access_token')
    ? { status: 200, text: TOKEN_OK }
    : { status: 200, text: '<html>gateway</html>' })
  await withEnv(APP, async () => {
    await assert.rejects(() => larkFetch('/open-apis/anything'), /unreadable/)
  })
})

test('code 0 returns data', async (t) => {
  resetLarkTokenCache()
  stubFetch(t, (url) => url.includes('tenant_access_token')
    ? { status: 200, text: TOKEN_OK }
    : { status: 200, text: '{"code":0,"data":{"items":[{"table_id":"tbl1"}]}}' })
  await withEnv(APP, async () => {
    const data = await larkFetch<{ items: any[] }>('/open-apis/anything')
    assert.equal(data.items[0].table_id, 'tbl1')
  })
})

test('the tenant token is minted once and reused', async (t) => {
  resetLarkTokenCache()
  const calls = stubFetch(t, (url) => url.includes('tenant_access_token')
    ? { status: 200, text: TOKEN_OK }
    : { status: 200, text: '{"code":0,"data":{}}' })
  await withEnv(APP, async () => {
    await larkFetch('/open-apis/a')
    await larkFetch('/open-apis/b')
  })
  assert.equal(calls.filter((c) => c.url.includes('tenant_access_token')).length, 1)
  assert.equal(calls[1].init.headers.Authorization, 'Bearer t-abc')
})

test('a permission error is NOT retried — the truthful message arrives at once', async (t) => {
  resetLarkTokenCache()
  const calls = stubFetch(t, (url) => url.includes('tenant_access_token')
    ? { status: 200, text: TOKEN_OK }
    : { status: 200, text: '{"code":1254045,"msg":"FieldNameNotFound"}' })
  await withEnv(APP, async () => {
    await assert.rejects(() => larkFetch('/open-apis/anything'))
  })
  assert.equal(calls.filter((c) => !c.url.includes('tenant_access_token')).length, 1)
})

test('an empty snapshot is refused before it is uploaded', async (t) => {
  resetLarkTokenCache()
  stubFetch(t, () => { throw new Error('must not fetch') })
  await withEnv(APP, async () => {
    await assert.rejects(
      () => larkUploadFile({ folderToken: 'fld', fileName: 'x.gz', content: Buffer.alloc(0) }),
      /empty snapshot/,
    )
  })
})

test('a snapshot past the 20MB limit fails loudly rather than uploading a truncated one', async (t) => {
  resetLarkTokenCache()
  stubFetch(t, () => { throw new Error('must not fetch') })
  await withEnv(APP, async () => {
    await assert.rejects(
      () => larkUploadFile({ folderToken: 'fld', fileName: 'x.gz', content: Buffer.alloc(DRIVE_UPLOAD_ALL_LIMIT + 1) }),
      /20MB/,
    )
  })
})

test('an upload that returns code 0 but no file_token is not a landed file', async (t) => {
  // "code 0" is Lark saying it accepted the call. The file_token is the only
  // evidence a file exists. Reporting success without it is how a backup that
  // never landed reads green for months.
  resetLarkTokenCache()
  stubFetch(t, (url) => url.includes('tenant_access_token')
    ? { status: 200, text: TOKEN_OK }
    : { status: 200, text: '{"code":0,"data":{}}' })
  await withEnv(APP, async () => {
    await assert.rejects(
      () => larkUploadFile({ folderToken: 'fld', fileName: 'x.gz', content: Buffer.from('gz') }),
      /no file_token/,
    )
  })
})

test('records are written in batches and every batch is counted', async (t) => {
  resetLarkTokenCache()
  const calls = stubFetch(t, (url) => url.includes('tenant_access_token')
    ? { status: 200, text: TOKEN_OK }
    : { status: 200, text: '{"code":0,"data":{}}' })
  await withEnv(APP, async () => {
    const rows = [...Array(1200)].map((_, i) => ({ id: String(i) }))
    assert.equal(await larkCreateRecords('app1', 'tbl1', rows), 1200)
  })
  const writes = calls.filter((c) => c.url.includes('batch_create'))
  assert.equal(writes.length, 3, '1200 rows at 500/batch = 3 calls')
})
