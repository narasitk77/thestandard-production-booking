'use client'

import CrudTable, { type CrudConfig } from '../_components/CrudTable'

const config: CrudConfig = {
  endpoint: '/api/admin/vendors',
  responseKey: 'vendors',
  title: 'Vendors',
  subtitle: 'ผู้ให้บริการเช่า/ซ่อม/ขายอุปกรณ์ พร้อมเบอร์ติดต่อและบัญชี',
  addLabel: 'เพิ่ม Vendor',
  columns: [
    { key: 'name', label: 'ชื่อ' },
    { key: 'service', label: 'บริการ', render: (r) => r.service || '—' },
    { key: 'contact', label: 'ติดต่อ', render: (r) => r.contact || '—' },
    { key: 'bankAccount', label: 'บัญชี', render: (r) => r.bankAccount || '—' },
    { key: '_count', label: 'ใช้งาน', render: (r) => { const c = r._count || {}; return `เช่า ${c.rentals || 0} · ซ่อม ${c.repairs || 0} · ซื้อ ${c.purchases || 0}` } },
  ],
  fields: [
    { key: 'name', label: 'ชื่อ Vendor', required: true },
    { key: 'service', label: 'ประเภทบริการ', placeholder: 'CAMERA / GRIP / LIGHT / RADIO / DRONE', half: true },
    { key: 'contact', label: 'เบอร์ติดต่อ', half: true },
    { key: 'bankAccount', label: 'บัญชีธนาคาร' },
  ],
}

export default function VendorsPage() {
  return <CrudTable config={config} />
}
