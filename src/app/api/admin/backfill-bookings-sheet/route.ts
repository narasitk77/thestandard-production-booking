import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { requireAdmin } from '@/lib/session'
import { prisma } from '@/lib/db'
import { appendBookingRow, updateBookingRow, getSheetsReadAuth } from '@/lib/google-sheets'
import { getProducerDashboardSheetId, getBookingsTabName, isUsingSandboxSheet } from '@/lib/google-config'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/admin/backfill-bookings-sheet   { apply?: boolean }
 *
 * v1.148.0 one-off: bring the Bookings tab in line with the DB after the
 * all-outlets export widening (create-booking.ts). Three passes:
 *
 *  1. APPEND — every live (non-deleted, non-CANCELLED) booking with no row in
 *     the tab gets one. Covers all pre-v1.148 outlet bookings, including
 *     future shoots already CONFIRMED, so PMDC's Airtable sync can pick up
 *     their Production ID spine without waiting for new bookings.
 *  2. CLAIM — bookings whose row exists (col-A match) but whose sheetRowIndex
 *     flag is null get the flag set, so lifecycle patches (approve/assign/
 *     cancel) start flowing to their row.
 *  3. EVENT-ID PATCH — rows whose Calendar Event ID cell (col W) is blank
 *     while the DB knows the id (events created by the calendar reconciler or
 *     the assign auto-recover before v1.148 backfilled them) get patched.
 *
 * Default is a DRY RUN returning the full plan; pass { apply: true } to
 * execute. Honors BOOKINGS_EXPORT_AGN_ONLY=1 (appends AGN only). Admin-only.
 *
 * v1.148.1 — SANDBOX GUARD: `apply` is refused while the app points at a
 * non-production Producer Dashboard sheet (v1.148.3: an env override away
 * from the production id). The entire point of this backfill is to feed
 * PMDC's Airtable sync off the PRODUCTION Bookings tab; running it against
 * a test sheet would append every live booking (hundreds of rows) into the
 * wrong sheet, burn quota, and LOOK done while Airtable still sees nothing.
 * Remove the override first (docs/runbook-sheet-swap.md), or pass
 * { apply: true, force: true } if you really do mean the test sheet. The dry
 * run is read-only and always allowed — every response reports its sheet
 * target.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireAdmin()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    const body = await request.json().catch(() => ({}))
    const apply = body?.apply === true
    const force = body?.force === true
    const agnOnly = process.env.BOOKINGS_EXPORT_AGN_ONLY === '1'

    const sandbox = isUsingSandboxSheet()
    const target = {
      sheetTarget: sandbox ? ('sandbox' as const) : ('production' as const),
      sheetId: getProducerDashboardSheetId(),
      tab: getBookingsTabName(),
    }
    if (apply && sandbox && !force) {
      return NextResponse.json({
        error:
          'ระบบกำลังชี้ไป sheet ที่ไม่ใช่ production (PRODUCER_DASHBOARD_SHEET_ID override อยู่) — ' +
          'backfill จะเขียนลง sheet ผิดตัว และ Airtable ฝั่ง PMDC จะยังไม่เห็นอะไรเลย. ' +
          'เอา override ออกจาก stack env (หรือตั้งเป็น id ของ sheet production) แล้ว redeploy ' +
          '(ดู docs/runbook-sheet-swap.md) — ถ้าตั้งใจจะ backfill ลง sheet ทดสอบจริงๆ ' +
          'ส่ง { apply: true, force: true }',
        ...target,
      }, { status: 409 })
    }

    // ── Read the tab once: col A (Production ID) + col W (Calendar Event ID)
    const sheets = google.sheets({ version: 'v4', auth: getSheetsReadAuth() })
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: getProducerDashboardSheetId(),
      range: `${getBookingsTabName()}!A2:W`,
    })
    const sheetRows = res.data.values || []
    const byCode = new Map<string, { rowIndex: number; eventId: string }>()
    sheetRows.forEach((row, i) => {
      const code = String(row[0] || '').trim()
      if (code && !byCode.has(code)) {
        byCode.set(code, { rowIndex: i + 2, eventId: String(row[22] || '').trim() })
      }
    })

    const bookings = await prisma.booking.findMany({
      where: { deletedAt: null, status: { notIn: ['CANCELLED'] } },
      include: { outlet: true, program: true, episodes: true },
      orderBy: { createdAt: 'asc' },
    })

    const plan = {
      dryRun: !apply,
      ...target, // v1.148.1 — always say WHICH sheet this plan is about
      forcedSandbox: apply && sandbox && force,
      agnOnly,
      sheetRows: sheetRows.length,
      dbBookings: bookings.length,
      append: [] as Array<{ code: string; outlet: string; status: string; appended?: boolean }>,
      claim: [] as Array<{ code: string; rowIndex: number; claimed?: boolean }>,
      patchEventId: [] as Array<{ code: string; eventId: string; patched?: boolean }>,
      skippedAgnOnly: 0,
      errors: [] as string[],
    }

    for (const booking of bookings) {
      const code = (booking.bookingCode || booking.id).trim()
      const inSheet = byCode.get(code)

      if (!inSheet) {
        if (agnOnly && booking.outlet.code !== 'AGN') {
          plan.skippedAgnOnly += 1
          continue
        }
        const entry = { code, outlet: booking.outlet.code, status: booking.status } as (typeof plan.append)[number]
        plan.append.push(entry)
        if (apply) {
          try {
            const rowIndex = await appendBookingRow({
              ...booking,
              shootDate: booking.shootDate,
              createdAt: booking.createdAt,
            })
            entry.appended = rowIndex != null
            if (rowIndex) {
              await prisma.booking.update({ where: { id: booking.id }, data: { sheetRowIndex: rowIndex } }).catch(() => {})
            }
          } catch (e: any) {
            entry.appended = false
            plan.errors.push(`append ${code}: ${e?.message || e}`)
          }
        }
        continue
      }

      if (!booking.sheetRowIndex) {
        const entry = { code, rowIndex: inSheet.rowIndex } as (typeof plan.claim)[number]
        plan.claim.push(entry)
        if (apply) {
          await prisma.booking.update({ where: { id: booking.id }, data: { sheetRowIndex: inSheet.rowIndex } })
            .then(() => { entry.claimed = true })
            .catch((e: any) => { entry.claimed = false; plan.errors.push(`claim ${code}: ${e?.message || e}`) })
        }
      }

      if (booking.calendarEventId && !inSheet.eventId) {
        const entry = { code, eventId: booking.calendarEventId } as (typeof plan.patchEventId)[number]
        plan.patchEventId.push(entry)
        if (apply) {
          const result = await updateBookingRow(code, { calendarEventId: booking.calendarEventId })
          entry.patched = result === 'updated'
          if (result === 'error') plan.errors.push(`patchEventId ${code}: sheet write failed`)
        }
      }
    }

    return NextResponse.json({
      ok: true,
      apply,
      summary: {
        append: plan.append.length,
        claim: plan.claim.length,
        patchEventId: plan.patchEventId.length,
        skippedAgnOnly: plan.skippedAgnOnly,
        errors: plan.errors.length,
      },
      ...plan,
    })
  } catch (e: any) {
    console.error('POST /api/admin/backfill-bookings-sheet error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
