/**
 * Minimal MCP (Model Context Protocol) server core — protocol layer only.
 *
 * Implements the JSON-RPC 2.0 message handling for MCP over Streamable
 * HTTP in its simplest valid form: every request gets a single JSON
 * response (no SSE streaming). That is enough for Claude Code
 * (`claude mcp add --transport http`), claude.ai custom connectors, and
 * any standard MCP client — they all accept `application/json` replies.
 *
 * Deliberately dependency-free (no @modelcontextprotocol/sdk): the SDK's
 * server transports don't fit Next.js App Router route handlers cleanly,
 * and the protocol subset we need — initialize / tools/list / tools/call
 * / ping — is small and stable. Pure module: no DB, no Next.js imports,
 * fully unit-testable.
 */

export const MCP_PROTOCOL_VERSION = '2025-03-26'
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export type McpToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown> // JSON Schema (draft-07 style)
}

/** Throw inside a handler to return a tool error the model can read. */
export class McpToolError extends Error {}

export type McpToolHandler = (args: Record<string, unknown>) => Promise<unknown>

export type McpRegistry = {
  defs: McpToolDef[]
  handlers: Record<string, McpToolHandler>
}

type JsonRpcId = string | number | null

export type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string }
}

const rpcError = (id: JsonRpcId, code: number, message: string): JsonRpcResponse =>
  ({ jsonrpc: '2.0', id, error: { code, message } })

export type McpServerInfo = { name: string; version: string; instructions?: string }

/**
 * Handle one decoded JSON-RPC message. Returns the response object, or
 * `null` when the message is a notification (no response — HTTP 202).
 */
export async function handleMcpMessage(
  message: unknown,
  registry: McpRegistry,
  serverInfo: McpServerInfo,
): Promise<JsonRpcResponse | null> {
  if (Array.isArray(message)) {
    // JSON-RPC batching was dropped from the MCP spec in 2025-06-18 and no
    // mainstream client sends it — reject explicitly rather than half-support.
    return rpcError(null, -32600, 'Batch requests are not supported')
  }
  if (!message || typeof message !== 'object') {
    return rpcError(null, -32600, 'Invalid request')
  }
  const { jsonrpc, id, method, params } = message as {
    jsonrpc?: string; id?: JsonRpcId; method?: string; params?: any
  }
  const isNotification = id === undefined

  if (jsonrpc !== '2.0' || typeof method !== 'string') {
    return rpcError(id ?? null, -32600, 'Invalid request')
  }

  // Notifications: acknowledge silently. The only ones clients send us are
  // notifications/initialized and notifications/cancelled.
  if (isNotification) return null

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSION
      return {
        jsonrpc: '2.0',
        id: id!,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverInfo.name, version: serverInfo.version },
          ...(serverInfo.instructions ? { instructions: serverInfo.instructions } : {}),
        },
      }
    }

    case 'ping':
      return { jsonrpc: '2.0', id: id!, result: {} }

    case 'tools/list':
      return { jsonrpc: '2.0', id: id!, result: { tools: registry.defs } }

    case 'tools/call': {
      const name = params?.name
      const args = (params?.arguments ?? {}) as Record<string, unknown>
      const handler = typeof name === 'string' ? registry.handlers[name] : undefined
      if (!handler) {
        return rpcError(id!, -32602, `Unknown tool: ${String(name)}`)
      }
      try {
        const result = await handler(args)
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        return {
          jsonrpc: '2.0',
          id: id!,
          result: { content: [{ type: 'text', text }] },
        }
      } catch (e: any) {
        // Tool-level failures are RESULTS with isError (the model should see
        // them), not protocol errors — per the MCP spec.
        const msg = e instanceof McpToolError ? e.message : `Tool failed: ${e?.message || String(e)}`
        return {
          jsonrpc: '2.0',
          id: id!,
          result: { content: [{ type: 'text', text: msg }], isError: true },
        }
      }
    }

    default:
      return rpcError(id!, -32601, `Method not found: ${method}`)
  }
}
