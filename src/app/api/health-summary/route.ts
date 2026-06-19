import { NextResponse } from 'next/server'
import { evaluateWorkers } from '@/lib/heartbeat'

export const dynamic = 'force-dynamic'

/**
 * GET /api/health-summary — coarse worker liveness for an external uptime
 * probe. Returns 503 when any enabled background worker has gone stale, 200
 * otherwise. Public on purpose (status code is the signal; body carries no
 * secrets) so a Portainer healthcheck / uptime monitor can hit it unauthenticated.
 */
export async function GET() {
  try {
    const workers = await evaluateWorkers()
    const stale = workers.filter((w) => w.stale)
    return NextResponse.json(
      {
        ok: stale.length === 0,
        workers: workers.map((w) => ({
          key: w.key,
          enabled: w.enabled,
          stale: w.stale,
          neverTicked: w.neverTicked,
          lastTickAgoSec: w.ageMs != null ? Math.round(w.ageMs / 1000) : null,
        })),
      },
      { status: stale.length === 0 ? 200 : 503 },
    )
  } catch (e: any) {
    // A failing health check must read as DOWN, not silently OK.
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 503 })
  }
}
