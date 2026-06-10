'use client'

import { bookingShowName } from '@/lib/display'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { ExternalLink, RefreshCw, AlertTriangle, Loader2 } from 'lucide-react'
import { formatDisplayDate, statusLabel } from '@/lib/utils'

interface Episode { episodeId: string; title: string; program?: { code?: string; name: string } | null }
interface Booking {
  id: string; shootDate: string; callTime: string; status: string
  producer: string; assignedEmails: string[]
  projectName?: string | null
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
  createdAt: string
  // Populated by /api/bookings (Prisma's default scalar select). Used by the
  // card to show a direct Google Calendar link when an event has been
  // created, or a warning + Re-sync button when CONFIRMED status drifted.
  calendarEventId?: string | null
  // v1.32.2 — async calendar sync visibility. PENDING right after
  // approve, OK once background create finishes, FAILED on Google API
  // error (with calendarSyncError + lastSyncedAt for the UI tooltip).
  calendarSyncStatus?: 'PENDING' | 'OK' | 'FAILED' | null
  calendarSyncError?: string | null
  calendarLastSyncedAt?: string | null
}

const STATUS_BADGE: Record<string, string> = {
  REQUESTED: 'bg-red-100 text-red-700 border border-red-200',
  ASSIGNED:  'bg-yellow-100 text-yellow-700 border border-yellow-200',
  CONFIRMED: 'bg-green-100 text-green-700 border border-green-200',
  CANCELLED: 'bg-gray-100 text-gray-500 border border-gray-200',
  COMPLETED: 'bg-blue-100 text-blue-700 border border-blue-200',
}

const STATUS_ORDER = ['REQUESTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED']

export default function AdminPage() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('REQUESTED')
  // v1.35.2 — only show the "Upload" shortcut on cards to crew that can use it.
  const [canUpload, setCanUpload] = useState(false)
  useEffect(() => {
    fetch('/api/me').then(r => r.ok ? r.json() : null).then(d => {
      if (d?.user?.canUpload) setCanUpload(true)
    }).catch(() => {})
  }, [])

  const fetch_ = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '50', ...(filter && { status: filter }) })
    const res = await fetch(`/api/bookings?${params}`)
    const data = await res.json()
    setBookings(data.bookings || [])
    setTotal(data.total || 0)
    setLoading(false)
  }, [filter])

  useEffect(() => { fetch_() }, [fetch_])

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8">

      {/* Header */}
      <div className="mb-4 sm:mb-6">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <h1 className="text-xl sm:text-2xl font-normal text-gray-800">Admin Console</h1>
          <div className="flex gap-2">
            <Link href="/admin/team" className="px-3 py-1.5 text-xs sm:text-sm border border-gray-300 rounded hover:bg-gray-50">
              Team
            </Link>
            <Link href="/admin/health" className="px-3 py-1.5 text-xs sm:text-sm border border-gray-300 rounded hover:bg-gray-50">
              Health
            </Link>
            <Link href="/admin/permissions" className="px-3 py-1.5 text-xs sm:text-sm border border-gray-300 rounded hover:bg-gray-50">
              Permissions
            </Link>
            <Link href="/new" className="gf-submit text-xs sm:text-sm">+ New</Link>
          </div>
        </div>
        <p className="text-xs sm:text-sm text-gray-500 mt-1">
          Review, assign crew, and approve bookings → Google Calendar
        </p>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 mb-5 border-b border-gray-200">
        {STATUS_ORDER.map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors -mb-px ${
              filter === s
                ? 'border-[#673ab7] text-[#673ab7] font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {s === 'REQUESTED' ? '[REQUESTED]' : statusLabel(s)}
          </button>
        ))}
        <button
          onClick={() => setFilter('')}
          className={`px-4 py-2 text-sm border-b-2 transition-colors -mb-px ${
            filter === ''
              ? 'border-[#673ab7] text-[#673ab7] font-medium'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          All
        </button>
      </div>

      {loading ? (
        <div className="py-16 text-center text-gray-400 text-sm">Loading…</div>
      ) : bookings.length === 0 ? (
        <div className="py-16 text-center text-gray-400 text-sm">
          No {filter || ''} bookings.
        </div>
      ) : (
        <div className="space-y-3">
          {bookings.map(b => (
            <div key={b.id} className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3 flex-col sm:flex-row">
                <div className="flex-1 min-w-0 w-full">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[b.status] || STATUS_BADGE.REQUESTED}`}>
                      {b.status === 'REQUESTED' ? '[REQUESTED]' : statusLabel(b.status)}
                    </span>
                    <span className="text-xs text-gray-400">
                      {formatDisplayDate(b.shootDate)} · {b.callTime}
                    </span>
                  </div>
                  <div className="font-medium text-gray-800 text-sm sm:text-base">
                    {b.outlet.name} · {bookingShowName(b)}
                  </div>
                  <div className="text-xs sm:text-sm text-gray-500 mt-0.5">
                    Producer: {b.producer}
                    {b.assignedEmails.length > 0 && (
                      <div className="mt-0.5 text-blue-600 break-all">
                        → {b.assignedEmails.join(', ')}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {b.episodes.map(ep => (
                      <span key={ep.episodeId} className="episode-badge text-xs">{ep.episodeId}</span>
                    ))}
                  </div>
                  {/* Calendar status — only meaningful once approved.
                      v1.29.2 — surfaces the actual Google Calendar state so
                      "approved but no event" is visible at a glance instead
                      of being hidden behind a button click on /admin/[id]. */}
                  {(b.status === 'CONFIRMED' || b.status === 'COMPLETED') && (
                    <CalendarStatus
                      bookingId={b.id}
                      calendarEventId={b.calendarEventId}
                      syncStatus={b.calendarSyncStatus}
                      syncError={b.calendarSyncError}
                      lastSyncedAt={b.calendarLastSyncedAt}
                      onResynced={fetch_}
                    />
                  )}
                </div>

                <div className="flex gap-2 flex-shrink-0 w-full sm:w-auto justify-end">
                  {b.status === 'REQUESTED' && (
                    <>
                      <Link href={`/admin/${b.id}`}
                        className="px-3 py-1.5 text-xs border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white transition-colors">
                        EDIT
                      </Link>
                      <ApproveButton bookingId={b.id} onDone={fetch_} />
                      <CancelButton bookingId={b.id} onDone={fetch_} />
                    </>
                  )}
                  {b.status === 'CONFIRMED' && (
                    <>
                      {canUpload && (
                        <Link href={`/upload?bookingId=${b.id}`}
                          title="Upload footage — opens the dedicated upload page"
                          className="px-3 py-1.5 text-xs border border-[#673ab7] text-white bg-[#673ab7] rounded hover:bg-[#5e35b1] inline-flex items-center gap-1">
                          📹 Upload
                        </Link>
                      )}
                      <Link href={`/admin/${b.id}`}
                        className="px-3 py-1.5 text-xs border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white transition-colors">
                        EDIT
                      </Link>
                      <CancelButton bookingId={b.id} onDone={fetch_} />
                      <span className="px-3 py-1.5 text-xs bg-green-50 text-green-700 rounded border border-green-200">
                        ✓ Approved
                      </span>
                    </>
                  )}
                  {b.status === 'COMPLETED' && (
                    <>
                      {canUpload && (
                        <Link href={`/upload?bookingId=${b.id}`}
                          title="Upload footage — opens the dedicated upload page"
                          className="px-3 py-1.5 text-xs border border-[#673ab7] text-white bg-[#673ab7] rounded hover:bg-[#5e35b1] inline-flex items-center gap-1">
                          📹 Upload
                        </Link>
                      )}
                      <Link href={`/admin/${b.id}`}
                        className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
                        View
                      </Link>
                      <span className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded border border-blue-200">
                        ✓ Completed
                      </span>
                    </>
                  )}
                  {b.status === 'CANCELLED' && (
                    <RestoreButton bookingId={b.id} onDone={fetch_} />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Calendar status chip + Re-sync button shown on CONFIRMED booking cards.
 *
 * Three visible states:
 *  - `calendarEventId` present  → "📅 Open in Google Calendar" link (the
 *    happy path; admin can click through to confirm guests).
 *  - `calendarEventId` null     → red warning chip "⚠ No calendar event"
 *    with a Re-sync button that triggers an immediate per-booking
 *    reconcile (creates the event, adds guests, persists the new id).
 *  - Re-sync in progress / done → inline result (created / patched / ok /
 *    failed) with the resolved htmlLink if applicable.
 *
 * The Re-sync button stays visible even when the event exists, so an admin
 * who notices "guests missing on the calendar" can force a patch without
 * waiting for the 10-minute worker tick.
 */
function CalendarStatus({
  bookingId,
  calendarEventId,
  syncStatus,
  syncError,
  lastSyncedAt,
  onResynced,
}: {
  bookingId: string
  calendarEventId?: string | null
  syncStatus?: 'PENDING' | 'OK' | 'FAILED' | null
  syncError?: string | null
  lastSyncedAt?: string | null
  onResynced: () => void
}) {
  type ResyncResult = {
    ok: boolean
    action?: 'ok' | 'patched' | 'created' | 'failed' | 'skipped'
    eventId?: string | null
    htmlLink?: string | null
    assignedEmails?: string[]
    calendarAttendees?: string[]
    error?: string
  }
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState<ResyncResult | null>(null)
  // The resolved event id is whatever we know most recently — fresh from
  // a re-sync if available, else the value from the list fetch.
  const effectiveEventId = result?.eventId ?? calendarEventId ?? null

  const handleResync = async () => {
    setSyncing(true)
    setResult(null)
    try {
      const res = await fetch(`/api/admin/${bookingId}/calendar-resync`, { method: 'POST' })
      const data: ResyncResult = await res.json()
      setResult(data)
      // Refresh list when the event id changes so the link updates without
      // a manual reload. (Same trigger used by Approve/Cancel.)
      if (data.ok && data.eventId && data.eventId !== calendarEventId) onResynced()
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) })
    } finally {
      setSyncing(false)
    }
  }

  // Google Calendar event URLs follow the {/event?eid=<base64(eventId + ' ' +
  // calendarId)>} pattern, but the proper public link comes from
  // events.get(htmlLink). We persist the eventId in the DB but not the link,
  // so the link is only known after a fresh re-sync. Fallback: build the
  // base64 eid ourselves — it's just `${eventId} ${calendarId}` b64-encoded.
  // For safety in browsers we only build it when the calendar id is the
  // default one baked into the worker (we don't have access to runtime env).
  // Result: link is "Open" when we have htmlLink, otherwise we surface the
  // raw event id so the admin can paste-search in Calendar.
  const link = result?.htmlLink || null

  // v1.32.2 — primary status chip now comes from the DB-tracked
  // calendarSyncStatus field (PENDING / OK / FAILED) instead of just
  // inferring from calendarEventId. Approve writes PENDING; background
  // task / reconciler / assign write OK or FAILED. The chip shows the
  // sync state; the link chip (separate, below) shows the actual
  // Google Calendar event if there is one.
  const effectiveStatus = syncStatus ?? (effectiveEventId ? 'OK' : null)

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      {/* Sync-state chip */}
      {effectiveStatus === 'PENDING' && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
          <Loader2 className="w-3 h-3 animate-spin" /> Calendar sync pending…
        </span>
      )}
      {effectiveStatus === 'FAILED' && (
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200"
          title={syncError || 'Calendar sync failed — click Re-sync to retry'}
        >
          <AlertTriangle className="w-3 h-3" /> Calendar sync FAILED
        </span>
      )}
      {effectiveStatus === null && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
          <AlertTriangle className="w-3 h-3" /> No calendar event
        </span>
      )}

      {/* Calendar event link chip — only when an event id exists, regardless of sync state */}
      {effectiveEventId && (
        link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100"
            title={`Calendar event: ${effectiveEventId}`}
          >
            📅 Open in Calendar <ExternalLink className="w-3 h-3" />
          </a>
        ) : (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200"
            title={`Calendar event: ${effectiveEventId} — click Re-sync to fetch the public link`}
          >
            📅 Calendar event linked
          </span>
        )
      )}

      {/* Last synced timestamp — small relative-time hint */}
      {lastSyncedAt && (
        <span className="text-[10px] text-gray-400" title={new Date(lastSyncedAt).toLocaleString()}>
          last checked {relativeTime(lastSyncedAt)}
        </span>
      )}

      <button
        onClick={handleResync}
        disabled={syncing}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        title="Force a calendar guest sync now (don't wait for the 10-min worker tick)"
      >
        {syncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        {syncing ? 'Syncing…' : 'Re-sync'}
      </button>

      {result && !syncing && (
        <span
          className={`px-2 py-0.5 rounded-full ${
            result.ok
              ? result.action === 'created' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : result.action === 'patched' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : 'bg-gray-100 text-gray-600 border border-gray-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
          title={result.error || ''}
        >
          {result.ok
            ? result.action === 'created'
              ? `✓ event created with ${(result.assignedEmails || []).length} guest${(result.assignedEmails || []).length === 1 ? '' : 's'}`
              : result.action === 'patched'
                ? `✓ guests updated (${(result.assignedEmails || []).length})`
                : result.action === 'ok'
                  ? '✓ already in sync'
                  : `✓ ${result.action}`
            : `⚠ ${result.error || 'sync failed'}`}
        </span>
      )}
    </div>
  )
}

/**
 * Compact relative-time formatter used by the calendar sync chip.
 * Examples: "12s", "5m", "2h", "3d". Anything older falls back to a
 * short ISO date.
 */
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (isNaN(t)) return ''
  const sec = Math.max(1, Math.floor((Date.now() - t) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toISOString().slice(0, 10)
}

function RestoreButton({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const [loading, setLoading] = useState(false)
  const handle = async () => {
    if (!confirm('Restore booking นี้กลับมาเป็น [REQUESTED]?')) return
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/${bookingId}/restore`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onDone()
    } catch (e: any) {
      alert('Restore failed: ' + e.message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <button onClick={handle} disabled={loading}
      className="px-3 py-1.5 text-xs border border-yellow-400 text-yellow-700 bg-yellow-50 rounded hover:bg-yellow-500 hover:text-white transition-colors disabled:opacity-50">
      {loading ? '…' : '↺ RESTORE'}
    </button>
  )
}

function CancelButton({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const [loading, setLoading] = useState(false)
  const handle = async () => {
    if (!confirm('Cancel this booking? It will be moved to Cancelled and removed from the calendar.')) return
    setLoading(true)
    try {
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'CANCELLED' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onDone()
    } catch (e: any) {
      alert('Cancel failed: ' + e.message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <button onClick={handle} disabled={loading}
      className="px-3 py-1.5 text-xs border border-red-200 text-red-600 rounded hover:bg-red-50 transition-colors disabled:opacity-50">
      {loading ? '…' : 'CANCEL'}
    </button>
  )
}

function ApproveButton({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const handle = async () => {
    if (!confirm('Approve this booking? A Google Calendar event will be created.')) return
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/${bookingId}/approve`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setDone(true)
      setTimeout(onDone, 800)
    } catch (e: any) {
      alert('Approve failed: ' + e.message)
    } finally {
      setLoading(false)
    }
  }

  if (done) return <span className="px-3 py-1.5 text-xs bg-green-50 text-green-700 rounded">✓ Approved</span>
  return (
    <button onClick={handle} disabled={loading}
      className="px-3 py-1.5 text-xs bg-[#673ab7] text-white rounded hover:bg-[#512da8] transition-colors disabled:opacity-50">
      {loading ? '…' : 'APPROVE'}
    </button>
  )
}
