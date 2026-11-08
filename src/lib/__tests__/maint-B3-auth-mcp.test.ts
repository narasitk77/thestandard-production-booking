import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'

// maint 2026-11-08 (auth-mcp-backoff-xff-spoof) — the /api/mcp brute-force backoff keyed
// on the FIRST X-Forwarded-For entry (client-controlled: the proxy appends) and was
// checked BEFORE the key, so 10 junk requests claiming Veela's IP locked Veela out
// with a valid key, and rotating the header dodged the backoff entirely.
mock.module('../mcp/tools', { namedExports: { buildMcpRegistry: () => ({}) } })
mock.module('../mcp/server', {
  namedExports: {
    handleMcpMessage: async (m: any) => ({ jsonrpc: '2.0', id: m.id, result: {} }),
    filterRegistry: (r: any) => r,
  },
})

let POST: (r: any) => Promise<Response>
before(async () => {
  process.env.MCP_API_KEYS_REQUEST = 'veela:veela-key-0123456789'
  ;({ POST } = await import('../../app/api/mcp/route'))
})

const call = (key: string, h: Record<string, string>) => POST(new Request('https://probook.test/api/mcp', {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...h },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
}) as any)

test('spoofed XFF claiming Veela\'s IP cannot lock Veela out', async () => {
  const VEELA = '203.0.113.7'
  for (let i = 0; i < 12; i++) {
    await call('wrong', { 'x-forwarded-for': `${VEELA}, 198.51.100.66`, 'x-real-ip': '198.51.100.66' })
  }
  const res = await call('veela-key-0123456789', { 'x-forwarded-for': VEELA, 'x-real-ip': VEELA })
  assert.equal(res.status, 200)
})

test('rotating the XFF header does not dodge the backoff (bucket = proxy-seen IP)', async () => {
  const statuses: number[] = []
  for (let i = 0; i < 11; i++) {
    const r = await call('wrong', { 'x-forwarded-for': `10.0.0.${i}, 198.51.100.99`, 'x-real-ip': '198.51.100.99' })
    statuses.push(r.status)
  }
  assert.equal(statuses[0], 401)
  assert.equal(statuses[10], 429)
})

test('a valid key is never 429\'d, even from a bucket that is blocked', async () => {
  const SHARED = '198.51.100.123'
  for (let i = 0; i < 11; i++) await call('wrong', { 'x-real-ip': SHARED })
  assert.equal((await call('wrong', { 'x-real-ip': SHARED })).status, 429)
  assert.equal((await call('veela-key-0123456789', { 'x-real-ip': SHARED })).status, 200)
})
