import crypto from 'crypto'
import { cookies } from 'next/headers'
import { prisma } from './db'

const SECRET = process.env.AUTH_SECRET || 'change-me-in-prod-please'
const COOKIE = 'pb_session'
const MAX_AGE = 60 * 60 * 24 * 7 // 7 days

// Bootstrap admin — seeded on first login
const INITIAL_ADMINS = ['narasit.k@thestandard.co']

function sign(data: string): string {
  return crypto.createHmac('sha256', SECRET).update(data).digest('hex')
}

function encode(payload: object): string {
  const data = JSON.stringify(payload)
  const b64 = Buffer.from(data).toString('base64url')
  return `${b64}.${sign(b64)}`
}

function decode(token: string): { email: string; ts: number } | null {
  const [b64, sig] = token.split('.')
  if (!b64 || !sig) return null
  if (sign(b64) !== sig) return null
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString())
    if (Date.now() - payload.ts > MAX_AGE * 1000) return null
    return payload
  } catch {
    return null
  }
}

export async function setSession(email: string) {
  const token = encode({ email, ts: Date.now() })
  cookies().set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
    secure: process.env.NODE_ENV === 'production',
  })
}

export function clearSession() {
  cookies().delete(COOKIE)
}

export async function getSession() {
  const token = cookies().get(COOKIE)?.value
  if (!token) return null
  const decoded = decode(token)
  if (!decoded) return null

  // Auto-bootstrap initial admins on first lookup
  let user = await prisma.user.findUnique({ where: { email: decoded.email } })
  if (!user) {
    const isAdmin = INITIAL_ADMINS.includes(decoded.email)
    user = await prisma.user.create({
      data: { email: decoded.email, role: isAdmin ? 'ADMIN' : 'USER' },
    })
  }
  if (!user.active) return null
  return { email: user.email, role: user.role, name: user.name, id: user.id }
}

export async function requireAdmin() {
  const s = await getSession()
  if (!s || s.role !== 'ADMIN') return null
  return s
}
