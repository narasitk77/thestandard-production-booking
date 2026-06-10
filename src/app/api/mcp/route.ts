/**
 * POST /api/mcp — MCP (Model Context Protocol) endpoint over Streamable
 * HTTP, so external AI clients (claude.ai custom connectors, Claude
 * Code, Claude Desktop, any MCP client) can operate Production Booking:
 * query the shoot schedule, look up projects/episodes, create booking
 * requests, cancel bookings. See docs/mcp.md for connection setup.
 *
 * Auth: `Authorization: Bearer <MCP_API_KEY>` — a single shared key set
 * in the stack env (constant-time compared). No key configured = the
 * endpoint is OFF (503). MCP callers act at staff level under the
 * MCP_ACTOR_EMAIL identity; admin actions are not exposed as tools.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { handleMcpMessage } from '@/lib/mcp/server'
import { buildMcpRegistry } from '@/lib/mcp/tools'

export const dynamic = 'force-dynamic'

function isAuthorized(request: NextRequest): boolean {
  const key = process.env.MCP_API_KEY?.trim()
  if (!key) return false
  const header = request.headers.get('authorization') || ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) return false
  const a = Buffer.from(token)
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: NextRequest) {
  if (!process.env.MCP_API_KEY?.trim()) {
    return NextResponse.json(
      { error: 'MCP is not enabled — set MCP_API_KEY in the stack env' },
      { status: 503 },
    )
  }
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
