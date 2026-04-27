import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'

const UPLOAD_DIR = process.env.UPLOAD_DIR || join(process.cwd(), 'uploads')

export async function GET(request: NextRequest) {
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

    return NextResponse.json({ uploads })
  } catch (error) {
    console.error('GET /api/upload error:', error)
    return NextResponse.json({ error: 'Failed to fetch uploads' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const bookingId = formData.get('bookingId') as string
    const episodeId = formData.get('episodeId') as string | null
    const camera = formData.get('camera') as string
    const notes = formData.get('notes') as string | null
    const uploadedBy = formData.get('uploadedBy') as string

    if (!file || !bookingId || !camera || !uploadedBy) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Verify booking exists
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { episodes: true },
    })
    if (!booking) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }

    // Find episode record if episodeId provided
    let episodeRecord = null
    if (episodeId) {
      episodeRecord = booking.episodes.find(e => e.episodeId === episodeId)
      if (!episodeRecord) {
        return NextResponse.json({ error: 'Episode not found in this booking' }, { status: 404 })
      }
    }

    // Save file to disk
    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)

    const uploadPath = join(UPLOAD_DIR, bookingId, camera)
    await mkdir(uploadPath, { recursive: true })
    const filePath = join(uploadPath, file.name)
    await writeFile(filePath, buffer)

    // Create upload record
    const upload = await prisma.upload.create({
      data: {
        bookingId,
        episodeId: episodeRecord?.id ?? null,
        camera,
        fileName: file.name,
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
