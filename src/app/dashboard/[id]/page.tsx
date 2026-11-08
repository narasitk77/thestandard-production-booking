'use client'

import { bookingDisplayName } from '@/lib/display'
import { hasConsoleAccess } from '@/lib/roles'
import { isMyBooking } from '@/lib/my-bookings-scope'
import EquipmentRequest from './EquipmentRequest'
import MixRequests from './MixRequests'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import BackButton from '@/app/_components/BackButton'
import { formatDateRange, buildCalendarPacket, statusColor, statusLabel, shootTypeLabel, categoryLabel } from '@/lib/utils'
import CalendarPacketDetails from '@/app/_components/CalendarPacketDetails'
import { isAdvertorial, AdBadge } from '@/app/_components/StatusPill'
import { isValidQuRef } from '@/lib/qu-ref'
import { Copy, Check, Calendar, Folder, Upload, CheckCircle2, XCircle, Loader2 } from 'lucide-react'

interface Episode {
  id: string
  episodeId: string
  sequence: number
  title: string
  program?: { code?: string; name: string } | null
}

interface UploadRecord {
  id: string
  camera: string
  fileName: string
  fileSize: string | null
  status: string
  uploadedBy: string
  createdAt: string
  episode: { episodeId: string } | null
}

interface BookingDetail {
  isBlockShot?: boolean
  assignedCrew?: { email: string; name: string; isLead?: boolean }[]
  id: string
  shootDate: string
  shootEndDate?: string | null
  callTime: string
  estimatedWrap?: string
  status: string
  category: string
  videoType?: string | null
  shootType: string
  locationName?: string
  producer: string
  creative: string[]
  crewRequired: string[]
  vanCount?: number | null
  agencyRef?: string
  notes?: string
  /** v1.219 — API คืนมาอยู่แล้ว แค่ยังไม่เคยประกาศในไทป์ฝั่งนี้ */
  bookingCode?: string | null
  /** v1.223.4 — ผลการจองห้องในระบบกลาง: เก็บมาตั้งแต่ v1.200 แต่ไม่เคยมีหน้าไหนแสดง */
  roomBookingNo?: string | null
  roomBookingStatus?: string | null
  roomBookingError?: string | null
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
  uploads: UploadRecord[]
  createdAt: string
  cancelRequestedAt?: string | null
  cancelReason?: string | null
  cancelRequestedBy?: string | null
  // the people on the booking — isMyBooking() reads these (GET returns every scalar)
  createdByEmail?: string | null
  producerEmail?: string | null
  coProducerEmail?: string | null
  assignedEmails?: string[] | null
}

export default function BookingDetailPage({ params }: { params: { id: string } }) {
  const { id } = params
  const [booking, setBooking] = useState<BookingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [updating, setUpdating] = useState(false)

  const [error, setError] = useState('')
  // v1.50.2 — the page is reachable by anyone on the booking (the API scopes
  // reads); status actions stay console-only, so hide them for plain users.
  const [isStaff, setIsStaff] = useState(false)
  const [canUpload, setCanUpload] = useState(false)
  const [myEmail, setMyEmail] = useState('')
  // /api/me failing used to be swallowed: isStaff/myEmail stayed empty and the
  // per-user buttons below silently vanished (bug-classes §2, "error removes affordance")
  const [meError, setMeError] = useState('')
  // v1.100 — per-EP "open footage on Drive" links, resolved from the EP's folder
  // path (works for footage moved from NAS into the boxes, not just uploads).
  const [epFolders, setEpFolders] = useState<Record<string, string | null>>({})
  // maint 2026-11-08 (ui-14) — the real id-first box link (same response). null =
  // not resolved yet / no box; epFoldersError = the lookup itself failed, which
  // used to look exactly like "no footage links" (bug-classes §2).
  const [boxUrl, setBoxUrl] = useState<string | null>(null)
  const [epFoldersError, setEpFoldersError] = useState('')
  const [epFoldersLoaded, setEpFoldersLoaded] = useState(false)
  // Request-cancellation (owner/producer asks; staff actually cancels).
  const [showCancelForm, setShowCancelForm] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [requesting, setRequesting] = useState(false)

  useEffect(() => {
    fetch(`/api/bookings/${id}`)
      .then(r => r.json())
      .then(data => {
        if (!data?.booking) {
          setError(data?.error || 'Booking not found')
          return
        }
        setBooking(data.booking)
      })
      .catch(e => setError(e?.message || 'Failed to load booking'))
      .finally(() => setLoading(false))
    fetch('/api/me')
      .then(async r => {
        const d = await r.json().catch(() => null)
        if (!r.ok || !d) throw new Error(d?.error ? `${d.error} (HTTP ${r.status})` : `HTTP ${r.status}`)
        if (!d.user) throw new Error('ไม่พบบัญชีผู้ใช้ของคุณในระบบ')
        return d
      })
      .then(d => { setIsStaff(hasConsoleAccess(d.user.role)); setCanUpload(!!d.user.canUpload); setMyEmail(d.user.email || '') })
      .catch(e => setMeError(e?.message || String(e)))
    // non-blocking — Drive folder links per EP (incl. NAS-moved footage) + the box
    fetch(`/api/bookings/${id}/ep-folders`)
      .then(async r => {
        const d = await r.json().catch(() => null)
        if (!r.ok || !d) throw new Error(d?.error ? `${d.error} (HTTP ${r.status})` : `HTTP ${r.status}`)
        return d
      })
      .then(d => {
        const m: Record<string, string | null> = {}
        for (const e of d.episodes || []) m[e.id] = e.url // keyed by Episode.id (unique)
        setEpFolders(m)
        setBoxUrl(d.bookingFolderUrl || null)
      })
      .catch(e => setEpFoldersError(e?.message || String(e)))
      .finally(() => setEpFoldersLoaded(true))
  }, [id])

  const backHref = isStaff ? '/dashboard' : '/my-bookings'
  const backLabel = isStaff ? 'Dashboard' : 'My Bookings'

  const handleStatusChange = async (newStatus: string) => {
    if (!booking) return
    // maint 2026-11-08 (ui-8) — Cancel sits next to Mark Complete and fires the
    // calendar delete + central room release + OT clear immediately; the queue's
    // CancelButton already asks first. Restore only returns it to REQUESTED.
    if (newStatus === 'CANCELLED' && !confirm(
      'ยกเลิกงานนี้?\n\n• ลบ event ใน Google Calendar (ทีมได้แจ้งยกเลิก)\n• คืนห้องในระบบจองห้องกลาง (คนอื่นจองไปได้ทันที)\n• ล้างร่าง OT ของงานนี้\n\nกู้คืนได้แค่กลับเป็น REQUESTED — ต้องอนุมัติ/จองห้องใหม่',
    )) return
    setUpdating(true)
    try {
      const res = await fetch(`/api/bookings/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      const data = await res.json()
      if (!res.ok || !data?.booking) {
        setError(data?.error || 'Failed to update status')
        return
      }
      setBooking(prev => prev ? { ...prev, status: data.booking.status } : prev)
    } finally {
      setUpdating(false)
    }
  }

  const submitCancelRequest = async () => {
    if (!booking || !cancelReason.trim()) return
    setRequesting(true)
    setError('')
    try {
      const res = await fetch(`/api/bookings/${id}/request-cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: cancelReason.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data?.error || 'ขอยกเลิกไม่สำเร็จ'); return }
      setBooking(prev => prev ? { ...prev, cancelRequestedAt: data.booking.cancelRequestedAt, cancelReason: data.booking.cancelReason, cancelRequestedBy: data.booking.cancelRequestedBy } : prev)
      setShowCancelForm(false)
      setCancelReason('')
    } finally {
      setRequesting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    )
  }

  if (!booking) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-20 text-center">
        <p className="text-gray-500">{error || 'Booking not found.'}</p>
        <Link href={backHref} className="gf-link mt-4 inline-block">Back to {backLabel}</Link>
      </div>
    )
  }

  let calendarPacket = ''
  try {
    calendarPacket = buildCalendarPacket({
    outletName: booking.outlet.name,
    outletCode: booking.outlet.code,
    programName: booking.program.name,
    programCode: booking.program.code,
    shootDate: booking.shootDate,
    shootEndDate: booking.shootEndDate,
    callTime: booking.callTime,
    estimatedWrap: booking.estimatedWrap,
    shootType: booking.shootType,
    locationName: booking.locationName,
    producer: booking.producer,
    creative: booking.creative,
    crewRequired: booking.crewRequired,
    agencyRef: booking.agencyRef,
    notes: booking.notes,
    episodes: booking.episodes,
    })
  } catch (e) {
    console.error('buildCalendarPacket error:', e)
    calendarPacket = '(calendar packet unavailable)'
  }

  // request-cancel and equipment-request accept any signed-in user (prod; who may
  // is Nat's open decision) — so the buttons are not gated on being on the booking.
  // Instead a cancel request filed by someone NOT on the booking is labelled here.
  const cancelByOutsider = !!booking.cancelRequestedBy && !isMyBooking(booking, booking.cancelRequestedBy)

  const handleCopy = () => {
    navigator.clipboard.writeText(calendarPacket)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-3">
      <BackButton fallback={backHref} />

      {error && <p className="text-xs text-red-600">{error}</p>}
      {meError && (
        <p className="text-xs text-red-600">
          โหลดข้อมูลผู้ใช้ไม่ได้ ({meError}) — ปุ่มที่ขึ้นกับสิทธิ์ (ปุ่มแอดมิน / อัปโหลด / ยกเลิกคำขอเบิกของตัวเอง) อาจไม่แสดง ลองรีเฟรชหน้า
        </p>
      )}

      {/* Header */}
      <div className="gf-header p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor(booking.status)}`}>
                {statusLabel(booking.status)}
              </span>
              {isAdvertorial(booking.category)
                ? <AdBadge category={booking.category} />
                : <span className="text-xs text-gray-400">{categoryLabel(booking.category)}</span>}
            </div>
            <h1 className="text-2xl font-normal text-gray-800 mb-1">
              {booking.isBlockShot ? '🧱 ' : ''}{booking.outlet.name} · {bookingDisplayName(booking)}
            </h1>
            <p className="text-sm text-gray-500">
              {formatDateRange(booking.shootDate, booking.shootEndDate)} · {booking.callTime}
              {booking.estimatedWrap && ` → ${booking.estimatedWrap}`}
              {' · '}{shootTypeLabel(booking.shootType)}
              {booking.locationName && ` @ ${booking.locationName}`}
            </p>
            {/* v1.223.4 — สถานะห้องในระบบกลาง
                `roomBookingStatus` ถูกเขียนลง DB ตั้งแต่ v1.200 แต่ `grep` ทั้งรีโป
                แล้วไม่มี .tsx ไฟล์ไหนอ่านมันเลย — ผลของการจองห้องจึงไม่เคยถึงตาคน
                ที่เป็นเจ้าของงาน ตรงกับกฎของทีมเป๊ะ: *บันทึกไว้ ≠ ส่งถึง*
                แสดงเฉพาะเคสที่ "มีอะไรต้องรู้" — สำเร็จแล้วไม่ต้องรบกวน */}
            {booking.roomBookingStatus === 'CONFLICT' && (
              <p className="mt-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 inline-block">
                ⚠️ จองห้องในระบบส่วนกลางไม่ได้ — ห้องไม่ว่างในช่วงเวลานี้
                {booking.roomBookingError ? ` (${booking.roomBookingError})` : ''}
              </p>
            )}
            {(booking.roomBookingStatus === 'INVALID' || booking.roomBookingStatus === 'UNKNOWN') && (
              <p className="mt-1 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-2 py-1 inline-block">
                ระบบยังจองห้องส่วนกลางให้ไม่สำเร็จ
                {booking.roomBookingError ? ` — ${booking.roomBookingError}` : ''}
              </p>
            )}
          </div>

          {isStaff && (
            <div className="flex gap-2 flex-shrink-0">
              {booking.status !== 'CANCELLED' && booking.status !== 'COMPLETED' && (
                <button onClick={() => handleStatusChange('CANCELLED')} disabled={updating}
                  className="px-3 py-1.5 text-xs border border-gray-300 rounded text-red-600 hover:border-red-300 hover:bg-red-50 flex items-center gap-1">
                  <XCircle className="w-3.5 h-3.5" /> Cancel
                </button>
              )}
              {booking.status === 'CONFIRMED' && (
                <button onClick={() => handleStatusChange('COMPLETED')} disabled={updating}
                  className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
                  Mark Complete
                </button>
              )}
            </div>
          )}
        </div>

        {/* v1.193 — เลข QU ที่ยังไม่มีจริง: เดิมเห็นได้อย่างเดียวใน Calendar Packet
            แต่ "แก้ไม่ได้จากที่ไหนเลย" ถ้าไม่ใช่เจ้าของงานที่ยังอยู่สถานะ Requested
            งานที่ย้ายระบบมาจึงค้างถาวร — แถบนี้คือทางเข้าเดียวที่พาไปเติมเลขได้ */}
        {isAdvertorial(booking.category) && booking.status !== 'CANCELLED'
          && !isValidQuRef(booking.agencyRef || '') && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded border border-amber-300 bg-amber-50 px-3 py-2">
            <div className="text-xs text-amber-900">
              <span className="font-medium">ยังไม่มีเลข QU ที่ใช้ได้</span>
              {booking.agencyRef ? <> — ตอนนี้เป็น “{booking.agencyRef}” ซึ่งเป็นตัวยึด</> : <> — ช่อง Agency Ref ว่างอยู่</>}
            </div>
            <Link href={`/bookings/${booking.id}/edit`}
              className="shrink-0 px-2.5 py-1.5 text-xs rounded border border-amber-500 text-amber-800 bg-white hover:bg-amber-500 hover:text-white">
              🧾 ใส่เลข QU
            </Link>
          </div>
        )}

        {/* Producer/Creative/Crew/Agency Ref moved into the Calendar Packet card
            below (v1.131 redesign) — only the actually-assigned crew (distinct
            from crewRequired) stays here since it's not part of that card. */}
        <div className="mt-4 pt-4 border-t border-gray-100 text-xs">
          <div className="text-gray-400">ทีมงาน (assigned)</div>
          <div className="font-medium text-gray-800">{booking.assignedCrew && booking.assignedCrew.length > 0 ? booking.assignedCrew.map(c => `${c.name}${c.isLead ? ' ⭐' : ''}`).join(' · ') : '— ยังไม่ได้ assign —'}</div>
        </div>
      </div>

      {/* Cancellation request — owner/producer asks; staff cancels for real */}
      {booking.cancelRequestedAt ? (
        <div className="gf-card p-4 border-l-4 border-red-400 bg-red-50/40">
          <div className="text-sm text-red-800 font-medium">🚫 มีการขอยกเลิกงานนี้</div>
          <div className="text-xs text-gray-600 mt-1">เหตุผล: {booking.cancelReason}</div>
          {booking.cancelRequestedBy && <div className="text-xs text-gray-400 mt-0.5">โดย {booking.cancelRequestedBy}</div>}
          {cancelByOutsider && (
            <div className="text-xs text-amber-700 mt-0.5">⚠️ ผู้ขอไม่ได้อยู่ในรายชื่อของงานนี้ (ไม่ใช่ผู้จอง / Producer / Co-Producer / ทีม) — ตรวจกับ Producer ก่อนยกเลิกจริง</div>
          )}
          {isStaff && <div className="text-xs text-gray-500 mt-1">กด Cancel ด้านบนเพื่อยกเลิกจริง</div>}
        </div>
      ) : (!isStaff && booking.status !== 'CANCELLED' && booking.status !== 'COMPLETED') ? (
        <div className="gf-card p-4">
          {!showCancelForm ? (
            <button onClick={() => setShowCancelForm(true)}
              className="text-sm text-red-600 hover:text-red-700 inline-flex items-center gap-1">
              <XCircle className="w-4 h-4" /> ขอยกเลิกงาน
            </button>
          ) : (
            <div className="space-y-2">
              <div className="text-sm text-gray-700">ระบุเหตุผลที่ขอยกเลิก</div>
              <textarea value={cancelReason} onChange={e => setCancelReason(e.target.value)} rows={3}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                placeholder="เช่น ลูกค้าเลื่อนงาน / ถ่ายไม่ทัน ..." />
              <div className="flex gap-2">
                <button onClick={submitCancelRequest} disabled={requesting || !cancelReason.trim()}
                  className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
                  {requesting ? 'กำลังส่ง…' : 'ส่งคำขอยกเลิก'}
                </button>
                <button onClick={() => { setShowCancelForm(false); setCancelReason('') }}
                  className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">ยกเลิก</button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* Episode IDs */}
      <div className="gf-card p-5">
        <div className="text-xs text-gray-500 font-medium mb-2 uppercase tracking-wide">
          Episode IDs ({booking.episodes.length})
        </div>
        <div className="space-y-1.5">
          {booking.episodes.map(ep => (
            <div key={ep.id} className="flex items-center gap-3 py-1">
              <span className="episode-badge">{ep.episodeId}</span>
              <span className="text-sm text-gray-700 flex-1">{ep.title}</span>
              {epFolders[ep.id] && (
                <a href={epFolders[ep.id]!} target="_blank" rel="noreferrer"
                  className="text-xs text-[#673ab7] hover:underline inline-flex items-center gap-1 whitespace-nowrap shrink-0">
                  <Folder className="w-3.5 h-3.5" /> footage
                </a>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Drive box — maint 2026-11-08 (ui-14): this card used to print a made-up
          `Production/<yyyy>/<mm>/<EP>/` + `01_Source/Cam1 · 02_Proxy …` that exists
          nowhere; people following it made hand-named folders merge never picks up.
          Now: the real id-first box `<Show> · <Job> (<Production ID>)` from ep-folders. */}
      <div className="gf-card p-4 flex items-start gap-3">
        <Folder className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-gray-500 mb-1">กล่องงานบน Drive</div>
          {epFoldersError ? (
            <div className="text-xs text-red-700">หาโฟลเดอร์บน Drive ไม่ได้ — {epFoldersError} (ลิงก์ footage รายตอนด้านบนจึงไม่ขึ้น)</div>
          ) : !epFoldersLoaded ? (
            <div className="text-xs text-gray-400">กำลังหา…</div>
          ) : boxUrl ? (
            <a href={boxUrl} target="_blank" rel="noreferrer" className="text-sm text-[#673ab7] hover:underline break-all">
              เปิดกล่องงาน{booking.bookingCode ? ` (${booking.bookingCode})` : ''} ↗
            </a>
          ) : (
            <div className="text-xs text-gray-500">ยังไม่พบกล่องงานบน Drive{booking.bookingCode ? '' : ' (งานนี้ยังไม่มี Production ID)'}</div>
          )}
          <div className="mt-2 text-xs text-gray-400">
            ในกล่องแยกโฟลเดอร์ตามตอน (EP) → CAM-A / CAM-B … / AUDIO — ไฟล์เข้ากล่องผ่านระบบ ไม่ต้องสร้างโฟลเดอร์เอง
          </div>
        </div>
      </div>

      {/* Crew equipment requisition (เบิกอุปกรณ์) — open to anyone who can view the
          booking, any status (prod; the POST accepts the same). On a CANCELLED
          booking the POST still opens the loan — say so before anyone clicks. */}
      {booking.status === 'CANCELLED' && (
        <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          ⚠️ งานนี้ถูกยกเลิกแล้ว — ถ้าเบิกอุปกรณ์ตอนนี้ คำขอจะเข้าคิวผู้ดูแลอุปกรณ์ทั้งที่ไม่มีงานถ่ายรองรับ
        </div>
      )}
      <EquipmentRequest bookingId={id} myEmail={myEmail} canRequest />

      {/* v1.219 — คิวมิกซ์ของงานนี้ · วางต่อจากเบิกอุปกรณ์เพราะเป็นของประเภทเดียวกัน
          คือ "ขออะไรเพิ่มสำหรับงานใบนี้" ไม่ใช่ข้อมูลของตัวใบจองเอง */}
      <MixRequests bookingId={id} bookingCode={booking?.bookingCode ?? null} />

      {/* Calendar packet */}
      <div className="gf-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-medium text-gray-700">Calendar Packet</h2>
          </div>
          <button onClick={handleCopy}
            className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 flex items-center gap-1">
            {copied ? <><Check className="w-3.5 h-3.5 text-green-500" /> Copied!</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
          </button>
        </div>
        <CalendarPacketDetails booking={{
          outletName: booking.outlet.name,
          outletCode: booking.outlet.code,
          programName: booking.program.name,
          programCode: booking.program.code,
          shootDate: booking.shootDate,
          shootEndDate: booking.shootEndDate,
          callTime: booking.callTime,
          estimatedWrap: booking.estimatedWrap,
          shootType: booking.shootType,
          locationName: booking.locationName,
          producer: booking.producer,
          creative: booking.creative,
          crewRequired: booking.crewRequired,
          vanCount: booking.vanCount,
          agencyRef: booking.agencyRef,
          notes: booking.notes,
          episodes: booking.episodes,
        }} />
      </div>

      {/* Uploads */}
      <div className="gf-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-medium text-gray-700">Footage Uploads ({booking.uploads.length})</h2>
          </div>
          {canUpload && (
            <Link href={`/upload?bookingId=${booking.id}`}
              className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">
              Upload Footage
            </Link>
          )}
        </div>
        {booking.uploads.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-4">No uploads yet.</p>
        ) : (
          <div className="space-y-1.5">
            {booking.uploads.map(up => (
              <div key={up.id} className="flex items-center gap-3 p-2.5 bg-gray-50 rounded text-xs">
                <span className="font-mono text-gray-500 w-12">{up.camera}</span>
                <span className="text-gray-800 flex-1 truncate">{up.fileName}</span>
                {up.episode && <span className="episode-badge">{up.episode.episodeId}</span>}
                <span className={`px-2 py-0.5 rounded-full ${up.status === 'COMPLETE' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                  {up.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
