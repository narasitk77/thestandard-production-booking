import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireOTApprover } from '@/lib/session'

/**
 * POST /api/ot/admin/approve
 *
 * Admin/manager-only. Approves SUBMITTED OT records in one of three modes:
 *
 *   1) { email, month }              — bulk-approve every SUBMITTED row for
 *                                      one user in one month (legacy mode
 *                                      from v1.32, kept stable).
 *   2) { recordIds: string[] }       — approve a hand-picked set of rows
 *                                      (used by manager bulk-select on
 *                                      /ot/admin and per-row approve on
 *                                      /ot/admin/review/[email]).
 *   3) { month, allSubmitted: true } — "approve every SUBMITTED row in this
 *                                      month across all users" — the
 *                                      one-click month close button.
 *
 * Modes are mutually exclusive — `recordIds` takes precedence, then
 * `allSubmitted`, then the legacy `{email, month}` shape.
 *
 * Only rows currently in SUBMITTED are touched (idempotent across
 * re-clicks; never silently moves a DRAFT/REJECTED row past the user).
 * The approver's saved signature is snapshotted onto every approved row.
 *
 * The UI uses recordIds only (maintenance 2026-11-08): the ids the approver was
 * SHOWN. {email, month} / allSubmitted approve whatever is SUBMITTED at click
 * time, incl. rows resubmitted after the page loaded — kept for other callers.
 *
 * `expectedCount` ({email, month} and allSubmitted modes, optional): the number
 * of SUBMITTED rows the caller expects. A different number → 409, nothing
 * approved. It compares COUNTS, not identity, and allSubmitted counts every row
 * of the month (incl. people a page may not list) — prefer recordIds.
 *
 * Returns { ok, approved, mode } where `approved` is the count of rows
 * that flipped SUBMITTED → APPROVED on this call. recordIds mode adds
 * `requested`, `notApprovedIds` (every requested id not approved) and
 * `changedIds` (still SUBMITTED but edited after the caller loaded it).
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireOTApprover()
    if (!session) {
      return NextResponse.json({ error: 'OT approver only' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))

    const approver = await prisma.user.findUnique({
      where: { email: session.email },
      select: { signaturePng: true },
    })
    const approvedAt = new Date()
    const writeData = {
      approvalStatus: 'APPROVED' as const,
      approvedByEmail: session.email,
      approvedAt,
      approverSignaturePng: approver?.signaturePng ?? null,
    }

    // Mode 1: explicit recordIds — exactly the rows the approver saw (both /ot/admin
    // bulk buttons and the review page). Each entry is either a bare id (legacy) or
    // { id, updatedAt } as the page loaded it. A row is approved only while it is
    // still SUBMITTED and — when updatedAt was sent — unchanged since (a row pulled
    // back to DRAFT and resubmitted with new hours keeps its id). The rest are named
    // in notApprovedIds (changedIds = still SUBMITTED but edited since); the caller
    // compares `approved` with `requested` and shows the shortfall.
    if (Array.isArray(body.recordIds) && body.recordIds.length > 0) {
      const seenAt = new Map<string, Date | null>()
      for (const x of body.recordIds as unknown[]) {
        if (x && typeof x === 'object') {
          const { id, updatedAt } = x as { id?: unknown; updatedAt?: unknown }
          const at = new Date(String(updatedAt ?? ''))
          if (!id || updatedAt == null || isNaN(at.getTime())) {
            return NextResponse.json({ error: 'recordIds entries must be an id or { id, updatedAt }' }, { status: 400 })
          }
          seenAt.set(String(id), at)
        } else if (x) {
          seenAt.set(String(x), null)
        }
      }
      const ids = Array.from(seenAt.keys())
      const current = ids.length === 0 ? [] : await prisma.oTRecord.findMany({
        where: { id: { in: ids }, approvalStatus: 'SUBMITTED' },
        select: { id: true, updatedAt: true },
      })
      const approvedIds: string[] = []
      const changedIds: string[] = []
      // ponytail: one UPDATE per row (CAS on updatedAt); a month is a few hundred rows at most.
      for (const r of current) {
        const at = seenAt.get(r.id)
        if (at && r.updatedAt?.getTime() !== at.getTime()) { changedIds.push(r.id); continue }
        const { count } = await prisma.oTRecord.updateMany({
          where: { id: r.id, approvalStatus: 'SUBMITTED', ...(at ? { updatedAt: at } : {}) },
          data: writeData,
        })
        if (count === 1) approvedIds.push(r.id)
        else if (at) changedIds.push(r.id)
      }
      const done = new Set(approvedIds)
      return NextResponse.json({
        ok: true, approved: approvedIds.length, requested: ids.length,
        notApprovedIds: ids.filter(id => !done.has(id)), changedIds, mode: 'recordIds',
      })
    }

    const month = String(body.month || '').trim()
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })
    }

    let expected: number | null = null
    if (body.expectedCount !== undefined && body.expectedCount !== null) {
      expected = Number(body.expectedCount)
      if (!Number.isInteger(expected) || expected < 0) {
        return NextResponse.json({ error: 'expectedCount must be a non-negative integer' }, { status: 400 })
      }
    }

    // Mode 2: month-wide approve everyone · Mode 3: legacy single-person/month
    const allSubmitted = body.allSubmitted === true
    const email = String(body.email || '').trim().toLowerCase()
    if (!allSubmitted && !email) {
      return NextResponse.json({ error: 'email is required (or pass recordIds / allSubmitted)' }, { status: 400 })
    }
    const where = allSubmitted
      ? { month, approvalStatus: 'SUBMITTED' as const }
      : { userEmail: email, month, approvalStatus: 'SUBMITTED' as const }
    const ids = (await prisma.oTRecord.findMany({ where, select: { id: true } })).map(r => r.id)
    if (expected !== null && ids.length !== expected) {
      return NextResponse.json({
        error: `รายการรออนุมัติเปลี่ยนไประหว่างที่เปิดหน้านี้ (ตอนเปิด ${expected} · ตอนนี้ ${ids.length}) — ไม่ได้อนุมัติอะไร โหลดใหม่แล้วตรวจอีกครั้ง`,
        code: 'STALE', expected, current: ids.length,
      }, { status: 409 })
    }
    const result = ids.length === 0 ? { count: 0 } : await prisma.oTRecord.updateMany({
      where: { id: { in: ids }, approvalStatus: 'SUBMITTED' },
      data: writeData,
    })
    return allSubmitted
      ? NextResponse.json({ ok: true, approved: result.count, mode: 'allSubmitted', month })
      : NextResponse.json({ ok: true, approved: result.count, mode: 'email', email, month })
  } catch (e) {
    console.error('POST /api/ot/admin/approve error:', e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
