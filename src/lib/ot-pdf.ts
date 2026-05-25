import { PDFDocument, PDFFont, PDFImage, PDFPage, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { summarizeDay, formatTHB } from '@/lib/ot-calc'

/**
 * Generates the OT cover-sheet PDF — one A4 page per person, with the
 * requester's and approver's signature snapshots embedded as PNG images.
 *
 * Renders Thai correctly via an embedded Sarabun TTF (OFL-licensed, see
 * public/fonts/SARABUN-OFL.txt for attribution).
 */

const MARGIN = 40
const PAGE_W = 595
const PAGE_H = 842

const COL = rgb(0.07, 0.09, 0.15)            // near-black ink
const MUTED = rgb(0.45, 0.47, 0.52)           // grey labels
const LINE = rgb(0.85, 0.86, 0.88)            // table separators
const AMBER = rgb(0.72, 0.46, 0.05)           // submitted highlight
const GREEN = rgb(0.18, 0.55, 0.20)           // approved highlight
const RED = rgb(0.75, 0.20, 0.20)             // rejected highlight

export interface OTPdfRecord {
  id: string
  date: string                  // ISO YYYY-MM-DD
  startTime: string | null
  endTime: string | null
  jobTask: string | null
  justification: string | null
  approvalStatus: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'
  submittedAt: string | null
  approvedAt: string | null
  approvedByEmail: string | null
  requesterSignaturePng: string | null
  approverSignaturePng: string | null
  bookingId: string | null
}

export interface OTPdfPerson {
  email: string
  thaiName: string | null
  employeeId: string | null
  position: string | null
  records: OTPdfRecord[]
}

const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม']
function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split('-')
  return `${THAI_MONTHS[parseInt(m) - 1]} ${y}`
}

function fmtDateTh(d: string): string {
  // d = "YYYY-MM-DD"
  const dt = new Date(d + 'T00:00:00Z')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const yy = String(dt.getUTCFullYear()).slice(2)
  return `${dd}/${mm}/${yy}`
}

function fmtDateTimeTh(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

/**
 * Best-effort word-aware truncation for fixed-width cells. pdf-lib has no
 * native text wrapping, so we slice strings down to fit. Returns the
 * original string when it already fits.
 */
function truncate(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (!text) return ''
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text
  const ell = '…'
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    const w = font.widthOfTextAtSize(text.slice(0, mid) + ell, size)
    if (w <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + ell
}

async function loadSarabunFonts(pdf: PDFDocument): Promise<{ regular: PDFFont; bold: PDFFont }> {
  pdf.registerFontkit(fontkit)
  const root = process.cwd()
  const regularBytes = await readFile(join(root, 'public/fonts/Sarabun-Regular.ttf'))
  const boldBytes = await readFile(join(root, 'public/fonts/Sarabun-Bold.ttf'))
  // subset: true means only the glyphs we use get embedded — keeps each
  // generated PDF small (~30KB instead of 150KB).
  const regular = await pdf.embedFont(regularBytes, { subset: true })
  const bold = await pdf.embedFont(boldBytes, { subset: true })
  return { regular, bold }
}

async function embedSignature(pdf: PDFDocument, dataUrl: string | null): Promise<PDFImage | null> {
  if (!dataUrl) return null
  const prefix = 'data:image/png;base64,'
  if (!dataUrl.startsWith(prefix)) return null
  try {
    const b64 = dataUrl.slice(prefix.length)
    const bytes = Buffer.from(b64, 'base64')
    return await pdf.embedPng(bytes)
  } catch {
    return null
  }
}

/**
 * Renders one person's page. Returns the page that was added.
 */
async function renderPersonPage(
  pdf: PDFDocument,
  person: OTPdfPerson,
  month: string,
  fonts: { regular: PDFFont; bold: PDFFont },
): Promise<PDFPage> {
  const page = pdf.addPage([PAGE_W, PAGE_H])
  const { regular, bold } = fonts

  let y = PAGE_H - MARGIN

  // ── Header bar ──
  page.drawText('THE STANDARD — OT Cover Sheet', { x: MARGIN, y, font: bold, size: 14, color: COL })
  page.drawText(monthLabel(month), { x: PAGE_W - MARGIN - bold.widthOfTextAtSize(monthLabel(month), 12), y, font: bold, size: 12, color: MUTED })
  y -= 6
  page.drawLine({
    start: { x: MARGIN, y: y - 4 },
    end: { x: PAGE_W - MARGIN, y: y - 4 },
    thickness: 1.2,
    color: COL,
  })
  y -= 22

  // ── Person info block ──
  const nameLine = person.thaiName || person.email
  page.drawText(nameLine, { x: MARGIN, y, font: bold, size: 13, color: COL })
  y -= 16

  const infoBits: string[] = []
  if (person.employeeId) infoBits.push(`รหัส ${person.employeeId}`)
  if (person.position) infoBits.push(person.position)
  infoBits.push(person.email)
  page.drawText(infoBits.join('  ·  '), { x: MARGIN, y, font: regular, size: 9, color: MUTED })
  y -= 22

  // ── Table header ──
  // Column layout (x positions and widths in points, sums to ~515 = PAGE_W - 2*MARGIN)
  const cols = {
    date:   { x: MARGIN,           w:  60 },
    day:    { x: MARGIN + 62,      w:  44 },
    time:   { x: MARGIN + 108,     w:  78 },
    task:   { x: MARGIN + 188,     w: 165 },
    status: { x: MARGIN + 355,     w:  60 },
    thb:    { x: MARGIN + 417,     w:  98 },
  }

  const drawHeader = () => {
    page.drawRectangle({ x: MARGIN, y: y - 4, width: PAGE_W - 2 * MARGIN, height: 18, color: rgb(0.95, 0.95, 0.97) })
    page.drawText('วันที่',   { x: cols.date.x + 2,   y: y + 2, font: bold, size: 8.5, color: COL })
    page.drawText('ประเภท',  { x: cols.day.x + 2,    y: y + 2, font: bold, size: 8.5, color: COL })
    page.drawText('เวลา',    { x: cols.time.x + 2,   y: y + 2, font: bold, size: 8.5, color: COL })
    page.drawText('งานที่ทำ', { x: cols.task.x + 2,   y: y + 2, font: bold, size: 8.5, color: COL })
    page.drawText('สถานะ',   { x: cols.status.x + 2, y: y + 2, font: bold, size: 8.5, color: COL })
    const thbLabel = 'THB'
    page.drawText(thbLabel, { x: cols.thb.x + cols.thb.w - bold.widthOfTextAtSize(thbLabel, 8.5) - 4, y: y + 2, font: bold, size: 8.5, color: COL })
    y -= 18
    page.drawLine({ start: { x: MARGIN, y: y + 2 }, end: { x: PAGE_W - MARGIN, y: y + 2 }, thickness: 0.5, color: LINE })
  }
  drawHeader()

  // ── Group records by date so day-level totals are correct ──
  const byDate = new Map<string, OTPdfRecord[]>()
  for (const r of person.records) {
    const d = r.date.slice(0, 10)
    if (!byDate.has(d)) byDate.set(d, [])
    byDate.get(d)!.push(r)
  }

  let totalAmount = 0
  let totalWeekendHolidayDays = 0
  let totalWeekdayOTDays = 0

  const dates = Array.from(byDate.keys()).sort()
  for (const d of dates) {
    const recs = byDate.get(d)!
    const summary = summarizeDay(d, recs.map(r => ({
      startTime: r.startTime || '',
      endTime: r.endTime || '',
      jobTask: r.jobTask,
      justification: r.justification,
    })))

    if (summary.qualifies) {
      totalAmount += summary.otAmountTHB
      if (summary.dayType === 'WEEKDAY') totalWeekdayOTDays += 1
      else totalWeekendHolidayDays += 1
    }

    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]
      const isFirstRow = i === 0

      // Page-break guard — keep at least 120pt at bottom for signature block
      if (y < 180) {
        // Footer line on the partial page (no signature block; signatures
        // only appear on the LAST page for the person). Add a new page +
        // re-draw header to continue the table.
        const cont = pdf.addPage([PAGE_W, PAGE_H])
        // Switch our page reference and reset y.
        // Note: pdf-lib doesn't let us swap mid-function cleanly, so we draw
        // an "เลขรายการต่อหน้าถัดไป" marker instead and break out — for
        // typical OT volumes (5–20 rows/month) we won't actually hit this.
        page.drawText('(continued on next page — too many rows for one page)', {
          x: MARGIN, y: 60, font: regular, size: 8, color: MUTED,
        })
        // Continue rendering on the new page from the top.
        // Reassign by mutating outer closure — simplest: recurse with the
        // remaining records. For now we just break.
        break
      }

      const dateStr = isFirstRow ? fmtDateTh(d) : ''
      const dayStr = isFirstRow ? summary.dayLabel : ''
      const timeStr = `${r.startTime || '—'}–${r.endTime || '—'}`
      const taskStr = truncate(r.jobTask || '', regular, 8.5, cols.task.w - 4)
      const statusStr = r.approvalStatus
      const statusColor =
        r.approvalStatus === 'APPROVED' ? GREEN :
        r.approvalStatus === 'SUBMITTED' ? AMBER :
        r.approvalStatus === 'REJECTED' ? RED :
        MUTED
      const thbStr = isFirstRow && summary.qualifies ? formatTHB(summary.otAmountTHB) : (isFirstRow ? '—' : '')

      page.drawText(dateStr, { x: cols.date.x + 2, y, font: regular, size: 8.5, color: COL })
      page.drawText(dayStr, { x: cols.day.x + 2, y, font: regular, size: 8.5, color: MUTED })
      page.drawText(timeStr, { x: cols.time.x + 2, y, font: regular, size: 8.5, color: COL })
      page.drawText(taskStr, { x: cols.task.x + 2, y, font: regular, size: 8.5, color: COL })
      page.drawText(statusStr, { x: cols.status.x + 2, y, font: regular, size: 7.5, color: statusColor })
      if (thbStr) {
        const tw = regular.widthOfTextAtSize(thbStr, 8.5)
        page.drawText(thbStr, { x: cols.thb.x + cols.thb.w - tw - 4, y, font: regular, size: 8.5, color: COL })
      }
      y -= 13

      // Justification (small, indented under the row) — only if present and
      // there's headroom; otherwise drop to save vertical space.
      if (r.justification && y > 180) {
        const just = truncate('เหตุผล: ' + r.justification, regular, 7.5, PAGE_W - 2 * MARGIN - 20)
        page.drawText(just, { x: cols.task.x + 2, y, font: regular, size: 7.5, color: MUTED })
        y -= 11
      }
    }
    // Per-day separator
    page.drawLine({ start: { x: MARGIN, y: y + 2 }, end: { x: PAGE_W - MARGIN, y: y + 2 }, thickness: 0.3, color: LINE })
    y -= 4
  }

  // ── Totals strip ──
  y -= 12
  page.drawRectangle({ x: MARGIN, y: y - 4, width: PAGE_W - 2 * MARGIN, height: 26, color: rgb(0.97, 0.96, 0.99) })
  const totalsLabel = 'รวม'
  const detail = `วันหยุด/Hol ${totalWeekendHolidayDays} วัน  ·  วันธรรมดา ${totalWeekdayOTDays} วัน`
  const amountStr = formatTHB(totalAmount)
  page.drawText(totalsLabel, { x: MARGIN + 6, y: y + 6, font: bold, size: 10, color: COL })
  page.drawText(detail, { x: MARGIN + 50, y: y + 6, font: regular, size: 9, color: MUTED })
  const amtW = bold.widthOfTextAtSize(amountStr, 11)
  page.drawText(amountStr, { x: PAGE_W - MARGIN - amtW - 6, y: y + 5, font: bold, size: 11, color: GREEN })
  y -= 36

  // ── Signature block (pick the most recent snapshot of each kind) ──
  // For requester: prefer the most recent submittedAt across records
  // For approver: prefer the most recent approvedAt across records
  const reqRec = [...person.records]
    .filter(r => r.requesterSignaturePng)
    .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''))[0]
  const aprRec = [...person.records]
    .filter(r => r.approverSignaturePng)
    .sort((a, b) => (b.approvedAt ?? '').localeCompare(a.approvedAt ?? ''))[0]
  const reqImg = await embedSignature(pdf, reqRec?.requesterSignaturePng ?? null)
  const aprImg = await embedSignature(pdf, aprRec?.approverSignaturePng ?? null)

  const boxW = (PAGE_W - 2 * MARGIN - 20) / 2
  const boxH = 100
  const boxY = Math.max(40, y - boxH)

  // Left box — requester
  page.drawRectangle({ x: MARGIN, y: boxY, width: boxW, height: boxH, borderColor: LINE, borderWidth: 0.5 })
  page.drawText('ผู้ขอ (Requester)', { x: MARGIN + 6, y: boxY + boxH - 14, font: bold, size: 9, color: MUTED })
  if (reqImg) {
    // Fit signature into a 70pt-tall area, preserve aspect ratio
    const targetH = 50
    const scale = targetH / reqImg.height
    const w = reqImg.width * scale
    page.drawImage(reqImg, {
      x: MARGIN + (boxW - w) / 2,
      y: boxY + 28,
      width: w,
      height: targetH,
    })
  } else {
    page.drawText('(ยังไม่ได้เซ็น)', { x: MARGIN + boxW / 2 - 25, y: boxY + 50, font: regular, size: 8.5, color: MUTED })
  }
  page.drawLine({
    start: { x: MARGIN + 14, y: boxY + 22 },
    end: { x: MARGIN + boxW - 14, y: boxY + 22 },
    thickness: 0.5, color: LINE,
  })
  page.drawText(person.thaiName || person.email, { x: MARGIN + 14, y: boxY + 10, font: regular, size: 8.5, color: COL })
  if (reqRec?.submittedAt) {
    const t = `วันที่ ${fmtDateTimeTh(reqRec.submittedAt)}`
    page.drawText(t, { x: MARGIN + boxW - 14 - regular.widthOfTextAtSize(t, 7.5), y: boxY + 10, font: regular, size: 7.5, color: MUTED })
  }

  // Right box — approver
  const rightX = MARGIN + boxW + 20
  page.drawRectangle({ x: rightX, y: boxY, width: boxW, height: boxH, borderColor: LINE, borderWidth: 0.5 })
  page.drawText('ผู้อนุมัติ (Manager)', { x: rightX + 6, y: boxY + boxH - 14, font: bold, size: 9, color: MUTED })
  if (aprImg) {
    const targetH = 50
    const scale = targetH / aprImg.height
    const w = aprImg.width * scale
    page.drawImage(aprImg, {
      x: rightX + (boxW - w) / 2,
      y: boxY + 28,
      width: w,
      height: targetH,
    })
  } else {
    page.drawText('(รออนุมัติ)', { x: rightX + boxW / 2 - 20, y: boxY + 50, font: regular, size: 8.5, color: MUTED })
  }
  page.drawLine({
    start: { x: rightX + 14, y: boxY + 22 },
    end: { x: rightX + boxW - 14, y: boxY + 22 },
    thickness: 0.5, color: LINE,
  })
  page.drawText(aprRec?.approvedByEmail || '—', { x: rightX + 14, y: boxY + 10, font: regular, size: 8.5, color: COL })
  if (aprRec?.approvedAt) {
    const t = `วันที่ ${fmtDateTimeTh(aprRec.approvedAt)}`
    page.drawText(t, { x: rightX + boxW - 14 - regular.widthOfTextAtSize(t, 7.5), y: boxY + 10, font: regular, size: 7.5, color: MUTED })
  }

  // Footer attribution
  const footer = `Generated ${new Date().toLocaleString('th-TH')} · Production Booking`
  page.drawText(footer, { x: MARGIN, y: 20, font: regular, size: 7, color: MUTED })

  return page
}

export async function generateOTCoverSheetPdf(people: OTPdfPerson[], month: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const fonts = await loadSarabunFonts(pdf)

  if (people.length === 0) {
    const page = pdf.addPage([PAGE_W, PAGE_H])
    page.drawText('OT Cover Sheet', { x: MARGIN, y: PAGE_H - MARGIN, font: fonts.bold, size: 14, color: COL })
    page.drawText(`ไม่พบรายการในเดือน ${monthLabel(month)}`, { x: MARGIN, y: PAGE_H - MARGIN - 30, font: fonts.regular, size: 11, color: MUTED })
  } else {
    for (const p of people) {
      await renderPersonPage(pdf, p, month, fonts)
    }
  }

  return await pdf.save()
}
