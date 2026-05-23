import { statusLabel } from '@/lib/utils'

type Status = 'REQUESTED' | 'ASSIGNED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | string
type Size = 'xs' | 'sm'

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

export default function StatusPill({
  status,
  size = 'xs',
  dot = true,
}: {
  status: Status
  size?: Size
  dot?: boolean
}) {
  const s = STYLES[status] || STYLES.REQUESTED
  const sizing = size === 'xs' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-1'
  const label = statusLabel(status).replace(/[\[\]]/g, '')
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium border ${s.bg} ${s.text} ${s.border} ${sizing} whitespace-nowrap`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} aria-hidden />}
      {label}
    </span>
  )
}
