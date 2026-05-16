import { getServerSession } from 'next-auth'
import { authOptions } from './auth'
import { prisma } from './db'

// AUTH_DISABLED=1 runs the app with NO login at all — every request is treated
// as the seeded admin. Used for trusted LAN deployments where Google OAuth
// isn't reachable. Set AUTH_DISABLED=0 (or unset) to restore Google sign-in.
const AUTH_DISABLED = process.env.AUTH_DISABLED === '1'

type AppSession = {
  email: string
  name: string | null
  role: 'USER' | 'ADMIN'
  id: string | undefined
}

async function getBypassAdmin(): Promise<AppSession> {
  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN', active: true },
    orderBy: { createdAt: 'asc' },
  })
  if (admin) {
    return {
      email: admin.email.toLowerCase(),
      name: admin.name ?? admin.thaiName ?? 'Admin',
      role: 'ADMIN',
      id: admin.id,
    }
  }
  // No admin seeded yet — still grant access so the app stays usable.
  return { email: 'admin@local', name: 'Admin', role: 'ADMIN', id: undefined }
}

export async function getSession(): Promise<AppSession | null> {
  if (AUTH_DISABLED) return getBypassAdmin()

  const s = await getServerSession(authOptions)
  if (!s?.user?.email) return null
  return {
    email: s.user.email.toLowerCase(),
    name: s.user.name ?? null,
    role: ((s.user as any).role || 'USER') as 'USER' | 'ADMIN',
    id: (s.user as any).id as string | undefined,
  }
}

export async function requireAdmin() {
  const s = await getSession()
  if (!s || s.role !== 'ADMIN') return null
  return s
}
