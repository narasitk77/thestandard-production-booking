/**
 * POST /api/internal/shoot-reviews/send — v1.166, reworked in v1.173.
 *
 * Once a job is COMPLETED — which the system decides by itself, see
 * autoCompleteBookings — invite everyone who worked it to rate the other teams
 * and to score their overall satisfaction with how the job was served. Dormant
 * until SHOOT_REVIEW_ENABLED=1, and dryRun by DEFAULT: a survey that mails the
 * whole crew is not something to fire by accident.
 *
 * v1.173 changed WHICH jobs a run picks up. It used to be the single calendar
 * day `delay` days back, which meant a morning the sender did not run skipped
 * those shoots for good. It is now "COMPLETED, and the shoot finished inside the
 * lookback window" — so a missed run is caught up by the next one, and the
 * trigger is the booking's own state rather than a date the run has to hit
 * exactly.
 *
 * Idempotent: the invite row is unique per (booking, email), so re-running sends
 * nothing twice. That is also why the row is created BEFORE the email — a crash
 * mid-send leaves people un-mailed rather than mailed twice, and the next run
 * only picks up whoever has no row yet.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendEmail, isEmailConfigured } from '@/lib/email'
import { logAudit } from '@/lib/audit'
import { recordHeartbeat } from '@/lib/heartbeat'
import { autoCompleteBookings } from '@/lib/booking-complete'
import {
  buildInvites, newInviteToken, reviewsEnabled, reviewDelayDays,
  reviewLookbackDays, reviewMaxBookingsPerRun, dueWindow, nonInvitableEmails,
  buildInviteMail,
} from '@/lib/shoot-review'
import { startOfTodayBangkok } from '@/lib/bangkok-day'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function authorised(request: NextRequest): boolean {
  const want = (process.env.RECONCILE_SECRET || process.env.NEXTAUTH_SECRET || '').trim()
  if (!want) return false
  const got = request.headers.get('x-reconcile-secret') || request.headers.get('x-review-secret') || ''
  return got === want
}

export async function POST(request: NextRequest) {
  if (!authorised(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const sp = new URL(request.url).searchParams
  const dryRun = sp.get('dryRun') !== '0'

  // v1.173 — a DRY RUN is allowed while the feature is off. The whole point of
  // the kill switch is that nobody gets mailed, and deciding whether to flip it
  // requires seeing the batch first; refusing the dry run left the operator
  // choosing blind. Real sends stay gated, and the worker exits on the flag
  // before it ever reaches this route.
  if (!reviewsEnabled() && !dryRun) {
    return NextResponse.json({ skipped: true, reason: 'SHOOT_REVIEW_ENABLED != 1' })
  }

  // v1.166.1 — the day is BANGKOK's, not UTC's. The worker runs in the morning
  // BKK, which is the previous UTC day, so `new Date()` with UTC arithmetic
  // pointed at the wrong calendar day and surveyed the wrong shoots.
  const delay = reviewDelayDays()
  const lookback = reviewLookbackDays()
  const { from, to } = dueWindow(startOfTodayBangkok(), delay, lookback)

  // The trigger is the booking being COMPLETED, and nothing here has to wait for
  // a human to set that: autoCompleteBookings closes any CONFIRMED job whose
  // shoot window has passed. It normally runs lazily on GET /api/bookings, i.e.
  // whenever somebody opens the app — running it here too means the survey does
  // not silently depend on someone having browsed the app that morning.
  //
  // Called on dry runs as well, on purpose: it is ordinary bookkeeping the app
  // performs constantly and it can only ever close a shoot that is already over,
  // so it is not a survey side-effect — but skipping it would make a dry run
  // under-report the batch the real run is about to send.
  let autoCompleted = 0
  try {
    autoCompleted = await autoCompleteBookings()
  } catch (e: any) {
    console.error('[shoot-review] autoCompleteBookings failed (continuing):', e?.message || e)
  }

  // Survey after the LAST shoot day: a multi-day shoot must not get the form
  // while the crew is still on set tomorrow. Oldest first so a backlog drains in
  // order rather than the newest jobs starving the older ones out.
  const bookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      status: 'COMPLETED',
      OR: [
        { shootEndDate: { gte: from, lte: to } },
        { shootEndDate: null, shootDate: { gte: from, lte: to } },
      ],
    },
    orderBy: { shootDate: 'asc' },
    select: {
      id: true, bookingCode: true, shootDate: true, status: true, deletedAt: true,
      producerEmail: true, createdByEmail: true, assignedEmails: true,
      mainVideographerEmail: true, crewRequired: true,
      program: { select: { name: true } },
      outlet: { select: { name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { title: true } },
    },
  })

  const roster = await prisma.teamMember.findMany({ select: { email: true, role: true } }).catch(() => [])
  const rosterRoleByEmail: Record<string, string> = {}
  for (const m of roster) if (m.email) rosterRoleByEmail[m.email.toLowerCase()] = m.role

  const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.xtec9.xyz'
  const maxPerRun = reviewMaxBookingsPerRun()
  let invited = 0, mailed = 0, skippedExisting = 0, worked = 0, deferred = 0
  const errors: string[] = []
  const details: Array<{ code: string | null; invites: number; resend?: number; emails?: string[] }> = []
  let sampleEmail: { to: string; role: string; subject: string; text: string } | null = null
  const skippedRecipients = new Map<string, number>()

  /** Thin adapter over the (pure, tested) copy builder — one call site per body. */
  const composeInvite = (
    b: (typeof bookings)[number],
    raterRole: string,
    targets: string[],
    token: string,
  ) => buildInviteMail({
    what: [b.program?.name, b.episodes[0]?.title].filter(Boolean).join(' · ') || (b.outlet?.name ?? 'งานถ่าย'),
    shootDateTh: new Date(b.shootDate).toLocaleDateString('th-TH-u-ca-gregory', { dateStyle: 'medium' }),
    bookingCode: b.bookingCode,
    raterRole,
    targets,
    url: `${appUrl}/review/${token}`,
  })

  for (const b of bookings) {
    try {
    // Shared mailboxes and outside addresses are filtered out of the ask list.
    // Counted here so a crowd that silently vanished from the batch is visible in
    // the run's own output — the operator has to be able to see that video@ was
    // dropped 18 times, or the numbers look like the crew simply was not there.
    for (const e of nonInvitableEmails(b)) skippedRecipients.set(e, (skippedRecipients.get(e) || 0) + 1)

    const invites = buildInvites(b, rosterRoleByEmail)
    if (invites.length === 0) continue

    const existing = await prisma.shootReviewInvite.findMany({
      where: { bookingId: b.id }, select: { id: true, email: true, token: true, mailedAt: true },
    })
    const byEmail = new Map(existing.map(e => [e.email.toLowerCase(), e]))
    // Someone already invited AND mailed is done. Someone with a row but no
    // mailedAt had their email fail on a previous run — re-send with the SAME
    // token so they never get two different links.
    const fresh = invites.filter(i => !byEmail.has(i.email))
    const retry = invites
      .map(i => ({ inv: i, row: byEmail.get(i.email) }))
      .filter(x => x.row && !x.row.mailedAt)
    skippedExisting += invites.length - fresh.length - retry.length
    if (fresh.length === 0 && retry.length === 0) continue

    // Per-run ceiling. Counted on bookings that actually HAVE work rather than
    // bookings scanned: a lookback window full of already-invited jobs would
    // otherwise spend the whole budget on no-ops and defer the real work
    // forever. Whatever is left over is reported, never dropped silently — the
    // next run picks it up because nothing was written for it.
    if (worked >= maxPerRun) { deferred++; continue }
    worked++

    details.push({ code: b.bookingCode, invites: fresh.length, resend: retry.length, ...(dryRun ? { emails: fresh.map(f => f.email) } : {}) })
    if (dryRun) {
      invited += fresh.length
      // One real specimen from the first booking with work, so "ขอดูตัวอย่างก่อน"
      // is answerable without mailing anyone. The token is the one thing that
      // cannot be shown — it does not exist until a real run mints it.
      if (!sampleEmail && fresh[0]) {
        const c = composeInvite(b, fresh[0].role, fresh[0].targets, '<ลิงก์เฉพาะบุคคล-สร้างตอนส่งจริง>')
        sampleEmail = { to: fresh[0].email, role: fresh[0].role, ...c }
      }
      continue
    }

    const work: Array<{ email: string; role: string; targets: string[]; token: string; inviteId: string | null }> = []
    for (const inv of fresh) {
      // Row first (the unique index is what stops a double invite), but with
      // mailedAt null so a failed send is visibly unfinished and retried.
      const row = await prisma.shootReviewInvite.create({
        data: { bookingId: b.id, email: inv.email, role: inv.role, targets: inv.targets, token: newInviteToken() },
        select: { id: true, token: true },
      })
      invited++
      work.push({ ...inv, token: row.token, inviteId: row.id })
    }
    for (const r of retry) {
      work.push({ email: r.inv.email, role: r.inv.role, targets: r.inv.targets, token: r.row!.token, inviteId: r.row!.id })
    }

    for (const inv of work) {
      if (!isEmailConfigured()) continue
      try {
        await sendEmail({ to: inv.email, ...composeInvite(b, inv.role, inv.targets, inv.token) })
        mailed++
        if (inv.inviteId) {
          await prisma.shootReviewInvite.update({ where: { id: inv.inviteId }, data: { mailedAt: new Date() } })
        }
      } catch (e: any) {
        // Left with mailedAt null on purpose — the next run re-sends this one.
        console.error(`[shoot-review] email to ${inv.email} failed:`, e?.message || e)
        errors.push(`${b.bookingCode}: ${inv.email} — ${e?.message || e}`)
      }
    }
    } catch (e: any) {
      // One bad booking must not abandon the rest of the night's batch.
      console.error(`[shoot-review] booking ${b.bookingCode} failed:`, e?.message || e)
      errors.push(`${b.bookingCode}: ${e?.message || e}`)
    }
  }

  const skipped = Array.from(skippedRecipients.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([email, bookings]) => ({ email, bookings }))
  if (skipped.length > 0) {
    console.log(`[shoot-review] not mailable, skipped: ${skipped.map(s => `${s.email} ×${s.bookings}`).join(', ')}`)
  }

  // A cap that nobody can see reads as "we covered everything".
  if (deferred > 0) {
    console.log(`[shoot-review] ${deferred} booking(s) over the ${maxPerRun}/run cap — deferred to the next run (nothing written for them).`)
  }

  if (!dryRun && invited > 0) {
    // Not entityType 'Booking': the booking-history endpoint matches on that
    // type, and a per-booking review row there is what leaked a rater's team in
    // the first cut of this feature. 'batch' would not match today, but the
    // next person to touch this should not have to know that.
    logAudit({
      actorEmail: 'shoot-review-worker',
      action: 'review.invites_sent',
      entityType: 'ShootReviewInvite',
      entityId: 'batch',
      changes: {
        window: `${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`,
        bookings: details.length, invited, mailed, deferred, autoCompleted,
      },
    })
  }

  if (!dryRun) await recordHeartbeat('shoot-review')
  return NextResponse.json({
    ok: true, dryRun, enabled: reviewsEnabled(),
    ...(dryRun ? { sampleEmail } : {}),
    window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    delayDays: delay, lookbackDays: lookback, maxPerRun,
    autoCompleted, bookingsScanned: bookings.length,
    invited, mailed, skippedExisting, deferred,
    skippedRecipients: skipped,
    errors, emailConfigured: isEmailConfigured(), details,
  })
}
