'use client'

import { bookingDisplayName } from '@/lib/display'
import CrewLine from '@/app/_components/CrewLine'
import { useEffect, useState, useCallback } from 'react'
import { formatDisplayDate, statusLabel } from '@/lib/utils'

interface Episode { episodeId: string; title: string; program?: { code?: string; name: string } | null }
interface Booking {
  assignedCrew?: { email: string; name: string; isLead?: boolean }[]
  id: string
  bookingCode: string | null
  shootDate: string
  callTime: string
  estimatedWrap?: string | null
  status: string
  assignedEmails: string[]
  producer: string
  projectId?: string | null
  projectName?: string | null
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
  createdAt: string
}
interface HistoryRow {
  id: string
  at: string
  action: string
  actorEmail: string | null
  fromStatus: string | null
  toStatus: string | null
  changes: any
}

const STATUS_BADGE: Record<string, string> = {
  REQUESTED: 'bg-red-100 text-red-700 border border-red-200',
  ASSIGNED: 'bg-yellow-100 text-yellow-700 border border-yellow-200',
  CONFIRMED: 'bg-green-100 text-green-700 border border-green-200',
  CANCELLED: 'bg-gray-100 text-gray-500 border border-gray-200',
  COMPLETED: 'bg-blue-100 text-blue-700 border border-blue-200',
}

export default function ProducerDashboard({ producerEmail }: { producerEmail: string }) {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [history, setHistory] = useState<Record<string, HistoryRow[]>>({})
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/bookings?scope=producer&limit=100&withCrew=1')
    const data = await res.json()
    setBookings(data.bookings || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const openBooking = async (id: string) => {
    if (openId === id) { setOpenId(null); return }
    setOpenId(id)
    if (!history[id]) {
      const res = await fetch(`/api/bookings/${id}/history`)
      if (res.ok) {
        const data = await res.json()
        setHistory(prev => ({ ...prev, [id]: data.history || [] }))
      }
    }
  }

  const sendMessage = async (
    id: string,
    type: 'update' | 'time_change',
    message: string,
    requestedTime?: string,
  ) => {
    setBusy(true)
    setFlash('')
    try {
      const res = await fetch(`/api/bookings/${id}/producer-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, message, requestedTime }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      setFlash(
        type === 'time_change'
          ? `ส่งคำขอแก้เวลาให้แอดมินแล้ว${data.emailed ? ` (อีเมล ${data.emailed} คน)` : ''}`
          : `ส่งอัปเดตให้แอดมินแล้ว${data.emailed ? ` (อีเมล ${data.emailed} คน)` : ''}`,
      )
      // refresh history for this booking
      const h = await fetch(`/api/bookings/${id}/history`)
      if (h.ok) { const d = await h.json(); setHistory(prev => ({ ...prev, [id]: d.history || [] })) }
    } catch (e: any) {
      setFlash(`ผิดพลาด: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-8">
      <div className="mb-5 flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-normal text-gray-800">Producer Dashboard</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            งานที่คุณเป็น Producer ({producerEmail}) · ดูสถานะ · ส่งอัปเดต · ขอแก้เวลา
          </p>
        </div>
        <a
          href="/api/bookings/export?scope=producer"
          className="px-3 py-1.5 text-xs sm:text-sm border border-gray-300 rounded hover:bg-gray-50 whitespace-nowrap"
        >
          📥 Export CSV
        </a>
      </div>

      {flash && (
        <div className="mb-4 rounded bg-blue-50 border border-blue-200 px-3 py-2 text-sm text-blue-800">{flash}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : bookings.length === 0 ? (
        <p className="text-sm text-gray-400">ยังไม่มีงานที่คุณเป็น Producer</p>
      ) : (
        <div className="space-y-3">
          {[...bookings].sort((a, b) => a.shootDate.localeCompare(b.shootDate)).map(b => {
            const assigned = (b.assignedEmails || []).length > 0
            const open = openId === b.id
            return (
              <div key={b.id} className="gf-card p-4">
                <button onClick={() => openBooking(b.id)} className="w-full text-left">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-mono font-medium text-gray-800">{b.bookingCode || b.id}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[b.status] || ''}`}>
                      {statusLabel(b.status)}
                    </span>
                  </div>
                  <div className="text-sm text-gray-600 mt-1">
                    {b.outlet.name} · {bookingDisplayName(b)}
                    {b.episodes[0]?.title ? ` — ${b.episodes[0].title}` : ''}
                    {b.projectId ? ` · ${b.projectId}` : ''}
                  </div>
                  <CrewLine crew={b.assignedCrew} />
                  <div className="text-xs text-gray-500 mt-0.5">
                    {formatDisplayDate(b.shootDate)} · {b.callTime}{b.estimatedWrap ? ` → ${b.estimatedWrap}` : ''}
                    {/* v1.36.1 — assignment hint must respect status: a CANCELLED
                        (or COMPLETED-but-unassigned) booking is NOT "waiting for
                        admin to assign". Only REQUESTED/ASSIGNED-stage bookings
                        show the pending-assign nudge; terminal states let the
                        status pill speak for itself. */}
                    {assigned ? (
                      <>{' · '}<span className="text-green-600">assigned: {b.assignedEmails.join(', ')}</span></>
                    ) : b.status === 'CANCELLED' || b.status === 'COMPLETED' ? null : (
                      <>{' · '}<span className="text-yellow-600">⏳ รอแอดมิน assign</span></>
                    )}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    {b.episodes.map(e => e.episodeId).join(', ')}
                  </div>
                </button>

                {open && (
                  <div className="mt-3 pt-3 border-t border-gray-100 space-y-4">
                    <ProducerActions bookingId={b.id} busy={busy} onSend={sendMessage} />
                    <HistoryList rows={history[b.id]} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ProducerActions({
  bookingId,
  busy,
  onSend,
}: {
  bookingId: string
  busy: boolean
  onSend: (id: string, type: 'update' | 'time_change', message: string, requestedTime?: string) => void
}) {
  const [updateMsg, setUpdateMsg] = useState('')
  const [timeReq, setTimeReq] = useState('')
  const [timeMsg, setTimeMsg] = useState('')

  return (
    <div className="grid sm:grid-cols-2 gap-4">
      <div>
        <label className="text-xs font-medium text-gray-600 block mb-1">ส่งอัปเดต / รายละเอียดเพิ่ม → แอดมิน</label>
        <textarea
          className="gf-input text-sm" rows={3}
          placeholder="รายละเอียดเพิ่มเติม…"
          value={updateMsg}
          onChange={e => setUpdateMsg(e.target.value)}
        />
        <button
          disabled={busy || !updateMsg.trim()}
          onClick={() => { onSend(bookingId, 'update', updateMsg); setUpdateMsg('') }}
          className="mt-2 px-3 py-1.5 text-xs bg-[#673ab7] text-white rounded disabled:opacity-40"
        >
          ส่งอัปเดต + อีเมลแอดมิน
        </button>
      </div>
      <div>
        <label className="text-xs font-medium text-gray-600 block mb-1">ขอแก้เวลา → แอดมิน</label>
        <input
          className="gf-input text-sm mb-2"
          placeholder="เวลาใหม่ที่ขอ เช่น 14:00 → 16:00"
          value={timeReq}
          onChange={e => setTimeReq(e.target.value)}
        />
        <textarea
          className="gf-input text-sm" rows={2}
          placeholder="เหตุผล…"
          value={timeMsg}
          onChange={e => setTimeMsg(e.target.value)}
        />
        <button
          disabled={busy || (!timeReq.trim() && !timeMsg.trim())}
          onClick={() => { onSend(bookingId, 'time_change', timeMsg, timeReq); setTimeReq(''); setTimeMsg('') }}
          className="mt-2 px-3 py-1.5 text-xs border border-[#673ab7] text-[#673ab7] rounded disabled:opacity-40"
        >
          ส่งคำขอแก้เวลา
        </button>
      </div>
    </div>
  )
}

function HistoryList({ rows }: { rows?: HistoryRow[] }) {
  if (!rows) return <p className="text-xs text-gray-400">กำลังโหลดประวัติ…</p>
  if (rows.length === 0) return <p className="text-xs text-gray-400">ยังไม่มีประวัติ</p>
  return (
    <div>
      <div className="text-xs font-medium text-gray-600 mb-1">ประวัติ</div>
      <ul className="space-y-1">
        {rows.map(r => (
          <li key={r.id} className="text-xs text-gray-500">
            <span className="text-gray-400">{new Date(r.at).toLocaleString('th-TH-u-ca-gregory')}</span>
            {' · '}<span className="font-medium text-gray-700">{r.action.replace('booking.', '')}</span>
            {r.fromStatus && r.toStatus ? ` · ${r.fromStatus}→${r.toStatus}` : ''}
            {r.changes?.message ? ` · "${r.changes.message}"` : ''}
            {r.changes?.requestedTime ? ` · ⏱ ${r.changes.requestedTime}` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}
