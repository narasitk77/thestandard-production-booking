'use client'

import CrudTable, { type CrudConfig, baht, ymd } from '../_components/CrudTable'
import { Badge, REPAIR_STATUS as REPAIR_BADGE } from '../_components/badges'

const REPAIR_STATUS = ['REPORTED', 'SENT', 'RETURNED', 'CANNOT_REPAIR']
const opt = (vals: string[]) => vals.map((v) => ({ value: v, label: v }))

const config: CrudConfig = {
  endpoint: '/api/admin/repairs',
  responseKey: 'repairs',
  title: 'Repairs',
  subtitle: 'งานซ่อม/บำรุงรักษา — อาการ → ร้าน → วันส่ง/รับ → ค่าซ่อม',
  addLabel: 'เปิดงานซ่อม',
  filters: [
    { key: 'status', label: 'สถานะ', options: [{ value: 'all', label: 'ทั้งหมด' }, ...opt(REPAIR_STATUS)] },
  ],
  columns: [
    { key: 'itemLabel', label: 'อุปกรณ์' },
    { key: 'equipment', label: 'ในคลัง', render: (r) => r.equipment?.name || '—' },
    { key: 'vendor', label: 'ร้าน', render: (r) => r.vendor?.name || '—' },
    { key: 'status', label: 'สถานะ', render: (r) => <Badge map={REPAIR_BADGE} value={r.status} /> },
    { key: 'sentDate', label: 'ส่ง', render: (r) => ymd(r.sentDate) },
    { key: 'returnedDate', label: 'รับคืน', render: (r) => ymd(r.returnedDate) },
    { key: 'cost', label: 'ค่าซ่อม (฿)', align: 'right', render: (r) => baht(r.cost) },
  ],
  fields: [
    { key: 'itemLabel', label: 'อุปกรณ์ (พิมพ์อิสระ)', required: true },
    { key: 'equipmentId', label: 'ผูกกับคลัง (ถ้ามี)', type: 'select', optionsFrom: '/api/admin/equipment', optionsKey: 'equipment', optionMap: (r) => ({ value: r.id, label: r.name }) },
    { key: 'vendorId', label: 'ร้านซ่อม', type: 'select', optionsFrom: '/api/admin/vendors', optionsKey: 'vendors', half: true },
    { key: 'status', label: 'สถานะ', type: 'select', options: opt(REPAIR_STATUS), half: true },
    { key: 'sentDate', label: 'วันส่งซ่อม', type: 'date', half: true },
    { key: 'returnedDate', label: 'วันรับคืน', type: 'date', half: true },
    { key: 'cost', label: 'ค่าซ่อม (บาท)', type: 'number', half: true },
    { key: 'kind', label: 'ประเภท', placeholder: 'REPLACE / ADD / FIX', half: true },
    { key: 'issue', label: 'อาการ', type: 'textarea' },
    { key: 'remark', label: 'หมายเหตุ', type: 'textarea' },
  ],
}

export default function RepairsPage() {
  return <CrudTable config={config} />
}
