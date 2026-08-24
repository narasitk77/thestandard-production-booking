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
import { quRuleEnabled, isAcceptableQuRef, normalizeQuRef, quRefRejectMessage } from '@/lib/agency-ref'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { producerEditMode } from '@/lib/producer-edit-access'
import { logAudit } from '@/lib/audit'
import { sendEmail, isEmailConfigured } from '@/lib/email'
import { FIELD_LABELS, fmt, diffEditable } from '@/lib/producer-edit-fields'
import { isValidHHMM } from '@/lib/shoot-window'
// v1.150.1 — post-approval location edits must flow to the calendar event and
// the _SHOOT.txt marker (same recipe as the admin PATCH's live-edit path).
import { updateCalendarEventDetails } from '@/lib/google-calendar'
import { refreshShootMarker } from '@/lib/shoot-marker'
import { hasDriveCredentials } from '@/lib/google-drive'

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
    // v1.193 — ทีมคิว (Admin/Coordinator) ก็ผ่านด่านนี้ได้ ไม่ใช่การเพิ่มอำนาจ:
    // เขาแก้ทุกฟิลด์ผ่าน PATCH /api/bookings/:id ได้อยู่แล้ว (hasConsoleAccess
    // เหมือนกัน) แต่ "ไม่มีหน้าจอไหนเลย" ที่แก้ Agency Ref ของใบที่มีอยู่ได้ →
    // งานที่ย้ายระบบมา (producer เดิมไม่มีในระบบ / ไม่กลับมาแก้) จึงค้างไม่มีเลข
    // QU ตลอดกาล และไม่มีใครเติมแทนได้ (operator 2026-08-24)
    const isQueueTeam = hasConsoleAccess(session.role)
    if (!isOwner && !isQueueTeam) {
      return NextResponse.json({ error: 'คุณไม่ใช่เจ้าของงานนี้' }, { status: 403 })
    }
    // v1.150.1 — two edit modes by status:
    //   REQUESTED  → full producer whitelist (unchanged).
    //   CONFIRMED  → LOCATION ONLY: the shoot location (often a Google-Maps
    //                link) routinely changes after approval, and producers had
    //                no way to paste the updated link — admins were pinged for
    //                every venue-pin change. Everything else stays locked.
    //   COMPLETED  → AGENCY REF ONLY (v1.188): เลข QU มักมาจากฝ่ายจัดซื้อ/ลูกค้า
    //                **หลังถ่ายเสร็จ** ถ้าล็อกไว้ เจ้าของงานก็ไม่มีทางเติมเลขจริง
    //                ได้เลย แล้วบอทเตือนก็จะจี้ไปตลอดกาลโดยไม่มีทางออก
    //                (operator: "ให้เจ้าของงานเข้าแก้ไข Agency ref ได้ภายหลังด้วย")
    // CANCELLED stays uneditable — งานที่เลิกแล้วไม่ต้องตั้งเบิก
    // v1.193 — กฎเดียวกับที่ UI ใช้ (src/lib/producer-edit-access.ts) route ยังเป็น
    // source of truth ของ authorization เหมือนเดิม เพียงแต่เลิกเขียนกฎซ้ำ
    const mode = producerEditMode({
      status: existing.status,
      category: existing.category,
      deleted: !!existing.deletedAt,
      authorized: true, // ผ่านด่านเจ้าของ/ทีมคิวมาแล้วข้างบน
    })
    if (mode === 'none') {
      return NextResponse.json(
        {
          error: existing.status === 'CANCELLED'
            ? 'งานนี้ยกเลิกแล้ว แก้ไขไม่ได้'
            : 'งานนี้อยู่ในสถานะที่แก้ไขไม่ได้แล้ว',
        },
        { status: 409 },
      )
    }
    const locationOnly = mode === 'location'
    const agencyRefOnly = mode === 'agencyRef'

    const body = await request.json()
    // PRODUCER-EDITABLE WHITELIST ONLY. Anything not listed here is ignored.
    // In location-only mode every other field is dropped before destructuring.
    // v1.188 — CONFIRMED เปิดให้แก้ Agency Ref ได้ด้วย (เดิมสถานที่อย่างเดียว)
    // และ COMPLETED เปิดเฉพาะ Agency Ref
    const src = agencyRefOnly
      ? { agencyRef: body?.agencyRef }
      : locationOnly
        ? { locationName: body?.locationName, agencyRef: body?.agencyRef }
        : body
    const {
      callTime, estimatedWrap, shootType, locationName, producer,
      creative, crewRequired, cameraCount, micCount, vanCount,
      specialEquipment, agencyRef, notes, episodeTitles,
    } = src

    // v1.161 — กฏ QU (เหมือน create/PATCH): งาน Agency (Advertorial) แก้ Agency ref
    // ได้เฉพาะรูปแบบ QU. v1.183 — ตัวยึด "1234" (ยังไม่มีเลข QU) ผ่านได้ด้วย
    let agencyRefValidated: string | null = agencyRef || null
    // v1.188 — ทุกบ้าน ไม่ใช่แค่ AGN
    if (agencyRef !== undefined && agencyRef && quRuleEnabled()
        && existing.category === 'ADVERTORIAL') {
      if (!isAcceptableQuRef(agencyRef)) {
        return NextResponse.json({ error: quRefRejectMessage(agencyRef) }, { status: 400 })
      }
      agencyRefValidated = normalizeQuRef(agencyRef)
    }

    // v1.146 review fix — same HH:MM guard as createBookingFromPayload.
    if (callTime && !isValidHHMM(callTime)) {
      return NextResponse.json({ error: `Invalid callTime "${callTime}" — must be 24h HH:MM (e.g. 09:00)` }, { status: 400 })
    }
    if (estimatedWrap != null && estimatedWrap !== '' && !isValidHHMM(estimatedWrap)) {
      return NextResponse.json({ error: `Invalid estimatedWrap "${estimatedWrap}" — must be 24h HH:MM (e.g. 18:00)` }, { status: 400 })
    }

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
          ...(agencyRef !== undefined && { agencyRef: agencyRefValidated }),
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

    // v1.150.1 — a location change on a CONFIRMED booking must reach the
    // surfaces the crew actually reads: the Google Calendar event and the
    // Drive `_SHOOT.txt` marker. Same fire-and-forget recipe as the admin
    // PATCH (a sync blip must never fail the save; nightly jobs backstop).
    if (locationOnly && fieldChanges.locationName) {
      if (booking.calendarEventId) {
        updateCalendarEventDetails(booking.calendarEventId, booking).catch(e =>
          console.error('[producer-edit] calendar details update failed (non-fatal):', e?.message || e))
      }
      if (hasDriveCredentials()) {
        refreshShootMarker(booking).catch(e =>
          console.error('[producer-edit] marker refresh failed (non-fatal):', e?.message || e))
      }
    }

    if (hasChanges) {
      logAudit({
        actorEmail: session.email,
        action: 'booking.producer_edit',
        entityType: 'Booking',
        entityId: booking.id,
        bookingCode: booking.bookingCode,
        changes: {
          ...fieldChanges,
          ...(titleChanges.length ? { episodeTitles: titleChanges } : {}),
          // v1.193 — แยกให้ชัดว่าเจ้าของงานแก้เอง หรือทีมคิวแก้แทน
          ...(isOwner ? {} : { onBehalfOfOwner: true, actorRole: session.role }),
        },
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
            // v1.188 — โหมดเพิ่มมา ป้ายต้องตรงกับสิ่งที่แก้ได้จริง ไม่งั้นเมลบอกว่า
            // "แก้สถานที่" ทั้งที่คนแก้เลข QU
            const modeLabel = agencyRefOnly
              ? 'Agency Ref (งานถ่ายจบแล้ว)'
              : locationOnly
                ? 'สถานที่ / Agency Ref (งาน Confirmed แล้ว)'
                : 'รายละเอียดงาน (สถานะ Requested)'
            const text = `Producer แก้ไข${modeLabel}

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
