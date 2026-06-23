import { test } from 'node:test'
import assert from 'node:assert'
import { completeWithRetry, COMPLETE_MAX_ATTEMPTS } from '../upload-client'

// Test doubles: a fetch that returns a scripted sequence of responses, and a
// no-op sleep so retries don't actually wait.
const noSleep = async () => {}
function res(status: number, body: any, json = true): any {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => { if (!json) throw new Error('Unexpected token <'); return body },
  }
}
function scriptedFetch(seq: any[]): typeof fetch {
  let i = 0
  return (async () => seq[Math.min(i++, seq.length - 1)]) as any
}

test('retries through a 502 (deploy restart) then succeeds — the real bug', async () => {
  const f = scriptedFetch([
    res(502, null, false),               // nginx HTML during container recreate
    res(502, null, false),
    res(200, { ok: true, upload: { status: 'COMPLETE' } }),
  ])
  const out = await completeWithRetry({ uploadId: 'x' }, { fetchImpl: f, sleepMs: noSleep })
  assert.equal(out.ok, true)
  assert.equal(out.upload.status, 'COMPLETE')
})

test('retries on a thrown network error then succeeds', async () => {
  let i = 0
  const f = (async () => {
    if (i++ === 0) throw new Error('network error')
    return res(200, { ok: true })
  }) as any
  const out = await completeWithRetry({ uploadId: 'x' }, { fetchImpl: f, sleepMs: noSleep })
  assert.equal(out.ok, true)
})

test('a 4xx is permanent — surfaced immediately, no retry', async () => {
  let calls = 0
  const f = (async () => { calls++; return res(403, { error: 'Forbidden' }) }) as any
  await assert.rejects(
    () => completeWithRetry({ uploadId: 'x' }, { fetchImpl: f, sleepMs: noSleep }),
    /Forbidden/,
  )
  assert.equal(calls, 1, 'must not retry a 4xx')
})

test('v1.92.2 — a 200 {ok:false, permanent:true} (size mismatch) stops immediately', async () => {
  let calls = 0
  const f = (async () => { calls++; return res(200, { ok: false, permanent: true, status: 'FAILED', errors: ['Drive size mismatch: expected 100, got 50'] }) }) as any
  await assert.rejects(
    () => completeWithRetry({ uploadId: 'x' }, { fetchImpl: f, sleepMs: noSleep }),
    /size mismatch/,
  )
  assert.equal(calls, 1, 'permanent FAILED must not retry')
})

test('v1.92.2 — a 200 {ok:false} WITHOUT permanent (transient lag) still retries then succeeds', async () => {
  const f = scriptedFetch([
    res(200, { ok: false, status: 'FAILED', errors: ['Drive file not readable'] }), // metadata lag
    res(200, { ok: true, upload: { status: 'COMPLETE' } }),
  ])
  const out = await completeWithRetry({ uploadId: 'x' }, { fetchImpl: f, sleepMs: noSleep })
  assert.equal(out.ok, true)
})

test('gives up after MAX attempts when the server never recovers', async () => {
  let calls = 0
  const f = (async () => { calls++; return res(503, null, false) }) as any
  await assert.rejects(
    () => completeWithRetry({ uploadId: 'x' }, { fetchImpl: f, sleepMs: noSleep }),
    /หลังลองใหม่/,
  )
  assert.equal(calls, COMPLETE_MAX_ATTEMPTS)
})
