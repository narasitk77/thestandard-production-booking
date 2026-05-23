'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { format, isToday, isThisWeek, isAfter, parseISO, startOfToday } from 'date-fns'
import { Plus, Calendar as CalendarIcon, Inbox, ArrowRight, Loader2, AlertCircle } from 'lucide-react'
import StatusPill from './_components/StatusPill'

interface Episode { episodeId: string; title: string }
interface Booking {
  id: string
  shootDate: string
  shootEndDate?: string | null
  callTime: string
  estimatedWrap?: string
  status: string
  shootType: string
  locationName?: string
  producer: string
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
}

type Bucket = { key: string; label: string; bookings: Booking[] }

/**
 * Home / Overview — first screen after login.
 * Replaces the legacy "open the booking form on /" behavior — the form now
 * lives at /new (reachable from the persistent + New Booking CTA in the nav).
 */
export default function HomeOverview() {
  const [allBookings, setAllBookings] = useState<Booking[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    // Pull a generous slice — the API caps at 500. Enough to populate
    // "today / this week / my upcoming / attention" without paging.
    fetch('/api/bookings?limit=200')
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(d => setAllBookings(d.bookings || []))
      .catch(e => setError(String(e)))
  }, [])

  const loading = allBookings === null

  // Buckets — purely client-side splits of the same fetch.
  const { today, thisWeek, mine, attention } = useMemo(() => {
    const today0 = startOfToday()
    const bs = allBookings || []
    const upcoming = bs.filter(b => {
      const d = parseISO(b.shootDate)
      return !isNaN(d.getTime()) && (isToday(d) || isAfter(d, today0))
    })
    return {
      today: upcoming.filter(b => isToday(parseISO(b.shootDate))),
      thisWeek: upcoming.filter(b => {
        const d = parseISO(b.shootDate)
        return !isToday(d) && isThisWeek(d, { weekStartsOn: 1 })
      }),
      // "Mine" is implicit: the GET filter without scope already returns the
      // user's own bookings + confirmed-everywhere (see /api/bookings).
      // For the overview "My upcoming" panel, just show their non-cancelled
      // upcoming items, capped at 6.
      mine: upcoming.filter(b => b.status !== 'CANCELLED').slice(0, 6),
      // "Attention" — REQUESTED bookings (waiting for coordinator action).
      // For an operator-style view this is the single most useful filter.
      attention: bs.filter(b => b.status === 'REQUESTED').slice(0, 6),
    }
  }, [allBookings])

  const counts = useMemo(() => ({
    today: today.length,
    week: thisWeek.length,
    attention: attention.length,
  }), [today, thisWeek, attention])

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      {/* Title row */}
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h1>Overview</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Today’s production schedule and items needing attention.
          </p>
        </div>
        <Link href="/new" className="ops-btn-primary">
          <Plus className="w-4 h-4" />
          New Booking
        </Link>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <KpiCard label="Today" value={counts.today} icon={<CalendarIcon className="w-4 h-4 text-gray-400" />} href="/calendar" />
        <KpiCard label="This week" value={counts.week} icon={<CalendarIcon className="w-4 h-4 text-gray-400" />} href="/calendar" />
        <KpiCard label="Needs attention" value={counts.attention} accent="warn" icon={<AlertCircle className="w-4 h-4 text-status-requested-500" />} href="/my-bookings" />
      </div>

      {error && (
        <div className="ops-card px-3 py-2 mb-3 text-sm text-red-700 bg-red-50 border-red-200 border-l-4 border-l-red-500">
          Couldn’t load bookings: {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Today's schedule */}
        <Panel
          title="Today’s schedule"
          subtitle={today.length === 0 ? 'No bookings today.' : `${today.length} booking${today.length === 1 ? '' : 's'}`}
          href="/calendar"
          loading={loading}
        >
          {today.length === 0 ? (
            <EmptyRow label="No bookings today." />
          ) : (
            <BookingList items={today} />
          )}
        </Panel>

        {/* My upcoming */}
        <Panel
          title="My upcoming"
          subtitle={mine.length === 0 ? 'Nothing on the horizon.' : `${mine.length} upcoming`}
          href="/my-bookings"
          loading={loading}
        >
          {mine.length === 0 ? (
            <EmptyRow label="No upcoming bookings yet." cta={{ href: '/new', label: 'Create a booking' }} />
          ) : (
            <BookingList items={mine} />
          )}
        </Panel>

        {/* Needs attention */}
        <Panel
          title="Needs attention"
          subtitle={attention.length === 0 ? 'All caught up.' : `${attention.length} requested`}
          href="/my-bookings"
          loading={loading}
        >
          {attention.length === 0 ? (
            <EmptyRow label="No requested bookings — nothing waiting." />
          ) : (
            <BookingList items={attention} />
          )}
        </Panel>
      </div>

      {/* This week row (full width) */}
      {!loading && thisWeek.length > 0 && (
        <div className="mt-3">
          <Panel title="Later this week" subtitle={`${thisWeek.length} booking${thisWeek.length === 1 ? '' : 's'}`} href="/calendar">
            <BookingList items={thisWeek} />
          </Panel>
        </div>
      )}
    </div>
  )
}

/* ---------- Panels & rows ---------- */

function KpiCard({ label, value, accent, icon, href }: {
  label: string
  value: number
  accent?: 'warn'
  icon: React.ReactNode
  href: string
}) {
  return (
    <Link
      href={href}
      className={`ops-card p-3 sm:p-4 flex items-center justify-between hover:border-gray-400 transition-colors ${accent === 'warn' && value > 0 ? 'border-status-requested-500/30' : ''}`}
    >
      <div>
        <div className="text-[11px] uppercase tracking-wider text-gray-500 font-medium">{label}</div>
        <div className={`text-2xl font-semibold mt-1 tabular-nums ${accent === 'warn' && value > 0 ? 'text-status-requested-700' : 'text-gray-900'}`}>
          {value}
        </div>
      </div>
      {icon}
    </Link>
  )
}

function Panel({ title, subtitle, href, loading, children }: {
  title: string
  subtitle?: string
  href?: string
  loading?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="ops-card overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900 truncate">{title}</h2>
          {subtitle && <p className="text-xs text-gray-500 truncate">{subtitle}</p>}
        </div>
        {href && (
          <Link href={href} className="text-xs text-gray-500 hover:text-gray-900 inline-flex items-center gap-0.5 flex-shrink-0">
            View all <ArrowRight className="w-3 h-3" />
          </Link>
        )}
      </div>
      <div>{loading ? <LoadingRow /> : children}</div>
    </div>
  )
}

function LoadingRow() {
  return (
    <div className="ops-empty">
      <Loader2 className="w-4 h-4 animate-spin mx-auto text-gray-400" />
    </div>
  )
}

function EmptyRow({ label, cta }: { label: string; cta?: { href: string; label: string } }) {
  return (
    <div className="ops-empty">
      <Inbox className="w-5 h-5 text-gray-300 mx-auto mb-2" />
      <div>{label}</div>
      {cta && (
        <Link href={cta.href} className="text-xs text-brand-primary hover:underline mt-2 inline-block">
          {cta.label} →
        </Link>
      )}
    </div>
  )
}

function BookingList({ items }: { items: Booking[] }) {
  return (
    <ul className="divide-y divide-gray-100">
      {items.map(b => (
        <li key={b.id}>
          <Link
            href={`/dashboard/${b.id}`}
            className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors"
          >
            <div className="flex-shrink-0 w-14 text-center">
              <div className="text-[10px] text-gray-400 uppercase">{format(parseISO(b.shootDate), 'EEE')}</div>
              <div className="text-base font-semibold text-gray-800 tabular-nums leading-none">{format(parseISO(b.shootDate), 'd')}</div>
              <div className="text-[10px] text-gray-400 tabular-nums mt-0.5">{b.callTime}</div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-gray-900 font-medium truncate">
                <span className="text-gray-500 font-normal mr-1">[{b.outlet.code}]</span>
                {b.program.name}
              </div>
              <div className="text-xs text-gray-500 truncate">
                {b.episodes.slice(0, 2).map(e => e.episodeId).join(' · ')}
                {b.episodes.length > 2 && ` +${b.episodes.length - 2}`}
                {b.producer && <> · {b.producer}</>}
              </div>
            </div>
            <StatusPill status={b.status} />
          </Link>
        </li>
      ))}
    </ul>
  )
}
