/**
 * MCP key auth — parsing + scope resolution. Pure (env in → verdict out,
 * no Next.js imports) so it unit-tests directly; the /api/mcp route is
 * just the HTTP skin over this.
 *
 * Two scopes:
 *   - 'full' — staff level, every tool. `MCP_API_KEY` + `MCP_API_KEYS`
 *     (unchanged from before — existing keys keep working as-is).
 *   - 'read' — v1.212: `MCP_API_KEYS_READONLY`, same comma-separated
 *     `<label>:<key>` format. A read key sees and can call ONLY the
 *     tools in READ_ONLY_TOOLS — the write tools are absent from
 *     tools/list and reject on tools/call, enforced server-side, so a
 *     leaked read key cannot book/cancel/mark-paid no matter what
 *     client holds it. Made for headless bots (e.g. Pigwidgeon) that
 *     only ever query.
 *
 * A key present in BOTH lists resolves to 'read' — least privilege wins
 * over a config mistake.
 */
import { timingSafeEqual } from 'crypto'

export type McpKeyScope = 'full' | 'read'
export type McpKey = { label: string; key: string; scope: McpKeyScope }

/**
 * Tools a read-only key may use. Deliberately an allowlist: a NEW tool
 * added to the registry is invisible to read keys until someone lists
 * it here (fail-closed) — forgetting this list can hide a read tool,
 * but can never leak a write tool.
 */
export const READ_ONLY_TOOLS: readonly string[] = [
  'list_bookings',
  'get_booking',
  'list_outlets_and_programs',
  'list_projects',
  'list_project_episodes',
  'list_reminders',
  'list_overdue_loans',
  'list_unpaid_rentals',
  'list_open_repairs',
  'list_equipment',
]

function parseKeyList(raw: string | undefined, scope: McpKeyScope): McpKey[] {
  const out: McpKey[] = []
  for (const entry of (raw || '').split(',')) {
    const e = entry.trim()
    if (!e) continue
    const sep = e.indexOf(':')
    if (sep > 0) out.push({ label: e.slice(0, sep).trim() || 'unnamed', key: e.slice(sep + 1).trim(), scope })
    else out.push({ label: 'unnamed', key: e, scope })
  }
  return out.filter(k => k.key)
}

/** Narrow on purpose — a typo'd env-var name in a caller/test should fail to compile, not silently parse zero keys. `process.env` is cast once at the default parameter (TS's weak-type rule bars direct assignment). */
export type McpKeyEnv = {
  MCP_API_KEY?: string
  MCP_API_KEYS?: string
  MCP_API_KEYS_READONLY?: string
}

/** Every configured key, read-scope entries first (so both-lists = read). */
export function configuredKeys(env: McpKeyEnv = process.env as McpKeyEnv): McpKey[] {
  const out: McpKey[] = []
  out.push(...parseKeyList(env.MCP_API_KEYS_READONLY, 'read'))
  const single = env.MCP_API_KEY?.trim()
  if (single) out.push({ label: 'default', key: single, scope: 'full' })
  out.push(...parseKeyList(env.MCP_API_KEYS, 'full'))
  return out
}

/**
 * Resolve an Authorization header to a configured key (constant-time
 * comparison), or null when the token matches nothing. Callers should
 * check `configuredKeys().length === 0` separately for the
 * endpoint-disabled (503) case.
 */
export function resolveBearerKey(
  authorizationHeader: string | null | undefined,
  env: McpKeyEnv = process.env as McpKeyEnv,
): McpKey | null {
  const token = (authorizationHeader || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const a = Buffer.from(token)
  for (const k of configuredKeys(env)) {
    const b = Buffer.from(k.key)
    if (a.length === b.length && timingSafeEqual(a, b)) return k
  }
  return null
}
