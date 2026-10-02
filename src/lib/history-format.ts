// Pure formatting for the admin booking-history side panel (no react/prisma).
// Turns raw audit rows into labelled lines with the FULL values — the bell
// notification truncates to 140 chars, this is the place to read the whole thing.
import { FIELD_LABELS as PRODUCER_LABELS } from './producer-edit-fields'

export interface HistoryRow {
  id: string
  at: string
  action: string
  actorEmail: string | null
  fromStatus: string | null
  toStatus: string | null
  changes: unknown
}

// Producer-editable labels + the extra admin-only fields audit.ts diffs.
const FIELD_LABELS: Record<string, string> = {
  ...PRODUCER_LABELS,
  status: 'สถานะ',
  shootEndDate: 'วันถ่ายสุดท้าย',
  category: 'หมวดงาน',
  adminNotes: 'Admin notes',
  assignedEmails: 'ทีมที่ assign',
  mainVideographerEmail: 'Main videographer',
  videographerCount: 'จำนวน videographer',
  switcherCount: 'จำนวน switcher',
  producerEmail: 'Producer email',
  producerPhone: 'Producer เบอร์โทร',
  director: 'Director',
  directorEmail: 'Director email',
  equipmentNote: 'Equipment note',
  rentalGearNote: 'Rental gear note',
  itinerary: 'Itinerary',
  assignedEquipmentIds: 'อุปกรณ์ที่ assign',
}

const ACTION_LABELS: Record<string, { label: string; tone: 'request' | 'edit' | 'status' | 'other' }> = {
  'booking.time_change_request': { label: 'Producer ขอแก้เวลา', tone: 'request' },
  'booking.producer_update': { label: 'Producer ส่งข้อความอัปเดต', tone: 'request' },
  'booking.producer_edit': { label: 'Producer แก้รายละเอียดเอง', tone: 'edit' },
  'booking.update': { label: 'แอดมิน/ทีมคิวแก้ไข', tone: 'edit' },
  'booking.status_change': { label: 'เปลี่ยนสถานะ', tone: 'status' },
  'booking.force_status': { label: 'บังคับสถานะ (admin)', tone: 'status' },
  'booking.create': { label: 'สร้างใบจอง', tone: 'other' },
  'booking.delete': { label: 'ยกเลิก/ลบใบจอง', tone: 'status' },
  approve: { label: 'Approve', tone: 'status' },
}

export function actionInfo(action: string) {
  // Unknown action → show the raw string, never hide it behind a guess.
  return ACTION_LABELS[action] ?? { label: action, tone: 'other' as const }
}

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key
}

export function showValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—'
  if (typeof v === 'boolean') return v ? 'ใช่' : 'ไม่'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export interface DiffLine { key: string; label: string; from?: string; to: string }

/** `changes` is either {field:{from,to}} (diffs) or loose values — accept both. */
export function diffLines(changes: unknown): DiffLine[] {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return []
  return Object.entries(changes as Record<string, unknown>)
    .filter(([k]) => !['message', 'requestedTime', 'onBehalfOfOwner', 'actorRole'].includes(k))
    .map(([key, v]) => {
      const isDiff = v && typeof v === 'object' && !Array.isArray(v) && 'to' in (v as object)
      return isDiff
        ? { key, label: fieldLabel(key), from: showValue((v as any).from), to: showValue((v as any).to) }
        : { key, label: fieldLabel(key), to: showValue(v) }
    })
}

/**
 * For a time_change_request row: has anyone edited callTime/estimatedWrap since?
 * `rows` is newest-first, so "since" = rows before `index`. This only reports what
 * the log contains — an edit made outside the app (e.g. sheet) won't be seen.
 */
export function timeEditedSince(rows: HistoryRow[], index: number): boolean {
  return rows.slice(0, index).some(r => {
    if (r.action !== 'booking.update' && r.action !== 'booking.producer_edit') return false
    const c = r.changes as Record<string, unknown> | null
    return !!c && typeof c === 'object' && ('callTime' in c || 'estimatedWrap' in c)
  })
}

export function bangkokStamp(iso: string): string {
  return new Date(iso).toLocaleString('th-TH-u-ca-gregory', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}
