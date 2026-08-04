/**
 * v1.162 — Auto-tick "footage ส่งแล้ว" ลงชีท footage log ของปุ๊ก
 * (https://docs.google.com/spreadsheets/d/1KMmbPjbRnd6Deb-…)
 *
 * ที่มา: ปุ๊กขอ "ถ้า Footage อัพครบแล้วฝากให้เด็กมาติ๊กในชีทนี้" — แต่เด็กกดปุ่ม
 * "ส่งงาน" ใน probook อยู่แล้ว (deliveredAt/By) ระบบจึงติ๊กแทนได้เลย ไม่ต้อง
 * พึ่งคนติ๊กมือ (ลืมไม่ได้ พลาดไม่ได้)
 *
 * การจับคู่แถว (เท่าที่ผูกได้ — คำสั่ง operator 2026-08-04):
 *   1. คอลัมน์ H "Production ID" == bookingCode
 *   2. คอลัมน์ A "Folder ID"     == driveFolders.box (id-first — ทนการเปลี่ยนชื่อ)
 * แถวยุคก่อนระบบที่ไม่มีทั้งสองอย่างจะไม่ถูกแตะ (ปุ๊กติ๊กมือเองได้ ค่าเดิมไม่ถูกทับ)
 *
 * กติกาเดียวกับ footage-sheet.ts: ไม่แตะโครงคอลัมน์ของเจ้าของชีท — เขียนแค่
 * คอลัมน์ P (ต่อท้าย 15 คอลัมน์เดิม) + header P1 เฉพาะตอนที่ยังว่าง
 * Auth: SA (ชีทต้องแชร์ Editor ให้ GOOGLE_SERVICE_ACCOUNT_EMAIL); บน staging
 * โดน assertStagingSheetsAllowed ใน getSheetsWriteAuth ตัดให้อยู่แล้ว
 */
import { google } from 'googleapis'
import { getSheetsWriteAuth } from './google-sheets'
import { prisma } from './db'
import { getDriveLink } from './drive-links'

const DEFAULT_SHEET_ID = '1KMmbPjbRnd6Deb-ct253YMmoINuLgTDnS4Id2lPA5VI'
export function deliveryTickSheetId(): string {
  return process.env.DELIVERY_TICK_SHEET_ID?.trim() || DEFAULT_SHEET_ID
}
export function deliveryTickEnabled(): boolean {
  return process.env.DELIVERY_TICK_ENABLED?.trim() !== '0'
}

const TICK_COL_INDEX = 15 // 0-based P — ต่อท้าย A..O (15 คอลัมน์เดิมของชีท)
const TICK_COL = 'P'
const HEADER = 'Delivered ✅ (auto จาก probook)'

export function fmtTick(deliveredAt: Date | string, deliveredBy?: string | null): string {
  const dt = new Date(deliveredAt).toLocaleString('th-TH-u-ca-gregory', { timeZone: 'Asia/Bangkok' })
  return deliveredBy ? `✅ ${dt} · ${deliveredBy}` : `✅ ${dt}`
}

export interface DeliveredKey {
  code: string
  boxId: string | null
  tick: string
}

/**
 * จับคู่แถวชีทกับ booking ที่ส่งงานแล้ว (pure — เทสต์ได้โดยไม่แตะ API)
 * คืนเฉพาะแถวที่ช่องติ๊ก (index 15) ยังว่าง — ไม่ทับสิ่งที่คน/รอบก่อนเขียนไว้
 */
export function matchDeliveredRows(
  sheetRows: string[][],
  delivered: DeliveredKey[],
): Array<{ rowIndex: number; value: string; code: string }> {
  const byCode = new Map<string, DeliveredKey>()
  const byBoxId = new Map<string, DeliveredKey>()
  for (const d of delivered) {
    if (d.code) byCode.set(d.code.trim().toUpperCase(), d)
    if (d.boxId) byBoxId.set(d.boxId, d)
  }
  const out: Array<{ rowIndex: number; value: string; code: string }> = []
  sheetRows.forEach((row, i) => {
    const existingTick = String(row[TICK_COL_INDEX] || '').trim()
    if (existingTick) return
    const folderId = String(row[0] || '').trim()
    const productionId = String(row[7] || '').trim().toUpperCase()
    const hit = (productionId && byCode.get(productionId)) || (folderId && byBoxId.get(folderId)) || null
    if (hit) out.push({ rowIndex: i + 2, value: hit.tick, code: hit.code })
  })
  return out
}

/** โหลด booking ที่กดส่งงานแล้วทั้งหมดจาก DB → คีย์จับคู่ */
async function loadDeliveredKeys(): Promise<DeliveredKey[]> {
  const rows = await prisma.booking.findMany({
    where: { deliveredAt: { not: null }, deletedAt: null, bookingCode: { not: null } },
    select: { bookingCode: true, driveFolders: true, deliveredAt: true, deliveredBy: true },
  })
  return rows.map(r => ({
    code: r.bookingCode!,
    boxId: getDriveLink(r.driveFolders, 'box'),
    tick: fmtTick(r.deliveredAt!, r.deliveredBy),
  }))
}

/**
 * Backfill/sweep: อ่านชีทครั้งเดียว จับคู่ทั้งหมด เขียนเป็น batch เดียว
 * (บทเรียน v1.161.1: ห้ามยิงรายแถว — ชน Sheets quota)
 */
export async function runDeliveryTick(opts: { apply?: boolean } = {}): Promise<{
  ok: boolean; reason?: string; sheetRows: number; delivered: number
  matched: Array<{ rowIndex: number; code: string }>; headerWritten?: boolean
}> {
  const empty = { sheetRows: 0, delivered: 0, matched: [] as Array<{ rowIndex: number; code: string }> }
  if (!deliveryTickEnabled()) return { ok: false, reason: 'DELIVERY_TICK_ENABLED=0', ...empty }
  const sheets = google.sheets({ version: 'v4', auth: getSheetsWriteAuth() })
  const sheetId = deliveryTickSheetId()

  // อ่านช่วง A:P ของแท็บแรก (ไม่ระบุชื่อแท็บ = แท็บแรก — ชีทปุ๊กมีแท็บเดียว)
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `A1:${TICK_COL}` })
  const all = (res.data.values || []) as string[][]
  if (all.length === 0) return { ok: false, reason: 'sheet ว่าง/อ่านไม่ได้', ...empty }
  const headerRow = all[0]
  const dataRows = all.slice(1)

  const delivered = await loadDeliveredKeys()
  const matched = matchDeliveredRows(dataRows, delivered)
  const headerBlank = !String(headerRow[TICK_COL_INDEX] || '').trim()

  if (opts.apply && (matched.length > 0 || headerBlank)) {
    const data: Array<{ range: string; values: string[][] }> = []
    if (headerBlank) data.push({ range: `${TICK_COL}1`, values: [[HEADER]] })
    for (const m of matched) data.push({ range: `${TICK_COL}${m.rowIndex}`, values: [[m.value]] })
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: 'RAW', data },
    })
  }
  return {
    ok: true, sheetRows: dataRows.length, delivered: delivered.length,
    matched: matched.map(m => ({ rowIndex: m.rowIndex, code: m.code })),
    headerWritten: opts.apply ? headerBlank : undefined,
  }
}

/**
 * Hook ตอนเด็กกด "ส่งงาน" — ติ๊กเฉพาะงานนั้น (อ่านชีท 1 ครั้ง เขียน ≤ ไม่กี่ cell)
 * fire-and-forget: พังเงียบพร้อม log — การส่งงานต้องไม่ล้มเพราะชีท
 */
export async function tickDeliveredBooking(b: {
  bookingCode: string | null
  driveFolders: unknown
  deliveredAt: Date | string
  deliveredBy?: string | null
}): Promise<void> {
  try {
    if (!deliveryTickEnabled() || !b.bookingCode) return
    const sheets = google.sheets({ version: 'v4', auth: getSheetsWriteAuth() })
    const sheetId = deliveryTickSheetId()
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `A2:${TICK_COL}` })
    const rows = (res.data.values || []) as string[][]
    const matched = matchDeliveredRows(rows, [{
      code: b.bookingCode,
      boxId: getDriveLink(b.driveFolders, 'box'),
      tick: fmtTick(b.deliveredAt, b.deliveredBy),
    }])
    if (matched.length === 0) return
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: 'RAW', data: matched.map(m => ({ range: `${TICK_COL}${m.rowIndex}`, values: [[m.value]] })) },
    })
  } catch (e: any) {
    console.error('[delivery-tick] failed (non-fatal):', e?.message || e)
  }
}
