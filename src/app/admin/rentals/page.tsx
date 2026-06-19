'use client'

import CrudTable, { type CrudConfig, baht, ymd } from '../_components/CrudTable'
import { Badge, PAYMENT_STATUS, RENTAL_STATUS as RENTAL_BADGE } from '../_components/badges'
import { OUTLETS } from '@/lib/data'

const PAY = ['PAID', 'INVOICED', 'PENDING']
const RENTAL_STATUS = ['ACTIVE', 'RETURNED', 'ARCHIVED']
const opt = (vals: string[]) => vals.map((v) => ({ value: v, label: v }))
const ALL = { value: 'all', label: 'ทั้งหมด' }

// Year list = 2024 → next year, newest first (mirrors the sheet's per-year tabs).
const THIS_YEAR = new Date().getFullYear()
const YEARS = Array.from({ length: THIS_YEAR + 1 - 2024 + 1 }, (_, i) => THIS_YEAR + 1 - i)
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

const config: CrudConfig = {
  endpoint: '/api/admin/rentals',
  responseKey: 'rentals',
  docsOwnerType: 'rental',
  title: 'Rentals',
  subtitle: 'งานเช่าอุปกรณ์ — สถานะจ่าย, วันคืน, ผูกกับ vendor (เฉพาะ ADMIN แก้ได้)',
  addLabel: 'เพิ่มงานเช่า',
  filters: [
    { key: 'year', label: 'ปี', options: [ALL, ...YEARS.map((y) => ({ value: String(y), label: String(y) }))] },
    { key: 'month', label: 'เดือน', options: [ALL, ...TH_MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))] },
    { key: 'outlet', label: 'Outlet', options: [ALL, ...OUTLETS.map((o) => ({ value: o.code, label: `${o.code} · ${o.name}` }))] },
    { key: 'status', label: 'สถานะ', options: [ALL, ...opt(RENTAL_STATUS)] },
    { key: 'payment', label: 'การจ่าย', options: [ALL, ...opt(PAY)] },
  ],
  columns: [
    { key: 'jobName', label: 'งาน', render: (r) => r.jobName || r.quoteNo || '—' },
    { key: 'outlet', label: 'Outlet', render: (r) => r.outlet?.code || '—', sortValue: (r) => r.outlet?.code || '' },
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
