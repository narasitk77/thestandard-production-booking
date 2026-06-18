import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, inEnum } from '@/lib/admin-parse'
import { DocKind } from '@prisma/client'

export const dynamic = 'force-dynamic'

// Exactly one owner FK is set per document. Maps the request's `ownerType` to
// the column so the polymorphic-by-nullable-FK shape stays consistent.
const OWNER_FK: Record<string, 'rentalJobId' | 'purchaseItemId' | 'repairTicketId' | 'loanId'> = {
  rental: 'rentalJobId',
  purchase: 'purchaseItemId',
  repair: 'repairTicketId',
  loan: 'loanId',
}

/**
 * POST /api/admin/documents — attach a Drive file to one owner record.
 * Body: { ownerType: 'rental'|'purchase'|'repair'|'loan', ownerId, fileName,
 *         kind?, driveUrl?, driveFileId? }
 */
export async function POST(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const b = await request.json()
    const fk = OWNER_FK[String(b.ownerType)]
    const ownerId = cleanStr(b.ownerId)
    const fileName = cleanStr(b.fileName)
    if (!fk || !ownerId) return NextResponse.json({ error: 'ownerType (rental|purchase|repair|loan) + ownerId required' }, { status: 400 })
    if (!fileName) return NextResponse.json({ error: 'fileName is required' }, { status: 400 })
    const kind = inEnum(DocKind, b.kind) ? b.kind : 'OTHER'
    const doc = await prisma.documentRef.create({
      data: { kind, fileName, driveUrl: cleanStr(b.driveUrl), driveFileId: cleanStr(b.driveFileId), [fk]: ownerId },
    })
    logAudit({ actorEmail: session.email, action: 'document.attach', entityType: 'DocumentRef', entityId: doc.id, changes: { ownerType: b.ownerType, ownerId, fileName } })
    return NextResponse.json({ document: doc }, { status: 201 })
  } catch (e: any) {
    console.error('POST /api/admin/documents error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

/** DELETE /api/admin/documents?id=<docId> — detach a document. */
export async function DELETE(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  const id = new URL(request.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  try {
    await prisma.documentRef.delete({ where: { id } })
    logAudit({ actorEmail: session.email, action: 'document.detach', entityType: 'DocumentRef', entityId: id })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('DELETE /api/admin/documents error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
