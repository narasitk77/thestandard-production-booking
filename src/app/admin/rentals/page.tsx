'use client'

import CrudTable, { type CrudConfig, baht, ymd } from '../_components/CrudTable'
import { Badge, PAYMENT_STATUS, RENTAL_STATUS as RENTAL_BADGE } from '../_components/badges'

const PAY = ['PAID', 'INVOICED', 'PENDING']
const RENTAL_STATUS = ['ACTIVE', 'RETURNED', 'ARCHIVED']
const opt = (vals: string[]) => vals.map((v) => ({ value: v, label: v }))

const config: CrudConfig = {
  endpoint: '/api/admin/rentals',
  responseKey: 'rentals',
  docsOwnerType: 'rental',
  title: 'Rentals',
  subtitle: 'งานเช่าอุปกรณ์ — สถานะจ่าย, วันคืน, ผูกกับ vendor (เฉพาะ ADMIN แก้ได้)',
  addLabel: 'เพิ่มงานเช่า',
  filters: [
    { key: 'status', label: 'สถานะ', options: [{ value: 'all', label: 'ทั้งหมด' }, ...opt(RENTAL_STATUS)] },
    { key: 'payment', label: 'การจ่าย', options: [{ value: 'all', label: 'ทั้งหมด' }, ...opt(PAY)] },
  ],
  columns: [
    { key: 'jobName', label: 'งาน', render: (r) => r.jobName || r.quoteNo || '—' },
    { key: 'vendor', label: 'Vendor', render: (r) => r.vendor?.name || '—' },
    { key: 'rentalDate', label: 'วันเช่า', render: (r) => ymd(r.rentalDate) },
    { key: 'returnDueDate', label: 'คืนภายใน', render: (r) => ymd(r.returnDueDate) },
    { key: 'paymentStatus', label: 'จ่าย', render: (r) => <Badge map={PAYMENT_STATUS} value={r.paymentStatus} /> },
    { key: 'amount', label: 'ยอด (฿)', align: 'right', render: (r) => baht(r.amount) },
    { key: 'status', label: 'สถานะ', render: (r) => <Badge map={RENTAL_BADGE} value={r.status} /> },
  ],
  fields: [
    { key: 'jobName', label: 'ชื่องาน', required: true },
    { key: 'quoteNo', label: 'Quote No.', half: true },
    { key: 'adType', label: 'AD / NON-AD', half: true },
    { key: 'vendorId', label: 'Vendor', type: 'select', optionsFrom: '/api/admin/vendors', optionsKey: 'vendors', half: true },
    { key: 'rentalDate', label: 'วันเช่า', type: 'date', half: true },
    { key: 'returnDueDate', label: 'กำหนดคืน', type: 'date', half: true },
    { key: 'returnedAt', label: 'คืนแล้วเมื่อ', type: 'date', half: true },
    { key: 'paymentStatus', label: 'สถานะจ่าย', type: 'select', options: opt(PAY), half: true },
    { key: 'status', label: 'สถานะงาน', type: 'select', options: opt(RENTAL_STATUS), half: true },
    { key: 'invoiceNo', label: 'เลขใบแจ้งหนี้', half: true },
    { key: 'amount', label: 'ยอดเงิน (บาท)', type: 'number', half: true },
    { key: 'remark', label: 'หมายเหตุ', type: 'textarea' },
  ],
}

export default function RentalsPage() {
  return <CrudTable config={config} />
}
