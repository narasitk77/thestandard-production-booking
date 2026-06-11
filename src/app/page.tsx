'use client'

import { bookingShowName } from '@/lib/display'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { format, isToday, isThisWeek, isAfter, parseISO, startOfToday } from 'date-fns'
import { Plus, Calendar as CalendarIcon, Inbox, ArrowRight, Loader2, AlertCircle, ChevronDown } from 'lucide-react'
import StatusPill from './_components/StatusPill'

interface Episode { episodeId: string; title: string; program?: { code?: string; name: string } | null }
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
  projectName?: string | null
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
  const [myBookings, setMyBookings] = useState<Booking[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    // Pull a generous slice — the API caps at 500. Enough to populate
    // "today / this week / attention" without paging.
    fetch('/api/bookings?limit=200')
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(d => setAllBookings(d.bookings || []))
      .catch(e => setError(String(e)))
    // v1.50 — console tiers now get the full corpus from the default scope,
    // so "My upcoming" asks for scope=mine explicitly (created-by or assigned)
    // instead of relying on the implicit plain-USER filter.
    fetch('/api/bookings?limit=200&scope=mine')
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(d => setMyBookings(d.bookings || []))
      .catch(() => setMyBookings([]))
  }, [])

  const loading = allBookings === null || myBookings === null

  // Buckets — purely client-side splits of the two fetches.
  const { today, thisWeek, mine, attention } = useMemo(() => {
    const today0 = startOfToday()
    const isUpcoming = (b: Booking) => {
      const d = parseISO(b.shootDate)
      return !isNaN(d.getTime()) && (isToday(d) || isAfter(d, today0))
    }
    const bs = allBookings || []
    const upcoming = bs.filter(isUpcoming)
    return {
      today: upcoming.filter(b => isToday(parseISO(b.shootDate))),
      thisWeek: upcoming.filter(b => {
        const d = parseISO(b.shootDate)
        return !isToday(d) && isThisWeek(d, { weekStartsOn: 1 })
      }),
      // "My upcoming" — the user's own non-cancelled upcoming items, capped
      // at 6, from the scope=mine fetch.
      mine: (myBookings || []).filter(isUpcoming).filter(b => b.status !== 'CANCELLED').slice(0, 6),
      // "Attention" — REQUESTED bookings (waiting for coordinator action).
      // For an operator-style view this is the single most useful filter.
      attention: bs.filter(b => b.status === 'REQUESTED').slice(0, 6),
    }
  }, [allBookings, myBookings])

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

      {/* กติกาการจองคิว — สื่อสารกับทุกฝ่ายก่อนกดจอง (v1.52) */}
      <BookingRulesNotice />

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

/**
 * v1.52 — กติกาการจองคิวจากทีมโปรดักชัน (พี่ตุ้ย / Production Coordinator).
 * Pinned to the home page for every user. Collapsible — the state sticks in
 * localStorage so daily users keep a dense dashboard while new users see the
 * full guide on first visit.
 */
const RULES_COLLAPSED_KEY = 'probook.rules.collapsed.v1'

function BookingRulesNotice() {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    try {
      if (localStorage.getItem(RULES_COLLAPSED_KEY) === '1') setOpen(false)
    } catch {}
  }, [])
  const toggle = () => {
    setOpen(o => {
      try { localStorage.setItem(RULES_COLLAPSED_KEY, o ? '1' : '0') } catch {}
      return !o
    })
  }

  return (
    <div className="ops-card mb-4 overflow-hidden border-amber-200 bg-amber-50/50">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between gap-2 px-3 sm:px-4 py-2.5 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-semibold text-gray-800">
          🚨 คู่มือการใช้งาน Production Booking โปรดอ่านก่อนจองคิว!
        </span>
        <ChevronDown className={`w-4 h-4 text-gray-500 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-3 sm:px-4 pb-4 text-sm text-gray-700 space-y-3 border-t border-amber-200/60 pt-3">
          <p>
            เว็บไซต์นี้ถูกจัดทำขึ้นเพื่อให้ทุกคนที่เกี่ยวข้องกับการทำงานวิดีโอ
            สามารถประเมินการใช้ทรัพยากรได้สะดวกและแม่นยำขึ้น
            รวมถึงทีมโปรดักชันเองก็สามารถจัดสรรทรัพยากรได้มีประสิทธิภาพยิ่งขึ้น
            โดยมีรายละเอียดที่อยากให้ทุกคนรับทราบก่อนกดจองคิวถ่ายทำกันสักนิด ดังนี้ครับ
          </p>

          <div>
            <div className="font-semibold text-gray-800 mb-1">✨ ทรัพยากรหลักที่เรามีให้บริการ</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5 text-[13px]">
              <div>📷 Camera: Sony FX6 จำนวน 3 ตัว · Sony FX3 จำนวน 3 ตัว</div>
              <div>🎥 Videographer: 8 คน</div>
              <div>🎙 Sound Engineer: 4 คน</div>
              <div>🎛 Switcher: 1 คน</div>
              <div>📸 Photographer: 1 คน</div>
            </div>
          </div>

          <div>
            <div className="font-semibold text-gray-800 mb-1">⚡️ ก่อนจองคิวต้องรู้</div>
            <ul className="space-y-2 list-none">
              <li>
                <span className="font-medium text-gray-800">First Come, First Served:</span>{' '}
                การจัดสรรทรัพยากรอุปกรณ์และทีมงานจะเป็นไปตามลำดับการแจ้งขอคิว ดังนั้น
                ก่อนจองคิวทุกครั้งอยากให้ลองเช็กในตารางด้านบนสักนิด
                ว่าในช่วงเวลาเดียวกันนั้นมีคิวถ่ายทำอื่นๆ จองไว้แล้วมากน้อยแค่ไหน
                ถ้าเกินทรัพยากรที่เรามีให้บริการ
                แปลว่าจะมีค่าใช้จ่ายเพิ่มเติมเพื่อจ้างฟรีแลนซ์และเช่าอุปกรณ์นะครับ
              </li>
              <li>
                <span className="font-medium text-gray-800">เราดีล คุณจ่าย:</span>{' '}
                ในกรณีจำเป็นต้องจ้างฟรีแลนซ์และเช่าอุปกรณ์จริงๆ เรายินดีช่วยจัดหาให้ได้ครับ
                แต่ค่าใช้จ่ายส่วนนี้จะถูกคิดเป็นต้นทุนการผลิตวิดีโอของคุณนะ
              </li>
              <li>
                <span className="font-medium text-gray-800">กองทัพต้องเดินด้วยท้อง:</span>{' '}
                งานเช้างานค่ำเราไม่เกี่ยง แต่เพื่อการทำงานอย่างมีพลัง
                ทีมงานจำเป็นต้องขอช่วงเบรกอย่างเหมาะสมครับ
                จึงอยากขอความร่วมมือทุกคนหลีกเลี่ยงการจองคิวทับช่วงพักกลางวัน
                โดยคิวถ่ายทำในช่วงบ่าย ขอให้เริ่มเซ็ตอัพตอน 13.00 น. เป็นต้นไป
              </li>
            </ul>
          </div>

          <p className="text-[13px] text-gray-600">
            ขอบคุณสำหรับทุกความร่วมมือครับ — หากมีข้อสงสัยใดๆ
            สามารถติดต่อสอบถามได้ที่ พี่ตุ้ย Production Coordinator ได้เลยครับ :)
          </p>
        </div>
      )}
    </div>
  )
}

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
                {bookingShowName(b)}
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
