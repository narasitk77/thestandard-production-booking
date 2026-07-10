'use client'

// v1.129 — the calendar drawer grew from quick-edit into a FULL edit surface:
// every field the admin edit page exposes, crew ASSIGN (same POST the admin
// page uses — requireConsole-gated server-side), and the status strip from the
// queue cards (camera/mic tag, footage badge, crew-gap warning, who's going).
// Identity fields (outlet/show/shoot date/episode identity) stay admin-page-only.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { format, parseISO } from 'date-fns'
import { ChevronLeft, Loader2, X, MapPin, User, Tag, Pencil, Save, Users } from 'lucide-react'
import StatusPill, { AdBadge } from '@/app/_components/StatusPill'
import CrewLine from '@/app/_components/CrewLine'
import FootageBadge from '@/app/_components/FootageBadge'
import { CameraMicTag } from '@/app/admin/_components/CameraMicTag'
import { bookingDisplayName } from '@/lib/display'
import { SPECIAL_EQUIPMENT_OPTIONS, CREW_OPTIONS } from '@/lib/data'
import { ROLE_LABEL, ROLE_ORDER, groupByRole, type RosterMember } from '@/lib/team-roster'
import { normalizeFreelancers, freelancerEmails, freelancerRoleLabel } from '@/lib/freelancers'
import type { Booking } from './types'
import BookingRentals from '@/app/_components/BookingRentals'

const showName = bookingDisplayName
const SHOOT_TYPE_OPTIONS = ['STUDIO', 'ON_LOCATION', 'REMOTE_ONLINE', 'EVENT'] as const

type Mode = 'view' | 'edit' | 'assign'
type CrewStatus = { missing: string[]; missingTh: string[]; freelancerCount: number }
type ProducerOpt = { email: string; name: string; nickname: string }

type DrawerForm = {
  callTime: string; estimatedWrap: string; locationName: string; shootType: string
  producer: string; producerEmail: string
  creative: string; crewRequired: string[]
  cameraCount: string; micCount: string
  isBlockShot: boolean; videographerCount: string; switcherCount: string
  vanCount: string; specialEquipment: string[]
  equipmentNote: string; rentalGearNote: string; itinerary: string; agencyRef: string
  notes: string; adminNotes: string
  episodeTitles: { id: string; episodeId: string; title: string }[]
}

export function BookingDrawer({ booking, onClose, onBack, canEdit, onSaved, meEmail }: {
  booking: Booking | null | undefined
  onClose: () => void
  /** Present when opened from the day drawer — "←" returns to the day list. */
  onBack?: () => void
  canEdit: boolean
  onSaved: () => void
  meEmail?: string
}) {
  const [mode, setMode] = useState<Mode>('view')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [form, setForm] = useState<DrawerForm | null>(null)

  // status strip — same source the admin detail page uses
  const [crewStatus, setCrewStatus] = useState<CrewStatus | null>(null)

  // edit: producer dropdown (v1.96 outlet producers)
  const [producers, setProducers] = useState<ProducerOpt[]>([])
  const [producersLoading, setProducersLoading] = useState(false)
  const [producerCustom, setProducerCustom] = useState(false)

  // assign
  const [roster, setRoster] = useState<RosterMember[] | null>(null)
  const [assignEmails, setAssignEmails] = useState<string[]>([])
  const [leadVideographer, setLeadVideographer] = useState('')
  const [assignMsg, setAssignMsg] = useState<string | null>(null)

  const bookingFreelancers = useMemo(() => normalizeFreelancers(booking?.freelancers), [booking?.freelancers])
  const bookingFreelancerEmails = useMemo(() => freelancerEmails(bookingFreelancers), [bookingFreelancers])

  // Reset per-booking state when switching to another booking (or closing).
  // producers included — a list fetched for another booking's outlet must not
  // leak into this one's dropdown (WLT names showed up on NWS bookings).
  useEffect(() => {
    setMode('view'); setSaveError(null); setForm(null); setAssignMsg(null)
    setCrewStatus(null); setProducerCustom(false); setProducers([]); setProducersLoading(false)
  }, [booking?.id])

  useEffect(() => {
    if (!booking) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [booking, onClose])

  // Crew-gap check (viewer-permitted endpoint) whenever the drawer opens.
  useEffect(() => {
    if (!booking?.id) return
    let dead = false
    fetch(`/api/bookings/${booking.id}/crew-status`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!dead && d) setCrewStatus(d) })
      .catch(() => {})
    return () => { dead = true }
  }, [booking?.id, mode])

  // Producer dropdown options for THIS booking's outlet (v1.96), fetched on
  // entering edit. Keyed + dead-flagged so a slow response for a previous
  // booking can't populate another outlet's dropdown. While the fetch is in
  // flight the producer field is locked (see JSX) — an editable free-text
  // input in that window would silently clear producerEmail on keystroke,
  // then get hot-swapped for the select when the list lands.
  const outletCode = booking?.outlet.code
  useEffect(() => {
    if (mode !== 'edit' || !outletCode) return
    let dead = false
    setProducersLoading(true)
    fetch(`/api/producers?outlet=${encodeURIComponent(outletCode)}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!dead && d?.producers) setProducers(d.producers) })
      .catch(() => {})
      .finally(() => { if (!dead) setProducersLoading(false) })
    return () => { dead = true }
  }, [mode, outletCode, booking?.id])

  if (!booking) return null
  const b = booking

  /* ── edit ─────────────────────────────────────────────────────────────── */

  const startEdit = () => {
    setForm({
      callTime: b.callTime || '',
      estimatedWrap: b.estimatedWrap || '',
      locationName: b.locationName || '',
      shootType: b.shootType,
      producer: b.producer || '',
      producerEmail: b.producerEmail || '',
      creative: (b.creative || []).join(', '),
      crewRequired: b.crewRequired || [],
      cameraCount: typeof b.cameraCount === 'number' ? String(b.cameraCount) : '',
      micCount: typeof b.micCount === 'number' ? String(b.micCount) : '',
      isBlockShot: !!b.isBlockShot,
      videographerCount: String(b.videographerCount || 1),
      switcherCount: String(b.switcherCount || 1),
      vanCount: String(b.vanCount ?? 0),
      specialEquipment: b.specialEquipment || [],
      equipmentNote: b.equipmentNote || '',
      rentalGearNote: b.rentalGearNote || '',
      itinerary: b.itinerary || '',
      agencyRef: b.agencyRef || '',
      notes: b.notes || '',
      adminNotes: b.adminNotes || '',
      episodeTitles: (b.episodes || []).map(e => ({ id: e.id, episodeId: e.episodeId, title: e.title || '' })),
    })
    setSaveError(null)
    setProducerCustom(false)
    setMode('edit')
  }

  const save = async () => {
    if (!form) return
    setSaving(true); setSaveError(null)
    try {
      const res = await fetch(`/api/bookings/${b.id}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callTime: form.callTime,                 // '' is ignored server-side (callTime required)
          estimatedWrap: form.estimatedWrap,       // '' clears
          locationName: form.locationName,
          shootType: form.shootType,
          ...(form.producer.trim() ? { producer: form.producer.trim() } : {}),
          producerEmail: form.producerEmail || null,
          creative: form.creative.split(',').map(s => s.trim()).filter(Boolean),
          crewRequired: form.crewRequired,
          cameraCount: form.cameraCount === '' ? null : form.cameraCount,
          micCount: form.micCount === '' ? null : form.micCount,
          isBlockShot: form.isBlockShot,
          videographerCount: Math.max(1, parseInt(form.videographerCount, 10) || 1),
          switcherCount: Math.max(1, parseInt(form.switcherCount, 10) || 1),
          vanCount: Math.max(0, Math.min(20, parseInt(form.vanCount, 10) || 0)),
          specialEquipment: form.specialEquipment,
          equipmentNote: form.equipmentNote || null,
          rentalGearNote: form.rentalGearNote || null,
          itinerary: form.itinerary || null,
          agencyRef: form.agencyRef || null,
          notes: form.notes,
          adminNotes: form.adminNotes || null,
          episodeTitles: form.episodeTitles.map(e => ({ id: e.id, title: e.title })),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error || `HTTP ${res.status}`)
      setMode('view')
      onSaved()
    } catch (e: any) {
      setSaveError(e?.message || 'บันทึกไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const toggleEquip = (item: string) =>
    setForm(f => f && ({ ...f, specialEquipment: f.specialEquipment.includes(item) ? f.specialEquipment.filter(x => x !== item) : [...f.specialEquipment, item] }))
  const toggleCrew = (item: string) =>
    setForm(f => f && ({ ...f, crewRequired: f.crewRequired.includes(item) ? f.crewRequired.filter(x => x !== item) : [...f.crewRequired, item] }))

  /* ── assign ───────────────────────────────────────────────────────────── */

  const startAssign = () => {
    setAssignMsg(null); setSaveError(null)
    setAssignEmails((b.assignedEmails || []).filter(e => !bookingFreelancerEmails.includes(e)))
    setLeadVideographer(b.mainVideographerEmail || '')
    setMode('assign')
    if (!roster) {
      fetch('/api/admin/team', { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.members) setRoster((d.members as RosterMember[]).filter((m: any) => m.active !== false)) })
        .catch(() => setRoster([]))
    }
  }

  const toggleAssign = (email: string) =>
    setAssignEmails(prev => prev.includes(email) ? prev.filter(e => e !== email) : [...prev, email])

  const submitAssign = async (sendEmail: boolean) => {
    setSaving(true); setSaveError(null); setAssignMsg(null)
    try {
      const res = await fetch(`/api/admin/${b.id}/assign`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignedEmails: assignEmails,
          adminNotes: b.adminNotes || '',
          freelancers: bookingFreelancers, // pass through untouched — edit them on the admin page
          mainVideographerEmail: leadVideographer && assignEmails.includes(leadVideographer) ? leadVideographer : null,
          sendEmail,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error || `HTTP ${res.status}`)
      const mail = d.email && !d.email.skipped ? ` · เมล ${d.email.sent}/${d.email.requested}` : ''
      const cal = d.calendar?.ok ? ` · ปฏิทิน ${d.calendar.action}` : d.calendar?.error ? ' · ⚠️ ปฏิทิน sync ไม่สำเร็จ' : ''
      setAssignMsg(`✓ บันทึกทีมแล้ว${mail}${cal}`)
      onSaved()
      setMode('view')
    } catch (e: any) {
      setSaveError(e?.message || 'บันทึกทีมไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const rosterByRole = roster ? groupByRole(roster) : null
  const selectedVideo = roster
    ? roster.filter(m => (m as any).role === 'video' && assignEmails.includes(m.email))
    : []

  /* ── render ───────────────────────────────────────────────────────────── */

  const inputCls = 'w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm'
  const labelCls = 'text-xs text-gray-500'

  return (
    <>
      <button aria-label="Close drawer" onClick={onClose} className="fixed inset-0 bg-black/30 z-40" />
      <div
        role="dialog"
        aria-modal="true"
        className="fixed z-50 bg-white shadow-xl flex flex-col
                   inset-x-0 bottom-0 max-h-[90vh] rounded-t-2xl
                   sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[460px] sm:max-h-none sm:rounded-none sm:rounded-l-2xl"
      >
        {/* header */}
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2 flex-shrink-0">
          {onBack && mode === 'view' && (
            <button onClick={onBack} className="p-1.5 -ml-1 text-gray-500 hover:text-gray-900 rounded-md hover:bg-gray-100 flex-shrink-0" aria-label="กลับไปรายการของวันนี้">
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <StatusPill status={b.status} />
              <AdBadge category={b.category} />
              <span className="text-xs text-gray-500 tabular-nums">{b.callTime}{b.estimatedWrap && ` → ${b.estimatedWrap}`}</span>
              {mode !== 'view' && <span className="text-[10px] uppercase tracking-wide text-[#673ab7] font-medium">{mode === 'edit' ? 'แก้ไข' : 'จัดทีม'}</span>}
            </div>
            <div className="text-sm font-semibold text-gray-900 truncate">{!!b.vanCount && <span title={`ต้องการรถตู้ × ${b.vanCount}`}>🚐{b.vanCount > 1 ? `×${b.vanCount}` : ''} </span>}{b.outlet.name} · {showName(b)}</div>
          </div>
          <button onClick={onClose} className="p-1.5 -mr-1 text-gray-500 hover:text-gray-900 rounded-md hover:bg-gray-100" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-sm">
          {mode === 'edit' && form ? (
            <>
              <div>
                <div className="ops-section-title mb-2">Schedule</div>
                <div className="text-gray-800 mb-2">{format(parseISO(b.shootDate), 'EEE d MMM yyyy')}</div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block"><span className={labelCls}>Call time</span>
                    <input type="time" value={form.callTime} onChange={e => setForm({ ...form, callTime: e.target.value })} className={`mt-1 ${inputCls}`} /></label>
                  <label className="block"><span className={labelCls}>Est. wrap</span>
                    <input type="time" value={form.estimatedWrap} onChange={e => setForm({ ...form, estimatedWrap: e.target.value })} className={`mt-1 ${inputCls}`} /></label>
                </div>
              </div>

              <div>
                <div className="ops-section-title mb-2">Location</div>
                <input type="text" value={form.locationName} placeholder="สถานที่ถ่ายทำ"
                  onChange={e => setForm({ ...form, locationName: e.target.value })} className={inputCls} />
                <select value={form.shootType} onChange={e => setForm({ ...form, shootType: e.target.value })}
                  className={`mt-2 ${inputCls} bg-white`}>
                  {SHOOT_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
                </select>
              </div>

              <div>
                <div className="ops-section-title mb-2">Producer</div>
                {producers.length > 0 && !producerCustom ? (
                  <select
                    // value must point at an option that exists — a producerEmail
                    // no longer in the outlet list would otherwise render a BLANK
                    // select (selectedIndex -1) instead of the "(พิมพ์เอง)" fallback.
                    value={producers.some(p => p.email === form.producerEmail) ? form.producerEmail : '__custom__'}
                    onChange={e => {
                      const v = e.target.value
                      if (v === '__custom__') { setProducerCustom(true); setForm({ ...form, producerEmail: '' }); return }
                      const p = producers.find(x => x.email === v)
                      if (p) setForm({ ...form, producer: p.nickname || p.name, producerEmail: p.email })
                    }}
                    className={`${inputCls} bg-white`}>
                    {!producers.some(p => p.email === form.producerEmail) && (
                      <option value="__custom__">{form.producer ? `${form.producer} (พิมพ์เอง)` : '— เลือกโปรดิวเซอร์ —'}</option>
                    )}
                    {producers.map(p => <option key={p.email} value={p.email}>{p.nickname || p.name}</option>)}
                    <option value="__custom__">พิมพ์ชื่อเอง…</option>
                  </select>
                ) : producersLoading && !producerCustom ? (
                  // List still loading — lock the field so a keystroke here can't
                  // silently clear producerEmail before the select swaps in.
                  <input type="text" value={form.producer} disabled placeholder="กำลังโหลดรายชื่อ…" className={`${inputCls} opacity-60`} />
                ) : (
                  <input type="text" value={form.producer} placeholder="ชื่อโปรดิวเซอร์"
                    onChange={e => setForm({ ...form, producer: e.target.value, producerEmail: '' })} className={inputCls} />
                )}
                <input type="text" value={form.creative} placeholder="Creative / Host (คั่นด้วย ,)"
                  onChange={e => setForm({ ...form, creative: e.target.value })} className={`mt-2 ${inputCls}`} />
              </div>

              <div>
                <div className="ops-section-title mb-2">Crew ที่ต้องการ</div>
                <div className="grid grid-cols-2 gap-1">
                  {CREW_OPTIONS.map(c => (
                    <label key={c} className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={form.crewRequired.includes(c)} onChange={() => toggleCrew(c)} className="accent-[#673ab7]" />
                      <span className="text-xs text-gray-700">{c}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <div className="ops-section-title mb-2">Gear</div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block"><span className={labelCls}>🎥 กล้อง</span>
                    <input type="number" min={0} max={10} value={form.cameraCount} onChange={e => setForm({ ...form, cameraCount: e.target.value })} className={`mt-1 ${inputCls}`} /></label>
                  <label className="block"><span className={labelCls}>🎙 ไมค์</span>
                    <input type="number" min={0} max={10} value={form.micCount} onChange={e => setForm({ ...form, micCount: e.target.value })} className={`mt-1 ${inputCls}`} /></label>
                  <label className="block"><span className={labelCls}>🧑‍🎥 จำนวนช่างภาพ</span>
                    <input type="number" min={1} max={10} value={form.videographerCount} onChange={e => setForm({ ...form, videographerCount: e.target.value })} className={`mt-1 ${inputCls}`} /></label>
                  <label className="block"><span className={labelCls}>🎛 จำนวน Switcher</span>
                    <input type="number" min={1} max={10} value={form.switcherCount} onChange={e => setForm({ ...form, switcherCount: e.target.value })} className={`mt-1 ${inputCls}`} /></label>
                  <label className="block"><span className={labelCls}>🚐 จำนวนรถตู้</span>
                    <input type="number" min={0} max={10} value={form.vanCount} onChange={e => setForm({ ...form, vanCount: e.target.value })} className={`mt-1 ${inputCls}`} /></label>
                </div>
                <div className="flex flex-wrap gap-4 mt-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.isBlockShot} onChange={e => setForm({ ...form, isBlockShot: e.target.checked })} className="accent-[#673ab7]" />
                    <span className="text-sm text-gray-700">📦 Block Shot</span>
                  </label>
                </div>
                <div className="mt-2">
                  <span className={labelCls}>อุปกรณ์พิเศษ</span>
                  <div className="grid grid-cols-2 gap-1 mt-1">
                    {SPECIAL_EQUIPMENT_OPTIONS.map(item => (
                      <label key={item} className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={form.specialEquipment.includes(item)} onChange={() => toggleEquip(item)} className="accent-[#673ab7]" />
                        <span className="text-xs text-gray-700">{item}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <div className="ops-section-title mb-2">Planning</div>
                <label className="block"><span className={labelCls}>🎬 จัดอุปกรณ์ (Equipment)</span>
                  <input type="text" value={form.equipmentNote} onChange={e => setForm({ ...form, equipmentNote: e.target.value })} className={`mt-1 ${inputCls}`} /></label>
                <label className="block mt-2"><span className={labelCls}>📦 ของเช่า (Rental gear)</span>
                  <input type="text" value={form.rentalGearNote} onChange={e => setForm({ ...form, rentalGearNote: e.target.value })} className={`mt-1 ${inputCls}`} /></label>
                <label className="block mt-2"><span className={labelCls}>🗒️ คิวถ่าย / Itinerary</span>
                  <textarea rows={3} value={form.itinerary} onChange={e => setForm({ ...form, itinerary: e.target.value })} className={`mt-1 ${inputCls}`} /></label>
                {/* v1.131 — Agency Ref (QU-xxxx) only matters for Advertorial work;
                    still shown if a legacy value exists on a non-AD booking. */}
                {(b.category === 'ADVERTORIAL' || form.agencyRef) && (
                  <label className="block mt-2"><span className={labelCls}>Agency Ref (QU-xxxx)</span>
                    <input type="text" value={form.agencyRef} onChange={e => setForm({ ...form, agencyRef: e.target.value })} className={`mt-1 ${inputCls}`} /></label>
                )}
              </div>

              {form.episodeTitles.length > 0 && (
                <div>
                  <div className="ops-section-title mb-2">Episodes</div>
                  {form.episodeTitles.map((ep, i) => (
                    <label key={ep.id} className="block mb-2">
                      <span className={labelCls}><span className="episode-badge">{ep.episodeId}</span></span>
                      <input type="text" value={ep.title}
                        onChange={e => setForm({ ...form, episodeTitles: form.episodeTitles.map((x, j) => j === i ? { ...x, title: e.target.value } : x) })}
                        className={`mt-1 ${inputCls}`} />
                    </label>
                  ))}
                </div>
              )}

              <div>
                <div className="ops-section-title mb-2">Notes</div>
                <textarea rows={4} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className={inputCls} />
                <label className="block mt-2"><span className={labelCls}>Admin notes (ทีมงานเห็นเท่านั้น)</span>
                  <textarea rows={2} value={form.adminNotes} onChange={e => setForm({ ...form, adminNotes: e.target.value })} className={`mt-1 ${inputCls}`} /></label>
              </div>

              {saveError && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">{saveError}</div>}
            </>
          ) : mode === 'assign' ? (
            <>
              <div className="text-xs text-gray-500">เลือกทีมที่ไปกองนี้ — บันทึกแล้วระบบอัปเดต guest ในปฏิทินให้ (เลือก "ส่งเมล" ถ้าต้องการแจ้งทีม)</div>
              {!rosterByRole ? (
                <div className="py-8 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
              ) : (
                ROLE_ORDER.map(role => {
                  const members = rosterByRole[role] || []
                  if (members.length === 0) return null
                  return (
                    <div key={role}>
                      <div className="ops-section-title mb-1.5">{ROLE_LABEL[role]}</div>
                      <div className="grid grid-cols-2 gap-1">
                        {members.map(m => (
                          <label key={m.email} className="flex items-center gap-1.5 cursor-pointer min-w-0">
                            <input type="checkbox" checked={assignEmails.includes(m.email)} onChange={() => toggleAssign(m.email)} className="accent-[#673ab7] flex-shrink-0" />
                            <span className={`text-xs truncate ${m.email === meEmail ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>{m.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )
                })
              )}
              {selectedVideo.length > 0 && (
                <div>
                  <div className="ops-section-title mb-1.5">⭐ ช่างภาพหลัก (Main Videographer)</div>
                  <select value={leadVideographer} onChange={e => setLeadVideographer(e.target.value)} className={`${inputCls} bg-white`}>
                    <option value="">— ไม่ระบุ —</option>
                    {selectedVideo.map(m => <option key={m.email} value={m.email}>{m.name}</option>)}
                  </select>
                </div>
              )}
              {bookingFreelancers.length > 0 && (
                <div>
                  <div className="ops-section-title mb-1.5">Freelancers (แก้ที่หน้า Admin)</div>
                  <div className="flex flex-wrap gap-1">
                    {bookingFreelancers.map((f, i) => (
                      <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-200">
                        {f.name}{f.role ? ` · ${freelancerRoleLabel(f.role)}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {saveError && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">{saveError}</div>}
            </>
          ) : (
            <>
              {/* status strip — same signals as the queue / my-bookings cards */}
              <div className="flex items-center gap-2 flex-wrap">
                <CameraMicTag cameraCount={b.cameraCount} micCount={b.micCount} isBlockShot={b.isBlockShot} size="sm" />
                <FootageBadge files={b.footageFiles} sent={b.footageSent} />
              </div>
              {crewStatus && crewStatus.missing.length > 0 && (b.status === 'CONFIRMED' || b.status === 'ASSIGNED') && (
                <div className="text-xs bg-orange-50 border border-orange-200 text-orange-800 rounded-md px-2.5 py-2">
                  ⚠️ ทีมงานยังไม่ครบ — ยังขาด: <span className="font-medium">{crewStatus.missingTh.join(', ')}</span>
                  {crewStatus.freelancerCount > 0 && <span className="text-orange-600"> · มี freelancer {crewStatus.freelancerCount} คน</span>}
                </div>
              )}
              {assignMsg && <div className="text-xs bg-green-50 border border-green-200 text-green-800 rounded-md px-2.5 py-2">{assignMsg}</div>}

              <div>
                <div className="ops-section-title mb-2">Schedule</div>
                <div className="text-gray-800">{format(parseISO(b.shootDate), 'EEE d MMM yyyy')}</div>
                <div className="text-gray-500 text-xs tabular-nums">{b.callTime}{b.estimatedWrap && ` → ${b.estimatedWrap}`}</div>
              </div>

              <div>
                <div className="ops-section-title mb-2">Location</div>
                <div className="text-gray-800 flex items-start gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                  <span>{b.locationName || '—'}</span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">{b.shootType.replace('_', ' ')}</div>
              </div>

              <div>
                <div className="ops-section-title mb-2">People</div>
                <div className="text-gray-800 flex items-start gap-1.5">
                  <User className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                  <span>Producer: {b.producer || '—'}</span>
                </div>
                <CrewLine crew={b.assignedCrew} meEmail={meEmail} className="text-[12px] text-gray-600 mt-1 ml-5" />
                {bookingFreelancers.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5 ml-5">
                    {bookingFreelancers.map((f, i) => (
                      <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-200">
                        {f.name}{f.role ? ` · ${freelancerRoleLabel(f.role)}` : ''}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="ops-section-title mb-2">Episodes</div>
                <div className="space-y-1">
                  {b.episodes.length === 0 ? (
                    <span className="text-gray-400 text-xs">—</span>
                  ) : b.episodes.map(ep => (
                    <div key={ep.episodeId} className="flex items-start gap-2 text-xs">
                      <Tag className="w-3 h-3 text-gray-400 mt-0.5 flex-shrink-0" />
                      <div>
                        <span className="episode-badge">{ep.episodeId}</span>
                        {ep.title && <span className="ml-2 text-gray-600">{ep.title}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {(b.itinerary || b.equipmentNote || b.rentalGearNote) && (
                <div>
                  <div className="ops-section-title mb-2">Planning</div>
                  {b.equipmentNote && <div className="text-xs text-gray-600">🎬 {b.equipmentNote}</div>}
                  {b.rentalGearNote && <div className="text-xs text-gray-600 mt-0.5">📦 {b.rentalGearNote}</div>}
                  {b.itinerary && <div className="text-xs text-gray-600 mt-0.5 whitespace-pre-wrap">🗒️ {b.itinerary}</div>}
                </div>
              )}

              {/* งานเช่า linked to this booking — admin/console only (finance data). */}
              {canEdit && <BookingRentals bookingId={b.id} bookingCode={b.bookingCode} variant="compact" />}
            </>
          )}
        </div>

        {/* footer */}
        <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-2 flex-shrink-0">
          {mode === 'edit' ? (
            <>
              <button onClick={() => { setMode('view'); setSaveError(null) }} disabled={saving} className="ops-btn-ghost ops-btn-sm">ยกเลิก</button>
              <button onClick={save} disabled={saving} className="ops-btn-primary ops-btn-sm inline-flex items-center gap-1.5">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} บันทึก
              </button>
            </>
          ) : mode === 'assign' ? (
            <>
              <button onClick={() => { setMode('view'); setSaveError(null) }} disabled={saving} className="ops-btn-ghost ops-btn-sm">กลับ</button>
              <div className="flex items-center gap-2">
                <button onClick={() => submitAssign(false)} disabled={saving} className="ops-btn-secondary ops-btn-sm inline-flex items-center gap-1.5">
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} บันทึก
                </button>
                <button onClick={() => submitAssign(true)} disabled={saving} className="ops-btn-primary ops-btn-sm">บันทึก + ส่งเมล</button>
              </div>
            </>
          ) : (
            <>
              <button onClick={onClose} className="ops-btn-ghost ops-btn-sm">Close</button>
              <div className="flex items-center gap-2">
                {canEdit && (
                  <button onClick={startAssign} className="ops-btn-secondary ops-btn-sm inline-flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5" /> จัดทีม
                  </button>
                )}
                {canEdit && (
                  <button onClick={startEdit} className="ops-btn-secondary ops-btn-sm inline-flex items-center gap-1.5">
                    <Pencil className="w-3.5 h-3.5" /> แก้ไข
                  </button>
                )}
                <Link href={`/dashboard/${b.id}`} className="ops-btn-primary ops-btn-sm">
                  Open detail →
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
