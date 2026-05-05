import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendAssignmentEmail } from '@/lib/email'
import { updateBookingRow } from '@/lib/google-sheets'
import { requireAdmin } from '@/lib/session'
import { syncBookingOT } from '@/lib/ot-sync'
import { format } from 'date-fns'
import { getToken } from 'next-auth/jwt'

function cleanEmailList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .filter((email): email is string => typeof email === 'string')
      .map(email => email.trim())
      .filter(Boolean)
  ))
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireAdmin()
    if (!session) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }
    const authToken = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET })
    const senderAccessToken = typeof authToken?.accessToken === 'string' ? authToken.accessToken : null
    const { assignedEmails, adminNotes } = await request.json()
    const emailRecipients = cleanEmailList(assignedEmails)

    const existing = await prisma.booking.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Status logic: don't downgrade CONFIRMED bookings during re-assign.
    // REQUESTED → ASSIGNED (was unassigned, now has crew).
    // ASSIGNED stays ASSIGNED (re-assignment).
    // CONFIRMED stays CONFIRMED (re-assignment after approve).
    const nextStatus = existing.status === 'CONFIRMED' ? 'CONFIRMED' : 'ASSIGNED'

    const booking = await prisma.booking.update({
      where: { id: params.id },
      data: {
        assignedEmails: emailRecipients,
        adminNotes: adminNotes || null,
        status: nextStatus,
      },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' } },
      },
    })

    // Fire-and-forget: DB save is done, return to the user immediately.
    // Emails send in background — failures are logged server-side only.
    Promise.allSettled(
      emailRecipients.map((email) =>
        sendAssignmentEmail({
          to: email,
          toName: email.split('@')[0],
          bookingId: booking.id,
          outletName: booking.outlet.name,
          programName: booking.program.name,
          shootDate: format(new Date(booking.shootDate), 'yyyy-MM-dd'),
          callTime: booking.callTime,
          estimatedWrap: booking.estimatedWrap,
          shootType: booking.shootType,
          locationName: booking.locationName,
          producer: booking.producer,
          episodes: booking.episodes,
          notes: booking.notes,
          adminNotes: booking.adminNotes,
          senderAccessToken,
          senderEmail: session.email,
        }).catch(e => console.error(`Email to ${email} failed:`, e?.message || e))
      )
    ).catch(() => {})

    if (booking.sheetRowIndex) {
      updateBookingRow(booking.sheetRowIndex, {
        assignedEmails: emailRecipients.join(', '),
        status: nextStatus,
      }).catch(e => console.error('updateBookingRow error:', e?.message || e))
    }

    syncBookingOT(booking.id).catch(e => console.error('syncBookingOT error:', e))

    return NextResponse.json({
      booking,
      queued: emailRecipients.length,
    })
  } catch (error) {
    console.error('POST /api/admin/[id]/assign error:', error)
    return NextResponse.json({ error: 'Failed to assign' }, { status: 500 })
  }
}
