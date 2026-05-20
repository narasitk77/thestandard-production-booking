'use client'

import { useEffect, useState } from 'react'

type Warning = {
  shouldWarn: boolean
  countInWindow: number
  oldestAt: string | null
  nextPurgeBefore: string | null
  retentionDays: number
  warningDays: number
}

function fmt(d: string | null): string {
  if (!d) return '—'
  try { return new Date(d).toISOString().slice(0, 10) } catch { return d }
}

export default function AdminAuditBanner() {
  const [warning, setWarning] = useState<Warning | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    fetch('/api/audit/purge-warning')
      .then(r => (r.ok ? r.json() : null))
      .then(setWarning)
      .catch(() => setWarning(null))
  }, [])

  if (!warning || !warning.shouldWarn || dismissed) return null

  const csvHref = warning.oldestAt
    ? `/api/audit/export?from=${encodeURIComponent(warning.oldestAt)}`
    : '/api/audit/export'

  return (
    <div className="border-b border-yellow-300 bg-yellow-50 text-yellow-900">
      <div className="max-w-5xl mx-auto px-4 py-2.5 flex items-start gap-3 text-sm">
        <span className="text-base leading-5">⚠️</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium">
            Audit log {warning.countInWindow} รายการ จะถูกลบในวันที่ {fmt(warning.nextPurgeBefore)}
          </div>
          <div className="text-xs text-yellow-800 mt-0.5">
            เก็บประวัติแค่ {warning.retentionDays} วัน (เก่าสุด: {fmt(warning.oldestAt)}) —
            ดาวน์โหลดเป็น CSV ก่อนลบ
          </div>
        </div>
        <a
          href={csvHref}
          className="px-3 py-1 text-xs bg-yellow-600 text-white rounded hover:bg-yellow-700 whitespace-nowrap"
        >
          📥 ดาวน์โหลด CSV
        </a>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="text-yellow-700 hover:text-yellow-900 leading-none text-lg"
        >
          ×
        </button>
      </div>
    </div>
  )
}
