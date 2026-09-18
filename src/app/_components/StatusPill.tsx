import { statusLabel } from '@/lib/utils'

type Status = 'REQUESTED' | 'ASSIGNED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | string

// Canonical status visual — single source of truth for status look-and-feel.
// Tailwind needs full class names (not template fragments) for purge to keep them.
const STYLES: Record<string, { bg: string; text: string; dot: string; border: string }> = {
  REQUESTED: {
    bg: 'bg-status-requested-50',
    text: 'text-status-requested-700',
    dot: 'bg-status-requested-500',
    border: 'border-status-requested-500/20',
  },
  ASSIGNED: {
    bg: 'bg-status-assigned-50',
    text: 'text-status-assigned-700',
    dot: 'bg-status-assigned-500',
    border: 'border-status-assigned-500/30',
  },
  CONFIRMED: {
    bg: 'bg-status-confirmed-50',
    text: 'text-status-confirmed-700',
    dot: 'bg-status-confirmed-500',
    border: 'border-status-confirmed-500/30',
  },
  COMPLETED: {
    bg: 'bg-status-completed-50',
    text: 'text-status-completed-700',
    dot: 'bg-status-completed-500',
    border: 'border-status-completed-500/30',
  },
  CANCELLED: {
    bg: 'bg-status-cancelled-50',
    text: 'text-status-cancelled-700',
    dot: 'bg-status-cancelled-500',
    border: 'border-status-cancelled-500/30',
  },
}

export function statusDotClass(status: Status): string {
  return (STYLES[status] || STYLES.REQUESTED).dot
}

// v1.131 — AD vs NON-AD (Category enum) color coding, orthogonal to status.
// Amber matches the "AD" toggle color already used in the booking wizard.
export function isAdvertorial(category?: string | null): boolean {
  return category === 'ADVERTORIAL'
}

// Left-border accent for calendar chips — subtle enough not to compete with
// the status dot/pill, but a clear "this one's AD" signal at a glance.
export function categoryAccentClass(category?: string | null): string {
  return isAdvertorial(category) ? 'border-l-4 border-l-amber-400' : ''
}

// Card-level treatment — the whole booking card gets the SAME amber signal on
// every list surface (admin queue, My Bookings, Overview, Producer, Upload),
// so "AD job" reads identically anywhere in the app.
export function categoryCardClass(category?: string | null): string {
  return isAdvertorial(category) ? 'border-l-4 border-l-amber-400 bg-amber-50/40' : ''
}

// Small "AD" tag for rows with more room (agenda list, drawer header).
export function AdBadge({ category, className = '' }: { category?: string | null; className?: string }) {
  if (!isAdvertorial(category)) return null
  return (
    <span
      className={`inline-flex items-center rounded-full border border-amber-300 bg-amber-50 text-amber-800 text-[9px] font-semibold px-1.5 py-0.5 whitespace-nowrap ${className}`}
      title="Advertorial"
    >
      AD
    </span>
  )
}

/**
 * v1.226 — ป้าย "ห้องไม่ว่าง" บนการ์ดใบจอง
 *
 * `roomBookingStatus` ถูกเขียนลง DB ตั้งแต่ v1.200 แต่จนถึง v1.223 มีที่แสดงแค่
 * ในหน้าใบจองใบเดียว — โปรดิวเซอร์ที่ไม่ได้เปิดใบนั้นจึงไม่มีทางรู้ว่าระบบจองห้อง
 * ให้ไม่ได้ ป้ายนี้ทำให้มันโผล่ในที่ที่คนมองจริง (คิวงาน / งานของฉัน / Producer)
 *
 * แสดงเฉพาะสถานะที่ "มีอะไรต้องทำ" — จองสำเร็จไม่ต้องรบกวน
 */
export function RoomBusyBadge({ status, error, className = '' }: {
  status?: string | null
  error?: string | null
  className?: string
}) {
  if (status !== 'CONFLICT' && status !== 'INVALID' && status !== 'UNKNOWN') return null
  const busy = status === 'CONFLICT'
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full border text-[9px] font-semibold px-1.5 py-0.5 whitespace-nowrap ${
        busy
          ? 'border-rose-300 bg-rose-50 text-rose-700'
          : 'border-slate-300 bg-slate-50 text-slate-600'
      } ${className}`}
      title={busy
        ? `จองห้องในระบบส่วนกลางไม่ได้ — ห้องไม่ว่างช่วงเวลานี้${error ? `\n${error}` : ''}`
        : `ระบบยังจองห้องส่วนกลางให้ไม่สำเร็จ${error ? `\n${error}` : ''}`}
    >
      {busy ? '⚠ ห้องไม่ว่าง' : 'ห้องยังไม่ได้จอง'}
    </span>
  )
}

export default function StatusPill({ status }: { status: Status }) {
  const s = STYLES[status] || STYLES.REQUESTED
  const label = statusLabel(status).replace(/[\[\]]/g, '')
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium border ${s.bg} ${s.text} ${s.border} text-[10px] px-1.5 py-0.5 whitespace-nowrap`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} aria-hidden />
      {label}
    </span>
  )
}
