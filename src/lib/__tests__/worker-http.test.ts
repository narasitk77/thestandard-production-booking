// Contract test for scripts/lib/http.js — the worker HTTP client that replaced
// global fetch() in v1.172.
//
// The bug it fixes cannot be reproduced in a unit test (it needs a 300-second
// response, which is undici's headersTimeout). So these tests lock the two
// properties that MAKE the fix a fix, both of which are cheap to assert:
//
//   1. a response whose headers are slow does NOT get killed by some cap of our
//      own — the only deadline is the timeoutMs we pass;
//   2. that deadline exists and fires, so a genuinely wedged endpoint is still
//      reported instead of hanging the worker until the heat death of the pod.
//
// Plus the fetch-compatibility surface the 12 call sites rely on: non-2xx
// resolves (never throws) with ok=false, and the body arrives as `.text`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { httpRequest } = require_('../../../scripts/lib/http.js') as {
  httpRequest: (
    url: string,
    opts?: { method?: string; headers?: Record<string, string>; timeoutMs?: number },
  ) => Promise<{ ok: boolean; status: number; text: string }>
}

/** Spin up a throwaway server on an ephemeral port; returns its base URL + a closer. */
async function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

test('a response with slow headers still succeeds — no deadline but ours', async () => {
  // 600ms before the first byte of the response. Any client with a sub-second
  // headers cap fails this; undici at 300s would pass it, which is the point —
  // the assertion is that OUR deadline is the only one in play, verified by the
  // next test proving the deadline is real.
  const { url, close } = await serve((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ merged: 3 }))
    }, 600)
  })
  try {
    const res = await httpRequest(url, { timeoutMs: 5_000 })
    assert.equal(res.ok, true)
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text), { merged: 3 })
  } finally {
    await close()
  }
})

test('a silent server trips the inactivity timeout and rejects', async () => {
  // Never responds. Without a timeout the worker would hang forever and its
  // `running` guard would block every later tick — silent death, exactly what
  // we are trying to stop being possible.
  const { url, close } = await serve(() => {
    /* deliberately no response */
  })
  try {
    await assert.rejects(
      () => httpRequest(url, { timeoutMs: 300 }),
      (err: Error) => /no activity for/.test(err.message),
    )
  } finally {
    await close()
  }
})

test('non-2xx resolves with ok=false instead of throwing — same as fetch', async () => {
  // The call sites branch on `!res.ok` and log `res.status`. If a 401 threw,
  // that branch would be dead and a mis-set secret would look like a transport
  // failure — which is the exact confusion this whole change is about.
  const { url, close } = await serve((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
  })
  try {
    const res = await httpRequest(url, { timeoutMs: 5_000 })
    assert.equal(res.ok, false)
    assert.equal(res.status, 401)
    assert.match(res.text, /Unauthorized/)
  } finally {
    await close()
  }
})

test('method and secret headers reach the server', async () => {
  // shoot-review-worker is the only POST; every worker sends an x-*-secret.
  let seen: { method?: string; secret?: string } = {}
  const { url, close } = await serve((req, res) => {
    seen = { method: req.method, secret: req.headers['x-reconcile-secret'] as string }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    const res = await httpRequest(url, {
      method: 'POST',
      headers: { 'x-reconcile-secret': 's3cr3t' },
      timeoutMs: 5_000,
    })
    assert.equal(res.ok, true)
    assert.equal(seen.method, 'POST')
    assert.equal(seen.secret, 's3cr3t')
  } finally {
    await close()
  }
})

test('a connection refused rejects — a dead app is still reported', async () => {
  // Port 1 on loopback: nothing listens there.
  await assert.rejects(() => httpRequest('http://127.0.0.1:1/api/internal/x', { timeoutMs: 2_000 }))
})

test('a malformed URL rejects with a useful message, not a cryptic TypeError', async () => {
  await assert.rejects(
    () => httpRequest('not-a-url'),
    (err: Error) => /invalid worker URL/.test(err.message),
  )
})
