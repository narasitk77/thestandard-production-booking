import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'

// maint 2026-11-08 (auth-get-mutations-csrf) — getSession must not hand an admin
// session to a request ANOTHER site made the browser send (an <img> on a sibling
// *.thestandard.co page, a fetch, a cross-site form POST). SameSite=Lax attaches the
// cookie to all of those, and several internal routes act on GET with dryRun off.
let reqHeaders: Record<string, string> | null = {}
mock.module('next/headers', {
  namedExports: {
    headers: () => {
      if (!reqHeaders) throw new Error('`headers` was called outside a request scope. Read more: …')
      return new Headers(reqHeaders)
    },
  },
})
mock.module('next-auth', {
  namedExports: {
    getServerSession: async () => ({ user: { email: 'Narasit.K@thestandard.co', name: 'Nat', role: 'ADMIN', active: true } }),
  },
})
mock.module('../auth', { namedExports: { authOptions: {} } })
mock.module('../db', { namedExports: { prisma: {} } })

let getSession: () => Promise<any>
let isCrossSiteRequest: (h: Headers) => boolean
before(async () => {
  ;({ getSession } = await import('../session'))
  ;({ isCrossSiteRequest } = await import('../internal-auth'))
})

const h = (o: Record<string, string>) => new Headers(o)

test('isCrossSiteRequest: subresource / fetch / form POST from another site = refused', () => {
  // <img src="https://probook…/api/internal/video-merge/run"> on a *.thestandard.co page
  assert.equal(isCrossSiteRequest(h({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' })), true)
  assert.equal(isCrossSiteRequest(h({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })), true)
  // auto-submitted <form method=POST> — a navigation, but it carries Origin
  assert.equal(isCrossSiteRequest(h({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', origin: 'https://evil.thestandard.co' })), true)
})

test('isCrossSiteRequest: the app itself, links from chat/mail/Docs, and curl/workers still pass', () => {
  assert.equal(isCrossSiteRequest(h({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', origin: 'https://probook.thestandard.co' })), false)
  // link clicked in Lark web / Gmail / the _FOOTAGE-CHECK Google Doc (GET navigation: no Origin)
  assert.equal(isCrossSiteRequest(h({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })), false)
  assert.equal(isCrossSiteRequest(h({ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' })), false)
  assert.equal(isCrossSiteRequest(h({})), false) // curl / node workers send no Sec-Fetch-*
})

test('getSession: cross-site subresource gets NO session — same request same-origin gets the admin', async () => {
  reqHeaders = { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }
  assert.equal(await getSession(), null)

  reqHeaders = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
  const s = await getSession()
  assert.equal(s?.role, 'ADMIN')
  assert.equal(s?.email, 'narasit.k@thestandard.co')
})

test('getSession: outside a request scope the check is skipped (no browser = no CSRF)', async () => {
  reqHeaders = null
  const s = await getSession()
  assert.equal(s?.role, 'ADMIN')
})
