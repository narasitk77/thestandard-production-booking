/**
 * Read-only MCP key tests (v1.212). Three layers:
 *
 * 1. Key parsing + scope resolution (@/lib/mcp/auth) — pure env-in /
 *    verdict-out, including the "same key in both lists = read wins"
 *    least-privilege rule.
 * 2. filterRegistry through the real protocol handler — a filtered
 *    registry must hide write tools from tools/list AND reject them on
 *    tools/call (single choke point, no drift between the two).
 * 3. Dead-man switch on the real registry (Prisma/Google mocked): every
 *    tool must be classified — either in READ_ONLY_TOOLS or in the
 *    known write list. Add a tool without classifying it and this file
 *    fails, so a new write tool can never leak to read-only keys by
 *    omission.
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { configuredKeys, resolveBearerKey, READ_ONLY_TOOLS } from '../mcp/auth'
import { handleMcpMessage, filterRegistry, type McpRegistry } from '../mcp/server'

// ---- 1) key parsing + scope -------------------------------------------------

test('configuredKeys: readonly list parses like MCP_API_KEYS and carries scope=read', () => {
  const keys = configuredKeys({
    MCP_API_KEY: 'root-key',
    MCP_API_KEYS: 'n8n:full-1, bare-full',
    MCP_API_KEYS_READONLY: 'pigwidgeon:ro-1, bare-ro ,',
  })
  assert.deepEqual(
    keys.map(k => [k.label, k.key, k.scope]),
    [
      ['pigwidgeon', 'ro-1', 'read'],
      ['unnamed', 'bare-ro', 'read'],
      ['default', 'root-key', 'full'],
      ['n8n', 'full-1', 'full'],
      ['unnamed', 'bare-full', 'full'],
    ],
  )
})

test('configuredKeys: readonly-only config counts as configured (endpoint on)', () => {
  const keys = configuredKeys({ MCP_API_KEYS_READONLY: 'bot:abc' })
  assert.equal(keys.length, 1)
  assert.equal(keys[0].scope, 'read')
})

test('resolveBearerKey: full and read keys resolve with their scopes; wrong/missing token = null', () => {
  const env = { MCP_API_KEYS: 'n8n:full-1', MCP_API_KEYS_READONLY: 'pigwidgeon:ro-1' }
  assert.equal(resolveBearerKey('Bearer full-1', env)!.scope, 'full')
  const ro = resolveBearerKey('Bearer ro-1', env)!
  assert.equal(ro.scope, 'read')
  assert.equal(ro.label, 'pigwidgeon')
  assert.equal(resolveBearerKey('Bearer nope', env), null)
  assert.equal(resolveBearerKey('', env), null)
  assert.equal(resolveBearerKey(null, env), null)
})

test('least privilege: a key present in both lists resolves as read', () => {
  const env = { MCP_API_KEYS: 'oops:same-key', MCP_API_KEYS_READONLY: 'bot:same-key' }
  assert.equal(resolveBearerKey('Bearer same-key', env)!.scope, 'read')
})

// ---- 2) filterRegistry through the protocol --------------------------------

const fakeRegistry: McpRegistry = {
  defs: [
    { name: 'read_a', description: 'reads', inputSchema: { type: 'object' } },
    { name: 'write_b', description: 'writes', inputSchema: { type: 'object' } },
  ],
  handlers: {
    async read_a() { return { ok: true } },
    async write_b() { return { wrote: true } },
  },
}
const serverInfo = { name: 't', version: '0' }

test('filterRegistry: keeps only allowed defs+handlers, ignores unknown names, does not mutate input', () => {
  const filtered = filterRegistry(fakeRegistry, ['read_a', 'not_a_tool'])
  assert.deepEqual(filtered.defs.map(d => d.name), ['read_a'])
  assert.deepEqual(Object.keys(filtered.handlers), ['read_a'])
  // original untouched
  assert.deepEqual(fakeRegistry.defs.map(d => d.name), ['read_a', 'write_b'])
  assert.ok(fakeRegistry.handlers.write_b)
})

test('filtered registry: write tool is gone from tools/list AND rejected on tools/call', async () => {
  const filtered = filterRegistry(fakeRegistry, ['read_a'])
  const list = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, filtered, serverInfo)
  assert.deepEqual((list!.result as any).tools.map((t: any) => t.name), ['read_a'])
  const call = await handleMcpMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_b', arguments: {} } },
    filtered, serverInfo,
  )
  assert.equal(call!.error!.code, -32602) // unknown tool — handler absent
  const ok = await handleMcpMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_a', arguments: {} } },
    filtered, serverInfo,
  )
  assert.deepEqual(JSON.parse((ok!.result as any).content[0].text), { ok: true })
})

test('prototype-chain names are unknown tools, not inherited functions — filtered and unfiltered', async () => {
  for (const registry of [fakeRegistry, filterRegistry(fakeRegistry, ['read_a'])]) {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      const res = await handleMcpMessage(
        { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: {} } },
        registry, serverInfo,
      )
      assert.equal(res!.error?.code, -32602, `expected -32602 for prototype name "${name}"`)
    }
  }
})

// ---- 3) dead-man switch on the real registry -------------------------------

// tools.ts pulls Prisma + Google-backed modules at import time — swap them for
// inert stubs; this test only inspects tool NAMES, never runs handlers.
// NOTE: relative specifiers on purpose ('../db', not '@/lib/db') — CI's
// mock.module() resolves the specifier with plain node rules (no tsconfig
// alias), same as heartbeat-specs.test.ts. Interception still applies to
// tools.ts's '@/lib/...' imports because both resolve to the same file.
mock.module('../db', { namedExports: { prisma: {} } })
mock.module('../projects', { namedExports: { listProjects: async () => [] } })
mock.module('../dashboard-episodes', { namedExports: { listProjectEpisodes: async () => [] } })
mock.module('../create-booking', { namedExports: { createBookingFromPayload: async () => ({}) } })
mock.module('../google-calendar', { namedExports: { deleteCalendarEvent: async () => undefined } })
mock.module('../audit', { namedExports: { logAudit: async () => undefined } })
mock.module('../ot-sync', { namedExports: { clearBookingOT: async () => undefined } })

const KNOWN_WRITE_TOOLS = ['create_booking', 'cancel_booking', 'create_repair_ticket', 'mark_rental_paid']

test('every registry tool is classified read or write — unclassified tools fail the build', async () => {
  const { buildMcpRegistry } = await import('../mcp/tools')
  const registry = buildMcpRegistry()
  const names = registry.defs.map(d => d.name)

  // every def has a handler and vice versa (registry self-consistency)
  assert.deepEqual([...names].sort(), Object.keys(registry.handlers).sort())

  // every READ_ONLY_TOOLS entry really exists (catches renames going stale)
  for (const t of READ_ONLY_TOOLS) assert.ok(names.includes(t), `READ_ONLY_TOOLS lists unknown tool: ${t}`)

  // no write tool is ever marked read-only
  for (const t of KNOWN_WRITE_TOOLS) assert.ok(!READ_ONLY_TOOLS.includes(t), `write tool in READ_ONLY_TOOLS: ${t}`)

  // dead-man switch: a tool that is neither classified read nor write
  // means someone added a tool without deciding its scope — fail loudly
  const unclassified = names.filter(n => !READ_ONLY_TOOLS.includes(n) && !KNOWN_WRITE_TOOLS.includes(n))
  assert.deepEqual(
    unclassified, [],
    `new tool(s) not classified: ${unclassified.join(', ')} — add to READ_ONLY_TOOLS (src/lib/mcp/auth.ts) if read-only, or to KNOWN_WRITE_TOOLS in this test if it writes`,
  )

  // and the read-only cut really removes all write tools
  const filtered = filterRegistry(registry, READ_ONLY_TOOLS)
  assert.deepEqual(filtered.defs.map(d => d.name).sort(), [...READ_ONLY_TOOLS].sort())
  for (const t of KNOWN_WRITE_TOOLS) assert.ok(!filtered.handlers[t], `write handler survived filter: ${t}`)
})
