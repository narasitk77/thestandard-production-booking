'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import BackButton from '@/app/_components/BackButton'
import { CheckCircle2, AlertCircle, Loader2, Video, Mic, RefreshCw, ExternalLink, Clock } from 'lucide-react'
import { format, parseISO } from 'date-fns'

interface ReviewRow {
  id: string
  bookingCode: string | null
  shootDate: string
  callTime: string
  estimatedWrap: string | null
  producer: string | null
  assignedEmails: string[]
  mainVideographerEmail: string | null
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  uploaders: string[]
  lastUploadAt: string | null
  videoCount: number
  soundCount: number
  inFlightCount: number
  failedCount: number
  totalBytes: number
  hasVideo: boolean
  hasSound: boolean
  isReady: boolean
}

function fmtBytes(n: number): string {
  if (!n || n <= 0) return '—'
  const units = ['B','KB','MB','GB','TB']
  let v = n, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

export default function UploadReviewPage() {
  const [ready, setReady] = useState<ReviewRow[]>([])
  const [inProgress, setInProgress] = useState<ReviewRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [acting, setActing] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [confirmNote, setConfirmNote] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/admin/upload-review')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      setReady(data.ready || [])
      setInProgress(data.inProgress || [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const confirmDone = async (row: ReviewRow, note: string) => {
    setActing(row.id)
    setError('')
    try {
      const res = await fetch(`/api/admin/${row.id}/mark-upload-done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note || null }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to confirm')
      setConfirmId(null)
      setConfirmNote('')
      load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setActing(null)
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3">
      <BackButton fallback="/admin" label="กลับ Admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800" />

      <div className="gf-header p-4 sm:p-6 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-normal text-gray-800">Upload Review</h1>
          <p className="text-xs sm:text-sm text-gray-500">
            CONFIRMED bookings ที่ crew อัพ video + sound ครบแล้ว — ดู log แล้วยืนยัน Done เพื่อปิด booking
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="text-xs px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && (
        <div className="gf-card p-3 text-sm text-red-600 border-l-4 border-red-400 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* SUMMARY STRIP */}
      <div className="grid grid-cols-2 gap-3">
        <div className="gf-card p-4 bg-green-50/50">
          <div className="text-xs text-green-700 mb-1">พร้อมยืนยัน Done</div>
          <div className="text-2xl font-medium text-green-800">{ready.length}</div>
          <div className="text-[10px] text-gray-500 mt-0.5">มี video + sound ครบ</div>
        </div>
        <div className="gf-card p-4 bg-amber-50/50">
          <div className="text-xs text-amber-700 mb-1">รอ crew อัพเพิ่ม</div>
          <div className="text-2xl font-medium text-amber-800">{inProgress.length}</div>
          <div className="text-[10px] text-gray-500 mt-0.5">ขาด video หรือ sound</div>
        </div>
      </div>

      {/* READY queue */}
      <div className="gf-card p-4 space-y-2">
        <div className="text-sm font-medium text-gray-700 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-green-600" /> พร้อมยืนยัน Done ({ready.length})
        </div>
        {loading ? (
          <div className="py-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
        ) : ready.length === 0 ? (
          <div className="py-8 text-center text-xs text-gray-400">ไม่มี booking ที่พร้อมรีวิว</div>
        ) : (
          <div className="space-y-2">
            {ready.map(r => <ReviewCard key={r.id} row={r}
              onConfirm={() => setConfirmId(r.id)}
              busy={acting === r.id} />)}
          </div>
        )}
      </div>

      {/* IN-PROGRESS */}
      {inProgress.length > 0 && (
        <div className="gf-card p-4 space-y-2">
          <div className="text-sm font-medium text-gray-700 flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-600" /> รอ crew อัพเพิ่ม ({inProgress.length})
          </div>
          <div className="space-y-2">
            {inProgress.map(r => <ReviewCard key={r.id} row={r} onConfirm={null} busy={false} />)}
          </div>
        </div>
      )}

      {/* CONFIRM MODAL */}
      {confirmId && (() => {
        const row = ready.find(r => r.id === confirmId)
        if (!row) return null
        return (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setConfirmId(null)}>
            <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5 space-y-3" onClick={e => e.stopPropagation()}>
              <h2 className="text-lg font-medium text-gray-800">ยืนยัน Done?</h2>
              <p className="text-xs text-gray-500">
                {row.bookingCode || row.id} · {row.outlet.code} · {row.program.name}
              </p>
              <div className="text-xs text-gray-700 bg-gray-50 rounded p-3 space-y-1">
                <div>📹 Video: <strong>{row.videoCount}</strong> ไฟล์</div>
                <div>🎙️ Sound: <strong>{row.soundCount}</strong> ไฟล์</div>
                <div>📦 รวม: <strong>{fmtBytes(row.totalBytes)}</strong></div>
                {row.inFlightCount > 0 && (
                  <div className="text-amber-700">⚠️ ยังมี {row.inFlightCount} ไฟล์ที่กำลัง upload</div>
                )}
                {row.failedCount > 0 && (
                  <div className="text-red-700">⚠️ มี {row.failedCount} ไฟล์ FAILED</div>
                )}
              </div>
              <div>
                <label className="text-[11px] text-gray-500 mb-1 block">หมายเหตุ (optional)</label>
                <textarea rows={2} maxLength={1000}
                  value={confirmNote} onChange={e => setConfirmNote(e.target.value)}
                  placeholder="เช่น ครบ 4 cam + sound + B-roll OK"
                  className="gf-input resize-none w-full" />
              </div>
              <p className="text-[11px] text-gray-500">
                Booking จะเปลี่ยน CONFIRMED → COMPLETED และหายจากคิว
              </p>
              <div className="flex justify-end gap-2">
                <button onClick={() => setConfirmId(null)}
                  className="text-xs px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50">
                  ยกเลิก
                </button>
                <button onClick={() => confirmDone(row, confirmNote)}
                  disabled={acting === row.id}
                  className="text-xs px-4 py-1.5 border border-green-500 text-white bg-green-600 rounded hover:bg-green-700 disabled:opacity-40 inline-flex items-center gap-1">
                  {acting === row.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                  ✓ Mark as Done
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

function ReviewCard({ row, onConfirm, busy }: { row: ReviewRow; onConfirm: (() => void) | null; busy: boolean }) {
  const shootDate = (() => { try { return format(parseISO(row.shootDate), 'EEE dd MMM yyyy') } catch { return row.shootDate } })()
  return (
    <div className="border border-gray-200 rounded p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/admin/${row.id}`}
              className="font-mono font-medium text-gray-900 hover:text-[#673ab7] hover:underline inline-flex items-center gap-1">
              {row.bookingCode || row.id} <ExternalLink className="w-3 h-3" />
            </Link>
            <span className="bg-gray-100 px-1.5 py-0.5 text-[11px] rounded">{row.outlet.code}</span>
            <span className="text-xs text-gray-700">{row.program.name}</span>
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            {shootDate} {row.callTime}{row.estimatedWrap ? `–${row.estimatedWrap}` : ''} · PD: {row.producer}
          </div>
        </div>
        {onConfirm ? (
          <button onClick={onConfirm} disabled={busy}
            className="text-xs px-3 py-1.5 border border-green-500 text-white bg-green-600 rounded hover:bg-green-700 disabled:opacity-40 inline-flex items-center gap-1 shrink-0">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
            ✓ Mark as Done
          </button>
        ) : (
          <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded shrink-0">
            ขาด {!row.hasVideo ? 'Video' : 'Sound'}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
        <div className={`px-2 py-1 rounded border ${row.hasVideo ? 'bg-green-50 border-green-200 text-green-800' : 'bg-gray-50 border-gray-200 text-gray-500'}`}>
          <Video className="w-3 h-3 inline mr-1" /> Video {row.videoCount}
        </div>
        <div className={`px-2 py-1 rounded border ${row.hasSound ? 'bg-green-50 border-green-200 text-green-800' : 'bg-gray-50 border-gray-200 text-gray-500'}`}>
          <Mic className="w-3 h-3 inline mr-1" /> Sound {row.soundCount}
        </div>
        <div className="px-2 py-1 rounded border border-gray-200 text-gray-600">
          📦 {fmtBytes(row.totalBytes)}
        </div>
        <div className="px-2 py-1 rounded border border-gray-200 text-gray-600">
          {row.lastUploadAt ? `🕐 ${new Date(row.lastUploadAt).toLocaleString('th-TH-u-ca-gregory')}` : '🕐 —'}
        </div>
      </div>
      {row.uploaders.length > 0 && (
        <div className="text-[10px] text-gray-500 truncate">
          อัพโดย: {row.uploaders.join(' · ')}
        </div>
      )}
      {(row.inFlightCount > 0 || row.failedCount > 0) && (
        <div className="text-[10px] text-amber-700">
          {row.inFlightCount > 0 && <>⏳ {row.inFlightCount} ไฟล์กำลังอัพ</>}
          {row.inFlightCount > 0 && row.failedCount > 0 && ' · '}
          {row.failedCount > 0 && <>❌ {row.failedCount} ไฟล์ FAILED</>}
        </div>
      )}
    </div>
  )
}
