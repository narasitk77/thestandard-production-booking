'use client'

// v1.111 — compact assigned-crew line for booking cards + detail pages.
// Short names come from the server (team label / nickname / Thai first name —
// see src/lib/crew-names.ts); this renders them as one wrapped line:
//   👥 ก้อง ⭐ · นัท · ทีมเสียง
// ⭐ = main videographer (ช่างภาพหลัก). Renders nothing when no crew assigned.

export interface CrewEntry { email: string; name: string; isLead?: boolean }

export default function CrewLine({ crew, meEmail, className }: {
  crew?: CrewEntry[] | null
  /** current user's email — their own name gets highlighted "(คุณ)" */
  meEmail?: string
  className?: string
}) {
  if (!crew || crew.length === 0) return null
  const me = (meEmail || '').toLowerCase()
  return (
    <div className={className ?? 'text-[11px] text-gray-500 truncate mt-0.5'}>
      <span aria-hidden>👥</span>{' '}
      {crew.map((c, i) => {
        const isMe = !!me && c.email.toLowerCase() === me
        return (
          <span key={c.email} className={isMe ? 'font-semibold text-gray-800' : c.isLead ? 'text-gray-700' : undefined}>
            {c.name}{c.isLead ? ' ⭐' : ''}{isMe ? ' (คุณ)' : ''}{i < crew.length - 1 ? ' · ' : ''}
          </span>
        )
      })}
    </div>
  )
}
