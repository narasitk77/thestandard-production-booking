// Bookings-tab row repair — a live booking whose create-time append failed still gets its row.
//
// WHY THIS FILE EXISTS. create-booking appends the row fire-and-forget; a failed append (quota 429,
// creds, timeout) left the booking in the DB with no row in the tab PMDC's Airtable sync reads, and
// nothing ever retried it (bug class 16: 12 rows lost 23 Sep 2026, 3 more by 13 Nov — each found only
// by comparing the sheet with the DB by hand). The calendar reconciler calls this every 10 minutes.
//
// Rules:
// - only bookings older than SHEET_REPAIR_GRACE_MS: a fresh one may still sit in the append queue
//   (same grace as backfill-bookings-sheet pass 1)
// - and only while no append is queued or running in this process (appendQueueIdle): a routine of a
//   few hundred bookings keeps the queue busy well past 5 minutes, and col A read before a queued
//   create-path append lands says "no row" for a booking that is about to get one
// - after our own append, a CAS miss means the booking got its row meanwhile = we just wrote a
//   duplicate. That lands in failed[] (alert) with the row to delete — never reported as appended OK.
// - col A is read FIRST. A code already there (the append landed but its index was never saved, or it
//   timed out after Google wrote it) is claimed, never appended again — a duplicate row is worse than a
//   missing one. Col A unreadable = append nothing (can't tell "no row" from "couldn't see") + alert.
// - SHEET_REPAIR_LIMIT per run, oldest first: each fixed booking leaves the set, so the queue drains.
//   One that fails every run stays at the head — that is what the alert is for.
// ponytail: in-process lock only; a manual backfill-bookings-sheet apply running in the same minute
// can still append the same booking twice (rare: the backfill is now rarely needed). Share one lock
// with the backfill route if that ever happens.
import { google } from 'googleapis'
import { prisma } from './db'
import { appendBookingRow, appendQueueIdle, getSheetsReadAuth, sheetsWriteConfigured } from './google-sheets'
import { getProducerDashboardSheetId, getBookingsTabName } from './google-config'
import { logAudit } from './audit'
import { alertOps } from './ops-alert'

export const SHEET_REPAIR_GRACE_MS = 5 * 60_000
export const SHEET_REPAIR_LIMIT = 20

export interface SheetRepairResult {
  dryRun: boolean
  /** bookings without a sheetRowIndex taken this run (≤ SHEET_REPAIR_LIMIT) */
  candidates: number
  /** more were waiting than this run took */
  more: boolean
  /** no row in col A → appended (dry run: would append) */
  append: Array<{ code: string; rowIndex?: number }>
  /** already in col A → sheetRowIndex set to that row (dry run: would set) */
  claim: Array<{ code: string; rowIndex: number }>
  failed: Array<{ code: string; error: string }>
  /** sheets are off in this process (no credentials / staging) — nothing to repair against ·
   *  append-queue-busy: an append is still queued/running, col A can't be trusted yet — next tick */
  skipped?: 'sheets-off' | 'already-running' | 'append-queue-busy'
}

let running = false

export async function repairMissingSheetRows(opts: { dryRun?: boolean; actorEmail?: string | null } = {}): Promise<SheetRepairResult> {
  const dryRun = !!opts.dryRun
  const out: SheetRepairResult = { dryRun, candidates: 0, more: false, append: [], claim: [], failed: [] }
  if (!dryRun && running) return { ...out, skipped: 'already-running' }
  if (!dryRun) running = true
  try {
    const rows = await prisma.booking.findMany({
      where: {
        deletedAt: null,
        status: { notIn: ['CANCELLED'] },
        sheetRowIndex: null,
        createdAt: { lt: new Date(Date.now() - SHEET_REPAIR_GRACE_MS) },
        // the create path exports AGN only under this kill-switch — the rest are meant to have no row
        ...(process.env.BOOKINGS_EXPORT_AGN_ONLY === '1' ? { outlet: { code: 'AGN' } } : {}),
      },
      include: { outlet: true, program: true, episodes: true },
      orderBy: { createdAt: 'asc' },
      take: SHEET_REPAIR_LIMIT + 1,
    })
    out.more = rows.length > SHEET_REPAIR_LIMIT
    const todo = rows.slice(0, SHEET_REPAIR_LIMIT)
    out.candidates = todo.length
    if (todo.length === 0) return out
    if (!sheetsWriteConfigured()) return { ...out, skipped: 'sheets-off' }
    if (!appendQueueIdle()) return { ...out, skipped: 'append-queue-busy' }

    let colA: Map<string, number>
    try {
      colA = await readColumnA()
    } catch (e: any) {
      const error = `อ่านคอลัมน์ A ไม่ได้ — ไม่ append (แยก "ไม่มีแถว" กับ "มองไม่เห็น" ไม่ได้): ${String(e?.message || e).slice(0, 200)}`
      out.failed = todo.map(b => ({ code: codeOf(b), error }))
      if (!dryRun) await alert(out)
      return out
    }

    for (const b of todo) {
      const code = codeOf(b)
      const at = colA.get(code)
      if (at) {
        out.claim.push({ code, rowIndex: at })
        if (!dryRun) {
          // CAS on null: the create path's own late index write wins if it lands first
          await prisma.booking.updateMany({ where: { id: b.id, sheetRowIndex: null }, data: { sheetRowIndex: at } })
            .catch((e: any) => { out.failed.push({ code, error: `เจอแถว ${at} แต่บันทึก sheetRowIndex ไม่ได้: ${e?.message || e}` }) })
        }
        continue
      }
      const entry: SheetRepairResult['append'][number] = { code }
      out.append.push(entry)
      if (dryRun) continue
      const rowIndex = await appendBookingRow({ ...b, shootDate: b.shootDate, createdAt: b.createdAt })
      if (!rowIndex) {
        out.failed.push({ code, error: 'append ไม่ได้เลขแถวกลับมา (โควตา/creds/หมดเวลา — ดู log "appendBookingRow error")' })
        continue
      }
      entry.rowIndex = rowIndex
      // the row IS in the sheet now; an unsaved index is claimed from col A next run, so log, don't alert
      const saved = await prisma.booking.updateMany({ where: { id: b.id, sheetRowIndex: null }, data: { sheetRowIndex: rowIndex } })
        .catch((e: any) => {
          console.error(`[sheet-row-repair] ${code}: appended row ${rowIndex} but saving sheetRowIndex failed — claimed next run:`, e?.message || e)
          return null
        })
      // count 0 = the booking already holds a row (its create-path append landed after col A was read)
      const duplicate = saved?.count === 0
      if (duplicate) {
        out.failed.push({ code, error: `แถว ${rowIndex} ที่เพิ่ง append เป็นแถวซ้ำ — ใบนี้มีแถวในชีทอยู่แล้ว · ลบแถว ${rowIndex} (คอลัมน์ A = ${code}) เอง ระบบไม่ลบให้` })
      }
      await logAudit({
        actorEmail: opts.actorEmail ?? 'sheet-row-repair',
        action: 'sheet.row_appended',
        entityType: 'Booking',
        entityId: b.id,
        bookingCode: b.bookingCode,
        changes: { rowIndex, via: 'sheet-row-repair', ...(duplicate ? { duplicate: true } : {}) },
      })
    }

    const claimed = out.claim.filter(c => !out.failed.some(f => f.code === c.code))
    if (!dryRun && claimed.length > 0) {
      await logAudit({
        actorEmail: opts.actorEmail ?? 'sheet-row-repair',
        action: 'sheet.rowindex_repaired',
        entityType: 'Booking',
        changes: { count: claimed.length, fixed: claimed.map(c => ({ code: c.code, was: null, now: c.rowIndex })), via: 'sheet-row-repair' },
      })
    }
    const appended = out.append.filter(a => a.rowIndex).map(a => `${a.code}→${a.rowIndex}`)
    if (appended.length || claimed.length) {
      console.log(`[sheet-row-repair] appended ${appended.length} (${appended.join(', ')}) · claimed ${claimed.length}`)
    }
    if (!dryRun && out.failed.length > 0) await alert(out)
    return out
  } finally {
    if (!dryRun) running = false
  }
}

const codeOf = (b: { bookingCode: string | null; id: string }) => (b.bookingCode || b.id).trim()

/** col A (Production ID) → first row holding it — the same "first row wins" as the backfill route */
async function readColumnA(): Promise<Map<string, number>> {
  const sheets = google.sheets({ version: 'v4', auth: getSheetsReadAuth() })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getProducerDashboardSheetId(),
    range: `${getBookingsTabName()}!A2:A`,
  }, { timeout: 30_000 })
  const byCode = new Map<string, number>()
  ;(res.data.values || []).forEach((row, i) => {
    const code = String(row?.[0] || '').trim()
    if (code && !byCode.has(code)) byCode.set(code, i + 2)
  })
  return byCode
}

async function alert(r: SheetRepairResult) {
  const lines = r.failed.slice(0, 15).map(f => `${f.code}: ${f.error}`)
  if (r.failed.length > 15) lines.push(`…และอีก ${r.failed.length - 15} ใบ`)
  await alertOps('sheet-row-repair', `⚠️ ซ่อมแถวชีต Bookings ไม่สำเร็จ ${r.failed.length} ใบ — Production Booking`,
    `ใบจองที่ไม่มีแถวในแท็บ Bookings (PMDC/Airtable ไม่เห็นงานพวกนี้) — รอบซ่อมเติมไม่สำเร็จ หรือเติมแล้วได้แถวซ้ำ:\n  ${lines.join('\n  ')}\n` +
    (r.more ? `(ยังมีใบที่รอคิวซ่อมอีก — รอบละ ${SHEET_REPAIR_LIMIT} ใบ)\n` : '') +
    `แถวที่ยังขาด: ระบบลองใหม่เองทุก 10 นาที (calendar-reconcile) · ถ้ายังค้าง ดู log "appendBookingRow error" ` +
    `แล้วซ่อมด้วย POST /api/admin/backfill-bookings-sheet (dry-run ก่อน) · แถวซ้ำ: ลบแถวที่บอกด้วยมือ`)
}
