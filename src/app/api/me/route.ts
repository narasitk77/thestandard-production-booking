import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, getOTApproverAccess } from '@/lib/session'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { email: session.email } })
  // v1.33.4 — surface OT approver flag so the client can show the
  // "→ Admin / Cover Sheet" shortcut to managers, not just full admins.
  const canApproveOT = user ? await getOTApproverAccess(user.email) : false
  return NextResponse.json({
    user: user ? {
      email: user.email,
      thaiName: user.thaiName,
      employeeId: user.employeeId,
      position: user.position,
      role: user.role,
      hasSignature: !!user.signaturePng,
      signatureUpdatedAt: user.signatureUpdatedAt,
      canApproveOT,
    } : null,
  })
}
