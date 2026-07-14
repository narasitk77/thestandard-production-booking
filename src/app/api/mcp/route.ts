/**
 * POST /api/mcp — MCP (Model Context Protocol) endpoint over Streamable
 * HTTP, so external AI clients (claude.ai custom connectors, Claude
 * Code, Claude Desktop, any MCP client) can operate Production Booking:
 * query the shoot schedule, look up projects/episodes, create booking
 * requests, cancel bookings. See docs/mcp.md for connection setup.
 *
 * Auth: `Authorization: Bearer <key>` (constant-time compared). Keys come
 * from the stack env:
 *   - MCP_API_KEY  — the original single shared key (still works as-is)
 *   - MCP_API_KEYS — v1.146, OPTIONAL: comma-separated per-client keys,
 *     each either "<key>" or "<label>:<key>" (label = which client holds
 *     it, e.g. "claude-desktop:abc123,n8n:def456"). Lets one leaked key
 *     be revoked without rotating every client at once.
 * No key configured at all = the endpoint is OFF (503). MCP callers act
 * at staff level under the MCP_ACTOR_EMAIL identity; admin actions are
 * not exposed as tools.
 *
 * v1.146 review fix — repeated auth failures back off per source IP
 * (10 fails / 15 min → 429): a leaked URL can't be brute-forced quietly,
 * and each rejection is one map lookup instead of a full request.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { handleMcpMessage } from '@/lib/mcp/server'
import { buildMcpRegistry } from '@/lib/mcp/tools'

export const dynamic = 'force-dynamic'

function configuredKeys(): Array<{ label: string; key: string }> {
  const out: Array<{ label: string; key: string }> = []
  const single = process.env.MCP_API_KEY?.trim()
  if (single) out.push({ label: 'default', key: single })
  for (const entry of (process.env.MCP_API_KEYS || '').split(',')) {
    const e = entry.trim()
    if (!e) continue
    const sep = e.indexOf(':')
    if (sep > 0) out.push({ label: e.slice(0, sep).trim() || 'unnamed', key: e.slice(sep + 1).trim() })
    else out.push({ label: 'unnamed', key: e })
  }
  return out.filter(k => k.key)
}

// In-memory failed-auth backoff — single-container deployment, so a restart
// clearing it is fine. Entries expire after the window; map is pruned on
// access so it can't grow unbounded.
const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000
const AUTH_FAIL_LIMIT = 10
const authFails = new Map<string, { count: number; firstAt: number }>()

function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || 'unknown'
}

function authFailState(ip: string): { blocked: boolean } {
  const now = Date.now()
  for (const [k, v] of Array.from(authFails)) {
    if (now - v.firstAt > AUTH_FAIL_WINDOW_MS) authFails.delete(k)
  }
  const rec = authFails.get(ip)
  return { blocked: !!rec && rec.count >= AUTH_FAIL_LIMIT }
}

function recordAuthFail(ip: string): void {
  const now = Date.now()
  const rec = authFails.get(ip)
  if (!rec || now - rec.firstAt > AUTH_FAIL_WINDOW_MS) authFails.set(ip, { count: 1, firstAt: now })
  else rec.count += 1
}

function authorizedKeyLabel(request: NextRequest): string | null {
  const keys = configuredKeys()
  if (keys.length === 0) return null
  const header = request.headers.get('authorization') || ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const a = Buffer.from(token)
  for (const { label, key } of keys) {
    const b = Buffer.from(key)
    if (a.length === b.length && timingSafeEqual(a, b)) return label
  }
  return null
}

export async function POST(request: NextRequest) {
  if (configuredKeys().length === 0) {
    return NextResponse.json(
      { error: 'MCP is not enabled — set MCP_API_KEY (or MCP_API_KEYS) in the stack env' },
      { status: 503 },
    )
  }
  const ip = clientIp(request)
  if (authFailState(ip).blocked) {
    return NextResponse.json(
      { error: 'Too many failed auth attempts — try again later' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(AUTH_FAIL_WINDOW_MS / 1000)) } },
    )
  }
  const keyLabel = authorizedKeyLabel(request)
  if (!keyLabel) {
    recordAuthFail(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  authFails.delete(ip)

  let message: unknown
  try {
    message = await request.json()
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400 },
    )
  }

  const response = await handleMcpMessage(message, buildMcpRegistry(), {
    name: 'production-booking',
    version: process.env.npm_package_version || '0.0.0',
    instructions:
      'Production Booking ของ THE STANDARD: จองคิวถ่ายทำ (booking) ดูตารางถ่าย ดูโปรเจกต์/Episode ของ Content Agency. ' +
      'Before create_booking, call list_outlets_and_programs (outlet bookings) or list_projects + list_project_episodes (Content Agency). ' +
      'New bookings start as REQUESTED and wait for admin approval.',
  })

  // Notifications get no body — 202 Accepted per Streamable HTTP.
  if (response === null) return new NextResponse(null, { status: 202 })

  return NextResponse.json(response)
}

// Streamable HTTP optional endpoints: we don't keep a server→client
// stream and don't track sessions — say so politely instead of 404.
export async function GET() {
  return NextResponse.json({ error: 'SSE stream not supported — POST JSON-RPC messages instead' }, { status: 405 })
}

export async function DELETE() {
  return new NextResponse(null, { status: 200 })
}
