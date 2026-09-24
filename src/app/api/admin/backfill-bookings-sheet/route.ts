import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { appendBookingRow, updateBookingRow, getSheetsReadAuth, getSheetsWriteAuth, joinEpisodeTitles } from '@/lib/google-sheets'
import { getDriveLink } from '@/lib/drive-links'
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
 *     is null **or wrong** get it set to the real row, so lifecycle patches
 *     (approve/assign/cancel) start flowing to their row.
 *     v1.237 — "wrong" was added after concurrent appends handed 39 bookings a
 *     row number belonging to another booking (see queueAppend in google-sheets.ts).
 *  3. EVENT-ID PATCH — rows whose Calendar Event ID cell (col W) is blank
 *     while the DB knows the id (events created by the calendar reconciler or
 *     the assign auto-recover before v1.148 backfilled them) get patched.
 *  4. EXTRAS PATCH — the delivery-evidence/metadata cells (cols AE–AI:
 *     Delivered At/By, Cancel Reason, Episode Titles, Drive Box ID) that are
 *     blank while the DB has a value get filled — brings pre-existing rows in
 *     line with the widened export. Fill-blank-only, same shape as pass 3.
 *     NOTE: the query below excludes CANCELLED bookings (pass-1 scope), so
 *     Cancel Reason backfills only requested-but-kept rows.
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
// v1.237 — กันรันซ้อน. เราต์นี้ยาวพอจะโดน 504 ที่ proxy (ทีมนี้เจอซ้ำจนเป็นกฎว่า
// "504 แล้วห้ามยิงซ้ำ") แต่กฎที่พึ่งวินัยคนไม่ใช่กฎ — ยิงซ้ำระหว่างรอบก่อนยังไม่จบ
// จะทำให้ pass 1 append **แถวซ้ำ** ให้ใบเดียวกัน แล้ว byCode เลือกแถวแรก
// ⇒ CLAIM ชี้ไปแถวที่ไม่ใช่ตัวล่าสุด
let backfillRunning = false

export async function POST(request: NextRequest) {
  let holdsLock = false
  try {
    const session = await requireAdmin()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    const body = await request.json().catch(() => ({}))
    const apply = body?.apply === true
    const force = body?.force === true
    const agnOnly = process.env.BOOKINGS_EXPORT_AGN_ONLY === '1'

    if (apply) {
      if (backfillRunning) {
        return NextResponse.json(
          { error: 'รอบก่อนยังไม่จบ — รอให้จบก่อนค่อยยิงใหม่ (ยิงซ้อนจะได้แถวซ้ำในชีท)' },
          { status: 409 },
        )
      }
      backfillRunning = true
      holdsLock = true
    }

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
    //    + cols AE–AI (delivery evidence/metadata, for the pass-4 fill-blank)
    const sheets = google.sheets({ version: 'v4', auth: getSheetsReadAuth() })
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: getProducerDashboardSheetId(),
      range: `${getBookingsTabName()}!A2:AI`,
    })
    const sheetRows = res.data.values || []
    const byCode = new Map<string, { rowIndex: number; eventId: string; extras: string[] }>()
    // v1.237 — เดิมเก็บแถวแรกแล้วเงียบ · การเลือกแถวแรกถูกอยู่แล้ว แต่ "มี Production ID
    // ซ้ำสองแถวในชีท" เป็นเรื่องที่คนต้องรู้ ไม่ใช่กลืนหาย (มักเกิดจากการยิงเราต์นี้ซ้ำ
    // หลัง 504 — ซึ่ง backfillRunning กันไว้แล้ว แต่ของเก่าที่ค้างอยู่ยังต้องเห็น)
    const duplicateCodes = new Map<string, number[]>()
    sheetRows.forEach((row, i) => {
      const code = String(row[0] || '').trim()
      if (code && byCode.has(code)) {
        const list = duplicateCodes.get(code) || [byCode.get(code)!.rowIndex]
        list.push(i + 2)
        duplicateCodes.set(code, list)
      }
      if (code && !byCode.has(code)) {
        byCode.set(code, {
          rowIndex: i + 2,
          eventId: String(row[22] || '').trim(),
          // cols AE–AI = 0-based 30–34 (Delivered At, Delivered By,
          // Cancel Reason, Episode Titles, Drive Box ID)
          extras: [30, 31, 32, 33, 34].map(c => String(row[c] || '').trim()),
        })
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
      claim: [] as Array<{ code: string; rowIndex: number; was?: number | null; claimed?: boolean }>,
      patchEventId: [] as Array<{ code: string; eventId: string; patched?: boolean }>,
      patchExtras: [] as Array<{ code: string; fields: string[]; patched?: boolean }>,
      // v1.161.1 — คิวของ pass-4 apply (ยิงเป็น batch หลังจบ loop)
      skippedAgnOnly: 0,
      /** Production ID ที่มีมากกว่าหนึ่งแถวในชีท → [เลขแถวทั้งหมด] */
      duplicateCodes: {} as Record<string, number[]>,
      errors: [] as string[],
    }
    const pendingExtras: Array<{ entry: (typeof plan.patchExtras)[number]; rowIndex: number; extraFields: Record<string, string> }> = []

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
            // v1.237 — `null` = append ไม่สำเร็จ (โควตา/creds/หมดเวลา) แต่ไม่ throw
            // เดิมจึงไม่มีอะไรลง errors ⇒ สรุปตอบ errors: 0 ได้ทั้งที่ล้มทุกใบ
            if (rowIndex == null) plan.errors.push(`append ${code}: ไม่ได้เลขแถวกลับมา (โควตา/creds?)`)
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

      // v1.237 — เดิมเช็กแค่ `!booking.sheetRowIndex` (ว่าง = ยังไม่เคยจับคู่)
      // แต่ค่าที่ **ผิด** ก็ต้องซ่อมเหมือนกัน: `values.append` ที่ยิงพร้อมกันคืน
      // updatedRange ที่ไม่ตรงแถวจริง ทำให้มีใบเก็บเลขแถวของใบอื่น
      // (พรอด 2026-09-24: 39 ใบ — 34 จาก append ที่ยิงพร้อมกัน + 5 จากคนแทรก/ลบแถว
      // ในชีทเอง ซึ่งจะเกิดอีกได้เรื่อย ๆ pass นี้จึงเป็นตัวซ่อมประจำ ไม่ใช่ครั้งเดียวจบ)
      // แถวจริงมาจากคอลัมน์ A
      // ซึ่งเป็นสิ่งที่ updateBookingRow ใช้อยู่แล้ว จึงเป็นคำตอบที่เชื่อได้
      if (booking.sheetRowIndex !== inSheet.rowIndex) {
        const entry = { code, rowIndex: inSheet.rowIndex, was: booking.sheetRowIndex } as (typeof plan.claim)[number]
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
          // v1.237 — pass 4 มีคันเร่ง (1200ms/ก้อน) แต่ pass 3 ไม่มี ทั้งที่
          // updateBookingRow = 1 อ่าน + 1 เขียน ต่อใบ · ยิงรัวจะกินโควตาจนใบที่
          // คนกำลังสร้างอยู่ตอนนั้น append ไม่ผ่าน
          await new Promise(r => setTimeout(r, 1200))
        }
      }

      // Pass 4 — fill the blank AE–AI cells from the DB (fill-blank only, so a
      // value someone hand-fixed in the sheet is never overwritten). Datetime
      // format matches the deliver route's live patch (th-TH gregory, BKK).
      const [cellDeliveredAt, cellDeliveredBy, cellCancelReason, cellEpisodeTitles, cellDriveBoxId] = inSheet.extras
      const episodeTitlesJoined = joinEpisodeTitles(booking.episodes)
      const driveBoxId = getDriveLink(booking.driveFolders, 'box')
      const extraFields: Parameters<typeof updateBookingRow>[1] = {
        ...(booking.deliveredAt && !cellDeliveredAt
          ? { deliveredAt: new Date(booking.deliveredAt).toLocaleString('th-TH-u-ca-gregory', { timeZone: 'Asia/Bangkok' }) }
          : {}),
        ...(booking.deliveredBy && !cellDeliveredBy ? { deliveredBy: booking.deliveredBy } : {}),
        ...(booking.cancelReason && !cellCancelReason ? { cancelReason: booking.cancelReason } : {}),
        ...(episodeTitlesJoined && !cellEpisodeTitles ? { episodeTitles: episodeTitlesJoined } : {}),
        ...(driveBoxId && !cellDriveBoxId ? { driveBoxId } : {}),
      }
      if (Object.keys(extraFields).length > 0) {
        const entry = { code, fields: Object.keys(extraFields) } as (typeof plan.patchExtras)[number]
        plan.patchExtras.push(entry)
        // v1.161.1 — สะสมไว้ยิงเป็น batch เดียว (เดิมเรียก updateBookingRow รายแถว
        // = read+write ต่อแถว ~470 API calls สำหรับ 235 แถว → ชน Sheets quota
        // 60 write/นาที → GaxiosError ทุกแถว ไม่มีอะไรถูกเขียนเลย. rowIndex รู้
        // อยู่แล้วจากการอ่าน A2:AI ข้างบน จึงไม่ต้อง read ซ้ำ)
        if (apply) pendingExtras.push({ entry, rowIndex: inSheet.rowIndex, extraFields })
      }
    }

    // Pass 4 (apply) — ยิงทุก cell เป็น values.batchUpdate เป็นก้อน ๆ ละ ~100
    // ranges (≈20 แถว) พร้อมหน่วงเบา ๆ กัน quota: 235 แถว ≈ 12 calls แทน 470
    if (apply && pendingExtras.length > 0) {
      const COL_LETTER: Record<string, string> = { deliveredAt: 'AE', deliveredBy: 'AF', cancelReason: 'AG', episodeTitles: 'AH', driveBoxId: 'AI' }
      const tab = getBookingsTabName()
      const sheetsW = google.sheets({ version: 'v4', auth: getSheetsWriteAuth() })
      const allRanges: Array<{ range: string; values: string[][]; entry: (typeof plan.patchExtras)[number] }> = []
      for (const pe of pendingExtras) {
        for (const [k, v] of Object.entries(pe.extraFields)) {
          const col = COL_LETTER[k]
          if (!col || v === undefined) continue
          allRanges.push({ range: `${tab}!${col}${pe.rowIndex}`, values: [[String(v)]], entry: pe.entry })
        }
      }
      const CHUNK = 100
      for (let i = 0; i < allRanges.length; i += CHUNK) {
        const chunk = allRanges.slice(i, i + CHUNK)
        try {
          await sheetsW.spreadsheets.values.batchUpdate({
            spreadsheetId: getProducerDashboardSheetId(),
            requestBody: { valueInputOption: 'RAW', data: chunk.map(c => ({ range: c.range, values: c.values })) },
          })
          for (const c of chunk) c.entry.patched = true
        } catch (e: any) {
          plan.errors.push(`patchExtras batch ${i / CHUNK + 1}: ${e?.message || e}`)
        }
        if (i + CHUNK < allRanges.length) await new Promise(r => setTimeout(r, 1200))
      }
    }

    plan.duplicateCodes = Object.fromEntries(duplicateCodes)

    // v1.237 — การซ่อม sheetRowIndex เขียน DB หลายสิบแถวและ bump updatedAt
    // ต้องมีร่องรอยว่าใครสั่งและซ่อมอะไรไปบ้าง · แถวเดียวสรุปทั้งรอบ ถูกกว่าเขียน
    // ราย booking และตอบคำถาม "เลขนี้เปลี่ยนตอนไหน" ได้ครบพอ
    const repaired = plan.claim.filter(c => c.claimed && c.was != null)
    if (apply && repaired.length > 0) {
      logAudit({
        actorEmail: session.email,
        action: 'sheet.rowindex_repaired',
        entityType: 'Booking',
        changes: { count: repaired.length, fixed: repaired.map(c => ({ code: c.code, was: c.was, now: c.rowIndex })) },
      })
    }

    return NextResponse.json({
      ok: true,
      apply,
      summary: {
        append: plan.append.length,
        claim: plan.claim.length,
        patchEventId: plan.patchEventId.length,
        patchExtras: plan.patchExtras.length,
        skippedAgnOnly: plan.skippedAgnOnly,
        errors: plan.errors.length,
      },
      ...plan,
    })
  } catch (e: any) {
    console.error('POST /api/admin/backfill-bookings-sheet error:', e)

    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  } finally {
    if (holdsLock) backfillRunning = false
  }
}
