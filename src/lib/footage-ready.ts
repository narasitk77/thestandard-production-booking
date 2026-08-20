/**
 * Auto "footage ready" notification (v1.147) — the automated counterpart of the
 * manual 📣 notify-ready button. A supervised worker sweeps recent bookings and,
 * once a booking's footage looks COMPLETE AND SETTLED, emails the folder links
 * automatically (audience configurable) — exactly once per booking.
 *
 * "Ready" = ALL of:
 *   a) eligible      — CONFIRMED/COMPLETED, not deleted, no cancel request,
 *                      has a bookingCode, not a photo-album booking
 *   b) shoot over    — isShootOver() (Bangkok time, honors shootEndDate)
 *   c) no in-flight  — zero PENDING/UPLOADING Upload rows fresher than 24h
 *                      (older = abandoned browser tab, must not block forever)
 *   d) NAS drained   — the NAS queue for this code is absent or lastPending=0
 *   e) footage exists— fresh Drive walk (getCachedFootagePayload refresh:true)
 *                      sees >0 folders and >0 files. The Drive walk is the ONLY
 *                      signal that covers BOTH delivery paths (browser uploads
 *                      AND NAS→video-merge, which creates no Upload rows)
 *   f) settled       — fileCount+totalBytes unchanged for FOOTAGE_READY_SETTLE_MS
 *                      (default 2 h — covers the "dump card 1 → travel/dinner →
 *                      dump card 2" gap) across sweeps, so a multi-batch card
 *                      dump doesn't fire after the first batch
 *
 * Send-once: Booking.readyNotifiedAt (stamped here AND by the manual notify-ready
 * route, so a manual 📣 suppresses the auto email). deliveredAt-null is also
 * required — if crew already pressed ส่งงาน the producer has the report.
 * Settle state persists in Booking.readySnapshot so restarts lose nothing.
 *
 * Rollout guard: only bookings whose shoot ended within FOOTAGE_READY_LOOKBACK_DAYS
 * (default 3) are ever considered — the first production run cannot blast the
 * backlog. The worker itself is OFF until FOOTAGE_READY_WORKER_ENABLED=1.
 */
import { prisma } from './db'
import { logAudit } from './audit'
import { sendEmail, isEmailConfigured } from './email'
import { notifyDiscord, notifyEmailDigest } from './notify'
import { getCachedFootagePayload, type CachedFootagePayload, type BookingForFootagePayload } from './footage-folders'
import { isPhotoAlbumBooking } from './outlet-folders'
import { isShootOver } from './shoot-window'
import { latestNasState } from './nas-sync'
import { PHOTO_ALBUM_EPISODE_CODE } from './outlet-folders'
import { formatBytes } from './footage-report'
import { bookingDisplayName } from './display'

const DAY = 86_400_000

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export type FootageReadyAudience = 'producer' | 'team' | 'everyone' | 'admin'

export function footageReadyAudience(): FootageReadyAudience {
  const v = (process.env.FOOTAGE_READY_AUDIENCE || '').trim().toLowerCase()
  return v === 'everyone' || v === 'admin' || v === 'team' ? v : 'producer'
}

/** Domains that count as "our staff" for the `team` audience. */
export function footageReadyInternalDomains(): string[] {
  const raw = process.env.FOOTAGE_READY_INTERNAL_DOMAINS?.trim()
  if (!raw) return ['thestandard.co']
  const list = raw.split(',').map(d => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
  return list.length > 0 ? list : ['thestandard.co']
}

/**
 * v1.179 — `team` = staff only. Same list as `everyone` minus anyone outside our
 * domains, because assignedEmails carries freelancers' PERSONAL addresses and the
 * operator did not want a one-day freelancer mailed a Drive link for every shoot
 * they ever touched. Shared boxes (video@, sound@) stay IN — unlike the review
 * invites, where a shared inbox was a credential problem, here it is simply how
 * "the camera team" is reached.
 *
 * Exactly one '@' required. Splitting on the LAST one would read
 * `a@b@thestandard.co` as internal — same trap already paid for in
 * isInvitableEmail (v1.173.1).
 */
export function isInternalEmail(email: string, domains: string[] = footageReadyInternalDomains()): boolean {
  const parts = (email || '').trim().toLowerCase().split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false
  return domains.includes(parts[1])
}

/**
 * Who gets the "footage พร้อม" mail for one booking.
 *
 * v1.178 — the operator's instruction was "ไม่ควรส่งให้ผมคนเดียว ควรส่งให้ทีมงานด้วย":
 * the team is to be ADDED, not swapped in. Before this, moving the audience off
 * 'admin' silently REMOVED his copy — the producer/everyone branch never touched
 * the digest — so the config change that answers the complaint would also have
 * hidden the feature from the one person who watches it.
 *
 *   people — one mail EACH (assignedEmails can carry a freelancer's personal
 *            address, so the caller must never put them in a shared To:)
 *   digest — send the admin digest as well; suppressed when the admin is already
 *            a named recipient so nobody is mailed the same thing twice
 */
export function footageReadyRecipients(
  audience: FootageReadyAudience,
  b: { producerEmail?: string | null; createdByEmail?: string | null; assignedEmails?: string[] | null },
  adminEmail?: string | null,
): { people: string[]; digest: boolean } {
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
  const admin = clean(adminEmail)
  if (audience === 'admin') return { people: [], digest: true }

  const raw =
    audience === 'everyone' || audience === 'team'
      ? [b.producerEmail, b.createdByEmail, ...(b.assignedEmails || [])]
      : [b.producerEmail]
  let people = Array.from(new Set(raw.map(clean).filter(e => e.includes('@'))))
  if (audience === 'team') people = people.filter(e => isInternalEmail(e))
  return { people, digest: !!admin && !people.includes(admin) }
}

// ── Pure settle logic (unit-tested) ────────────────────────────────────────

export type ReadySnapshot = { fileCount: number; totalBytes: number; at: string }

/** Coerce the Booking.readySnapshot JSON blob; malformed → null (restart timer). */
export function parseReadySnapshot(json: unknown): ReadySnapshot | null {
  const s = json as Partial<ReadySnapshot> | null | undefined
  if (!s || typeof s !== 'object') return null
  if (typeof s.fileCount !== 'number' || typeof s.totalBytes !== 'number' || typeof s.at !== 'string') return null
  if (!Number.isFinite(new Date(s.at).getTime())) return null
  return { fileCount: s.fileCount, totalBytes: s.totalBytes, at: s.at }
}

/**
 * Gate (f): the footage counts must be IDENTICAL to a snapshot taken at least
 * `settleMs` ago. Counts changed (or first sighting) → restart the timer by
 * writing a fresh snapshot (`write`); unchanged but young → keep waiting with
 * the existing snapshot (write:null, no DB touch).
 */
export function evaluateSettle(
  current: { fileCount: number; totalBytes: number },
  snapshot: ReadySnapshot | null,
  now: Date,
  settleMs: number,
): { settled: boolean; write: ReadySnapshot | null } {
  if (snapshot && snapshot.fileCount === current.fileCount && snapshot.totalBytes === current.totalBytes) {
    const age = now.getTime() - new Date(snapshot.at).getTime()
    return { settled: age >= settleMs, write: null }
  }
  return { settled: false, write: { fileCount: current.fileCount, totalBytes: current.totalBytes, at: now.toISOString() } }
}

/**
 * v1.179 — the order the capped Drive walks are handed out in.
 *
 * The bug this closes: `findMany` had no `orderBy` at all, so Postgres returned
 * the same rows in the same order every sweep and `slice(0, MAX_PER_RUN)` handed
 * the budget to the same five bookings forever. Proven against prod — three
 * consecutive dry runs walked an identical five and deferred an identical four.
 * Worse, the five squatters were bookings that can never have footage (THE
 * STANDARD NOW ×2, an event, a lighting-only job): they are never notified, so
 * they are never stamped, so they held the queue for the whole lookback window
 * and the shoots behind them were never walked ONCE — not "notified late",
 * never notified at all, because they aged out of the window still unwalked.
 *
 * least-recently-walked first, never-walked at the very front (a booking that
 * just became eligible jumps the queue, which is what people are waiting for),
 * newest shoot as the tie-break.
 */
export function orderForWalk<T extends { readyCheckedAt?: Date | null; shootDate: Date | string }>(rows: T[]): T[] {
  const checked = (r: T) => (r.readyCheckedAt ? new Date(r.readyCheckedAt).getTime() : -1)
  const shot = (r: T) => new Date(r.shootDate).getTime()
  return [...rows].sort((a, b) => checked(a) - checked(b) || shot(b) - shot(a))
}

// ── Scan ────────────────────────────────────────────────────────────────────

export type FootageReadyScanResult = {
  dryRun: boolean
  audience: FootageReadyAudience
  scanned: number            // candidates from the DB window
  eligible: number           // survivors of the JS gates (shoot over, no in-flight, NAS drained)
  walked: number             // Drive walks actually performed this sweep
  deferred: number           // eligible but beyond MAX_PER_RUN — picked up next sweep
  deferredCodes: string[]    // v1.179 — WHICH ones. A bare count sent us back to
                             // the calendar to guess who was starved; never again.
  notified: string[]         // booking codes notified this sweep
  settling: string[]         // codes waiting out the settle window
  skipped: Array<{ code: string; reason: string }>
  errors: Array<{ code: string; error: string }>
}

// `program` is widened here (the base type has name only) so the photo-album
// gate can read the BOOKING's program code, not just each episode's.
type CandidateRow = Omit<BookingForFootagePayload, 'program'> & {
  program: { name: string; code?: string | null }
  id: string
  bookingCode: string | null
  status: string
  shootDate: Date
  shootEndDate: Date | null
  estimatedWrap: string | null
  callTime: string
  readySnapshot: unknown
  producer: string
  producerEmail: string | null
  createdByEmail: string | null
  assignedEmails: string[]
  outlet: { code: string; name: string }
  episodes: Array<{ episodeId: string | null; sequence: number; title: string | null; program: { name: string; code: string } | null }>
}

export async function runFootageReadyScan(opts: { dryRun?: boolean } = {}): Promise<FootageReadyScanResult> {
  const dryRun = !!opts.dryRun
  const now = new Date()
  const audience = footageReadyAudience()
  const lookbackDays = envInt('FOOTAGE_READY_LOOKBACK_DAYS', 3)
  const settleMs = envInt('FOOTAGE_READY_SETTLE_MS', 2 * 60 * 60_000)
  const maxPerRun = envInt('FOOTAGE_READY_MAX_PER_RUN', 5)
  const since = new Date(now.getTime() - lookbackDays * DAY)

  const result: FootageReadyScanResult = {
    dryRun, audience, scanned: 0, eligible: 0, walked: 0, deferred: 0, deferredCodes: [],
    notified: [], settling: [], skipped: [], errors: [],
  }

  const rows = await prisma.booking.findMany({
    where: {
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      deletedAt: null,
      cancelRequestedAt: null,
      bookingCode: { not: null },
      readyNotifiedAt: null,
      deliveredAt: null, // crew already ส่งงาน → producer already has the report
      OR: [{ shootDate: { gte: since } }, { shootEndDate: { gte: since } }],
    },
    select: {
      id: true, bookingCode: true, status: true, driveFolders: true,
      projectId: true, projectName: true, category: true, crewRequired: true,
      producer: true, producerEmail: true, createdByEmail: true, assignedEmails: true,
      callTime: true, shootDate: true, shootEndDate: true, estimatedWrap: true,
      readySnapshot: true, readyCheckedAt: true,
      outlet: { select: { code: true, name: true } },
      program: { select: { name: true, code: true } },
      episodes: {
        orderBy: { sequence: 'asc' },
        select: { episodeId: true, sequence: true, title: true, program: { select: { name: true, code: true } } },
      },
    },
  }) as unknown as CandidateRow[]
  result.scanned = rows.length
  if (rows.length === 0) return result

  // Gate (c): one groupBy covers every candidate — a PENDING/UPLOADING Upload
  // row fresher than 24h means the crew is still actively uploading.
  const freshInFlight = await prisma.upload.groupBy({
    by: ['bookingId'],
    where: {
      bookingId: { in: rows.map(r => r.id) },
      status: { in: ['PENDING', 'UPLOADING'] },
      updatedAt: { gte: new Date(now.getTime() - DAY) },
    },
    _count: true,
  })
  const uploading = new Set(freshInFlight.map(u => u.bookingId))

  // Gate (d): NAS queue state, one read for the whole sweep.
  const nasStatuses = (await latestNasState().catch(() => ({ statuses: {} as Record<string, any> }))).statuses || {}

  const eligible: CandidateRow[] = []
  for (const b of rows) {
    const code = b.bookingCode as string
    if (!isShootOver({ shootDate: b.shootDate, shootEndDate: b.shootEndDate, estimatedWrap: b.estimatedWrap }, now)) {
      result.skipped.push({ code, reason: 'shoot-not-over' }); continue
    }
    // v1.179 — also honour the BOOKING's own program. isPhotoAlbumBooking reads
    // the EPISODES' program code, and WLT-OTH-260819-01 (a Photo Album booking,
    // lighting only) slipped through it every sweep because its episode code is
    // 'OTH' — burning a walk slot on a job that by definition has no video.
    if (isPhotoAlbumBooking(b.episodes) || (b.program?.code || '').toUpperCase() === PHOTO_ALBUM_EPISODE_CODE) {
      result.skipped.push({ code, reason: 'photo-album' }); continue
    }
    if (uploading.has(b.id)) {
      result.skipped.push({ code, reason: 'uploads-in-flight' }); continue
    }
    const nas = nasStatuses[code]
    if (nas && (nas.lastPending || 0) > 0) {
      result.skipped.push({ code, reason: 'nas-still-sending' }); continue
    }
    eligible.push(b)
  }
  result.eligible = eligible.length

  // Cap the expensive Drive walks per sweep; the rest are picked up next run —
  // which only holds because orderForWalk rotates the queue (see its comment).
  const ordered = orderForWalk(eligible)
  const toWalk = ordered.slice(0, maxPerRun)
  result.deferred = ordered.length - toWalk.length
  result.deferredCodes = ordered.slice(maxPerRun).map(r => r.bookingCode as string)

  for (const b of toWalk) {
    const code = b.bookingCode as string
    try {
      // Always refresh on the live path: the system-wide video-merge worker moves
      // files WITHOUT clearing footageCache, so the cache can be stale-empty.
      // dryRun stays read-only (cached payload; refresh only if cache is empty-shaped).
      let payload = await getCachedFootagePayload(b, { refresh: !dryRun })
      if (dryRun && payload.folders.length === 0) payload = await getCachedFootagePayload(b, { refresh: false })
      result.walked++
      // Stamp BEFORE the outcome branches: a walk that found nothing still has to
      // move this booking to the back of the queue, or it squats forever (that is
      // exactly the bug — see orderForWalk).
      if (!dryRun) {
        await prisma.booking.update({ where: { id: b.id }, data: { readyCheckedAt: now } }).catch(() => {})
      }
      if (payload.folders.length === 0 || payload.fileCount === 0) {
        result.skipped.push({ code, reason: 'no-footage' })
        continue
      }
      const decision = evaluateSettle(
        { fileCount: payload.fileCount, totalBytes: payload.folders.reduce((n, f) => n + f.totalBytes, 0) },
        parseReadySnapshot(b.readySnapshot),
        now,
        settleMs,
      )
      if (!decision.settled) {
        result.settling.push(code)
        if (!dryRun && decision.write) {
          await prisma.booking.update({ where: { id: b.id }, data: { readySnapshot: decision.write } }).catch(() => {})
        }
        continue
      }

      if (dryRun) {
        result.notified.push(code) // would notify
        continue
      }

      const sent = await sendFootageReadyNotification(b, payload, audience)
      if (!sent.delivered) {
        result.errors.push({ code, error: sent.error || 'no delivery channel succeeded' })
        continue // no stamp — retried next sweep
      }
      // Send-once stamp — CAS so a racing manual 📣 doesn't double-stamp.
      await prisma.booking.updateMany({
        where: { id: b.id, readyNotifiedAt: null },
        data: { readyNotifiedAt: new Date() },
      })
      logAudit({
        actorEmail: 'footage-ready-worker',
        action: 'booking.auto_notified_ready',
        entityType: 'Booking',
        entityId: b.id,
        bookingCode: code,
        changes: { audience, recipients: sent.recipients, folderCount: payload.folders.length, fileCount: payload.fileCount, emailError: sent.error },
      })
      result.notified.push(code)
    } catch (e: any) {
      result.errors.push({ code, error: e?.message || String(e) })
    }
  }

  return result
}

// ── Delivery ────────────────────────────────────────────────────────────────

async function sendFootageReadyNotification(
  b: CandidateRow,
  payload: CachedFootagePayload,
  audience: FootageReadyAudience,
): Promise<{ delivered: boolean; recipients: string[]; error: string | null }> {
  const code = b.bookingCode as string
  const show = bookingDisplayName({ projectName: b.projectName, program: b.program, episodes: b.episodes })
  const shootDate = new Date(b.shootDate).toISOString().slice(0, 10)
  const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.xtec9.xyz'
  const totalBytes = payload.folders.reduce((n, f) => n + f.totalBytes, 0)
  const folderLines = payload.folders.map(f => `• ${f.label} — ${f.fileCount} ไฟล์ · ${formatBytes(f.totalBytes)}\n  ${f.url}`).join('\n')
  const subject = `[Footage พร้อม] ${code} — ${show}`
  // Same body shape as the manual 📣 notify-ready, marked as automatic.
  const text = `footage ของ ${code} พร้อมแล้ว ✅ (แจ้งอัตโนมัติโดยระบบ)
${b.outlet.name} · ${show} · ${shootDate} ${b.callTime}

— โฟลเดอร์ footage (${payload.folders.length} โฟลเดอร์ · ${payload.fileCount} ไฟล์ · ${formatBytes(totalBytes)}) —
${folderLines}
${payload.bookingFolderUrl ? `\nเปิดกล่องงานทั้งหมด: ${payload.bookingFolderUrl}` : ''}

เปิดในระบบ: ${appUrl}/upload?bookingId=${b.id}

THE STANDARD Production Booking`

  const discordLine = `📣 auto-แจ้งไฟล์พร้อม: ${code} — ${show} (${payload.fileCount} ไฟล์ · ${formatBytes(totalBytes)})`

  if (audience === 'admin') {
    const emailOk = await notifyEmailDigest(subject, text)
    const discordOk = await notifyDiscord(discordLine)
    return { delivered: emailOk || discordOk, recipients: ['admin-digest'], error: emailOk || discordOk ? null : 'admin digest + discord both unavailable' }
  }

  const { people: recipients, digest: alsoDigest } = footageReadyRecipients(
    audience,
    b,
    process.env.REMINDER_ADMIN_EMAIL || process.env.EMAIL_FROM,
  )

  if (recipients.length === 0) {
    // No producer email — tell the admin instead of retrying forever.
    // Caller stamps readyNotifiedAt, so this warns exactly once per booking.
    const warned = await notifyEmailDigest(`⚠️ ${subject} — ไม่มีอีเมล producer`, `${code} footage พร้อมแล้ว แต่ booking ไม่มี producerEmail ให้แจ้ง\n\n${text}`)
    const discordOk = await notifyDiscord(`⚠️ ${discordLine} — ไม่มีอีเมล producer ให้แจ้ง`)
    return { delivered: warned || discordOk, recipients: [], error: 'no producer email' }
  }

  let emailed = 0
  let error: string | null = null
  if (isEmailConfigured()) {
    // One email PER recipient — assignedEmails can include external freelancers'
    // personal addresses (same privacy rule as the manual notify-ready).
    const results = await Promise.allSettled(recipients.map(to => sendEmail({ to: [to], subject, text })))
    emailed = results.filter(r => r.status === 'fulfilled').length
    if (emailed < results.length) error = `${results.length - emailed}/${results.length} ส่งไม่สำเร็จ`
  } else {
    error = 'email not configured'
  }
  // The operator keeps his overview copy on top of the team's mails (v1.178).
  // Best-effort and never counted as delivery: if the digest is the ONLY thing
  // that got through, the team still did not hear about it, and reporting that
  // as success is how the old "ส่งให้ผมคนเดียว" state stayed invisible.
  if (alsoDigest) await notifyEmailDigest(subject, text)

  // Discord summary is best-effort on top of email; it also serves as the
  // fallback channel when email is unavailable.
  const discordOk = await notifyDiscord(`${discordLine} → ${emailed}/${recipients.length} อีเมล`)

  return {
    delivered: emailed > 0 || (!isEmailConfigured() && discordOk),
    recipients: alsoDigest ? [...recipients, 'admin-digest'] : recipients,
    error,
  }
}
