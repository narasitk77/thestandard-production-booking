'use client'

import { bookingShowName } from '@/lib/display'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { formatDateRange, shootTypeLabel } from '@/lib/utils'
import { ArrowLeft, Mail, CheckCircle2, Loader2, UserPlus, X, Pencil, RotateCcw, Lock, Save, AlertTriangle } from 'lucide-react'
import { LOCATIONS, LOCATION_GROUPS } from '@/lib/locations'
import { INITIAL_TEAM_ROSTER, ROLE_LABEL, ROLE_ORDER, groupByRole, type RosterRole } from '@/lib/team-roster'
import { normalizeFreelancers, splitLegacyFreelancers } from '@/lib/freelancers'
import { CameraMicTag } from '../_components/CameraMicTag'
// v1.35.11 — UploadSection import removed; upload now lives at /upload?bookingId=X

interface Episode { id: string; episodeId: string; title: string; program?: { code?: string; name: string } | null }
interface BookingDetail {
  id: string; bookingCode?: string | null; shootDate: string; shootEndDate?: string | null; callTime: string; estimatedWrap?: string
  status: string; shootType: string; locationName?: string
  producer: string; creative: string[]; crewRequired: string[]; videographerCount?: number
  cameraCount?: number | null; micCount?: number | null; isBlockShot?: boolean; needsVan?: boolean; specialEquipment?: string[]
  equipmentNote?: string | null; rentalGearNote?: string | null; itinerary?: string | null; assignedEquipmentIds?: string[]
  assignedEmails: string[]; mainVideographerEmail?: string | null; agencyRef?: string; projectId?: string; projectName?: string; notes?: string; adminNotes?: string
  freelancers?: unknown
  outlet: { code: string; name: string; storagePolicy?: 'DRIVE_ONLY' | 'DUAL_WRITE' }
  program: { code: string; name: string }
  episodes: Episode[]
  deletedAt?: string | null // v1.51 — soft-deleted (visible to ADMIN only)
  calendarEventId?: string
  // v1.32.2 — calendar sync visibility fields (see Booking model in schema.prisma).
  calendarSyncStatus?: 'PENDING' | 'OK' | 'FAILED' | null
  calendarSyncError?: string | null
  calendarLastSyncedAt?: string | null
}

interface Freelancer { id: string; name: string; contract: string; email: string }

// Team distribution / group inboxes — quick-select alongside individual crew so
// an admin can notify a whole team at once (e.g. the shared video / sound desk).
const TEAM_GROUP_EMAILS: { name: string; email: string }[] = [
  { name: 'Video Team (กลุ่ม)', email: 'video@thestandard.co' },
  { name: 'Sound Team (กลุ่ม)', email: 'Sound@thestandard.co' },
]

// v1.31 — roster now lives in the DB (table `team_members`, managed at
// /admin/team). We fetch it via /api/admin/team on mount; the hardcoded
// INITIAL_TEAM_ROSTER from src/lib/team-roster.ts is kept ONLY as a
// last-resort fallback if that API call fails (network blip, fresh DB
// with no seed, etc.) so the assign UI is never blank.
type RosterEntry = { name: string; email: string; role: string; active?: boolean }
const FALLBACK_TEAM = groupByRole(INITIAL_TEAM_ROSTER)

function TeamSection({ label, members, checked, onToggle }: {
  label: string
  members: { name: string; email: string }[]
  checked: string[]
  onToggle: (email: string) => void
}) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">{label}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
        {members.map(m => (
          <label key={m.email} className="gf-option">
            <input type="checkbox" checked={checked.includes(m.email)}
              onChange={() => onToggle(m.email)} className="accent-[#673ab7]" />
            <span className="text-sm text-gray-700">{m.name}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

export default function AdminEditPage({ params }: { params: { id: string } }) {
  const { id } = params
  const [booking, setBooking] = useState<BookingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [assignEmails, setAssignEmails] = useState<string[]>([])
  const [mainVideographer, setMainVideographer] = useState('')
  const [customEmail, setCustomEmail] = useState('')
  const [adminNotes, setAdminNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [approving, setApproving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [savedMessage, setSavedMessage] = useState('✓ Saved')
  const [savedTone, setSavedTone] = useState<'success' | 'warning'>('success')
  const [approved, setApproved] = useState(false)
  const [error, setError] = useState('')

  // Freelancers
  const [freelancers, setFreelancers] = useState<Freelancer[]>([])
  const [flName, setFlName] = useState('')
  const [flContract, setFlContract] = useState('')
  const [flEmail, setFlEmail] = useState('')

  // Team roster (v1.31 — fetched from /api/admin/team).
  // We fetch once on mount and group by role for the assign sections.
  // If the API call fails we keep FALLBACK_TEAM (hardcoded seed) so the
  // UI is never blank — an admin can still assign people, just from a
  // potentially-stale list.
  const [team, setTeam] = useState<Record<RosterRole, RosterEntry[]>>(FALLBACK_TEAM)
  // v1.35.11 — meCanUpload / meEmail removed (inline UploadSection moved
  // to /upload?bookingId=X). MarkUploadDoneCard still renders below for
  // admins; its own internal fetch handles auth.

  useEffect(() => {
    fetch('/api/admin/team', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(d => {
        const active = (d.members || []).filter((m: RosterEntry) => m.active !== false)
        setTeam(groupByRole(active))
      })
      .catch(e => {
        console.warn('[admin/[id]] team fetch failed — keeping hardcoded fallback:', e)
      })
  }, [])

  // Edit Booking Details mode
  const [editMode, setEditMode] = useState(false)
  const [editSaving, setEditSaving] = useState(false)
  // v1.61.0 — NON-BLOCKING camera-overload warning for this booking's slot
  const [cameraOverload, setCameraOverload] = useState('')
  const [editForm, setEditForm] = useState({
    callTime: '',
    estimatedWrap: '',
    shootType: '',
    locationName: '',
    producer: '',
    creative: '',
    crewRequired: '',
    cameraCount: '',
    micCount: '',
    needsVan: false,
    specialEquipment: [] as string[],
    equipmentNote: '',
    rentalGearNote: '',
    itinerary: '',
    agencyRef: '',
    notes: '',
    episodeTitles: [] as { id: string; episodeId: string; title: string }[],
  })
  const [restoring, setRestoring] = useState(false)

  const hydrateEditForm = (b: BookingDetail) => {
    setEditForm({
      callTime: b.callTime || '',
      estimatedWrap: b.estimatedWrap || '',
      shootType: b.shootType,
      locationName: b.locationName || '',
      producer: b.producer || '',
      creative: (b.creative || []).join(', '),
      crewRequired: (b.crewRequired || []).join(', '),
      cameraCount: b.cameraCount === null || b.cameraCount === undefined ? '' : String(b.cameraCount),
      micCount: b.micCount === null || b.micCount === undefined ? '' : String(b.micCount),
      needsVan: !!b.needsVan,
      specialEquipment: b.specialEquipment || [],
      equipmentNote: b.equipmentNote || '',
      rentalGearNote: b.rentalGearNote || '',
      itinerary: b.itinerary || '',
      agencyRef: b.agencyRef || '',
      notes: b.notes || '',
      episodeTitles: b.episodes.map(e => ({ id: e.id, episodeId: e.episodeId, title: e.title })),
    })
  }

  // v1.61.0 — NON-BLOCKING camera-overload warning for this booking's slot.
  // Excludes this booking's own row (excludeBookingId) and re-adds its own
  // cameraCount via the endpoint, so the total isn't double-counted.
  useEffect(() => {
    if (!booking || !booking.cameraCount || booking.cameraCount <= 0) { setCameraOverload(''); return }
    if (booking.status === 'CANCELLED' || booking.status === 'COMPLETED') { setCameraOverload(''); return }
    let cancelled = false
    fetch('/api/camera-load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shootDate: booking.shootDate,
        shootEndDate: booking.shootEndDate || null,
        callTime: booking.callTime,
        estimatedWrap: booking.estimatedWrap || null,
        cameraCount: booking.cameraCount,
        excludeBookingId: booking.id,
      }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setCameraOverload(d.exceedsLimit ? `กล้องเต็ม: ช่วงเวลานี้จองรวม ${d.totalCameras}/${d.limit} ตัว — ต้องเช่ากล้องเพิ่ม` : '') })
      .catch(() => {})
    return () => { cancelled = true }
  }, [booking])

  useEffect(() => {
    fetch(`/api/bookings/${id}`)
      .then(r => r.json())
      .then(d => {
        if (!d?.booking) {
          setError(d?.error || 'Booking not found')
          return
        }
        setBooking(d.booking)
        setMainVideographer(d.booking.mainVideographerEmail || '')
        // v1.41.0 — freelancers are now a structured list, not appended text.
        // Prefer the structured field; for older bookings, parse the legacy
        // "Freelancers:" block out of adminNotes and strip it from the textarea
        // so it can't be double-counted on the next save.
        const structured = normalizeFreelancers(d.booking.freelancers)
        if (structured.length > 0) {
          setFreelancers(structured.map(f => ({ id: crypto.randomUUID(), name: f.name, contract: f.contract || '', email: f.email || '' })))
          setAdminNotes(d.booking.adminNotes || '')
        } else {
          const split = splitLegacyFreelancers(d.booking.adminNotes)
          setFreelancers(split.freelancers.map(f => ({ id: crypto.randomUUID(), name: f.name, contract: f.contract || '', email: f.email || '' })))
          setAdminNotes(split.notes)
        }
        // Keep freelancer emails out of the staff "assigned" list so each crew
        // member shows in exactly one place (the assign route re-merges them).
        const flEmails = new Set(
          (structured.length > 0 ? structured : splitLegacyFreelancers(d.booking.adminNotes).freelancers)
            .map(f => f.email).filter(Boolean),
        )
        setAssignEmails((d.booking.assignedEmails || []).filter((e: string) => !flEmails.has(e)))
        hydrateEditForm(d.booking)
      })
      .catch(e => setError(e?.message || 'Failed to load booking'))
      .finally(() => setLoading(false))
  }, [id])

  const toggleEmail = (email: string) =>
    setAssignEmails(prev => prev.includes(email) ? prev.filter(e => e !== email) : [...prev, email])

  const addCustomEmail = () => {
    if (customEmail && !assignEmails.includes(customEmail)) {
      setAssignEmails(prev => [...prev, customEmail])
      setCustomEmail('')
    }
  }

  const addFreelancer = () => {
    if (!flName.trim()) return
    setFreelancers(prev => [...prev, {
      id: crypto.randomUUID(),
      name: flName.trim(),
      contract: flContract.trim(),
      email: flEmail.trim(),
    }])
    setFlName(''); setFlContract(''); setFlEmail('')
  }

  const removeFreelancer = (id: string) =>
    setFreelancers(prev => prev.filter(f => f.id !== id))

  const showSaved = (message = '✓ Saved', tone: 'success' | 'warning' = 'success') => {
    setSavedMessage(message)
    setSavedTone(tone)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  const handleAssign = async () => {
    setError('')
    setSaving(true)
    try {
      // v1.41.0 — send STAFF emails + structured freelancers separately. The
      // assign route merges freelancer emails into the guest list server-side
      // and rebuilds the calendar description from the structured list — so
      // re-saving never duplicates names (the old append-into-adminNotes bug).
      const freelancerPayload = freelancers
        .map(f => ({ name: f.name.trim(), contract: f.contract.trim(), email: f.email.trim() }))
        .filter(f => f.name)
      const allEmails = [
        ...assignEmails,
        ...freelancerPayload.map(f => f.email).filter(Boolean),
      ]

      // Only keep the picked main videographer if they're still in the assigned list
      const mainVdo = mainVideographer && allEmails.includes(mainVideographer) ? mainVideographer : null
      const res = await fetch(`/api/admin/${id}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignedEmails: assignEmails,
          adminNotes,
          freelancers: freelancerPayload,
          mainVideographerEmail: mainVdo,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setBooking(prev => prev ? {
        ...prev,
        status: data.booking.status,
        assignedEmails: data.booking.assignedEmails,
        mainVideographerEmail: data.booking.mainVideographerEmail,
        adminNotes: data.booking.adminNotes,
        freelancers: data.booking.freelancers,
      } : data.booking)
      // Re-derive the staff list (response assignedEmails includes freelancer
      // emails — keep them out of the staff checkboxes, they live in the cards).
      const savedFlEmails = new Set(freelancerPayload.map(f => f.email).filter(Boolean))
      setAssignEmails((data.booking.assignedEmails || []).filter((e: string) => !savedFlEmails.has(e)))
      setMainVideographer(data.booking.mainVideographerEmail || '')
      setAdminNotes(data.booking.adminNotes || '')

      const email = data.email || { sent: 0, requested: allEmails.length, failed: [] }
      const failedList: { email: string; error?: string; hint?: string }[] = email.failed || []
      // v1.28.2 — calendar guest sync status reported synchronously by the
      // assign route. Surface it in the toast so admins know whether crew
      // actually got Google Calendar invites (the persistent "no guests"
      // regression was caused by silent fire-and-forget failures).
      type CalSync = { ok: boolean; eventId: string | null; action: 'patched' | 'created' | 'deferred'; note?: string; error?: string }
      const cal: CalSync | undefined = data.calendar
      const guestCount = allEmails.length
      const calendarFragment = !cal
        ? ''
        : cal.ok && cal.action === 'patched' && guestCount > 0
          ? ` · calendar guests updated (${guestCount})`
          : cal.ok && cal.action === 'created' && guestCount > 0
            ? ` · calendar event auto-created with ${guestCount} guest${guestCount === 1 ? '' : 's'}`
            : cal.ok && cal.action === 'deferred'
              ? '' // booking not approved yet — silent, normal flow
              : ` · ⚠ calendar guests NOT added (${cal.error || 'unknown error'})`

      if (data.warning) {
        showSaved(data.warning + calendarFragment, 'warning')
      } else if (email.requested === 0) {
        showSaved('✓ Saved (no email recipients)' + calendarFragment, cal && !cal.ok ? 'warning' : 'success')
      } else if (failedList.length === 0) {
        const baseMsg = `✓ Saved & sent ${email.sent} email${email.sent === 1 ? '' : 's'}`
        showSaved(baseMsg + calendarFragment, cal && !cal.ok ? 'warning' : 'success')
      } else {
        const firstHint = failedList.find(f => f.hint)?.hint
        const failedNames = failedList.map(f => f.email).join(', ')
        const baseMsg = email.sent > 0
          ? `⚠ Saved · sent ${email.sent}/${email.requested} · failed: ${failedNames}`
          : `⚠ Saved but ALL emails failed (${failedNames})`
        showSaved((firstHint ? `${baseMsg} — ${firstHint}` : baseMsg) + calendarFragment, 'warning')
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleApprove = async () => {
    if (!confirm('Approve? A Google Calendar event will be created and the booking will be confirmed.')) return
    setError('')
    setApproving(true)
    try {
      const res = await fetch(`/api/admin/${id}/approve`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      // v1.54.1 — the route returns { booking } (status, calendarSyncStatus
      // PENDING, calendarLastSyncedAt); merge it so the sync-pending chip
      // shows immediately instead of after a manual reload.
      setBooking(prev => data.booking ? (prev ? { ...prev, ...data.booking } : data.booking) : prev)
      setApproved(true)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setApproving(false)
    }
  }

  const handleSaveDetails = async () => {
    setError('')
    setEditSaving(true)
    try {
      const body: any = {
        callTime: editForm.callTime,
        estimatedWrap: editForm.estimatedWrap || null,
        shootType: editForm.shootType,
        locationName: editForm.locationName || null,
        producer: editForm.producer,
        creative: editForm.creative ? editForm.creative.split(',').map(s => s.trim()).filter(Boolean) : [],
        crewRequired: editForm.crewRequired ? editForm.crewRequired.split(',').map(s => s.trim()).filter(Boolean) : [],
        cameraCount: editForm.cameraCount.trim() === '' ? null : Math.max(0, parseInt(editForm.cameraCount, 10) || 0),
        micCount: editForm.micCount.trim() === '' ? null : Math.max(0, parseInt(editForm.micCount, 10) || 0),
        needsVan: editForm.needsVan,
        specialEquipment: editForm.specialEquipment,
        equipmentNote: editForm.equipmentNote || null,
        rentalGearNote: editForm.rentalGearNote || null,
        itinerary: editForm.itinerary || null,
        agencyRef: editForm.agencyRef || null,
        notes: editForm.notes || null,
        episodeTitles: editForm.episodeTitles.map(e => ({ id: e.id, title: e.title })),
      }
      const res = await fetch(`/api/bookings/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setBooking(data.booking)
      hydrateEditForm(data.booking)
      setEditMode(false)
      showSaved()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setEditSaving(false)
    }
  }

  const handleRestore = async () => {
    if (!confirm('นำ booking กลับมา (สถานะจะเป็น [REQUESTED] รอ Approve อีกครั้ง)?')) return
    setError('')
    setRestoring(true)
    try {
      const res = await fetch(`/api/admin/${id}/restore`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setBooking(data.booking)
      hydrateEditForm(data.booking)
      setApproved(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setRestoring(false)
    }
  }

  if (loading) return <div className="flex items-center justify-center min-h-96"><Loader2 className="w-8 h-8 animate-spin text-gray-400" /></div>
  if (!booking) return <div className="max-w-2xl mx-auto px-4 py-20 text-center text-gray-500">Booking not found.</div>

  const isConfirmed = booking.status === 'CONFIRMED' || approved
  const isCancelled = booking.status === 'CANCELLED'
  const totalAssigned = assignEmails.length + freelancers.length

  // v1.68 — flag incomplete bookings right on the detail card. Camera/mic only
  // count as "missing" when it's NOT a Block Shot (those defer gear on purpose).
  const missingDetails = isCancelled ? [] : ([
    !booking.isBlockShot && (booking.cameraCount === null || booking.cameraCount === undefined) ? 'จำนวนกล้อง' : '',
    !booking.isBlockShot && (booking.micCount === null || booking.micCount === undefined) ? 'จำนวนไมค์' : '',
    !booking.estimatedWrap ? 'เวลาเลิก (Wrap)' : '',
    !booking.locationName ? 'สถานที่' : '',
    (!booking.crewRequired || booking.crewRequired.length === 0) ? 'ทีมงาน (Crew)' : '',
  ].filter(Boolean) as string[])

  return (
    <div className="max-w-[680px] mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3">

      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-2">
        <ArrowLeft className="w-4 h-4" /> Admin Console
      </Link>

      {/* v1.51 — soft-deleted: only ADMIN can open this page; actions 409 server-side */}
      {booking.deletedAt && (
        <div className="bg-gray-800 text-white rounded-lg px-4 py-3 text-sm flex items-center gap-2 flex-wrap">
          <span className="font-medium">🗑 Booking นี้ถูกลบแล้ว</span>
          <span className="text-gray-300">— ซ่อนจากทุกหน้าเว็บ ปุ่มแก้ไข/approve ใช้ไม่ได้จนกว่าจะกู้คืน
            (แท็บ 🗑 Deleted ใน Admin Console)</span>
        </div>
      )}

      {/* Header */}
      <div className="gf-header p-6">
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            isConfirmed ? 'bg-green-100 text-green-700' :
            booking.status === 'ASSIGNED' ? 'bg-yellow-100 text-yellow-700' :
            booking.status === 'COMPLETED' ? 'bg-blue-100 text-blue-700' :
            booking.status === 'CANCELLED' ? 'bg-gray-100 text-gray-600' :
            'bg-red-100 text-red-700'
          }`}>
            {isConfirmed ? '✓ CONFIRMED' :
             booking.status === 'ASSIGNED' ? 'ASSIGNED' :
             booking.status === 'COMPLETED' ? '✓ COMPLETED' :
             booking.status === 'CANCELLED' ? 'CANCELLED' :
             '[REQUESTED]'}
          </span>
          {cameraOverload && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-red-100 text-red-700 border border-red-300 font-medium">
              <AlertTriangle className="w-3 h-3" /> {cameraOverload}
            </span>
          )}
        </div>
        <h1 className="text-2xl font-normal text-gray-800">
          {booking.outlet.name} · {bookingShowName(booking)}
        </h1>
        {booking.bookingCode && (
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-xs text-gray-400 uppercase tracking-wide">Production ID</span>
            <span className="episode-badge">{booking.bookingCode}</span>
          </div>
        )}
        <p className="text-sm text-gray-500 mt-1">
          {formatDateRange(booking.shootDate, booking.shootEndDate)} · {booking.callTime}
          {booking.estimatedWrap && ` → ${booking.estimatedWrap}`}
          {' · '}{shootTypeLabel(booking.shootType)}
          {booking.locationName && ` @ ${booking.locationName}`}
        </p>
        <div className="mt-2">
          <CameraMicTag cameraCount={booking.cameraCount} micCount={booking.micCount} isBlockShot={booking.isBlockShot} size="md" />
        </div>
      </div>

      {/* v1.68 — incomplete-details warning, surfaced right on the card */}
      {missingDetails.length > 0 && (
        <div className="gf-card p-3 text-sm border-l-4 border-amber-400 bg-amber-50 text-amber-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-medium">รายละเอียดไม่ครบ — ยังไม่ได้ระบุ: {missingDetails.join(', ')}</div>
            <div className="text-xs text-amber-700 mt-0.5">กด EDIT เพื่อเติมให้ครบ{booking.isBlockShot ? ' · งานนี้เป็น Block Shot จึงไม่นับจำนวนกล้อง/ไมค์' : ''}</div>
          </div>
        </div>
      )}

      {booking.isBlockShot && (
        <div className="gf-card p-2.5 text-xs border-l-4 border-[#673ab7] bg-[#f3f0fb] text-[#5e35b1] inline-flex items-center gap-1.5">
          📦 Block Shot — ไม่ระบุจำนวนกล้อง/ไมค์โดยตั้งใจ
        </div>
      )}

      {error && <div className="gf-card p-4 text-sm text-red-600 border-l-4 border-red-400">{error}</div>}
      {saved && (
        <div className={`gf-card p-4 text-sm border-l-4 ${
          savedTone === 'warning'
            ? 'text-yellow-700 border-yellow-400 bg-yellow-50'
            : 'text-green-600 border-green-400'
        }`}>
          {savedMessage}
        </div>
      )}
      {approved && <div className="gf-card p-4 text-sm text-green-600 border-l-4 border-green-400">✓ Approved — Google Calendar event created</div>}

      {/* CANCELLED → Restore banner */}
      {isCancelled && (
        <div className="gf-card p-4 border-l-4 border-yellow-400 bg-yellow-50 flex items-start gap-3 flex-wrap">
          <AlertTriangle className="w-5 h-5 text-yellow-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-yellow-900">Booking ถูกยกเลิก</div>
            <div className="text-xs text-yellow-700">นำกลับมาเป็น [REQUESTED] เพื่อให้ Approve ใหม่ได้ — Calendar event เก่าโดนลบไปแล้ว ต้อง Approve เพื่อสร้างใหม่</div>
          </div>
          <button onClick={handleRestore} disabled={restoring}
            className="px-3 py-1.5 text-xs bg-yellow-500 text-white rounded hover:bg-yellow-600 inline-flex items-center gap-1 disabled:opacity-50">
            {restoring ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Restore
          </button>
        </div>
      )}

      {/* Episode IDs (always visible — IDs locked, titles editable in edit mode) */}
      <div className="gf-card p-5">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-gray-500 font-medium uppercase tracking-wide flex items-center gap-1">
            Episode IDs
            <Lock className="w-3 h-3 text-gray-400" />
          </div>
          <span className="text-[10px] text-gray-400">ID ห้ามแก้ · แก้ชื่อตอนได้ในโหมด Edit</span>
        </div>
        {(editMode ? editForm.episodeTitles : booking.episodes).map((ep, i) => (
          <div key={ep.id} className="flex items-center gap-3 py-1.5">
            <span className="episode-badge">{ep.episodeId}</span>
            {editMode ? (
              <input className="gf-input flex-1" value={editForm.episodeTitles[i].title}
                onChange={e => {
                  const next = [...editForm.episodeTitles]
                  next[i] = { ...next[i], title: e.target.value }
                  setEditForm({ ...editForm, episodeTitles: next })
                }} />
            ) : (
              <span className="text-sm text-gray-700">{(ep as Episode).title}</span>
            )}
          </div>
        ))}
      </div>

      {/* Booking details — view or edit mode */}
      <div className="gf-card p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-gray-700">Booking Details</div>
          {!editMode ? (
            <button onClick={() => setEditMode(true)}
              className="text-xs px-3 py-1 border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
              <Pencil className="w-3 h-3" /> Edit
            </button>
          ) : (
            <div className="flex gap-2">
              <button onClick={() => { hydrateEditForm(booking); setEditMode(false) }}
                disabled={editSaving}
                className="text-xs px-3 py-1 border border-gray-300 rounded hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={handleSaveDetails} disabled={editSaving}
                className="text-xs px-3 py-1 border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white inline-flex items-center gap-1 disabled:opacity-50">
                {editSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save
              </button>
            </div>
          )}
        </div>

        {!editMode ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div><div className="text-xs text-gray-400 mb-0.5">Call Time → Wrap</div><div className="text-gray-800">{booking.callTime}{booking.estimatedWrap && ` → ${booking.estimatedWrap}`}</div></div>
            <div><div className="text-xs text-gray-400 mb-0.5">Shoot Type</div><div className="text-gray-800">{shootTypeLabel(booking.shootType)}</div></div>
            <div><div className="text-xs text-gray-400 mb-0.5">Location</div><div className="text-gray-800">{booking.locationName || '—'}</div></div>
            <div><div className="text-xs text-gray-400 mb-0.5">Producer</div><div className="text-gray-800">{booking.producer}</div></div>
            <div><div className="text-xs text-gray-400 mb-0.5">Creative/Host</div><div className="text-gray-800">{booking.creative.join(', ') || '—'}</div></div>
            <div><div className="text-xs text-gray-400 mb-0.5">Crew Requested</div><div className="text-gray-800">{
              booking.crewRequired.length === 0
                ? '—'
                : booking.crewRequired
                    .map(c => c === 'Videographer' && (booking.videographerCount || 1) > 1
                      ? `${c} × ${booking.videographerCount}`
                      : c)
                    .join(', ')
            }</div></div>
            <div className="sm:col-span-2"><div className="text-xs text-gray-400 mb-1">กล้อง / ไมค์ (Camera / Mic)</div><CameraMicTag cameraCount={booking.cameraCount} micCount={booking.micCount} isBlockShot={booking.isBlockShot} size="md" /></div>
            <div><div className="text-xs text-gray-400 mb-0.5">Agency Ref</div><div className="text-gray-800">{booking.agencyRef || '—'}</div></div>
            {booking.specialEquipment && booking.specialEquipment.length > 0 && (
              <div className="sm:col-span-2"><div className="text-xs text-gray-400 mb-0.5">Special Equipment</div><div className="text-gray-800">{booking.specialEquipment.join(', ')}</div></div>
            )}
            {booking.equipmentNote && (
              <div><div className="text-xs text-gray-400 mb-0.5">🎬 Equipment</div><div className="text-gray-800">{booking.equipmentNote}</div></div>
            )}
            {booking.rentalGearNote && (
              <div><div className="text-xs text-gray-400 mb-0.5">📦 Rental Gear</div><div className="text-gray-800">{booking.rentalGearNote}</div></div>
            )}
            {booking.itinerary && (
              <div className="sm:col-span-2"><div className="text-xs text-gray-400 mb-0.5">🗒️ Itinerary</div><div className="text-gray-800 whitespace-pre-line">{booking.itinerary}</div></div>
            )}
            <div className="sm:col-span-2"><div className="text-xs text-gray-400 mb-0.5">Project ID</div><div className="text-gray-800">{booking.projectId ? <><span className="font-mono">{booking.projectId}</span>{booking.projectName ? <span className="text-gray-500"> · {booking.projectName}</span> : null}</> : '—'}</div></div>
            {booking.notes && <div className="sm:col-span-2"><div className="text-xs text-gray-400 mb-0.5">Notes</div><div className="text-gray-800 whitespace-pre-line">{booking.notes}</div></div>}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="bg-gray-50 border border-gray-200 rounded p-2 text-xs text-gray-500 flex items-start gap-2">
              <Lock className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span>ห้ามแก้: Outlet · Program · Shoot Date · Episode ID · ลำดับ EP (เพราะกระทบ Booking number)</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Call Time</label>
                <input type="time" className="gf-input" value={editForm.callTime}
                  onChange={e => setEditForm({ ...editForm, callTime: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Estimated Wrap</label>
                <input type="time" className="gf-input" value={editForm.estimatedWrap}
                  onChange={e => setEditForm({ ...editForm, estimatedWrap: e.target.value })} />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Shoot Type</label>
                <select className="gf-input" value={editForm.shootType}
                  onChange={e => setEditForm({ ...editForm, shootType: e.target.value })}>
                  <option value="STUDIO">Studio</option>
                  <option value="ON_LOCATION">On Location</option>
                  <option value="REMOTE_ONLINE">Remote / Online</option>
                  <option value="EVENT">Event</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Location / Room</label>
                <select className="gf-input" value={editForm.locationName}
                  onChange={e => setEditForm({ ...editForm, locationName: e.target.value })}>
                  <option value="">— Choose —</option>
                  {LOCATION_GROUPS.map(g => (
                    <optgroup key={g.key} label={g.label}>
                      {LOCATIONS.filter(l => l.group === g.key).map(l => (
                        <option key={l.id} value={l.fullName}>{l.name}</option>
                      ))}
                    </optgroup>
                  ))}
                  {/* If existing booking has a non-standard location, preserve it as an option */}
                  {editForm.locationName && !LOCATIONS.some(l => l.fullName === editForm.locationName) && (
                    <option value={editForm.locationName}>{editForm.locationName}</option>
                  )}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs text-gray-500 mb-1 block">Producer</label>
              <input className="gf-input" value={editForm.producer}
                onChange={e => setEditForm({ ...editForm, producer: e.target.value })} />
            </div>

            <div>
              <label className="text-xs text-gray-500 mb-1 block">Creative / Host (คั่นด้วย ,)</label>
              <input className="gf-input" value={editForm.creative}
                onChange={e => setEditForm({ ...editForm, creative: e.target.value })} />
            </div>

            <div>
              <label className="text-xs text-gray-500 mb-1 block">Crew Requested (คั่นด้วย ,)</label>
              <input className="gf-input" value={editForm.crewRequired}
                onChange={e => setEditForm({ ...editForm, crewRequired: e.target.value })} />
            </div>

            {/* v1.41.0 — equipment + van; flow to the calendar event on save */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">🎥 จำนวนกล้อง</label>
                <input type="number" min={0} max={50} inputMode="numeric" className="gf-input tabular-nums"
                  value={editForm.cameraCount}
                  onChange={e => setEditForm({ ...editForm, cameraCount: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">🎙 จำนวนไมค์</label>
                <input type="number" min={0} max={50} inputMode="numeric" className="gf-input tabular-nums"
                  value={editForm.micCount}
                  onChange={e => setEditForm({ ...editForm, micCount: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">การเดินทาง</label>
                <label className="flex items-center gap-2 h-[38px] px-2 cursor-pointer">
                  <input type="checkbox" checked={editForm.needsVan} className="accent-[#673ab7]"
                    onChange={e => setEditForm({ ...editForm, needsVan: e.target.checked })} />
                  <span className="text-sm text-gray-700">🚐 ต้องการรถตู้</span>
                </label>
              </div>
            </div>

            <div>
              <label className="text-xs text-gray-500 mb-1 block">⚙️ Special Equipment</label>
              <div className="grid grid-cols-2 gap-2">
                {['Gimbal/Ronin', 'Prompter', 'Clip-on Mic (DJI Mic)', 'ไฟดวงเล็ก'].map(item => {
                  const checked = editForm.specialEquipment.includes(item)
                  return (
                    <label key={item} className="flex items-center gap-2 px-2 py-1 cursor-pointer">
                      <input type="checkbox" className="accent-[#673ab7]" checked={checked}
                        onChange={() => setEditForm({ ...editForm, specialEquipment: checked ? editForm.specialEquipment.filter(x => x !== item) : [...editForm.specialEquipment, item] })} />
                      <span className="text-sm text-gray-700">{item}</span>
                    </label>
                  )
                })}
              </div>
            </div>

            {/* v1.62.0 — Auto-Planning fields. Filling these replaces the manual
                calendar→planning-sheet copy; they show in /admin/workspace + the
                planning export, and feed the "shoot missing gear" reminder. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">🎬 จัดอุปกรณ์ (Equipment)</label>
                <input className="gf-input" placeholder="เช่น FX3 1, FX30 3"
                  value={editForm.equipmentNote}
                  onChange={e => setEditForm({ ...editForm, equipmentNote: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">📦 ของเช่า (Rental gear)</label>
                <input className="gf-input" placeholder="อุปกรณ์ที่ต้องเช่าสำหรับงานนี้"
                  value={editForm.rentalGearNote}
                  onChange={e => setEditForm({ ...editForm, rentalGearNote: e.target.value })} />
              </div>
            </div>

            <div>
              <label className="text-xs text-gray-500 mb-1 block">🗒️ คิวถ่าย / Itinerary</label>
              <textarea className="gf-input resize-none" rows={4} placeholder="ไทม์ไลน์ทีละช่วง / รายละเอียดกองถ่าย"
                value={editForm.itinerary}
                onChange={e => setEditForm({ ...editForm, itinerary: e.target.value })} />
            </div>

            <div>
              <label className="text-xs text-gray-500 mb-1 block">Agency Ref</label>
              <input className="gf-input" value={editForm.agencyRef}
                onChange={e => setEditForm({ ...editForm, agencyRef: e.target.value })} />
            </div>

            <div>
              <label className="text-xs text-gray-500 mb-1 block">Notes</label>
              <textarea className="gf-input resize-none" rows={3} value={editForm.notes}
                onChange={e => setEditForm({ ...editForm, notes: e.target.value })} />
            </div>
          </div>
        )}
      </div>

      {/* ASSIGN — allow editing crew on REQUESTED, ASSIGNED, and CONFIRMED bookings (not CANCELLED) */}
      {!isCancelled && (
        <div className="gf-card p-5 space-y-5">
          <div className="text-sm font-medium text-gray-700 border-b border-gray-100 pb-2 flex items-center gap-2">
            <Mail className="w-4 h-4 text-[#673ab7]" /> ASSIGN TEAM
            {isConfirmed && <span className="ml-auto text-[10px] bg-green-50 text-green-700 px-2 py-0.5 rounded border border-green-200">re-assign</span>}
            {totalAssigned > 0 && (
              <span className="ml-auto text-xs bg-[#673ab7] text-white px-2 py-0.5 rounded-full">{totalAssigned} assigned</span>
            )}
          </div>

          {/* Team distribution emails (shared inboxes) */}
          <TeamSection label="Team Email (กลุ่ม)" members={TEAM_GROUP_EMAILS} checked={assignEmails} onToggle={toggleEmail} />

          {/* Video Team */}
          <TeamSection label="Producer / Coordinator" members={team.producer} checked={assignEmails} onToggle={toggleEmail} />
          <TeamSection label="Videographer" members={team.video} checked={assignEmails} onToggle={toggleEmail} />
          <TeamSection label="Video Director" members={team.director} checked={assignEmails} onToggle={toggleEmail} />
          <TeamSection label="Sound Team" members={team.sound} checked={assignEmails} onToggle={toggleEmail} />
          <TeamSection label="Photographer" members={team.photo} checked={assignEmails} onToggle={toggleEmail} />
          <TeamSection label="Switcher" members={team.switcher} checked={assignEmails} onToggle={toggleEmail} />
          <TeamSection label="Virtual Production" members={team.virtualProduction} checked={assignEmails} onToggle={toggleEmail} />

          {/* Freelance */}
          <div>
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1">
              <UserPlus className="w-3.5 h-3.5" /> Freelance
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
              <input className="gf-input" placeholder="Name *"
                value={flName} onChange={e => setFlName(e.target.value)} />
              <input className="gf-input" placeholder="Contract No."
                value={flContract} onChange={e => setFlContract(e.target.value)} />
              <input className="gf-input" placeholder="Email (optional)"
                value={flEmail} onChange={e => setFlEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addFreelancer())} />
            </div>
            <button type="button" onClick={addFreelancer} disabled={!flName.trim()}
              className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40">
              + Add Freelancer
            </button>
            {freelancers.length > 0 && (
              <div className="mt-2 space-y-1">
                {freelancers.map(f => (
                  <div key={f.id} className="flex items-center gap-2 text-xs bg-orange-50 border border-orange-200 rounded px-2 py-1">
                    <span className="font-medium text-orange-800">{f.name}</span>
                    {f.contract && <span className="text-orange-600">#{f.contract}</span>}
                    {f.email && <span className="text-orange-500">{f.email}</span>}
                    <button onClick={() => removeFreelancer(f.id)} className="ml-auto text-orange-400 hover:text-red-500">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Custom email */}
          <div>
            <div className="text-xs text-gray-500 mb-1">Add by Email (Other)</div>
            <div className="flex gap-2">
              <input type="email" className="gf-input flex-1" placeholder="email@thestandard.co"
                value={customEmail} onChange={e => setCustomEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addCustomEmail())} />
              <button type="button" onClick={addCustomEmail}
                className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">Add</button>
            </div>
          </div>

          {/* Selected staff emails */}
          {assignEmails.length > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-1">Staff emails — will receive notification:</div>
              <div className="flex flex-wrap gap-1">
                {assignEmails.map(e => (
                  <span key={e} className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded border border-blue-200">
                    {e}
                    <button onClick={() => setAssignEmails(prev => prev.filter(x => x !== e))} className="text-blue-400 hover:text-red-500">×</button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Main Videographer (ช่างภาพหลัก) — pick one of the assigned
              members from the Videographer team. Hidden until at least one
              Videographer is ticked in the section above. */}
          {(() => {
            const assignedVideographers = team.video.filter(v => assignEmails.includes(v.email))
            if (assignedVideographers.length === 0) return null
            return (
              <div>
                <div className="text-xs text-gray-500 mb-1">
                  Main Videographer (ช่างภาพหลัก)
                  {booking?.videographerCount && booking.videographerCount > 1 && (
                    <span className="ml-1 text-gray-400">— ขอ {booking.videographerCount} ช่างภาพ</span>
                  )}
                </div>
                <select className="gf-input" value={mainVideographer}
                  onChange={e => setMainVideographer(e.target.value)}>
                  <option value="">— เลือก main videographer —</option>
                  {assignedVideographers.map(v => (
                    <option key={v.email} value={v.email}>{v.name}</option>
                  ))}
                </select>
              </div>
            )
          })()}

          {/* Admin notes */}
          <div>
            <div className="text-xs text-gray-500 mb-1">Admin Notes (sent in email)</div>
            <textarea className="gf-input resize-none" rows={2} placeholder="Additional instructions for crew..."
              value={adminNotes} onChange={e => setAdminNotes(e.target.value)} />
          </div>

          <button onClick={handleAssign} disabled={saving}
            className="px-4 py-2 text-sm border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white transition-colors disabled:opacity-50">
            {saving ? 'Saving…' : 'Save & Send Email'}
          </button>
        </div>
      )}

      {/* APPROVE */}
      {!isConfirmed && (
        <div className="gf-card p-5">
          <div className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-green-600" /> APPROVE BOOKING
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Approving will create a Google Calendar event and confirm the booking.
            {totalAssigned === 0 && (
              <span className="text-yellow-600"> No crew assigned yet — you can still approve.</span>
            )}
          </p>
          <button onClick={handleApprove} disabled={approving}
            className="gf-submit flex items-center gap-2">
            {approving ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating Calendar Event…</> : '✓ Approve & Add to Calendar'}
          </button>
        </div>
      )}

      {/* Confirmed card — v1.32.2 + v1.32.3:
          shows the DB-tracked calendarSyncStatus, then (if v1.32.3
          dry-run completed) the live guest-list verification + Re-sync. */}
      {isConfirmed && (
        <BookingConfirmedCard
          booking={booking}
          onResynced={() => {
            // After a Re-sync POST, reload booking + verification.
            // v1.35.10 — fixed: API returns { booking: {...} }, not the
            // booking directly. Previous setBooking(d) made booking ==
            // { booking: {...} } which crashed downstream `.outlet.name`
            // reads.
            fetch(`/api/bookings/${id}`).then(r => r.json()).then(d => {
              if (d?.booking) setBooking(d.booking)
            })
          }}
        />
      )}

      {/* v1.35.11 — quick "Upload" shortcut to the dedicated upload page,
          shown only on CONFIRMED / COMPLETED bookings where uploads are
          legal. Matches the booking-card button on /admin so the admin
          flow is consistent. Clicking opens the focused upload surface
          (no booking-detail noise). */}
      {(booking.status === 'CONFIRMED' || booking.status === 'COMPLETED') && (
        <Link
          href={`/upload?bookingId=${booking.id}`}
          className="gf-card p-3 border-l-4 border-[#673ab7] bg-purple-50/30 hover:bg-purple-50 transition-colors flex items-center gap-2 text-sm text-[#673ab7]"
        >
          📹 Open the dedicated upload page →
          <span className="text-[11px] text-gray-500 ml-auto">/upload?bookingId={booking.id}</span>
        </Link>
      )}

      {/* v1.35.11 — Upload section has moved to its own dedicated page at
          /upload?bookingId=<id>. The booking card on /admin links there
          via 📹 Upload. /admin/[id] stays focused on booking metadata +
          assign + Mark-as-Done; the upload UI is its own surface so a
          crew member opening the upload link doesn't see all the admin
          internals (and admins get a less-noisy upload screen too).
          The MarkUploadDoneCard below remains here because it's an
          admin-only review action, not an upload action. */}

      {/* v1.35.5 — Mark-as-Done card. Shows on CONFIRMED bookings only,
          fetches the upload completeness report, enables the button when
          video + sound are both COMPLETE. Out of scope for COMPLETED
          bookings (already Done). */}
      {booking.status === 'CONFIRMED' && (
        <MarkUploadDoneCard bookingId={booking.id} bookingCode={booking.bookingCode || null}
          onDone={() => fetch(`/api/bookings/${id}`).then(r => r.json()).then(d => {
            // v1.35.10 — API returns { booking: {...} }; unwrap before setState
            if (d?.booking) setBooking(d.booking)
          })} />
      )}
    </div>
  )
}

function MarkUploadDoneCard({ bookingId, bookingCode, onDone }: {
  bookingId: string
  bookingCode: string | null
  onDone: () => void
}) {
  const [report, setReport] = useState<{
    videoCount: number; soundCount: number; inFlightCount: number; failedCount: number
    totalBytes: number; hasVideo: boolean; hasSound: boolean; isReady: boolean
  } | null>(null)
  const [acting, setActing] = useState(false)
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch(`/api/upload/list?bookingId=${bookingId}`)
      const data = await res.json()
      if (!res.ok) { setReport(null); return }
      // Mirror the server's assessCompleteness logic (simplified — only counts what we need)
      let videoCount = 0, soundCount = 0, inFlightCount = 0, failedCount = 0, totalBytes = 0
      for (const u of (data.uploads || [])) {
        if (u.status === 'COMPLETE') {
          const isSound = String(u.camera || '').toLowerCase() === 'sound'
          if (isSound) soundCount += 1; else videoCount += 1
          if (u.fileSize) totalBytes += Number(u.fileSize)
        } else if (u.status === 'FAILED' || u.status === 'ORPHANED') failedCount += 1
        else inFlightCount += 1
      }
      setReport({
        videoCount, soundCount, inFlightCount, failedCount, totalBytes,
        hasVideo: videoCount > 0, hasSound: soundCount > 0,
        isReady: videoCount > 0 && soundCount > 0,
      })
    } catch (e: any) {
      setError(e.message)
    }
  }, [bookingId])
  useEffect(() => { load() }, [load])

  const confirmDone = async () => {
    setActing(true); setError('')
    try {
      const res = await fetch(`/api/admin/${bookingId}/mark-upload-done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note || null }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to mark done')
      setConfirming(false)
      setNote('')
      onDone()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setActing(false)
    }
  }

  if (!report) return null

  return (
    <div className="gf-card p-3 border-l-4 border-green-400 bg-green-50/30 space-y-2">
      <div className="text-sm font-medium text-green-800 flex items-center gap-1">
        ✓ Upload Review · Mark as Done
      </div>
      <div className="text-[11px] text-gray-700 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className={`px-2 py-1 rounded border ${report.hasVideo ? 'bg-green-100 border-green-300 text-green-900' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
          📹 Video: {report.videoCount}
        </div>
        <div className={`px-2 py-1 rounded border ${report.hasSound ? 'bg-green-100 border-green-300 text-green-900' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
          🎙️ Sound: {report.soundCount}
        </div>
        <div className="px-2 py-1 rounded border border-gray-200">📦 {fmtBytesLocal(report.totalBytes)}</div>
        <div className="px-2 py-1 rounded border border-gray-200">
          {report.inFlightCount > 0 ? <span className="text-amber-700">⏳ {report.inFlightCount} in-flight</span>
          : report.failedCount > 0 ? <span className="text-red-700">❌ {report.failedCount} failed</span>
          : <span className="text-gray-600">— ok —</span>}
        </div>
      </div>

      {error && <div className="text-xs text-red-600">{error}</div>}

      {!report.isReady ? (
        <div className="text-[11px] text-amber-700">
          ขาด {!report.hasVideo ? 'Video' : ''}{!report.hasVideo && !report.hasSound ? ' + ' : ''}{!report.hasSound ? 'Sound' : ''} —
          ปุ่ม Done จะเปิดเมื่อ crew อัพครบ
        </div>
      ) : !confirming ? (
        <button onClick={() => setConfirming(true)}
          className="text-xs px-3 py-1.5 border border-green-500 text-white bg-green-600 rounded hover:bg-green-700 inline-flex items-center gap-1">
          ✓ Mark as Done — เปลี่ยน CONFIRMED → COMPLETED
        </button>
      ) : (
        <div className="space-y-2">
          <textarea rows={2} maxLength={1000} value={note} onChange={e => setNote(e.target.value)}
            placeholder="หมายเหตุ (optional) — เช่น ครบ 4 cam + sound + B-roll OK"
            className="gf-input resize-none w-full text-xs" />
          <div className="flex gap-2">
            <button onClick={confirmDone} disabled={acting}
              className="text-xs px-4 py-1.5 border border-green-500 text-white bg-green-600 rounded hover:bg-green-700 disabled:opacity-40">
              {acting ? '…' : '✓ ยืนยัน Done'}
            </button>
            <button onClick={() => { setConfirming(false); setNote('') }}
              className="text-xs px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50">
              ยกเลิก
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtBytesLocal(n: number): string {
  if (!n || n <= 0) return '—'
  const units = ['B','KB','MB','GB','TB']
  let v = n, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

/* ───────────────────────────────────────────────────────────────────────── */
/* Confirmed card (v1.32.2 + v1.32.3)                                       */
/* Shows DB-tracked calendarSyncStatus + a live dry-run guest verification.  */
/* The dry-run fetches the actual Google Calendar event attendees and       */
/* diffs them against booking.assignedEmails so admins can see at a glance  */
/* whether the team will actually receive the calendar invite.              */
/* ───────────────────────────────────────────────────────────────────────── */
function BookingConfirmedCard({
  booking,
  onResynced,
}: {
  booking: BookingDetail
  onResynced: () => void
}) {
  type Verification = {
    ok: boolean
    action?: 'ok' | 'patched' | 'created' | 'failed' | 'skipped'
    eventId?: string | null
    htmlLink?: string | null
    assignedEmails?: string[]
    calendarAttendees?: string[]
    error?: string
  }
  const [verif, setVerif] = useState<Verification | null>(null)
  const [verifLoading, setVerifLoading] = useState(false)
  const [verifError, setVerifError] = useState<string>('')
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string>('')

  const fetchVerification = useCallback(async () => {
    setVerifLoading(true)
    setVerifError('')
    try {
      // v1.32.3 — GET aliases POST in dryRun mode (set by the route).
      const res = await fetch(`/api/admin/${booking.id}/calendar-resync?dryRun=1`, { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok && !data.assignedEmails) throw new Error(data.error || `HTTP ${res.status}`)
      setVerif(data)
    } catch (e: any) {
      setVerifError(e?.message || String(e))
    } finally {
      setVerifLoading(false)
    }
  }, [booking.id])

  useEffect(() => { fetchVerification() }, [fetchVerification])

  const handleResync = async () => {
    setSyncing(true)
    setSyncError('')
    try {
      const res = await fetch(`/api/admin/${booking.id}/calendar-resync`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      onResynced()
      await fetchVerification()
    } catch (e: any) {
      setSyncError(e?.message || String(e))
    } finally {
      setSyncing(false)
    }
  }

  // Diff display — what's assigned vs what's actually on the event.
  const assigned = new Set((verif?.assignedEmails || booking.assignedEmails).map(e => e.toLowerCase()))
  const onEvent = new Set((verif?.calendarAttendees || []).map(e => e.toLowerCase()))
  const missing = Array.from(assigned).filter(e => !onEvent.has(e))
  const extra = Array.from(onEvent).filter(e => !assigned.has(e))
  const allInSync = verif && missing.length === 0 && extra.length === 0 && assigned.size > 0

  return (
    <div className="gf-card p-5 border-l-4 border-green-400">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2 text-green-700 font-medium">
          <CheckCircle2 className="w-5 h-5" /> Booking Confirmed
        </div>
        <div className="flex items-center gap-2">
          {/* Sync status badge from v1.32.2 calendarSyncStatus field */}
          {booking.calendarSyncStatus === 'PENDING' && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
              <Loader2 className="w-3 h-3 animate-spin" /> Sync pending…
            </span>
          )}
          {booking.calendarSyncStatus === 'OK' && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">
              <CheckCircle2 className="w-3 h-3" /> Sync OK
            </span>
          )}
          {booking.calendarSyncStatus === 'FAILED' && (
            <span
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200"
              title={booking.calendarSyncError || ''}
            >
              <AlertTriangle className="w-3 h-3" /> Sync FAILED
            </span>
          )}
          {booking.calendarLastSyncedAt && (
            <span
              className="text-[10px] text-gray-400"
              title={new Date(booking.calendarLastSyncedAt).toLocaleString()}
            >
              last checked {compactRelativeTime(booking.calendarLastSyncedAt)}
            </span>
          )}
        </div>
      </div>

      {/* Sync error inline */}
      {booking.calendarSyncStatus === 'FAILED' && booking.calendarSyncError && (
        <div className="mb-3 px-3 py-2 rounded text-xs bg-red-50 border border-red-200 text-red-700">
          {booking.calendarSyncError}
        </div>
      )}

      {/* Calendar event ID + Open link */}
      {booking.calendarEventId && (
        <p className="text-sm text-gray-600 mb-2">
          Calendar event · ID: <code className="text-xs">{booking.calendarEventId}</code>
          {verif?.htmlLink && (
            <> · <a href={verif.htmlLink} target="_blank" rel="noopener noreferrer" className="text-brand-primary hover:underline">Open in Calendar ↗</a></>
          )}
        </p>
      )}

      {/* Guest verification (v1.32.3) */}
      <div className="mt-3 pt-3 border-t border-gray-100">
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Calendar guests</div>
        {verifLoading && (
          <div className="text-sm text-gray-400 flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking attendees on Google Calendar…
          </div>
        )}
        {verifError && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            Verification failed: {verifError}
          </div>
        )}
        {verif && !verifLoading && (
          <div className="space-y-2 text-sm">
            <div className="grid grid-cols-[140px_1fr] gap-2">
              <div className="text-gray-500">Assigned crew</div>
              <div className="text-gray-800 break-words">
                {assigned.size === 0 ? <span className="text-gray-400">none</span> : Array.from(assigned).join(', ')}
                <span className="text-xs text-gray-400 ml-2">({assigned.size})</span>
              </div>
            </div>
            <div className="grid grid-cols-[140px_1fr] gap-2">
              <div className="text-gray-500">Calendar guests</div>
              <div className="text-gray-800 break-words">
                {onEvent.size === 0 ? <span className="text-gray-400">none</span> : Array.from(onEvent).join(', ')}
                <span className="text-xs text-gray-400 ml-2">({onEvent.size})</span>
              </div>
            </div>
            {missing.length > 0 && (
              <div className="px-3 py-2 rounded bg-red-50 border border-red-200 text-sm text-red-700 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">Missing {missing.length} guest{missing.length === 1 ? '' : 's'} on calendar:</div>
                  <div className="text-xs break-words mt-0.5">{missing.join(', ')}</div>
                </div>
              </div>
            )}
            {extra.length > 0 && (
              <div className="px-3 py-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800">
                <strong>{extra.length} extra guest{extra.length === 1 ? '' : 's'} on calendar</strong> (not in assigned list): {extra.join(', ')}
              </div>
            )}
            {allInSync && (
              <div className="px-3 py-2 rounded bg-green-50 border border-green-200 text-sm text-green-700 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                ✓ All {assigned.size} crew {assigned.size === 1 ? 'is' : 'are'} on the calendar
              </div>
            )}
          </div>
        )}

        {/* Re-sync action */}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={handleResync}
            disabled={syncing}
            className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1 disabled:opacity-50"
            title="Force a calendar guest sync now (don't wait for the 10-min worker tick)"
          >
            {syncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
            {syncing ? 'Syncing…' : 'Re-sync calendar guests'}
          </button>
          {syncError && (
            <span className="text-xs text-red-700">⚠ {syncError}</span>
          )}
        </div>
      </div>
    </div>
  )
}

function compactRelativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (isNaN(t)) return ''
  const sec = Math.max(1, Math.floor((Date.now() - t) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}
