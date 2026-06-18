'use client'

import CrudTable, { type CrudConfig, baht } from '../_components/CrudTable'

const PURCHASE_STATUS = ['OPEN', 'RECEIVED', 'CANCELLED']
const opt = (vals: string[]) => vals.map((v) => ({ value: v, label: v }))

const config: CrudConfig = {
  endpoint: '/api/admin/purchases',
  responseKey: 'purchases',
  title: 'Purchases',
  subtitle: 'งานซื้ออุปกรณ์ — vendor, ลิงก์สินค้า, ราคา (เฉพาะ ADMIN แก้ได้)',
  addLabel: 'เพิ่มงานซื้อ',
  filters: [
    { key: 'status', label: 'สถานะ', options: [{ value: 'all', label: 'ทั้งหมด' }, ...opt(PURCHASE_STATUS)] },
  ],
  columns: [
    { key: 'month', label: 'เดือน', render: (r) => r.month || '—' },
    { key: 'item', label: 'รายการ' },
    { key: 'quantity', label: 'จำนวน', align: 'right' },
    { key: 'vendor', label: 'ซื้อจาก', render: (r) => r.vendor?.name || '—' },
    { key: 'total', label: 'รวม (฿)', align: 'right', render: (r) => baht(r.total) },
    { key: 'kind', label: 'ประเภท', render: (r) => r.kind || '—' },
    { key: 'status', label: 'สถานะ' },
    { key: 'productLink', label: 'ลิงก์', render: (r) => r.productLink ? <a href={r.productLink} target="_blank" rel="noreferrer" className="text-[#673ab7] hover:underline">เปิด</a> : '—' },
  ],
  fields: [
    { key: 'item', label: 'รายการ', required: true },
    { key: 'month', label: 'เดือน (YYYY-MM)', half: true },
    { key: 'quantity', label: 'จำนวน', type: 'number', half: true },
    { key: 'vendorId', label: 'ซื้อจาก (Vendor)', type: 'select', optionsFrom: '/api/admin/vendors', optionsKey: 'vendors', half: true },
    { key: 'kind', label: 'ประเภท', placeholder: 'ADD / REPLACE / FIX', half: true },
    { key: 'unitPrice', label: 'ราคา/หน่วย', type: 'number', half: true },
    { key: 'total', label: 'ราคารวม', type: 'number', half: true },
    { key: 'status', label: 'สถานะ', type: 'select', options: opt(PURCHASE_STATUS), half: true },
    { key: 'productLink', label: 'ลิงก์สินค้า' },
    { key: 'remark', label: 'หมายเหตุ', type: 'textarea' },
  ],
}

export default function PurchasesPage() {
  return <CrudTable config={config} />
}
