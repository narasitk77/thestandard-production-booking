import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole, getOTApproverAccess } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr } from '@/lib/admin-parse'
import { MONTH_RE, isBatchEditable, batchTotal } from '@/lib/purchase-batch'
import { ensurePurchaseMonthFolder, ensurePurchaseItemFolder, driveFolderUrl } from '@/lib/purchase-drive'
import { sendEmail, isEmailConfigured } from '@/lib/email'

export const dynamic = 'force-dynamic'

const baht = (n: number) => `฿${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Who gets the "please approve" email: explicit env, else active MANAGER users, else the digest inbox. */
async function approverEmails(): Promise<string[]> {
  const env = (process.env.PURCHASE_APPROVER_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean)
  if (env.length) return env
  const managers = await prisma.user.findMany({ where: { role: 'MANAGER', active: true }, select: { email: true } })
  if (managers.length) return managers.map(m => m.email)
  const fallback = (process.env.REMINDER_ADMIN_EMAIL || process.env.EMAIL_FROM || '').trim()
  return fallback ? [fallback] : []
}

/** Create the month folder + every item subfolder in Drive, persisting the ids. Best-effort caller decides. */
async function syncFolders(batchId: string) {
  const batch = await prisma.purchaseBatch.findUnique({ where: { id: batchId }, include: { items: true } })
  if (!batch) return null
  const monthFolderId = await ensurePurchaseMonthFolder(batch.month)
  await prisma.purchaseBatch.update({ where: { id: batchId }, data: { driveFolderId: monthFolderId, driveFolderUrl: driveFolderUrl(monthFolderId) } })
  for (const it of batch.items) {
    const itemFolderId = await ensurePurchaseItemFolder(batch.month, it.item, it.id)
    await prisma.purchase.update({ where: { id: it.id }, data: { driveFolderId: itemFolderId } })
  }
  return driveFolderUrl(monthFolderId)
}

/**
 * POST /api/admin/purchases/batch — month-level actions.
 *   { action: 'submit',  month }            buyer pushes their month for approval
 *   { action: 'sync-folder', month }        buyer creates/opens the Drive month folder
 *   { action: 'approve', batchId }          manager signs off
 *   { action: 'reject',  batchId, note }    manager pushes back
 */
export async function POST(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const b = await request.json()
    const action = cleanStr(b.action)

    // ---- buyer actions (own month) ----
    if (action === 'submit' || action === 'sync-folder') {
      const month = cleanStr(b.month)
      if (!month || !MONTH_RE.test(month)) return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })
      const batch = await prisma.purchaseBatch.findUnique({
        where: { ownerEmail_month: { ownerEmail: session.email, month } },
        include: { items: true },
      })
      if (!batch) return NextResponse.json({ error: 'ยังไม่มีรายการในเดือนนี้' }, { status: 400 })

      if (action === 'sync-folder') {
        const url = await syncFolders(batch.id) // surfaces DRIVE_DOCS_ROOT errors to the user
        return NextResponse.json({ ok: true, driveFolderUrl: url })
      }

      // submit
      if (!isBatchEditable(batch.status)) return NextResponse.json({ error: 'เดือนนี้ส่งอนุมัติแล้ว' }, { status: 400 })
      if (batch.items.length === 0) return NextResponse.json({ error: 'ยังไม่มีรายการในเดือนนี้' }, { status: 400 })

      // Best-effort: file the receipts into Drive folders before the manager looks.
      let driveUrl: string | null = batch.driveFolderUrl
      try { driveUrl = (await syncFolders(batch.id)) ?? driveUrl } catch (e) { console.error('purchase submit: folder sync failed (continuing):', e) }

      const updated = await prisma.purchaseBatch.update({
        where: { id: batch.id },
        data: { status: 'SUBMITTED', submittedAt: new Date(), rejectionNote: null },
      })
      logAudit({ actorEmail: session.email, action: 'purchase.submit', entityType: 'PurchaseBatch', entityId: batch.id, changes: { month } })

      // Notify the manager(s). Best-effort — never block submit on email.
      try {
        if (isEmailConfigured()) {
          const to = await approverEmails()
          if (to.length) {
            const total = baht(batchTotal(batch.items.map(i => ({ quantity: i.quantity, unitPrice: i.unitPrice == null ? null : Number(i.unitPrice), total: i.total == null ? null : Number(i.total) }))))
            const link = process.env.NEXTAUTH_URL ? `${process.env.NEXTAUTH_URL.replace(/\/$/, '')}/admin/purchases?batchId=${batch.id}` : ''
            await sendEmail({
              to,
              subject: `[จัดซื้อ] ขออนุมัติเดือน ${month} — ${batch.items.length} รายการ ${total}`,
              text: `${session.email} ส่งรายการจัดซื้อเดือน ${month} ให้อนุมัติ\nจำนวน ${batch.items.length} รายการ · รวม ${total}\n${driveUrl ? `โฟลเดอร์ใบเสร็จ: ${driveUrl}\n` : ''}${link ? `เปิดเพื่ออนุมัติ: ${link}` : ''}`,
            })
          }
        }
      } catch (e) { console.error('purchase submit: email failed (continuing):', e) }

      return NextResponse.json({ ok: true, batch: updated })
    }

    // ---- manager actions (any batch by id) ----
    if (action === 'approve' || action === 'reject') {
      const isApprover = await getOTApproverAccess(session.email) // = manager/admin
      if (!isApprover) return NextResponse.json({ error: 'เฉพาะ Manager เท่านั้นที่อนุมัติได้' }, { status: 403 })
      const batchId = cleanStr(b.batchId)
      if (!batchId) return NextResponse.json({ error: 'batchId required' }, { status: 400 })
      const batch = await prisma.purchaseBatch.findUnique({ where: { id: batchId } })
      if (!batch) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      if (batch.status !== 'SUBMITTED') return NextResponse.json({ error: 'เดือนนี้ไม่ได้อยู่ในสถานะรออนุมัติ' }, { status: 400 })

      if (action === 'reject') {
        const note = cleanStr(b.note)
        if (!note) return NextResponse.json({ error: 'กรุณาใส่เหตุผลที่ไม่อนุมัติ' }, { status: 400 })
        const updated = await prisma.purchaseBatch.update({
          where: { id: batchId },
          data: { status: 'REJECTED', rejectionNote: note.slice(0, 500), approvedByEmail: null, approvedAt: null },
        })
        logAudit({ actorEmail: session.email, action: 'purchase.reject', entityType: 'PurchaseBatch', entityId: batchId, changes: { note } })
        notifyBuyer(batch.ownerEmail, `[จัดซื้อ] เดือน ${batch.month} ไม่อนุมัติ`, `Manager ขอให้แก้ไข: ${note}`)
        return NextResponse.json({ ok: true, batch: updated })
      }

      const updated = await prisma.purchaseBatch.update({
        where: { id: batchId },
        data: { status: 'APPROVED', approvedByEmail: session.email, approvedAt: new Date(), rejectionNote: null },
      })
      logAudit({ actorEmail: session.email, action: 'purchase.approve', entityType: 'PurchaseBatch', entityId: batchId, changes: { month: batch.month } })
      notifyBuyer(batch.ownerEmail, `[จัดซื้อ] เดือน ${batch.month} อนุมัติแล้ว`, `${session.email} อนุมัติรายการจัดซื้อเดือน ${batch.month} เรียบร้อย`)
      return NextResponse.json({ ok: true, batch: updated })
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  } catch (e: any) {
    console.error('POST /api/admin/purchases/batch error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

/** Fire-and-forget buyer notification. Never throws into the request. */
function notifyBuyer(to: string, subject: string, text: string) {
  if (!to || !isEmailConfigured()) return
  sendEmail({ to, subject, text }).catch(e => console.error('purchase notifyBuyer failed:', e))
}
