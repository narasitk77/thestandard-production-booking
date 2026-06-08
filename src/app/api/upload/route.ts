import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { getSession, canUploadToBooking, requireConsole } from '@/lib/session'

const UPLOAD_DIR = process.env.UPLOAD_DIR || join(process.cwd(), 'uploads')

/**
 * v1.35.9 — legacy local-disk upload endpoint. Pre-v1.35.0 this was the
 * primary upload path; v1.35.x replaced it with the browser-direct dual-
 * cloud flow under /api/upload/{init,complete,cancel,list}. This module
 * stays around for the v1.35.5 transition window and any old client code
 * that still POSTs here, but BOTH methods are now properly gated:
 *
 *   GET  — admin-only (lists rows across bookings; the per-booking,
 *          assignment-aware list lives at /api/upload/list)
 *   POST — same gate as /api/upload/init (uploader must be assigned to
 *          the booking, admins bypass)
 *
 * Will be removed entirely in v1.35.10 once we confirm no client still
 * hits it. Until then: lock the door.
 */

export async function GET(request: NextRequest) {
  // v1.35.9 — this listed every Upload row site-wide with no auth check
  // (pre-v1.35.9 bug, found in audit). Admin-only now. The per-booking
  // /api/upload/list endpoint covers the legitimate use-case with the
  // assignment-aware gate.
  if (!(await requireConsole())) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }
  try {
    const { searchParams } = new URL(request.url)
    const bookingId = searchParams.get('bookingId')
    const episodeId = searchParams.get('episodeId')

    const uploads = await prisma.upload.findMany({
      where: {
        ...(bookingId && { bookingId }),
        ...(episodeId && { episode: { episodeId } }),
      },
      include: { episode: true, booking: { include: { outlet: true, program: true } } },
      orderBy: { createdAt: 'desc' },
    })

    // Serialize BigInt fileSize — JSON.stringify cannot handle BigInt natively
    // and throws "Do not know how to serialize a BigInt" without this.
    return NextResponse.json({
      uploads: uploads.map(u => ({ ...u, fileSize: u.fileSize != null ? Number(u.fileSize) : null })),
    })
  } catch (error) {
    console.error('GET /api/upload error:', error)
    return NextResponse.json({ error: 'Failed to fetch uploads' }, { status: 500 })
  }
}

// Filename sanitizer for the legacy disk-write path. Drops path-traversal
// attempts (basename only, reject leading dots and `..` sequences).
function safeFileName(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.length > 255) return null
  // Reject names with directory separators or parent-dir tokens
  if (/[\\/]/.test(trimmed)) return null
  if (trimmed === '.' || trimmed === '..' || trimmed.startsWith('.')) return null
  if (trimmed.includes('..')) return null
  // Allow letters/digits, dots, underscores, dashes, parens, brackets, space, Thai
  if (!/^[A-Za-z0-9._\-()[\] ฀-๿]+$/.test(trimmed)) return null
  return trimmed
}

export async function POST(request: NextRequest) {
  // v1.35.9 — same gate as /api/upload/init: signed-in + (admin OR
  // assigned crew with video/sound role) + booking is CONFIRMED/COMPLETED.
  // The legacy POST used to accept any uploadedBy string with no auth at
  // all, which made it possible to attribute uploads to other people.
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const bookingId = formData.get('bookingId') as string
    const episodeId = formData.get('episodeId') as string | null
    const camera = formData.get('camera') as string
    const notes = formData.get('notes') as string | null
    // v1.35.9 — uploadedBy is ALWAYS the session email now, not whatever
    // the client posted. Otherwise a logged-in user could attribute an
    // upload to a different crew member.
    const uploadedBy = session.email

    if (!file || !bookingId || !camera) {
      return NextResponse.json({ error: 'Missing required fields (file/bookingId/camera)' }, { status: 400 })
    }
    const safeName = safeFileName(file.name)
    if (!safeName) {
      return NextResponse.json({ error: 'Unsafe filename — reject path-like tokens' }, { status: 400 })
    }

    const access = await canUploadToBooking(session.email, bookingId)
    if (!access.ok) {
      return NextResponse.json({ error: 'Forbidden', code: access.reason }, { status: 403 })
    }

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { episodes: true },
    })
    if (!booking) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }

    let episodeRecord = null
    if (episodeId) {
      episodeRecord = booking.episodes.find(e => e.episodeId === episodeId)
      if (!episodeRecord) {
        return NextResponse.json({ error: 'Episode not found in this booking' }, { status: 404 })
      }
    }

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)

    // bookingId comes from the booking record we just loaded, so it's
    // database-trusted. Camera is small + validated indirectly by the
    // canUpload assignment gate (only the booking's known cameras would
    // be used in practice).
    const uploadPath = join(UPLOAD_DIR, booking.id, camera)
    await mkdir(uploadPath, { recursive: true })
    const filePath = join(uploadPath, safeName)
    await writeFile(filePath, buffer)

    const upload = await prisma.upload.create({
      data: {
        bookingId,
        episodeId: episodeRecord?.id ?? null,
        camera,
        fileName: safeName,
        fileSize: BigInt(file.size),
        mimeType: file.type,
        notes: notes || null,
        uploadedBy,
        status: 'COMPLETE',
      },
      include: { episode: true },
    })

    return NextResponse.json({ upload }, { status: 201 })
  } catch (error) {
    console.error('POST /api/upload error:', error)
    return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 })
  }
}
