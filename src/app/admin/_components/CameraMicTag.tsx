'use client'

/* Camera + mic counts as a loud, can't-miss tag. Red highlight by request —
   gear needs must jump out on every booking card and detail view. Missing
   counts (non Block Shot) read as a red warning; Block Shot shows a calm purple
   "deferred" pill instead. Shared by the /admin queue cards and /admin/[id]. */
export function CameraMicTag({
  cameraCount,
  micCount,
  isBlockShot,
  size = 'sm',
}: {
  cameraCount?: number | null
  micCount?: number | null
  isBlockShot?: boolean
  size?: 'sm' | 'md'
}) {
  const pad = size === 'md' ? 'text-sm px-3 py-1' : 'text-xs px-2 py-0.5'

  if (isBlockShot) {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full font-medium bg-[#ede7f6] text-[#5e35b1] border border-[#d1c4e9] ${pad}`}>
        📦 Block Shot
      </span>
    )
  }

  const hasCam = cameraCount !== null && cameraCount !== undefined
  const hasMic = micCount !== null && micCount !== undefined

  if (!hasCam && !hasMic) {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full font-semibold bg-red-100 text-red-700 border border-red-300 ${pad}`}>
        ⚠️ ไม่ระบุกล้อง/ไมค์
      </span>
    )
  }

  return (
    <span className={`inline-flex items-center gap-2 rounded-full font-bold bg-red-100 text-red-700 border border-red-300 ${pad}`}>
      <span className={!hasCam ? 'opacity-60 font-medium' : ''}>🎥 {hasCam ? cameraCount : '—'}</span>
      <span className="text-red-300">·</span>
      <span className={!hasMic ? 'opacity-60 font-medium' : ''}>🎙 {hasMic ? micCount : '—'}</span>
    </span>
  )
}
