import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendAssignmentEmail } from '@/lib/email'
import { updateBookingRow } from '@/lib/google-sheets'
import { requireAdmin } from '@/lib/session'
import { syncBookingOT } from '@/lib/ot-sync'
import { format } from 'date-fns'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!(await requireAdmin())) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }
    const { assignedEmails, adminNotes } = await request.json()

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
        assignedEmails: assignedEmails || [],
        adminNotes: adminNotes || null,
        status: nextStatus,
      },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' } },
      },
    })

    // Send email to each assigned crew member
    const emailResults: string[] = []
    for (const email of (assignedEmails || [])) {
      try {
        const name = email.split('@')[0]
        await sendAssignmentEmail({
          to: email,
          toName: name,
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
        })
        emailResults.push(`✓ ${email}`)
      } catch (e) {
        console.error(`Failed to send email to ${email}:`, e)
        emailResults.push(`✗ ${email}`)
      }
    }

    // Update Google Sheets
    if (booking.sheetRowIndex) {
      await updateBookingRow(booking.sheetRowIndex, {
        assignedEmails: assignedEmails?.join(', ') || '',
        status: 'ASSIGNED',
      })
    }

    // Re-sync OT records (in case crew list changed)
    syncBookingOT(booking.id).catch(e => console.error('syncBookingOT error:', e))

    return NextResponse.json({ booking, emailResults })
  } catch (error) {
    console.error('POST /api/admin/[id]/assign error:', error)
    return NextResponse.json({ error: 'Failed to assign' }, { status: 500 })
  }
}
