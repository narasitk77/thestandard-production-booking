import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } })
  return NextResponse.json({ users })
}

export async function PATCH(request: NextRequest) {
  const me = await requireAdmin()
  if (!me) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const { id, role, active } = await request.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  // Prevent self-demotion to avoid lockout
  if (id === me.id && (role === 'USER' || active === false)) {
    return NextResponse.json({ error: 'Cannot demote/disable yourself' }, { status: 400 })
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(role && { role }),
      ...(active !== undefined && { active }),
    },
  })
  return NextResponse.json({ user })
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }
  const { email, role } = await request.json()
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 })

  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: { role: role || 'USER', active: true },
    create: { email: email.toLowerCase(), role: role || 'USER' },
  })
  return NextResponse.json({ user })
}
