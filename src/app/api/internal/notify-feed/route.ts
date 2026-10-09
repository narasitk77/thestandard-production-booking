import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { bookingDisplayName } from '@/lib/display'
import { latestNasState, nasManifestAge } from '@/lib/nas-sync'

export const dynamic = 'force-dynamic'

/**
 * GET /api/internal/notify-feed?since=<ISO>[&limit=50] — v1.262
 *
 * The events an operator wants to HEAR about, as data, for a relay outside the app to deliver
 * (Hermes posts them into the Discord room Nat reads). Read-only.
 *
 * Why a feed and not another push: footage-ready already pushes (team email + the "Ohm" Discord
 * webhook) but the operator's own copy has been a Gmail self-send since day one — From = To =
 * narasit.k@ via his own SMTP — which never lands, and since v1.248 is not even attempted. 31 notices
 * in 14 days reached the team while the operator heard none and concluded the worker was gone.
 *
 * Sources are the audit rows the senders already write (a record of what WAS sent, not intent):
 *   booking.auto_notified_ready · booking.notified_ready (📣 by hand) · nas.folder_drained (v1.262)
 * plus how old the NAS picture is, so a silent NAS scanner is visible from the same call.
 */
const ACTIONS = ['booking.auto_notified_ready', 'booking.notified_ready', 'nas.folder_drained'] as const

export async function GET(request: NextRequest) {
  const allowed =
    internalSecretAllowed(request, 'x-footage-ready-secret',
      ['FOOTAGE_READY_SECRET', 'REMINDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET']) ||
    (await getSession())?.role === 'ADMIN'
  if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sp = new URL(request.url).searchParams
  const since = new Date(sp.get('since') || '')
  if (!Number.isFinite(since.getTime())) {
    return NextResponse.json({ error: 'since=<ISO timestamp> required' }, { status: 400 })
  }
  const limit = Math.min(Math.max(Math.floor(Number(sp.get('limit'))) || 50, 1), 200)

  try {
    // gte + asc + take: a relay that advances its cursor to the last `at` it got never skips a row
    // between pages; the row(s) at exactly that millisecond come back again and the relay drops them by id
    const rows = await prisma.auditLog.findMany({
      where: { action: { in: [...ACTIONS] }, at: { gte: since } },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, at: true, action: true, actorEmail: true, entityId: true, bookingCode: true, changes: true },
    })
    // booking.* rows carry the booking id (survives a regenerated Production ID); NAS rows only the code
    const ids = [...new Set(rows.filter(r => r.action !== 'nas.folder_drained').map(r => r.entityId).filter((v): v is string => !!v))]
    const codes = [...new Set(rows.map(r => r.bookingCode).filter((c): c is string => !!c))]
    const bookings = ids.length || codes.length
      ? await prisma.booking.findMany({
          where: { OR: [{ id: { in: ids } }, { bookingCode: { in: codes } }] },
          select: {
            id: true, bookingCode: true, projectName: true, driveFolders: true,
            program: { select: { name: true } },
            episodes: { orderBy: { sequence: 'asc' }, select: { title: true, program: { select: { name: true } } } },
          },
        })
      : []
    const byId = new Map(bookings.map(b => [b.id, b]))
    const byCode = new Map(bookings.filter(b => b.bookingCode).map(b => [b.bookingCode!, b]))
    const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.thestandard.co'

    const events = rows.map(r => {
      const c = (r.changes || {}) as Record<string, any>
      const b = (r.action !== 'nas.folder_drained' && r.entityId ? byId.get(r.entityId) : undefined) ?? (r.bookingCode ? byCode.get(r.bookingCode) : undefined)
      const box = typeof (b?.driveFolders as any)?.box === 'string' ? (b!.driveFolders as any).box as string : null
      const recipients = Array.isArray(c.recipients) ? c.recipients.filter((x: unknown) => typeof x === 'string' && x.includes('@')) : []
      return {
        id: r.id,
        at: r.at.toISOString(),
        kind: r.action === 'nas.folder_drained' ? 'nas-drained' : r.action === 'booking.notified_ready' ? 'footage-ready-manual' : 'footage-ready',
        code: r.bookingCode,
        title: b ? bookingDisplayName({ projectName: b.projectName, program: b.program, episodes: b.episodes }) : (c.folder ?? null),
        files: typeof c.fileCount === 'number' ? c.fileCount : typeof c.driveFiles === 'number' ? c.driveFiles : null,
        bytes: typeof c.driveBytes === 'number' ? c.driveBytes : null,
        people: recipients.length,
        by: r.action === 'booking.notified_ready' ? r.actorEmail : null,
        verified: typeof c.mediapro === 'string' ? c.mediapro : null,
        emailError: typeof c.emailError === 'string' ? c.emailError : null,
        boxUrl: box ? `https://drive.google.com/drive/folders/${box}` : null,
        url: b ? `${appUrl}/upload?bookingId=${b.id}` : null,
      }
    })

    // the NAS part must not take the footage events down with it — and an unreadable NAS state is said, not hidden
    let nas: Record<string, unknown>
    try {
      const { manifest } = await latestNasState()
      nas = { manifestAt: manifest?.at ?? null, ...nasManifestAge(manifest?.at) }
    } catch (e: any) {
      nas = { manifestAt: null, ageMinutes: null, stale: null, error: e?.message || String(e) }
    }
    return NextResponse.json({ now: new Date().toISOString(), events, more: rows.length === limit, nas })
  } catch (e: any) {
    console.error('[notify-feed] error:', e?.message || e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
