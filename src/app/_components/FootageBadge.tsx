'use client'

// v1.111 — compact "ไฟล์มาแล้ว/ครบแล้ว" chip for booking cards.
//   ✅ ไฟล์ครบแล้ว — the NAS upload queue for this booking fully drained
//      (everything the crew dumped has shipped to Drive).
//   📦 มีไฟล์ N — files detected in the booking's Drive folders (may still be
//      uploading more). Renders nothing when there's no footage signal yet.

export default function FootageBadge({ files, sent, className }: {
  files?: number | null
  sent?: boolean
  className?: string
}) {
  if (!sent && !(files && files > 0)) return null
  return sent ? (
    <span className={className ?? 'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-800 border border-green-200 font-medium whitespace-nowrap'}>
      ✅ ไฟล์ครบแล้ว{files && files > 0 ? ` (${files})` : ''}
    </span>
  ) : (
    <span className={className ?? 'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-medium whitespace-nowrap'}>
      📦 มีไฟล์ {files}
    </span>
  )
}
