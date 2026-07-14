import { NextRequest, NextResponse } from 'next/server'
import { Readable } from 'stream'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, inEnum } from '@/lib/admin-parse'
import { ensureFolderPath, uploadFileToFolder, deleteDriveFile } from '@/lib/google-drive'
import { ensurePurchaseItemFolder } from '@/lib/purchase-drive'
import { isBatchEditable } from '@/lib/purchase-batch'
import { DocKind } from '@prisma/client'

// Receipts on a purchase are the financial paperwork the approval state machine
// freezes. Only the batch owner may add/remove them, and only while the month is
// still editable (DRAFT/REJECTED) — so SUBMITTED/APPROVED stays immutable and one
// buyer can't touch another's receipts. Mirrors guardEditable on the item routes.
async function purchaseDocGuard(purchaseId: string, email: string): Promise<NextResponse | null> {
  const p = await prisma.purchase.findUnique({ where: { id: purchaseId }, select: { batch: { select: { ownerEmail: true, status: true } } } })
  if (!p) return NextResponse.json({ error: 'ไม่พบรายการจัดซื้อ' }, { status: 404 })
  if (p.batch.ownerEmail !== email) return NextResponse.json({ error: 'จัดการใบเสร็จได้เฉพาะรายการของตนเอง' }, { status: 403 })
  if (!isBatchEditable(p.batch.status)) return NextResponse.json({ error: 'เดือนนี้ส่งอนุมัติแล้ว — แก้ไขไม่ได้' }, { status: 400 })
  return null
}

export const dynamic = 'force-dynamic'

// Exactly one owner FK is set per document. Maps the request's `ownerType` to
// the column so the polymorphic-by-nullable-FK shape stays consistent.
const OWNER_FK: Record<string, 'rentalJobId' | 'purchaseId' | 'repairTicketId' | 'loanId'> = {
  rental: 'rentalJobId',
  purchase: 'purchaseId',
  repair: 'repairTicketId',
  loan: 'loanId',
}

// v1.146 review fix — rental/loan/repair records are Admin-only (finance): their
// CRUD routes all gate on requireAdmin and /admin/rentals|loans|repairs are
// blocked for non-ADMIN in middleware. The five doc slots attached to those
// records ARE the financial paperwork, so mutating them must be Admin-only too —
// previously any console tier (MANAGER/COORDINATOR/SUPPORT) could upload or
// delete an invoice/receipt by calling this route directly. Purchases keep
// their own owner+editable guard (purchaseDocGuard) instead.
const ADMIN_ONLY_OWNER_TYPES = new Set(['rental', 'loan', 'repair'])

function adminOwnerTypeGuard(ownerType: string, role: string | null | undefined): NextResponse | null {
  if (ADMIN_ONLY_OWNER_TYPES.has(ownerType) && role !== 'ADMIN') {
    return NextResponse.json({ error: 'เอกสารการเงิน (เช่า/ยืม/ซ่อม) จัดการได้เฉพาะ Admin' }, { status: 403 })
  }
  return null
}

// Top-level folder per category under DRIVE_DOCS_ROOT, then one folder per job
// inside it ("ผมแบ่งโฟลเดอร์เป็นงาน"). Thai labels match how the team thinks.
const CATEGORY_FOLDER: Record<string, string> = {
  rental: 'เช่า (Rentals)',
  purchase: 'จัดซื้อ (Purchases)',
  repair: 'ซ่อม (Repairs)',
  loan: 'ยืม-คืน (Loans)',
}

const MAX_BYTES = 25 * 1024 * 1024 // ponytail: in-memory upload — 25MB is plenty for a quote/invoice/receipt

// Drive folder names can't contain "/". Keep it readable, never empty.
function safeFolderName(label: string, fallback: string): string {
  const s = label.replace(/[/\\]/g, '-').replace(/\s+/g, ' ').trim()
  return s.slice(0, 120) || fallback
}

/** Human label for the job folder, looked up per owner type. */
async function ownerFolderLabel(ownerType: string, ownerId: string): Promise<string> {
  if (ownerType === 'rental') {
    const r = await prisma.rentalJob.findUnique({ where: { id: ownerId }, select: { jobName: true, quoteNo: true } })
    return safeFolderName(r?.jobName || r?.quoteNo || '', ownerId)
  }
  // Purchase is special-cased in resolveDocsFolder (nested month → item), never here.
  if (ownerType === 'repair') {
    const r = await prisma.repairTicket.findUnique({ where: { id: ownerId }, select: { itemLabel: true } })
    return safeFolderName(r?.itemLabel || '', ownerId)
  }
  // loan
  const r = await prisma.equipmentLoan.findUnique({ where: { id: ownerId }, select: { loanCode: true, photographer: true } })
  return safeFolderName([r?.loanCode, r?.photographer].filter(Boolean).join(' '), ownerId)
}

/** Resolve (creating if needed) the per-job Drive folder for a document owner. */
async function resolveDocsFolder(ownerType: string, ownerId: string): Promise<string> {
  const root = process.env.DRIVE_DOCS_ROOT
  if (!root) throw new Error('ยังไม่ได้ตั้งค่า DRIVE_DOCS_ROOT (โฟลเดอร์ปลายทางใน Drive)')
  // Purchases nest by month → item so receipts land in the same folder the
  // batch workflow builds (จัดซื้อ/<YYYY-MM>/<item>).
  if (ownerType === 'purchase') {
    const r = await prisma.purchase.findUnique({ where: { id: ownerId }, select: { item: true, batch: { select: { month: true } } } })
    if (!r) throw new Error('ไม่พบรายการจัดซื้อ')
    return ensurePurchaseItemFolder(r.batch.month, r.item, ownerId)
  }
  // Rentals nest by month → booking (เช่า/<YYYY-MM>/<bookingCode · job · id>/):
  // a month's rental paperwork lives together, and every doc for one rental sits
  // in its own folder. The folder id is resolved once and stored on the rental,
  // so it never moves even if the booking link or rentalDate changes later, and
  // the short id suffix keeps two rentals from ever sharing a folder.
  if (ownerType === 'rental') {
    const r = await prisma.rentalJob.findUnique({
      where: { id: ownerId },
      select: { jobName: true, quoteNo: true, rentalDate: true, createdAt: true, driveFolderId: true, booking: { select: { bookingCode: true, shootDate: true } } },
    })
    if (!r) throw new Error('ไม่พบงานเช่า')
    if (r.driveFolderId) return r.driveFolderId
    // Month in Asia/Bangkok (UTC+7): @db.Date sources sit at UTC midnight so +7h
    // stays on the same day, while a createdAt timestamp gets its true local month.
    const d = r.rentalDate || r.booking?.shootDate || r.createdAt
    const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000)
    const month = `${bkk.getUTCFullYear()}-${String(bkk.getUTCMonth() + 1).padStart(2, '0')}`
    const base = r.booking?.bookingCode
      ? [r.booking.bookingCode, r.jobName].filter(Boolean).join(' · ')
      : (r.jobName || r.quoteNo || '')
    const label = safeFolderName(`${base} · ${ownerId.slice(-4)}`.trim(), ownerId)
    const folderId = await ensureFolderPath(root, [CATEGORY_FOLDER.rental, month, label])
    await prisma.rentalJob.update({ where: { id: ownerId }, data: { driveFolderId: folderId } }).catch(() => {})
    return folderId
  }
  const label = await ownerFolderLabel(ownerType, ownerId)
  return ensureFolderPath(root, [CATEGORY_FOLDER[ownerType], label])
}

/**
 * GET /api/admin/documents?ownerType=&ownerId= — list a record's documents.
 */
export async function GET(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  const sp = new URL(request.url).searchParams
  const fk = OWNER_FK[String(sp.get('ownerType'))]
  const ownerId = cleanStr(sp.get('ownerId'))
  if (!fk || !ownerId) return NextResponse.json({ error: 'ownerType + ownerId required' }, { status: 400 })
  const documents = await prisma.documentRef.findMany({
    where: { [fk]: ownerId },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json({ documents })
}

/**
 * POST /api/admin/documents — attach a document to one owner record.
 *
 * Two modes:
 *  - multipart/form-data with a `file`  → uploads the file to the job's Drive
 *    folder, then records the ref. Fields: file, ownerType, ownerId, kind?
 *  - application/json (no file)         → records a ref to an already-uploaded
 *    Drive file. Body: { ownerType, ownerId, fileName, kind?, driveUrl?, driveFileId? }
 */
export async function POST(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const isMultipart = (request.headers.get('content-type') || '').includes('multipart/form-data')

    if (isMultipart) {
      const form = await request.formData()
      const file = form.get('file')
      const ownerType = String(form.get('ownerType') || '')
      const fk = OWNER_FK[ownerType]
      const ownerId = cleanStr(form.get('ownerId'))
      const kind = inEnum(DocKind, form.get('kind')) ? (form.get('kind') as DocKind) : 'OTHER'
      if (!fk || !ownerId) return NextResponse.json({ error: 'ownerType (rental|purchase|repair|loan) + ownerId required' }, { status: 400 })
      { const blocked = adminOwnerTypeGuard(ownerType, session.role); if (blocked) return blocked }
      if (ownerType === 'purchase') { const blocked = await purchaseDocGuard(ownerId, session.email); if (blocked) return blocked }
      if (!(file instanceof File)) return NextResponse.json({ error: 'file is required' }, { status: 400 })
      if (file.size === 0) return NextResponse.json({ error: 'ไฟล์ว่าง' }, { status: 400 })
      if (file.size > MAX_BYTES) return NextResponse.json({ error: `ไฟล์ใหญ่เกิน ${MAX_BYTES / 1024 / 1024}MB` }, { status: 413 })

      const folderId = await resolveDocsFolder(ownerType, ownerId)
      const buf = Buffer.from(await file.arrayBuffer())
      const up = await uploadFileToFolder({
        parentFolderId: folderId,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        body: Readable.from(buf),
      })
      const doc = await prisma.documentRef.create({
        data: { kind, fileName: file.name, driveFileId: up.id, driveUrl: up.webViewLink, [fk]: ownerId },
      })
      logAudit({ actorEmail: session.email, action: 'document.upload', entityType: 'DocumentRef', entityId: doc.id, changes: { ownerType, ownerId, fileName: file.name, driveFileId: up.id } })
      return NextResponse.json({ document: doc }, { status: 201 })
    }

    // JSON ref-attach (no upload).
    const b = await request.json()
    const fk = OWNER_FK[String(b.ownerType)]
    const ownerId = cleanStr(b.ownerId)
    const fileName = cleanStr(b.fileName)
    if (!fk || !ownerId) return NextResponse.json({ error: 'ownerType (rental|purchase|repair|loan) + ownerId required' }, { status: 400 })
    { const blocked = adminOwnerTypeGuard(String(b.ownerType), session.role); if (blocked) return blocked }
    if (String(b.ownerType) === 'purchase') { const blocked = await purchaseDocGuard(ownerId, session.email); if (blocked) return blocked }
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

/** DELETE /api/admin/documents?id=<docId> — remove the Drive file + the ref. */
export async function DELETE(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  const id = new URL(request.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  try {
    const doc = await prisma.documentRef.findUnique({ where: { id }, select: { driveFileId: true, purchaseId: true, rentalJobId: true, loanId: true, repairTicketId: true } })
    const docOwnerType = doc?.rentalJobId ? 'rental' : doc?.loanId ? 'loan' : doc?.repairTicketId ? 'repair' : doc?.purchaseId ? 'purchase' : ''
    { const blocked = adminOwnerTypeGuard(docOwnerType, session.role); if (blocked) return blocked }
    if (doc?.purchaseId) { const blocked = await purchaseDocGuard(doc.purchaseId, session.email); if (blocked) return blocked }
    if (doc?.driveFileId) {
      // Best-effort: a missing/already-deleted Drive file shouldn't block detach.
      await deleteDriveFile(doc.driveFileId).catch((e) => console.warn('Drive delete failed:', e?.message || e))
    }
    await prisma.documentRef.delete({ where: { id } })
    logAudit({ actorEmail: session.email, action: 'document.detach', entityType: 'DocumentRef', entityId: id })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('DELETE /api/admin/documents error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
