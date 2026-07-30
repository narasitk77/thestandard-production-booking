import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { snapshotIdFirst, publicGaugeView } from '@/lib/id-first-metrics'

export const dynamic = 'force-dynamic'

/**
 * GET /api/internal/id-first-stats — v1.158
 *
 * The id-first coverage gauge, readable by an EXTERNAL monitor (a daily
 * scheduled check that decides when the name fallbacks have gone quiet and can
 * be deleted — step (c) of the id-first plan).
 *
 * DELIBERATELY UNAUTHENTICATED, like /api/version: the shared-secret envs are
 * not available to the monitor, so this returns AGGREGATES ONLY — counters per
 * subsystem, booking codes reduced to a count (publicGaugeView strips them).
 * Never add codes, names, or links here without adding auth first.
 *
 *   live  — in-memory counters since the last daily digest (reset on send)
 *   daily — the last 14 persisted daily snapshots (auditLog drive.id_first_gauge,
 *           written once/day by maybeSendDailyDigest)
 */
export async function GET() {
  const live = publicGaugeView(snapshotIdFirst(false))
  const rows = await prisma.auditLog.findMany({
    where: { action: 'drive.id_first_gauge' },
    orderBy: { at: 'desc' },
    take: 14,
    select: { at: true, changes: true },
  }).catch(() => [] as Array<{ at: Date; changes: unknown }>)
  const daily = rows.map(r => ({ at: r.at.toISOString(), ...publicGaugeView(r.changes) }))
  return NextResponse.json({ ok: true, live, daily })
}
