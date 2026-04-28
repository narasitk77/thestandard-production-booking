import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }
  const users = await prisma.user.findMany({ orderBy: [{ employeeId: 'asc' }, { createdAt: 'asc' }] })
  return NextResponse.json({ users })
}

export async function PATCH(request: NextRequest) {
  const me = await requireAdmin()
  if (!me) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const { id, role, active, thaiName, employeeId, position } = await request.json()
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
      ...(thaiName !== undefined && { thaiName: thaiName?.trim() || null }),
      ...(employeeId !== undefined && { employeeId: employeeId?.trim() || null }),
      ...(position !== undefined && { position: position?.trim() || null }),
    },
  })
  return NextResponse.json({ user })
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }
  const { email, role, thaiName, employeeId, position } = await request.json()
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 })

  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: {
      role: role || 'USER',
      active: true,
      ...(thaiName !== undefined && { thaiName: thaiName?.trim() || null }),
      ...(employeeId !== undefined && { employeeId: employeeId?.trim() || null }),
      ...(position !== undefined && { position: position?.trim() || null }),
    },
    create: {
      email: email.toLowerCase(),
      role: role || 'USER',
      thaiName: thaiName?.trim() || null,
      employeeId: employeeId?.trim() || null,
      position: position?.trim() || null,
    },
  })
  return NextResponse.json({ user })
}

export async function DELETE(request: NextRequest) {
  const me = await requireAdmin()
  if (!me) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const { id } = await request.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (id === me.id) {
    return NextResponse.json({ error: 'Cannot delete yourself' }, { status: 400 })
  }

  // Soft-delete by deactivating (preserves OT history)
  const user = await prisma.user.update({
    where: { id },
    data: { active: false },
  })
  return NextResponse.json({ user, soft: true })
}
