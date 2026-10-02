'use client'

// Admin side panel: the booking's full audit trail (what was asked, when, what
// changed) with untruncated values. Reads GET /api/bookings/:id/history, which
// is already unfiltered for console roles.
import { useCallback, useEffect, useState } from 'react'
import { X, History, Loader2, RotateCcw, AlertTriangle } from 'lucide-react'
import {
  actionInfo, bangkokStamp, diffLines, showValue, timeEditedSince, type HistoryRow,
} from '@/lib/history-format'

const HISTORY_LIMIT = 200 // must match `take` in the history route

const TONE: Record<string, string> = {
  request: 'border-amber-400 bg-amber-50',
  edit: 'border-blue-300 bg-white',
  status: 'border-purple-300 bg-white',
  other: 'border-gray-200 bg-white',
}

export default function BookingHistoryPanel({
  bookingId, open, onClose, current,
}: {
  bookingId: string
  open: boolean
  onClose: () => void
  current: { callTime: string; estimatedWrap?: string | null }
}) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch(`/api/bookings/${bookingId}/history`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setRows(data.history || [])
    } catch (e: any) {
      setRows(null)
      setError(e?.message || 'โหลดไม่สำเร็จ')
    }
  }, [bookingId])

  // Reload on every open — the panel is for checking the latest state.
  useEffect(() => { if (open) { setRows(null); load() } }, [open, load])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="relative w-full sm:w-[440px] h-full bg-gray-50 shadow-2xl flex flex-col">
        <header className="flex items-center gap-2 px-4 py-3 bg-white border-b">
          <History className="w-4 h-4 text-gray-500" />
          <h2 className="text-sm font-medium text-gray-800 flex-1">ประวัติการขอ/แก้ไข</h2>
          <button onClick={load} title="โหลดใหม่" className="p-1 text-gray-400 hover:text-gray-700"><RotateCcw className="w-4 h-4" /></button>
          <button onClick={onClose} title="ปิด" className="p-1 text-gray-400 hover:text-gray-700"><X className="w-4 h-4" /></button>
        </header>

        <div className="px-4 py-2 text-xs text-gray-600 bg-white border-b">
          ตอนนี้ในระบบ: <b>{current.callTime}{current.estimatedWrap ? ` → ${current.estimatedWrap}` : ''}</b>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {error && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-3">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <div>โหลดประวัติไม่สำเร็จ ({error}) — นี่ไม่ได้แปลว่าไม่มีประวัติ <button className="underline" onClick={load}>ลองใหม่</button></div>
            </div>
          )}
          {!error && rows === null && <div className="text-xs text-gray-400 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> กำลังโหลด…</div>}
          {rows && rows.length === 0 && <div className="text-xs text-gray-400">ยังไม่มีประวัติ</div>}
          {rows && rows.length >= HISTORY_LIMIT && (
            <div className="text-xs text-amber-700">แสดงเฉพาะ {HISTORY_LIMIT} รายการล่าสุด — รายการเก่ากว่านี้ไม่แสดง</div>
          )}
          {rows?.map((r, i) => <Entry key={r.id} r={r} rows={rows} i={i} />)}
        </div>
      </aside>
    </div>
  )
}

function Entry({ r, rows, i }: { r: HistoryRow; rows: HistoryRow[]; i: number }) {
  const info = actionInfo(r.action)
  const ch = (r.changes && typeof r.changes === 'object' ? r.changes : {}) as Record<string, unknown>
  const lines = diffLines(r.changes)
  const message = typeof ch.message === 'string' ? ch.message.trim() : ''
  const requestedTime = typeof ch.requestedTime === 'string' ? ch.requestedTime.trim() : ''
  const isTimeReq = r.action === 'booking.time_change_request'
  return (
    <div className={`border-l-4 rounded-r p-3 text-xs shadow-sm ${TONE[info.tone]}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-gray-800">{info.label}</span>
        <span className="text-gray-400 shrink-0">{bangkokStamp(r.at)}</span>
      </div>
      <div className="text-gray-500 mt-0.5 break-all">
        {r.actorEmail || 'ระบบ'}
        {ch.onBehalfOfOwner ? ` (ทีมคิวแก้แทนเจ้าของงาน${ch.actorRole ? ` · ${String(ch.actorRole)}` : ''})` : ''}
      </div>

      {requestedTime && <div className="mt-2">เวลาที่ขอใหม่: <b>{requestedTime}</b></div>}
      {message && <div className="mt-2 whitespace-pre-wrap break-words text-gray-800">{message}</div>}
      {isTimeReq && (
        <div className={`mt-2 ${timeEditedSince(rows, i) ? 'text-green-700' : 'text-amber-700 font-medium'}`}>
          {timeEditedSince(rows, i)
            ? '✓ มีการแก้เวลาในระบบหลังคำขอนี้แล้ว'
            : '⚠ ยังไม่พบการแก้เวลาในระบบหลังคำขอนี้'}
        </div>
      )}

      {r.fromStatus || r.toStatus ? (
        <div className="mt-2">สถานะ: {showValue(r.fromStatus)} → <b>{showValue(r.toStatus)}</b></div>
      ) : null}

      {lines.length > 0 && (
        <table className="mt-2 w-full">
          <tbody>
            {lines.map(l => (
              <tr key={l.key} className="align-top">
                <td className="pr-2 py-0.5 text-gray-500 whitespace-nowrap">{l.label}</td>
                <td className="py-0.5 break-words whitespace-pre-wrap">
                  {l.from !== undefined && <span className="text-red-600 line-through mr-1">{l.from}</span>}
                  <span className="text-green-700 font-medium">{l.to}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {info.tone === 'other' && info.label === r.action && r.changes != null && lines.length === 0 && !message && (
        <pre className="mt-2 text-[10px] bg-gray-100 rounded p-2 overflow-x-auto">{JSON.stringify(r.changes, null, 2)}</pre>
      )}
    </div>
  )
}
