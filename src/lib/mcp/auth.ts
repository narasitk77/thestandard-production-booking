/**
 * MCP key auth — parsing + scope resolution. Pure (env in → verdict out,
 * no Next.js imports) so it unit-tests directly; the /api/mcp route is
 * just the HTTP skin over this.
 *
 * Three scopes:
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
 *   - 'request' — `MCP_API_KEYS_REQUEST`: read tools + create_booking
 *     only, for Veela's booking requests (ยังรอ admin อนุมัติเหมือนเดิม).
 *
 * Duplicate keys resolve read > request > full — least privilege wins
 * over a config mistake; configuredKeys ordering determines first match.
 */
import { timingSafeEqual } from 'crypto'

export type McpKeyScope = 'full' | 'read' | 'request'
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

/**
 * Request keys (Veela, a LINE bot in the switcher group): only what a booking
 * request needs — NOT every read tool. Rentals (amounts, invoice/quote numbers),
 * repairs, reminders and equipment stay out, and a read tool added later does
 * not flow here by itself (fail-closed, review of PR #21).
 * list_switcher_jobs / list_mix_jobs are request+full only: existing read keys
 * (e.g. Pigwidgeon in a group chat) did not gain them silently.
 */
export const REQUEST_TOOLS: readonly string[] = [
  'list_bookings', 'get_booking', 'list_outlets_and_programs', 'list_projects', 'list_project_episodes',
  'list_switcher_jobs', 'list_mix_jobs', 'create_booking',
]

/**
 * Identity of bookings created through a request key. Deliberately not a real
 * mailbox and not the full-key actor: the room reconciler keys on it to leave
 * these REQUESTED bookings without a room until an admin approves them.
 */
export function mcpRequestActorEmail(env: Record<string, string | undefined> = process.env): string {
  const set = env.MCP_REQUEST_ACTOR_EMAIL?.trim()
  // must never equal the full-key actor: the room rule would then also hold back full-key bookings
  return set && set.toLowerCase() !== mcpActorEmail(env).toLowerCase() ? set : 'mcp-request@probook'
}

/** Identity of bookings created through a full key (unchanged default). */
export function mcpActorEmail(env: Record<string, string | undefined> = process.env): string {
  return env.MCP_ACTOR_EMAIL?.trim() || 'mcp@probook'
}

/** An MCP actor is an identity, not a mailbox — never e-mail it (approve confirmation, footage-ready). */
export function isMcpActorEmail(email: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const e = (email || '').trim().toLowerCase()
  return !!e && (e === mcpActorEmail(env).toLowerCase() || e === mcpRequestActorEmail(env).toLowerCase())
}

/** Max bookings a request key may create per rolling 24 h (a looping bot or a leaked key stops here). */
export function mcpRequestDailyMax(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MCP_REQUEST_DAILY_MAX)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20
}

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
  MCP_API_KEYS_REQUEST?: string
}

/** First match wins: read → request → full; preserve entry order within each list. */
export function configuredKeys(env: McpKeyEnv = process.env as McpKeyEnv): McpKey[] {
  const out: McpKey[] = []
  out.push(...parseKeyList(env.MCP_API_KEYS_READONLY, 'read'))
  out.push(...parseKeyList(env.MCP_API_KEYS_REQUEST, 'request'))
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
