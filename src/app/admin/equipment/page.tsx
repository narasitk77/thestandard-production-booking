'use client'

import CrudTable, { type CrudConfig } from '../_components/CrudTable'

const CATEGORIES = ['AUDIO', 'CAMERA', 'COMPUTER_MONITOR', 'GRIP_SUPPORT', 'LENS', 'LIGHTING', 'POWER', 'STORAGE_MEDIA', 'UNCATEGORIZED']
const STATUSES = ['AVAILABLE', 'ON_LOAN', 'IN_REPAIR', 'RETIRED']
const opt = (vals: string[]) => vals.map((v) => ({ value: v, label: v }))

const config: CrudConfig = {
  endpoint: '/api/admin/equipment',
  responseKey: 'equipment',
  title: 'Equipment',
  subtitle: 'คลังอุปกรณ์ — ค้นด้วยชื่อ/serial/รหัส, สถานะผูกกับการยืม/ซ่อม',
  addLabel: 'เพิ่มอุปกรณ์',
  filters: [
    { key: 'category', label: 'หมวด', options: [{ value: 'all', label: 'ทั้งหมด' }, ...opt(CATEGORIES)] },
    { key: 'status', label: 'สถานะ', options: [{ value: 'all', label: 'ทั้งหมด' }, ...opt(STATUSES)] },
    { key: 'fixedAsset', label: 'ประเภท', options: [{ value: 'all', label: 'ทั้งหมด' }, { value: '0', label: 'อุปกรณ์ยืมได้' }, { value: '1', label: 'ทรัพย์สิน (อ่านอย่างเดียว)' }] },
  ],
  columns: [
    { key: 'itemId', label: 'รหัส', render: (r) => r.itemId || r.fixedAssetTag || '—' },
    { key: 'name', label: 'ชื่อ' },
    { key: 'category', label: 'หมวด' },
    { key: 'serialNumber', label: 'S/N', render: (r) => r.serialNumber || '—' },
    { key: 'location', label: 'ที่เก็บ', render: (r) => r.location || '—' },
    { key: 'status', label: 'สถานะ' },
  ],
  fields: [
    { key: 'name', label: 'ชื่อ', required: true },
    { key: 'itemId', label: 'รหัส (ITEMID)', half: true },
    { key: 'category', label: 'หมวด', type: 'select', options: opt(CATEGORIES), half: true },
    { key: 'serialNumber', label: 'Serial Number', half: true },
    { key: 'location', label: 'ที่เก็บ / ผู้ถือ', half: true },
    { key: 'status', label: 'สถานะ', type: 'select', options: opt(STATUSES), half: true },
    { key: 'loanable', label: 'ยืมได้', type: 'checkbox', placeholder: 'ให้ยืมออกได้', half: true },
    { key: 'description', label: 'รายละเอียด', type: 'textarea' },
    { key: 'fixedAssetTag', label: 'Asset Tag', half: true },
    { key: 'warrantyExpiresAt', label: 'ประกันหมด', type: 'date', half: true },
    { key: 'purchaseDate', label: 'วันที่ซื้อ', type: 'date', half: true },
    { key: 'purchasePrice', label: 'ราคา (บาท)', type: 'number', half: true },
    { key: 'notes', label: 'หมายเหตุ', type: 'textarea' },
  ],
}

export default function EquipmentPage() {
  return <CrudTable config={config} />
}
