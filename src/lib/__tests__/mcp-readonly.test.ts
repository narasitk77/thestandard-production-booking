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
import { configuredKeys, resolveBearerKey, READ_ONLY_TOOLS, REQUEST_TOOLS } from '../mcp/auth'
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
// inert stubs; registry checks and read queries never reach the DB/services.
// NOTE: relative specifiers on purpose ('../db', not '@/lib/db') — CI's
// mock.module() resolves the specifier with plain node rules (no tsconfig
// alias), same as heartbeat-specs.test.ts. Interception still applies to
// tools.ts's '@/lib/...' imports because both resolve to the same file.
const queries: { model: string; args: any }[] = []
const db = { activeUsers: ['prod@thestandard.co'], count24h: 0, recent: [] as any[] }
mock.module('../db', { namedExports: { prisma: {
  switcherJob: { async findMany(args: any) { queries.push({ model: 'switcher', args }); return [] } },
  mixJob: { async findMany(args: any) { queries.push({ model: 'mix', args }); return [{ number: 7, sourceLink: 'source', deliveryLink: 'delivery' }] } },
  user: { async findFirst(args: any) {
    const want = String(args.where.email.equals).toLowerCase()
    if (args.where.active === true) return db.activeUsers.includes(want) ? { email: want } : null
    return { email: want } // full-key path: any known user
  } },
  episode: { async count() { return db.count24h } },
  booking: {
    async count() { return db.count24h },
    async findMany(args: any) { queries.push({ model: 'booking', args }); return db.recent },
  },
} } })
const creates: { body: any; actor: string; opts: any }[] = []
const fakeBooking = (o: any = {}) => ({ bookingCode: 'NWS-KYM-261105-01', status: 'REQUESTED', outlet: { code: 'NWS' }, program: { code: 'L', name: 'Long' },
  shootDate: new Date('2026-11-05'), callTime: '13:00', producer: 'ศรุต', episodes: [], ...o })
mock.module('../projects', { namedExports: { listProjects: async () => [{ projectId: 'PP-26-001', projectName: 'Shark', client: 'SECRET CLIENT', director: 'x' }] } })
mock.module('../dashboard-episodes', { namedExports: { listProjectEpisodes: async () => [] } })
let createDelayMs = 0
mock.module('../create-booking', { namedExports: { createBookingFromPayload: async (body: any, actor: string, opts: any) => {
  creates.push({ body, actor, opts })
  const b = fakeBooking({ shootDate: new Date(String(body.shootDate)), callTime: body.callTime, producer: body.producer, program: { code: body.programCode, name: 'Long' } })
  if (createDelayMs) await new Promise(r => setTimeout(r, createDelayMs))
  db.recent = [b, ...db.recent] // what the next dedupe query will see
  return { ok: true, booking: b }
} } })
mock.module('../google-calendar', { namedExports: { deleteCalendarEvent: async () => undefined } })
mock.module('../audit', { namedExports: { logAudit: async () => undefined } })
mock.module('../room-booking-sync', { namedExports: { releaseRoomForBooking: async () => undefined } })
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
  const unclassified = names.filter(n => !READ_ONLY_TOOLS.includes(n) && !REQUEST_TOOLS.includes(n) && !KNOWN_WRITE_TOOLS.includes(n))
  // request keys may write exactly one thing
  assert.deepEqual(REQUEST_TOOLS.filter(t => KNOWN_WRITE_TOOLS.includes(t)), ['create_booking'])
  for (const t of REQUEST_TOOLS) assert.ok(names.includes(t), `REQUEST_TOOLS lists unknown tool: ${t}`)
  assert.deepEqual(
    unclassified, [],
    `new tool(s) not classified: ${unclassified.join(', ')} — add to READ_ONLY_TOOLS (src/lib/mcp/auth.ts) if read-only, or to KNOWN_WRITE_TOOLS in this test if it writes`,
  )

  // and the read-only cut really removes all write tools
  const filtered = filterRegistry(registry, READ_ONLY_TOOLS)
  assert.deepEqual(filtered.defs.map(d => d.name).sort(), [...READ_ONLY_TOOLS].sort())
  for (const t of KNOWN_WRITE_TOOLS) assert.ok(!filtered.handlers[t], `write handler survived filter: ${t}`)
})


test('request keys parse in least-privilege order and enable the endpoint alone', () => {
  assert.deepEqual(configuredKeys({ MCP_API_KEYS_REQUEST: 'veela:req, bare ,empty: ' }).map(k => [k.label, k.key, k.scope]), [
    ['veela', 'req', 'request'], ['unnamed', 'bare', 'request'],
  ])
  const env = { MCP_API_KEY: 'same', MCP_API_KEYS: 'full:same', MCP_API_KEYS_REQUEST: 'veela:same' }
  assert.equal(resolveBearerKey('Bearer same', env)!.scope, 'request')
  assert.equal(resolveBearerKey('Bearer same', { ...env, MCP_API_KEYS_READONLY: 'bot:same' })!.scope, 'read')
  assert.deepEqual(configuredKeys({ ...env, MCP_API_KEYS_READONLY: 'bot:same' }).map(k => k.scope), ['read', 'request', 'full', 'full'])
})

test('request registry lists reads + create_booking only and rejects other writes server-side', async () => {
  const { buildMcpRegistry } = await import('../mcp/tools')
  const registry = filterRegistry(buildMcpRegistry(), REQUEST_TOOLS)
  const list = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, registry, serverInfo)
  assert.deepEqual((list!.result as any).tools.map((t: any) => t.name).sort(), [...REQUEST_TOOLS].sort())
  for (const money of ['list_unpaid_rentals', 'list_open_repairs', 'list_reminders', 'list_equipment']) {
    assert.ok(!(list!.result as any).tools.some((t: any) => t.name === money), `request key must not see ${money}`)
  }
  for (const name of ['cancel_booking', 'mark_rental_paid', 'create_repair_ticket']) {
    const call = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name } }, registry, serverInfo)
    assert.equal(call!.error?.code, -32602)
  }
  const readList = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, filterRegistry(buildMcpRegistry(), READ_ONLY_TOOLS), serverInfo)
  // v1.276 — existing read-only keys (Pigwidgeon in a group chat) did NOT silently gain these
  for (const name of ['list_switcher_jobs', 'list_mix_jobs']) {
    assert.ok(!(readList!.result as any).tools.some((t: any) => t.name === name))
  }
  assert.ok(!filterRegistry(fakeRegistry, REQUEST_TOOLS).handlers.write_b)
})


test('new read tools filter compact queries and include the whole Bangkok day', async () => {
  const { buildMcpRegistry } = await import('../mcp/tools')
  const registry = buildMcpRegistry()
  queries.length = 0
  await registry.handlers.list_switcher_jobs({ from: '2026-10-01', to: '2026-10-28', outlet: 'nws', status: 'DRAFT', switcherEmail: 'switcher@example.com', limit: 999 })
  assert.deepEqual(queries[0].args.where, {
    deletedAt: null, outletCode: 'NWS', status: 'DRAFT', switcherEmail: 'switcher@example.com',
    workDate: { gte: new Date('2026-10-01'), lte: new Date('2026-10-28') },
  })
  assert.equal(queries[0].args.take, 200)
  assert.deepEqual(queries[0].args.orderBy, [{ workDate: 'desc' }, { createdAt: 'desc' }])
  assert.equal(queries[0].args.select.notes, undefined)
  const result = await registry.handlers.list_mix_jobs({ from: '2026-10-28', to: '2026-10-28', status: 'QUEUED', assigneeEmail: 'mix@example.com' }) as any
  assert.deepEqual(queries[1].args.where, {
    deletedAt: null, status: 'QUEUED', assigneeEmail: 'mix@example.com',
    createdAt: { gte: new Date('2026-10-27T17:00:00Z'), lt: new Date('2026-10-28T17:00:00Z') },
  })
  assert.equal(queries[1].args.take, 50)
  assert.equal(queries[1].args.select.events, undefined)
  assert.equal(queries[1].args.select.sourceLink, true)
  assert.equal(queries[1].args.select.deliveryLink, true)
  assert.equal(result.jobs[0].number, 'MIX-007')
})

test('new read tools reject non YYYY-MM-DD dates instead of shifting a day, and truncate limit', async () => {
  const { buildMcpRegistry } = await import('../mcp/tools')
  const { McpToolError } = await import('../mcp/server')
  const registry = buildMcpRegistry()
  for (const bad of ['2026-10-5', '2026/10/05', '2026-10-28T00:00:00+07:00', '2026-13-40']) {
    await assert.rejects(registry.handlers.list_switcher_jobs({ to: bad }), McpToolError)
    await assert.rejects(registry.handlers.list_mix_jobs({ from: bad }), McpToolError)
  }
  queries.length = 0
  await registry.handlers.list_mix_jobs({ limit: 10.7 })
  assert.equal(queries[0].args.take, 10)
})

// ---- v1.276 — request-scope create_booking (review of PR #21) ----------------
const goodReq = (o: any = {}) => ({ outletCode: 'NWS', programCode: 'L', shootDate: '2099-11-05', callTime: '13:00', shootType: 'STUDIO',
  category: 'ORIGINAL_CONTENT', producer: 'ศรุต', cameraCount: 1, micCount: 1, episodes: [{ programCode: 'KYM', title: 'x' }], ...o })

test('request create: unknown fields are dropped AND reported; requestedBy never becomes the owner; created as the request actor', async () => {
  const { buildMcpRegistry } = await import('../mcp/tools')
  db.count24h = 0; db.recent = []; creates.length = 0
  const r = await buildMcpRegistry({ scope: 'request', label: 'veela' }).handlers.create_booking(goodReq({
    isRoutine: true, routineGroupId: 'g1', locationId: 'tsd-studio-1', shootEndDate: '2099-11-09', virtualProduction: true,
    coProducerEmail: 'outsider@gmail.com', requestedBy: 'boss.admin@thestandard.co',
  })) as any
  assert.equal(r.created, true)
  assert.deepEqual([...r.ignoredFields].sort(), ['coProducerEmail', 'isRoutine', 'locationId', 'routineGroupId', 'shootEndDate', 'virtualProduction'])
  const c = creates[0]
  for (const k of ['isRoutine', 'routineGroupId', 'locationId', 'shootEndDate', 'virtualProduction', 'coProducerEmail']) assert.ok(!(k in c.body), k)
  assert.equal(c.actor, 'mcp-request@probook')
  assert.equal(c.opts.createdByEmail, undefined, 'requestedBy from a chat must not become createdByEmail')
  assert.equal(c.opts.requestedBy, 'boss.admin@thestandard.co')
  assert.equal(c.opts.via, 'mcp:veela')
})

test('request create: producerEmail must be an active probook user; dates must be real, Gregorian, not past', async () => {
  const { buildMcpRegistry } = await import('../mcp/tools')
  const { McpToolError } = await import('../mcp/server')
  const h = buildMcpRegistry({ scope: 'request', label: 'veela' }).handlers
  db.count24h = 0; db.recent = []
  await assert.rejects(h.create_booking(goodReq({ producerEmail: 'outsider@gmail.com' })), McpToolError)
  creates.length = 0
  await h.create_booking(goodReq({ producerEmail: ' PROD@TheStandard.co ' }))
  assert.equal(creates[0].body.producerEmail, 'prod@thestandard.co')
  for (const bad of ['2026-02-30', '2569-11-05', '2020-01-01', '5/11/2026']) {
    await assert.rejects(h.create_booking(goodReq({ shootDate: bad })), McpToolError, bad)
  }
})

test('request create: a looping bot hits the daily cap; a resend within 15 min returns the first booking', async () => {
  const { buildMcpRegistry } = await import('../mcp/tools')
  const { McpToolError } = await import('../mcp/server')
  const h = buildMcpRegistry({ scope: 'request', label: 'veela' }).handlers
  db.count24h = 20; db.recent = []; creates.length = 0
  await assert.rejects(h.create_booking(goodReq()), McpToolError)
  assert.equal(creates.length, 0)
  db.count24h = 0; db.recent = [fakeBooking({ bookingCode: 'NWS-KYM-209911-01', shootDate: new Date('2099-11-05') })]
  const r = await h.create_booking(goodReq({ producer: ' ศรุต ' })) as any
  assert.equal(r.duplicate, true)
  assert.equal(r.booking.bookingCode, 'NWS-KYM-209911-01')
  assert.equal(creates.length, 0, 'a resend must not create a second booking')
})

test('full keys keep their behaviour: extra fields pass through, a known requestedBy is the owner', async () => {
  const { buildMcpRegistry } = await import('../mcp/tools')
  creates.length = 0
  await buildMcpRegistry({ scope: 'full', label: 'n8n' }).handlers.create_booking(goodReq({ shootEndDate: '2099-11-06', requestedBy: 'staff@thestandard.co' }))
  assert.equal(creates[0].body.shootEndDate, '2099-11-06')
  assert.equal(creates[0].opts.createdByEmail, 'staff@thestandard.co')
})

test('read tools: status/email are case-insensitive, a typo is an error not "nothing found", mix can filter by due date', async () => {
  const { buildMcpRegistry } = await import('../mcp/tools')
  const { McpToolError } = await import('../mcp/server')
  const h = buildMcpRegistry().handlers
  queries.length = 0
  await h.list_switcher_jobs({ status: 'logged', switcherEmail: ' Foo.B@TheStandard.co ' })
  assert.equal(queries[0].args.where.status, 'LOGGED')
  assert.equal(queries[0].args.where.switcherEmail, 'foo.b@thestandard.co')
  await assert.rejects(h.list_switcher_jobs({ status: 'PENDING' }), McpToolError)
  await assert.rejects(h.list_mix_jobs({ status: 'in progress' }), McpToolError)
  queries.length = 0
  await h.list_mix_jobs({ dueFrom: '2026-10-29', dueTo: '2026-10-29' })
  assert.deepEqual(queries[0].args.where.dueDate, { gte: new Date('2026-10-29'), lte: new Date('2026-10-29') })
  for (const bad of ['2026-02-30', '2026-04-31', '2569-10-28']) {
    await assert.rejects(h.list_mix_jobs({ to: bad }), McpToolError, bad)
    await assert.rejects(h.list_switcher_jobs({ from: bad }), McpToolError, bad)
  }
})

test('request create: two identical requests at the same time → one booking, one duplicate (queue, not a race)', async () => {
  const { buildMcpRegistry } = await import('../mcp/tools')
  const h = buildMcpRegistry({ scope: 'request', label: 'veela' }).handlers
  db.count24h = 0; db.recent = []; creates.length = 0; createDelayMs = 30
  const [a, b] = await Promise.all([h.create_booking(goodReq()), h.create_booking(goodReq())]) as any[]
  createDelayMs = 0
  assert.equal(creates.length, 1)
  assert.deepEqual([a.created, b.duplicate], [true, true])
})

test('request create: the daily cap counts episodes (each burns an Episode ID), and a resend at the cap still gets its booking back', async () => {
  const { buildMcpRegistry } = await import('../mcp/tools')
  const { McpToolError } = await import('../mcp/server')
  const h = buildMcpRegistry({ scope: 'request', label: 'veela' }).handlers
  db.recent = []; creates.length = 0; db.count24h = 18
  const three = goodReq({ episodes: [1, 2, 3].map(i => ({ programCode: 'KYM', title: `t${i}` })) })
  await assert.rejects(h.create_booking(three), McpToolError) // 18 + 3 > 20
  await h.create_booking(goodReq()) // 18 + 1 ok
  db.count24h = 20
  const again = await h.create_booking(goodReq()) as any
  assert.equal(again.duplicate, true, 'dedupe runs before the cap')
})

test('request create: different show at the same time is NOT a duplicate', async () => {
  const { buildMcpRegistry } = await import('../mcp/tools')
  const h = buildMcpRegistry({ scope: 'request', label: 'veela' }).handlers
  db.count24h = 0; db.recent = []; creates.length = 0
  await h.create_booking(goodReq({ programCode: 'L' }))
  const r = await h.create_booking(goodReq({ programCode: 'S' })) as any
  assert.equal(r.created, true)
  assert.equal(creates.length, 2)
})

test('request keys: list_projects hides clients; full keys still see them', async () => {
  const { buildMcpRegistry } = await import('../mcp/tools')
  const req = await buildMcpRegistry({ scope: 'request', label: 'veela' }).handlers.list_projects({}) as any
  assert.ok(!JSON.stringify(req).includes('SECRET CLIENT'))
  assert.deepEqual(req.projects[0], { projectId: 'PP-26-001', projectName: 'Shark' })
  const full = await buildMcpRegistry({ scope: 'full' }).handlers.list_projects({}) as any
  assert.ok(JSON.stringify(full).includes('SECRET CLIENT'))
})

test('isMcpActorEmail / mcpRequestActorEmail: actors are not mailboxes, and the two can never be the same identity', async () => {
  const { isMcpActorEmail, mcpRequestActorEmail } = await import('../mcp/auth')
  assert.equal(isMcpActorEmail('mcp-request@probook', {}), true)
  assert.equal(isMcpActorEmail('MCP@probook', {}), true)
  assert.equal(isMcpActorEmail('prod@thestandard.co', {}), false)
  assert.equal(mcpRequestActorEmail({ MCP_ACTOR_EMAIL: 'bot@x.co', MCP_REQUEST_ACTOR_EMAIL: 'BOT@x.co' }), 'mcp-request@probook')
  assert.equal(mcpRequestActorEmail({ MCP_REQUEST_ACTOR_EMAIL: 'veela@x.co' }), 'veela@x.co')
})

