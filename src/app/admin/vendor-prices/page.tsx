'use client'

import CrudTable, { type CrudConfig, baht } from '../_components/CrudTable'

const config: CrudConfig = {
  endpoint: '/api/admin/vendor-prices',
  responseKey: 'prices',
  title: 'ราคาเช่าอุปกรณ์',
  subtitle: 'ราคาเช่าจาก vendor ต่างๆ — ใช้เปรียบเทียบราคาและกรอก cost sheet',
  addLabel: 'เพิ่มราคา',
  columns: [
    { key: 'vendor', label: 'Vendor', sortable: true },
    { key: 'category', label: 'หมวด', sortable: true },
    { key: 'item', label: 'รายการ', sortable: true },
    { key: 'spec', label: 'Spec', render: (r) => r.spec || '—' },
    { key: 'unit', label: 'หน่วย' },
    {
      key: 'pricePerDay', label: 'ราคา/วัน', sortable: true,
      sortValue: (r) => Number(r.pricePerDay),
      render: (r) => baht(r.pricePerDay),
    },
    { key: 'notes', label: 'หมายเหตุ', render: (r) => r.notes || '—' },
  ],
  fields: [
    { key: 'vendor', label: 'Vendor', required: true, placeholder: 'เช่น 17thanwafilm, Baanfilm, Hiya', half: true },
    { key: 'category', label: 'หมวด', required: true, placeholder: 'เช่น Camera, Lens, Lighting', half: true },
    { key: 'item', label: 'ชื่ออุปกรณ์', required: true, placeholder: 'เช่น ARRI Alexa 35' },
    { key: 'spec', label: 'Spec / รายละเอียด', placeholder: 'เช่น 4K, 12-stop DR' },
    { key: 'unit', label: 'หน่วย', placeholder: 'วัน', half: true },
    { key: 'pricePerDay', label: 'ราคา (บาท)', type: 'number', required: true, half: true },
    { key: 'notes', label: 'หมายเหตุ' },
  ],
}

export default function VendorPricesPage() {
  return <CrudTable config={config} />
}
