'use client'

import { useEffect, useMemo, useState } from 'react'
import BackButton from '@/app/_components/BackButton'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { Loader2, CheckCircle2, XCircle, AlertTriangle, Lock, Send, Download } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { summarizeDay, formatTHB, dateOffsetDays, type DaySummary } from '@/lib/ot-calc'

type ApprovalStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'

interface OTRecord {
  id: string
  userEmail: string
  month: string
  date: string
  endDate: string | null
  startTime: string | null
  endTime: string | null
  jobTask: string | null
  justification: string | null
  approvalStatus: ApprovalStatus
  submittedAt: string | null
  approvedAt: string | null
  approvedByEmail: string | null
  rejectionNote: string | null
  bookingId: string | null
}

const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม']
function currentMonth(): string { return new Date().toISOString().slice(0, 7) }
function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split('-')
  return `${THAI_MONTHS[parseInt(m) - 1]} ${y}`
}

export default function OTReviewPage() {
  const params = useParams<{ email: string }>()
  const search = useSearchParams()
  const router = useRouter()
  const email = decodeURIComponent(String(params?.email || ''))
  const month = search?.get('month') || currentMonth()

  const [records, setRecords] = useState<OTRecord[]>([])
  const [requesterSig, setRequesterSig] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [acting, setActing] = useState(false)

  // Reject modal state
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [rejectNote, setRejectNote] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/ot?email=${encodeURIComponent(email)}&month=${month}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      const recs: OTRecord[] = data.records || []
      setRecords(recs)
      // Pull the most-recent requester signature snapshot from the records
      // themselves so the page can preview what the user submitted with
      // (manager wants to see the signature alongside the work).
      const withSig = recs.find(r => (r as any).requesterSignaturePng)
      setRequesterSig(withSig ? (withSig as any).requesterSignaturePng : null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [email, month])

  // Group records by date and compute summary per day (same logic as /ot)
  const days = useMemo(() => {
    const byDate = new Map<string, OTRecord[]>()
    for (const r of records) {
      const key = r.date.slice(0, 10)
      if (!byDate.has(key)) byDate.set(key, [])
      byDate.get(key)!.push(r)
    }
    return Array.from(byDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, list]) => {
        const summary = summarizeDay(date, list.map(r => ({
          startTime: r.startTime || '',
          endTime: r.endTime || '',
          endOffsetDays: dateOffsetDays(r.date, r.endDate),
          jobTask: r.jobTask,
          justification: r.justification,
        })))
        return { date, records: list, summary }
      })
  }, [records])

  const submittedRecords = useMemo(() => records.filter(r => r.approvalStatus === 'SUBMITTED'), [records])
  const totalAmount = useMemo(() => days.reduce((a, d) => a + (d.summary.qualifies ? d.summary.otAmountTHB : 0), 0), [days])

  const approveOne = async (id: string) => {
    setActing(true)
    setError('')
    try {
      const res = await fetch('/api/ot/admin/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordIds: [id] }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      load()
    } catch (e: any) { setError(e.message) }
    finally { setActing(false) }
  }

  const approveAll = async () => {
    if (!submittedRecords.length) return
    if (!confirm(`อนุมัติ OT ${submittedRecords.length} รายการของ ${email} (${monthLabel(month)})?`)) return
    setActing(true)
    setError('')
    try {
      const res = await fetch('/api/ot/admin/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, month }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      load()
    } catch (e: any) { setError(e.message) }
    finally { setActing(false) }
  }

  const submitReject = async () => {
    if (!rejectId || !rejectNote.trim()) return
    setActing(true)
    setError('')
    try {
      const res = await fetch('/api/ot/admin/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId: rejectId, note: rejectNote.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setRejectId(null)
      setRejectNote('')
      load()
    } catch (e: any) { setError(e.message) }
    finally { setActing(false) }
  }

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3 pb-24">
      <BackButton fallback={`/ot/admin?month=${month}`} label="กลับ Admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800" />

      <div className="gf-header p-4 sm:p-6 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-normal text-gray-800">Review OT</h1>
          <p className="text-xs sm:text-sm text-gray-500">{email} · {monthLabel(month)}</p>
        </div>
        <a
          href={`/api/ot/export/pdf?month=${month}&email=${encodeURIComponent(email)}`}
          download
          className="px-3 py-1.5 text-xs border border-[#673ab7] text-white bg-[#673ab7] rounded hover:bg-[#5e35b1] inline-flex items-center gap-1 self-start">
          <Download className="w-3 h-3" /> PDF
        </a>
      </div>

      {error && (
        <div className="gf-card p-3 text-sm text-red-600 border-l-4 border-red-400 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="gf-card p-3">
          <div className="text-[10px] text-gray-500 mb-0.5">รายการทั้งหมด</div>
          <div className="text-xl font-medium text-gray-800">{records.length}</div>
        </div>
        <div className="gf-card p-3 bg-amber-50">
          <div className="text-[10px] text-amber-700 mb-0.5">รออนุมัติ</div>
          <div className="text-xl font-medium text-amber-700">{submittedRecords.length}</div>
        </div>
        <div className="gf-card p-3 bg-green-50">
          <div className="text-[10px] text-green-700 mb-0.5">อนุมัติแล้ว</div>
          <div className="text-xl font-medium text-green-700">{records.filter(r => r.approvalStatus === 'APPROVED').length}</div>
        </div>
        <div className="gf-card p-3 bg-blue-50">
          <div className="text-[10px] text-blue-700 mb-0.5">รวม THB</div>
          <div className="text-xl font-medium text-blue-700">{formatTHB(totalAmount)}</div>
        </div>
      </div>

      {/* Requester signature preview */}
      {requesterSig && (
        <div className="gf-card p-3 flex items-center gap-3">
          <div className="text-xs text-gray-500">ลายเซ็นผู้ขอ:</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={requesterSig} alt="requester signature" className="max-h-12" />
        </div>
      )}

      {/* Days list */}
      {loading ? (
        <div className="py-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
      ) : days.length === 0 ? (
        <div className="gf-card p-8 text-center text-sm text-gray-400">ไม่มีรายการเดือนนี้</div>
      ) : (
        days.map(d => (
          <DayReviewCard
            key={d.date}
            date={d.date}
            records={d.records}
            summary={d.summary}
            acting={acting}
            onApprove={approveOne}
            onReject={(id) => { setRejectId(id); setRejectNote('') }}
          />
        ))
      )}

      {/* Sticky footer — bulk approve all SUBMITTED for this person */}
      {submittedRecords.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-40">
          <div className="max-w-5xl mx-auto px-3 sm:px-4 py-3 flex items-center gap-3 flex-wrap">
            <div className="text-sm text-gray-700">
              รออนุมัติ <strong className="text-amber-700">{submittedRecords.length}</strong> รายการ · {formatTHB(submittedRecords.length > 0 ? totalAmount : 0)}
            </div>
            <button
              type="button"
              onClick={approveAll}
              disabled={acting}
              className="ml-auto text-sm px-4 py-2 border border-[#673ab7] text-white bg-[#673ab7] rounded hover:bg-[#5e35b1] disabled:opacity-40 inline-flex items-center gap-1">
              {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              อนุมัติทั้งหมด + เซ็น
            </button>
          </div>
        </div>
      )}

      {/* Reject modal */}
      {rejectId && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setRejectId(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-medium text-gray-800">ตีกลับรายการนี้</h2>
            <p className="text-xs text-gray-500">
              เขียนเหตุผลให้ user เห็น — เช่น "เวลาผิด", "เหตุผลไม่ชัด", "ขอเอกสารแนบ"
            </p>
            <textarea
              autoFocus
              rows={3}
              maxLength={500}
              value={rejectNote}
              onChange={e => setRejectNote(e.target.value)}
              placeholder="เหตุผลที่ตีกลับ..."
              className="gf-input resize-none"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setRejectId(null)}
                className="text-xs px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50">
                ยกเลิก
              </button>
              <button type="button" onClick={submitReject}
                disabled={acting || !rejectNote.trim()}
                className="text-xs px-4 py-1.5 border border-red-500 text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-40 inline-flex items-center gap-1">
                {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                ตีกลับ
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function statusChip(status: ApprovalStatus) {
  switch (status) {
    case 'DRAFT':     return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">Draft</span>
    case 'SUBMITTED': return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">Submitted</span>
    case 'APPROVED':  return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">Approved</span>
    case 'REJECTED':  return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">Rejected</span>
  }
}

function DayReviewCard({ date, records, summary, acting, onApprove, onReject }: {
  date: string
  records: OTRecord[]
  summary: DaySummary
  acting: boolean
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  const colorClass =
    summary.dayType === 'HOLIDAY' ? 'border-l-red-400 bg-red-50/30' :
    summary.dayType === 'WEEKEND' ? 'border-l-orange-400 bg-orange-50/30' :
    summary.qualifies ? 'border-l-blue-400 bg-blue-50/30' :
    'border-l-gray-200'

  return (
    <div className={`gf-card p-4 border-l-4 ${colorClass}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
        <div>
          <div className="text-sm font-medium text-gray-800">
            {format(parseISO(date), 'EEE dd MMM yyyy')}
            {summary.holidayName && <span className="ml-2 text-xs text-red-600">🎉 {summary.holidayName}</span>}
          </div>
          <div className="text-[10px] text-gray-500 mt-0.5">
            {summary.dayLabel} · span {summary.totalHours}h{summary.hasStandby && ' · Standby'}
          </div>
        </div>
        <div className={`text-right text-base font-medium ${summary.qualifies ? 'text-green-700' : 'text-gray-400'}`}>
          {summary.qualifies ? formatTHB(summary.otAmountTHB) : '—'}
        </div>
      </div>

      <div className="divide-y divide-gray-100">
        {records.map(r => {
          const canAct = r.approvalStatus === 'SUBMITTED'
          return (
            <div key={r.id} className="py-2 flex items-start gap-3 flex-wrap">
              <div className="text-xs text-gray-500 font-mono flex-shrink-0 w-24">
                {r.startTime || '—'} → {r.endTime || '—'}
                {dateOffsetDays(r.date, r.endDate) > 0 && (
                  <span className="ml-1 text-purple-600" title={`เลิกงานวันที่ ${r.endDate?.slice(0, 10)}`}>🌙+{dateOffsetDays(r.date, r.endDate)}</span>
                )}
              </div>
              <div className="flex-1 min-w-[200px]">
                <div className="text-sm text-gray-800">{r.jobTask || '—'}</div>
                {r.justification && (
                  <div className="text-xs text-gray-500 mt-0.5">📝 {r.justification}</div>
                )}
                {r.approvalStatus === 'REJECTED' && r.rejectionNote && (
                  <div className="text-xs text-red-700 mt-0.5">⚠️ Note: {r.rejectionNote}</div>
                )}
                <div className="flex items-center gap-1 mt-1 flex-wrap">
                  {statusChip(r.approvalStatus)}
                  {r.submittedAt && (
                    <span className="text-[9px] text-gray-400">ส่ง {new Date(r.submittedAt).toLocaleDateString('th-TH-u-ca-gregory')}</span>
                  )}
                  {r.approvedAt && (
                    <span className="text-[9px] text-gray-400">โดย {r.approvedByEmail} เมื่อ {new Date(r.approvedAt).toLocaleDateString('th-TH-u-ca-gregory')}</span>
                  )}
                  {r.bookingId && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">auto</span>}
                </div>
              </div>
              {canAct ? (
                <div className="inline-flex gap-1 flex-shrink-0">
                  <button onClick={() => onApprove(r.id)} disabled={acting}
                    title="อนุมัติแถวนี้"
                    className="text-xs px-2 py-1 border border-green-400 text-green-700 rounded hover:bg-green-50 disabled:opacity-40 inline-flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Approve
                  </button>
                  <button onClick={() => onReject(r.id)} disabled={acting}
                    title="ตีกลับ + ใส่เหตุผล"
                    className="text-xs px-2 py-1 border border-red-400 text-red-700 rounded hover:bg-red-50 disabled:opacity-40 inline-flex items-center gap-1">
                    <XCircle className="w-3 h-3" /> Reject
                  </button>
                </div>
              ) : r.approvalStatus === 'APPROVED' ? (
                <span className="text-[10px] text-gray-400 inline-flex items-center gap-0.5 flex-shrink-0">
                  <Lock className="w-3 h-3" /> ล็อก
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
