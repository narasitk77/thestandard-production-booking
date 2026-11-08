import { test, mock, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// maint 2026-11-08 (ops-refresh-token-retry-every-request) — a revoked Google refresh token
// was re-sent to Google on EVERY session read (prod 2026-11-05: 278 invalid_grant in 72 h):
// the failure returned the old token unchanged, and server-side getServerSession cannot
// write the cookie back anyway, so the next request retried with the same dead token.
mock.module('../db', { namedExports: { prisma: { user: { findUnique: async () => null } } } })
mock.module('../team-profiles', { namedExports: { findProfileByEmail: () => null } })

let jwt: (a: any) => Promise<any>
let calls = 0
let reply: { status: number; body: any } = { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }
const realFetch = globalThis.fetch
before(async () => {
  const { authOptions } = await import('../auth')
  jwt = authOptions.callbacks!.jwt as any
})
beforeEach(() => {
  calls = 0
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify(reply.body), { status: reply.status }) }) as any
})
afterEach(() => { globalThis.fetch = realFetch })

const expired = (refreshToken: string) => ({
  email: 'x@thestandard.co', accessToken: 'old', accessTokenExpires: Date.now() - 1000, refreshToken,
})

test('invalid_grant: Google is asked ONCE, then never again for that refresh token', async () => {
  reply = { status: 400, body: { error: 'invalid_grant' } }
  const t = expired('rt-revoked')
  const first = await jwt({ token: t })
  assert.equal(calls, 1)
  assert.equal(first.accessTokenError, 'RefreshAccessTokenError')
  assert.equal(first.refreshToken, undefined, 'dead refresh token dropped from the token')
  // the cookie still holds the old token (server-side reads cannot rewrite it)
  for (let i = 0; i < 5; i++) await jwt({ token: t })
  assert.equal(calls, 1)
})

test('transient failure: backs off instead of retrying on the next request', async () => {
  reply = { status: 503, body: { error: 'backend_error' } }
  const t = expired('rt-flaky')
  const first = await jwt({ token: t })
  assert.equal(first.refreshToken, 'rt-flaky', 'a transient error keeps the refresh token')
  await jwt({ token: t })
  assert.equal(calls, 1)
})

test('success path unchanged', async () => {
  reply = { status: 200, body: { access_token: 'new', expires_in: 3600 } }
  const out = await jwt({ token: expired('rt-good') })
  assert.equal(out.accessToken, 'new')
  assert.equal(out.accessTokenError, undefined)
  assert.equal(out.refreshToken, 'rt-good')
})
