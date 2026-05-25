import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'

// Hard cap on stored signature size. Real hand-drawn signatures from the
// 600x200 canvas in /profile/signature land around 5–25KB; the limit gives
// imported PNGs headroom while preventing a malicious client from blowing
// up the users table.
const MAX_SIG_BYTES = 200 * 1024 // 200KB raw base64 (~150KB binary)

function isValidPngDataUrl(s: string): boolean {
  if (typeof s !== 'string') return false
  if (!s.startsWith('data:image/png;base64,')) return false
  const b64 = s.slice('data:image/png;base64,'.length)
  if (b64.length === 0) return false
  // Allow only base64 chars (+ padding). Reject obvious garbage early.
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return false
  return true
}

/**
 * GET /api/me/signature
 * Returns the signed-in user's saved signature PNG (full data URL) or null.
 * Used by the user's submit modal to preview their saved signature before
 * snapshotting it onto OT records.
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({
    where: { email: session.email },
    select: { signaturePng: true, signatureUpdatedAt: true },
  })
  return NextResponse.json({
    signaturePng: user?.signaturePng ?? null,
    signatureUpdatedAt: user?.signatureUpdatedAt ?? null,
  })
}

/**
 * POST /api/me/signature  { png: "data:image/png;base64,..." }
 * Saves the signed-in user's signature. Used on /profile/signature.
 *
 * To clear the signature, send { png: null } or omit it.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const raw = body.png

    if (raw === null || raw === undefined || raw === '') {
      await prisma.user.update({
        where: { email: session.email },
        data: { signaturePng: null, signatureUpdatedAt: null },
      })
      return NextResponse.json({ ok: true, cleared: true })
    }

    if (!isValidPngDataUrl(raw)) {
      return NextResponse.json({ error: 'Signature must be a PNG data URL (data:image/png;base64,...)' }, { status: 400 })
    }
    if (raw.length > MAX_SIG_BYTES) {
      return NextResponse.json({ error: `Signature too large (max ${MAX_SIG_BYTES} bytes)` }, { status: 400 })
    }

    await prisma.user.update({
      where: { email: session.email },
      data: { signaturePng: raw, signatureUpdatedAt: new Date() },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('POST /api/me/signature error:', e)
    return NextResponse.json({ error: 'Failed to save signature' }, { status: 500 })
  }
}
