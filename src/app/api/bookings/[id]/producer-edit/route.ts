/**
 * PATCH /api/bookings/:id/producer-edit
 *
 * Lets the Producer (booking owner) edit the details of THEIR OWN booking
 * while it is still in REQUESTED status. On save, the queue-manager team
 * (Coordinator/Admin) is emailed a summary of what changed.
 *
 * Deliberately separate from the admin PATCH (/api/bookings/[id]) so it does
 * NOT require console access and never touches admin-only or immutable fields:
 *   - immutable (Episode-ID determinants): shootDate, shootEndDate, outlet,
 *     program, episodeId/sequence, bookingCode — never read from the body.
 *   - admin-only: status, category, assignedEmails, adminNotes,
 *     mainVideographerEmail, freelancers — never read from the body.
 * A producer therefore cannot self-approve or reassign; only REQUESTED-stage
 * details change. UI gating is convenience only — this route is the source of
 * truth for authorization.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { sendEmail, isEmailConfigured } from '@/lib/email'
import { FIELD_LABELS, fmt, diffEditable } from '@/lib/producer-edit-fields'

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const existing = await prisma.booking.findUnique({
      where: { id: params.id },
      include: { episodes: true, outlet: true, program: true },
    })
    if (!existing || existing.deletedAt) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }

    // Owner = the booking's creator OR the named producer (case-insensitive;
    // session.email is already lowercased by getSession). Only while REQUESTED.
    const isOwner =
      (existing.createdByEmail || '').toLowerCase() === session.email ||
      (existing.producerEmail || '').toLowerCase() === session.email
    if (!isOwner) {
      return NextResponse.json({ error: 'คุณไม่ใช่เจ้าของงานนี้' }, { status: 403 })
    }
    if (existing.status !== 'REQUESTED') {
      return NextResponse.json(
        { error: 'แก้ไขได้เฉพาะงานที่อยู่ในสถานะ Requested เท่านั้น — งานนี้ถูกดำเนินการไปแล้ว' },
        { status: 409 },
      )
    }

    const body = await request.json()
    // PRODUCER-EDITABLE WHITELIST ONLY. Anything not listed here is ignored.
    const {
      callTime, estimatedWrap, shootType, locationName, producer,
      creative, crewRequired, cameraCount, micCount, vanCount,
      specialEquipment, agencyRef, notes, episodeTitles,
    } = body

    const booking = await prisma.$transaction(async (tx) => {
      // Episode TITLE edits only — never episodeId or sequence.
      if (Array.isArray(episodeTitles)) {
        for (const ep of episodeTitles) {
          if (!ep?.id || typeof ep.title !== 'string') continue
          if (!existing.episodes.find(e => e.id === ep.id)) continue
          await tx.episode.update({ where: { id: ep.id }, data: { title: ep.title.trim() } })
        }
      }
      return tx.booking.update({
        where: { id: params.id },
        data: {
          ...(callTime && { callTime }),
          ...(estimatedWrap !== undefined && { estimatedWrap: estimatedWrap || null }),
          ...(shootType && { shootType }),
          ...(locationName !== undefined && { locationName: locationName || null }),
          ...(producer && { producer }),
          ...(Array.isArray(creative) && { creative }),
          ...(Array.isArray(crewRequired) && { crewRequired }),
          ...(cameraCount !== undefined && { cameraCount: cameraCount === null || cameraCount === '' ? null : Math.max(0, parseInt(cameraCount, 10) || 0) }),
          ...(micCount !== undefined && { micCount: micCount === null || micCount === '' ? null : Math.max(0, parseInt(micCount, 10) || 0) }),
          ...(vanCount !== undefined && { vanCount: vanCount === null || vanCount === '' ? 0 : Math.max(0, Math.min(20, parseInt(vanCount, 10) || 0)) }),
          ...(Array.isArray(specialEquipment) && { specialEquipment: specialEquipment.filter((x: unknown) => typeof x === 'string' && x.trim() !== '') }),
          ...(agencyRef !== undefined && { agencyRef: agencyRef || null }),
          ...(notes !== undefined && { notes: notes || null }),
        },
        include: { episodes: true, outlet: true, program: true },
      })
    })

    // What changed (booking fields + episode titles), for audit + email.
    const fieldChanges = diffEditable(existing, booking)
    const titleChanges = booking.episodes
      .map(e => {
        const was = existing.episodes.find(x => x.id === e.id)
        return was && was.title !== e.title ? `${e.episodeId}: ${fmt(was.title)} → ${fmt(e.title)}` : null
      })
      .filter(Boolean) as string[]

    const hasChanges = Object.keys(fieldChanges).length > 0 || titleChanges.length > 0
    if (hasChanges) {
      logAudit({
        actorEmail: session.email,
        action: 'booking.producer_edit',
        entityType: 'Booking',
        entityId: booking.id,
        bookingCode: booking.bookingCode,
        changes: { ...fieldChanges, ...(titleChanges.length ? { episodeTitles: titleChanges } : {}) },
      })

      // Email the producer-update inbox (best-effort — never fails the save).
      // v1.128 — per ops (2026-07-07): these used to fan out to EVERY active
      // coordinator/manager/support/admin; now they go to one inbox only.
      // Override with PRODUCER_UPDATE_NOTIFY_EMAIL (comma-separated).
      if (isEmailConfigured()) {
        try {
          const recipients = (process.env.PRODUCER_UPDATE_NOTIFY_EMAIL || 'narasit.k@thestandard.co')
            .split(',').map(s => ({ email: s.trim() })).filter(r => r.email)
          if (recipients.length > 0) {
            const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.xtec9.xyz'
            const code = booking.bookingCode || booking.id
            const shootDate = new Date(booking.shootDate).toISOString().slice(0, 10)
            const changeLines = [
              ...Object.entries(fieldChanges).map(([k, { from, to }]) => `${FIELD_LABELS[k] || k}: ${fmt(from)} → ${fmt(to)}`),
              ...titleChanges.map(t => `Episode title — ${t}`),
            ].join('\n')
            const text = `Producer แก้ไขรายละเอียดงาน (สถานะ Requested)

Booking: ${code}
${booking.outlet.name} · ${booking.program.name} · ${shootDate}
Producer: ${booking.producer} (${session.email})

รายการที่แก้ไข:
${changeLines}

ดูรายละเอียด: ${appUrl}/dashboard/${booking.id}

THE STANDARD Production Booking`
            await sendEmail({ to: recipients.map(r => r.email), subject: `[แก้ไขงาน] ${code}`, text })
          }
        } catch (e: any) {
          console.error('[producer-edit] email failed:', e?.message || e)
        }
      }
    }

    return NextResponse.json({ booking, changed: hasChanges })
  } catch (error) {
    console.error('PATCH /api/bookings/[id]/producer-edit error:', error)
    return NextResponse.json({ error: 'Failed to save changes' }, { status: 500 })
  }
}
