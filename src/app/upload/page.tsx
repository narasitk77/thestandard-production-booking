'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Loader2, Search } from 'lucide-react'
import UploadSection from '@/app/_components/booking/UploadSection'

interface BookingRow {
  id: string
  bookingCode: string | null
  shootDate: string
  callTime: string
  status: string
  cameraCount?: number | null
  micCount?: number | null
  outlet: { code: string; name: string; storagePolicy?: 'DRIVE_ONLY' | 'DUAL_WRITE' }
  program: { code: string; name: string }
  assignedEmails: string[]
  episodes: Array<{ id: string; episodeId: string; title: string; sequence: number }>
}

interface Me {
  email: string
  role: string
  canUpload: boolean
}

const THAI_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']
function fmtDate(d: string): string {
  const dt = new Date(d)
  return `${dt.getDate()} ${THAI_MONTHS[dt.getMonth()]} ${String(dt.getFullYear()).slice(2)}`
}

// v1.85 — upload-progress badge for a booking in the crew's job list.
// Compares cameras with COMPLETE uploads against the booking's cameraCount.
function uploadBadge(b: BookingRow, st?: { epSlots: number; flatCams: number; files: number }) {
  const base = 'text-[10px] px-1.5 py-0.5 rounded border'
  const files = st?.files ?? 0
  // v1.93 — footage is split per episode. Pick the matching bucket so legacy
  // (no-EP) and EP-tagged counts never mix:
  //   booking HAS episodes → "ครบ" = every camera for every EP filled
  //     (delivered = EP-tagged slots; expected = cameraCount × #EP).
  //   booking has NO episodes (block shot / event) → flat cameras vs cameraCount.
  const hasEps = (b.episodes?.length ?? 0) > 0
  const delivered = hasEps ? (st?.epSlots ?? 0) : (st?.flatCams ?? 0)
  const expectedCams = (b.cameraCount ?? 0) * (hasEps ? b.episodes.length : 1)
  if (files === 0) return <span className={`${base} bg-red-50 text-red-700 border-red-200`}>🔴 ยังไม่อัป</span>
  // 0 cameras expected (audio-only / block shot) → any completed file = done.
  if (expectedCams <= 0) return <span className={`${base} bg-green-50 text-green-700 border-green-200`}>🟢 อัปครบ ({files})</span>
  if (delivered >= expectedCams) return <span className={`${base} bg-green-50 text-green-700 border-green-200`}>🟢 อัปครบ ({files})</span>
  return <span className={`${base} bg-yellow-50 text-yellow-700 border-yellow-200`}>🟡 อัปบางกล้อง {delivered}/{expectedCams}</span>
}

/**
 * /upload — v1.35.3 rewrite.
 *
 * Two modes driven by the `?bookingId=X` query param:
 *   - With bookingId  → embeds UploadSection for that booking
 *   - Without         → shows a list of bookings the user can upload to
 *                       (admin sees all CONFIRMED/COMPLETED; crew sees
 *                        only the ones they're assigned to)
 */
function UploadPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  // Back = the actual previous page (not a hardcoded route); fall back to
  // My Bookings only when there's no history (page opened directly).
  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back()
    else router.push('/my-bookings')
  }
  const requestedBookingId = searchParams.get('bookingId') || ''

  const [me, setMe] = useState<Me | null>(null)
  // meLoaded flips to true once /api/me settles (success OR failure).
  // The list-mode fetch waits for this so we know the real role before
  // picking the scope — prevents admins from briefly seeing the crew-only
  // view (scope=mine) on the first render before /api/me resolves.
  const [meLoaded, setMeLoaded] = useState(false)
  const [bookings, setBookings] = useState<BookingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  // v1.85 — per-booking upload status for the "ยังไม่อัป / อัปบางกล้อง / ครบ" badge
  const [uploadStatus, setUploadStatus] = useState<Record<string, { epSlots: number; flatCams: number; files: number }>>({})

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.user) setMe({ email: d.user.email, role: d.user.role, canUpload: !!d.user.canUpload })
      })
      .catch(() => {})
      .finally(() => setMeLoaded(true))
  }, [])

  useEffect(() => {
    if (requestedBookingId) {
      // Single-booking mode — doesn't need me (no scope decision)
      setLoading(true)
      fetch(`/api/bookings/${requestedBookingId}`)
        .then(r => r.json())
        .then(d => {
          if (d.error) {
            setError(d.error)
            setBookings([])
          } else {
            // /api/bookings/[id] returns { booking: {...} } — unwrap it.
            setBookings([d.booking ?? d])
          }
        })
        .catch(e => setError(String(e?.message || e)))
        .finally(() => setLoading(false))
      return
    }
    // List mode — wait for /api/me to settle before choosing the scope.
    // Without this guard, the effect fires with me=null (before /api/me
    // returns) and fetches scope=mine — admins briefly see an empty crew
    // list before the effect re-fires with the correct admin scope.
    if (!meLoaded) return
    setLoading(true)
    const isAdmin = me?.role === 'ADMIN'
    const urls = isAdmin
      ? [
          '/api/bookings?limit=100&status=CONFIRMED',
          '/api/bookings?limit=100&status=COMPLETED',
        ]
      : ['/api/bookings?scope=mine&limit=200']
    Promise.all(urls.map(u => fetch(u).then(r => r.json())))
      .then(results => {
        const seen = new Set<string>()
        const merged: BookingRow[] = []
        for (const d of results) {
          for (const b of (d.bookings || []) as BookingRow[]) {
            if (seen.has(b.id)) continue
            seen.add(b.id)
            if (b.status === 'CONFIRMED' || b.status === 'COMPLETED') merged.push(b)
          }
        }
        // Sort newest shoot date first so the most-relevant rows are on top
        merged.sort((a, b) => (b.shootDate || '').localeCompare(a.shootDate || ''))
        setBookings(merged)
        // v1.85 — upload status for the badges (best-effort; non-blocking)
        if (merged.length) {
          fetch(`/api/upload/status?bookingIds=${merged.map(b => b.id).join(',')}`)
            .then(r => (r.ok ? r.json() : { status: {} }))
            .then(d => setUploadStatus(d.status || {}))
            .catch(() => {})
        }
      })
      .catch(e => setError(String(e?.message || e)))
      .finally(() => setLoading(false))
  }, [requestedBookingId, meLoaded, me?.role])

  const single = requestedBookingId ? bookings[0] : null
  const filtered = bookings.filter(b => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (b.bookingCode || '').toLowerCase().includes(q)
        || (b.outlet?.name || '').toLowerCase().includes(q)
        || (b.program?.name || '').toLowerCase().includes(q)
  })

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3">
      <button onClick={goBack} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="w-4 h-4" /> กลับ
      </button>

      <div className="gf-header p-4 sm:p-6">
        <h1 className="text-xl sm:text-2xl font-normal text-gray-800">Upload Footage</h1>
        <p className="text-xs sm:text-sm text-gray-500">
          อัปโหลด footage ตรงเข้า Drive (+ Wasabi ถ้า outlet เป็น DUAL_WRITE) — ผูกกับ Production ID อัตโนมัติ
        </p>
      </div>

      {error && (
        <div className="gf-card p-3 text-sm text-red-600 border-l-4 border-red-400">{error}</div>
      )}

      {/* SINGLE BOOKING MODE */}
      {requestedBookingId && single && (() => {
        // Upload is only allowed when the booking has been approved
        // (CONFIRMED) or finished (COMPLETED). REQUESTED hasn't been
        // approved yet; ASSIGNED is mid-flight; CANCELLED is dead.
        // We surface this upfront instead of letting the user fill the
        // form and then get a 403 from /api/upload/init.
        const canStatus = single.status === 'CONFIRMED' || single.status === 'COMPLETED'
        return (
          <>
            <div className="gf-card p-3 text-xs text-gray-600 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono font-medium text-gray-900">{single.bookingCode || single.id}</span>
                <span className="bg-gray-100 px-1.5 py-0.5 rounded">{single.outlet.code}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  single.status === 'CONFIRMED' ? 'bg-green-50 text-green-700 border border-green-200'
                  : single.status === 'COMPLETED' ? 'bg-blue-50 text-blue-700 border border-blue-200'
                  : 'bg-amber-50 text-amber-700 border border-amber-200'
                }`}>{single.status}</span>
                <span className="text-gray-500">·</span>
                <span className="text-gray-700">{single.program.name}</span>
                <span className="text-gray-500">·</span>
                <span className="text-gray-700">{fmtDate(single.shootDate)} {single.callTime}</span>
              </div>
            </div>
            {canStatus ? (
              <UploadSection booking={{
                id: single.id,
                bookingCode: single.bookingCode ?? null,
                status: single.status,
                cameraCount: single.cameraCount,
                micCount: single.micCount,
                outlet: single.outlet,
                episodes: single.episodes ?? [],
              }} />
            ) : (
              <div className="gf-card p-6 text-center space-y-2 border-l-4 border-amber-400 bg-amber-50/40">
                <div className="text-sm text-amber-900">
                  Booking นี้สถานะ <strong>{single.status}</strong> — upload ทำได้เฉพาะ
                  {' '}<strong>CONFIRMED</strong> หรือ <strong>COMPLETED</strong> เท่านั้น
                </div>
                <div className="text-xs text-gray-600">
                  {single.status === 'REQUESTED' && 'รอ Admin approve booking ก่อน — แจ้ง Producer'}
                  {single.status === 'ASSIGNED' && 'รอ Admin ยืนยัน assign — แจ้ง Producer'}
                  {single.status === 'CANCELLED' && 'Booking ถูกยกเลิก — ไม่ควร upload'}
                </div>
                <Link href="/upload" className="inline-block text-xs text-[#673ab7] hover:underline">
                  ← เลือก booking อื่น
                </Link>
              </div>
            )}
          </>
        )
      })()}

      {requestedBookingId && !loading && !single && !error && (
        <div className="gf-card p-6 text-center text-sm text-gray-500">
          ไม่พบ booking นี้ หรือคุณไม่มีสิทธิ์ upload ที่นี่
        </div>
      )}

      {/* LIST MODE — show eligible bookings */}
      {!requestedBookingId && (
        <>
          <div className="gf-card p-3 flex items-center gap-2 flex-wrap">
            <Search className="w-4 h-4 text-gray-400 shrink-0" />
            <input
              type="text"
              placeholder="ค้นหา Production ID / Program / Outlet"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm flex-1 min-w-[200px]"
            />
            <span className="text-xs text-gray-500 ml-auto">
              {me?.role === 'ADMIN' ? 'แสดงทุก booking ที่ CONFIRMED/COMPLETED' : 'แสดงเฉพาะที่คุณถูก assign'}
            </span>
          </div>

          {loading ? (
            <div className="gf-card p-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
          ) : filtered.length === 0 ? (
            <div className="gf-card p-8 text-center text-sm text-gray-500">
              {bookings.length === 0
                ? me?.role === 'ADMIN'
                  ? 'ยังไม่มี booking ที่ CONFIRMED/COMPLETED'
                  : 'ยังไม่มี booking ที่ถูก assign — รอ producer assign ก่อน'
                : 'ไม่ตรงกับคำค้น'}
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map(b => (
                <Link key={b.id} href={`/upload?bookingId=${b.id}`}
                  className="gf-card p-3 hover:border-[#673ab7] transition-colors block">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-medium text-gray-900">{b.bookingCode || b.id}</span>
                    <span className="bg-gray-100 px-1.5 py-0.5 text-[11px] rounded">{b.outlet.code}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      b.status === 'CONFIRMED' ? 'bg-green-50 text-green-700 border border-green-200'
                                               : 'bg-blue-50 text-blue-700 border border-blue-200'
                    }`}>{b.status}</span>
                    {b.outlet.storagePolicy === 'DUAL_WRITE' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200" title="ขึ้นทั้ง Drive + Wasabi">
                        DUAL
                      </span>
                    )}
                    {/* v1.85 — upload status badge: which shoots still need footage */}
                    <span className="ml-auto">{uploadBadge(b, uploadStatus[b.id])}</span>
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    {b.program.name} · {fmtDate(b.shootDate)} {b.callTime}
                  </div>
                  {b.episodes?.length > 0 && (
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      {b.episodes.slice(0, 3).map(e => e.episodeId).join(' · ')}{b.episodes.length > 3 ? ` +${b.episodes.length - 3}` : ''}
                    </div>
                  )}
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default function UploadPageWrapper() {
  return (
    <Suspense fallback={<div className="p-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>}>
      <UploadPage />
    </Suspense>
  )
}
