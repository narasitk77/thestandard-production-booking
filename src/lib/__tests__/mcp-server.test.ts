/**
 * MCP protocol-layer tests (run: npm test). Covers the JSON-RPC subset
 * the /api/mcp endpoint speaks: initialize, ping, tools/list,
 * tools/call (success, unknown tool, handler failure), notifications,
 * and malformed input. Uses a fake registry — no DB.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleMcpMessage, McpToolError, type McpRegistry } from '../mcp/server'

const serverInfo = { name: 'test-server', version: '9.9.9', instructions: 'hello' }

const registry: McpRegistry = {
  defs: [
    { name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },
  ],
  handlers: {
    async echo(args) { return { echoed: args.msg } },
    async boom() { throw new McpToolError('คุณส่งของผิด') },
    async crash() { throw new Error('unexpected') },
  },
}

const call = (message: unknown) => handleMcpMessage(message, registry, serverInfo)

test('initialize: echoes a supported protocol version and returns server info', async () => {
  const res = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  assert.ok(res && res.result)
  const r = res!.result as any
  assert.equal(r.protocolVersion, '2025-06-18')
  assert.deepEqual(r.serverInfo, { name: 'test-server', version: '9.9.9' })
  assert.equal(r.instructions, 'hello')
  assert.ok(r.capabilities.tools)
})

test('initialize: unknown protocol version falls back to ours', async () => {
  const res = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  assert.equal((res!.result as any).protocolVersion, '2025-03-26')
})

test('ping returns an empty result', async () => {
  const res = await call({ jsonrpc: '2.0', id: 2, method: 'ping' })
  assert.deepEqual(res!.result, {})
})

test('tools/list returns the registry definitions', async () => {
  const res = await call({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  assert.deepEqual((res!.result as any).tools.map((t: any) => t.name), ['echo'])
})

test('tools/call: success wraps the result as text content', async () => {
  const res = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'สวัสดี' } } })
  const r = res!.result as any
  assert.equal(r.isError, undefined)
  assert.deepEqual(JSON.parse(r.content[0].text), { echoed: 'สวัสดี' })
})

test('tools/call: unknown tool is a -32602 protocol error', async () => {
  const res = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } })
  assert.equal(res!.error!.code, -32602)
})

test('tools/call: McpToolError becomes an isError RESULT the model can read', async () => {
  const res = await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'boom' } })
  const r = res!.result as any
  assert.equal(r.isError, true)
  assert.equal(r.content[0].text, 'คุณส่งของผิด')
})

test('tools/call: unexpected throw also becomes isError, with a generic prefix', async () => {
  const res = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'crash' } })
  const r = res!.result as any
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /^Tool failed: unexpected/)
})

test('notifications (no id) get no response', async () => {
  assert.equal(await call({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.equal(await call({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), null)
})

test('unknown method is -32601', async () => {
  const res = await call({ jsonrpc: '2.0', id: 8, method: 'resources/list' })
  assert.equal(res!.error!.code, -32601)
})

test('malformed messages are -32600', async () => {
  assert.equal((await call('hi'))!.error!.code, -32600)
  assert.equal((await call({ id: 9, method: 'ping' }))!.error!.code, -32600)            // missing jsonrpc
  assert.equal((await call({ jsonrpc: '2.0', id: 10 }))!.error!.code, -32600)           // missing method
  assert.equal((await call([{ jsonrpc: '2.0', id: 11, method: 'ping' }]))!.error!.code, -32600) // batch
})
