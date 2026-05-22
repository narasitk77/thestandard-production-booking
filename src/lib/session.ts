import { getServerSession } from 'next-auth'
import { authOptions } from './auth'
import { prisma } from './db'

export async function getSession() {
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

// Producer Dashboard access: admins, or users whose `position` is a Producer
// role (Producer / Co-Producer — set by an admin on the permissions page).
// Matches any position containing "producer" so variants are covered.
export async function getProducerAccess(email: string | null | undefined): Promise<boolean> {
  if (!email) return false
  try {
    const u = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { role: true, position: true },
    })
    if (!u) return false
    if (u.role === 'ADMIN') return true
    return (u.position || '').toLowerCase().includes('producer')
  } catch {
    return false
  }
}
