import { NextRequest, NextResponse } from 'next/server'
import { setSession } from '@/lib/session'

const ALLOWED_DOMAIN = '@thestandard.co'

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json()

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email required' }, { status: 400 })
    }

    const normalized = email.trim().toLowerCase()
    if (!normalized.endsWith(ALLOWED_DOMAIN)) {
      return NextResponse.json({ error: `Only ${ALLOWED_DOMAIN} emails allowed` }, { status: 403 })
    }

    await setSession(normalized)
    return NextResponse.json({ ok: true, email: normalized })
  } catch (e) {
    console.error('Login error:', e)
    return NextResponse.json({ error: 'Login failed' }, { status: 500 })
  }
}
