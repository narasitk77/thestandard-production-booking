import { getServerSession } from 'next-auth'
import { authOptions } from './auth'

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
