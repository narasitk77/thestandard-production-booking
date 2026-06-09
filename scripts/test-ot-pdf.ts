// One-shot smoke test for the OT PDF generator. Not part of the app
// runtime — run via:
//   npx tsx scripts/test-ot-pdf.ts
// and inspect the resulting /tmp/test-ot.pdf.

import { generateOTCoverSheetPdf, type OTPdfPerson } from '../src/lib/ot-pdf'
import { writeFile } from 'fs/promises'

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const person: OTPdfPerson = {
  email: 'test@thestandard.co',
  thaiName: 'ทดสอบ ลายเซ็น',
  employeeId: 'TSD00999',
  position: 'Videographer',
  records: [
    {
      id: '1',
      date: '2026-05-03',
      endDate: null,
      startTime: '09:00', endTime: '18:00',
      jobTask: 'ถ่ายทำ Key Message EP.5 — Studio 1',
      justification: 'งานวันอาทิตย์ตามตารางออกอากาศ',
      approvalStatus: 'APPROVED',
      submittedAt: '2026-05-04T03:00:00Z',
      approvedAt: '2026-05-05T08:00:00Z',
      approvedByEmail: 'manager@thestandard.co',
      requesterSignaturePng: PNG_1x1,
      approverSignaturePng: PNG_1x1,
      bookingId: null,
    },
    {
      id: '2',
      date: '2026-05-15',
      endDate: null,
      startTime: '08:00', endTime: '20:30',
      jobTask: 'Live event ยืดเวลา — Standby + ถ่ายทำ',
      justification: 'Live event เกินเวลา 2 ชั่วโมง',
      approvalStatus: 'SUBMITTED',
      submittedAt: '2026-05-16T03:00:00Z',
      approvedAt: null, approvedByEmail: null,
      requesterSignaturePng: PNG_1x1, approverSignaturePng: null,
      bookingId: null,
    },
    {
      id: '3',
      date: '2026-05-22',
      endDate: null,
      startTime: '14:00', endTime: '16:00',
      jobTask: 'Standby กองถ่าย Event',
      justification: 'รอลูกค้ามาถ่าย',
      approvalStatus: 'REJECTED',
      submittedAt: '2026-05-23T03:00:00Z',
      approvedAt: null, approvedByEmail: null,
      requesterSignaturePng: PNG_1x1, approverSignaturePng: null,
      bookingId: null,
    },
  ],
}

async function main() {
  console.log('Generating PDF...')
  const bytes = await generateOTCoverSheetPdf([person], '2026-05')
  await writeFile('/tmp/test-ot.pdf', Buffer.from(bytes))
  console.log(`OK — wrote /tmp/test-ot.pdf (${bytes.byteLength} bytes)`)
}

main().catch(e => {
  console.error('FAILED:', e)
  process.exit(1)
})
