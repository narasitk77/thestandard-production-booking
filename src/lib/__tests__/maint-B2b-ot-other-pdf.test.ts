/**
 * Maintenance 2026-11-08 — OT cover-sheet PDF.
 *  1. Past ~19 days per person the row loop `break`-ed: remaining days were never
 *     drawn, each later day added a blank page, yet the totals counted the whole
 *     month (25 days → 6 pages, ~20 rows).
 *  2. The signature dates were Buddhist 2-digit years in UTC while the table is
 *     Gregorian.
 *  3. The total silently included rows no manager approved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { generateOTCoverSheetPdf, fmtDateTimeTh, type OTPdfRecord } from '../ot-pdf'

// Each drawn table row = date, day type, time, task, status, THB, justification.
const TJ_PER_ROW = 7

function rec(i: number, status: OTPdfRecord['approvalStatus'] = 'APPROVED'): OTPdfRecord {
  return {
    id: `r${i}`, date: `2026-10-${String(i + 1).padStart(2, '0')}`, endDate: null,
    startTime: '09:00', endTime: '20:00', jobTask: '[Auto] NWS·KYM', justification: 'Auto-generated',
    approvalStatus: status, submittedAt: null, approvedAt: null, approvedByEmail: null,
    requesterSignaturePng: null, approverSignaturePng: null, bookingId: 'b1',
  }
}

async function render(records: OTPdfRecord[]): Promise<number[]> {
  const bytes = await generateOTCoverSheetPdf([{ email: 'cam@thestandard.co', thaiName: null, employeeId: null, position: null, records }], '2026-10')
  const doc = await PDFDocument.load(bytes)
  return doc.getPages().map(p => {
    const c = p.node.Contents()
    const streams = c instanceof PDFArray ? c.asArray().map(x => doc.context.lookup(x)) : [c]
    let ops = ''
    for (const s of streams) ops += Buffer.from(decodePDFRawStream(s as PDFRawStream).decode()).toString('latin1')
    return (ops.match(/Tj/g) || []).length // text-show operators drawn on the page
  })
}

test('25 days for one person: every row is drawn, on 2 pages — no blank pages', async () => {
  const pages = await render(Array.from({ length: 25 }, (_, i) => rec(i)))
  assert.equal(pages.length, 2, `expected 2 pages, got ${pages.length}`)
  assert.ok(pages.every(n => n > 10), `a page with almost nothing on it: ${pages}`)
  const total = pages.reduce((a, b) => a + b, 0)
  assert.ok(total >= 25 * TJ_PER_ROW, `only ${total} text ops — rows were dropped`)
})

test('few days still fit on one page (unchanged layout)', async () => {
  const pages = await render([rec(0), rec(1), rec(2)])
  assert.equal(pages.length, 1)
})

test('rows no manager approved are called out under the total', async () => {
  // 3 Oct 2026 is a Saturday → 500 THB either way
  const allApproved = await render([rec(0), rec(1), rec(2)])
  const oneDraft = await render([rec(0), rec(1), rec(2, 'DRAFT')])
  assert.equal(oneDraft[0], allApproved[0] + 1, 'one extra line: "* ยอดนี้รวมรายการที่ยังไม่อนุมัติ …"')
})

test('signature date: Gregorian year, Bangkok day (01:30 BKK on 6 Nov = 05 Nov 18:30 UTC)', () => {
  assert.equal(fmtDateTimeTh('2026-11-05T18:30:00Z'), '06/11/26')
  assert.equal(fmtDateTimeTh(null), '—')
})
