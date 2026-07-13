'use client'

/* งานเช่า (Rentals) — v1.122 rebuild. Purpose-built for the rental-paperwork
   workflow the old generic CrudTable made painful: one card per rental job,
   grouped by month, each card showing its linked Booking, money + payment/return
   status, and the five document slots (ใบเสนอราคา · ใบแจ้งหนี้ · ใบกำกับภาษี ·
   ใบเสร็จ · ใบโอน) so a missing paper is obvious at a glance. Files upload to
   Google Drive under เช่า/<เดือน>/<booking>/ automatically (API). ADMIN only. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus, Search, X, Loader2, Upload, ExternalLink, Trash2, Link2,
  Pencil, AlertCircle, Check, Calendar, RefreshCw, FileText,
} from 'lucide-react'
import { PAYMENT_STATUS, RENTAL_STATUS } from '../_components/badges'
import { baht, ymd } from '../_components/CrudTable'
import { OUTLETS } from '@/lib/data'
import { bookingDisplayName } from '@/lib/display'

// ── types ───────────────────────────────────────────────────────────────────
type DocRef = { id: string; kind: string; fileName: string; driveUrl?: string | null }
type Booking = { id: string; bookingCode: string; shootDate?: string | null }
type Vendor = { id: string; name: string }
type Rental = {
  id: string
  jobName?: string | null; items?: string | null; quoteNo?: string | null; adType?: string | null; invoiceNo?: string | null
  rentalDate?: string | null; returnDueDate?: string | null; returnedAt?: string | null
  amount?: string | number | null; paymentStatus: string; status: string; remark?: string | null
  bookingId?: string | null; outletId?: string | null; vendorId?: string | null
  vendor?: Vendor | null; outlet?: { code: string; name: string } | null; booking?: Booking | null
  documents?: DocRef[]
}

// The five documents the finance flow tracks, in filing order. Maps 1:1 to the
// DocKind enum (OTHER is shown separately as extras, not a required slot).
const DOC_SLOTS = [
  { value: 'QUOTATION', label: 'ใบเสนอราคา' },
  { value: 'INVOICE', label: 'ใบแจ้งหนี้' },
  { value: 'TAX_INVOICE', label: 'ใบกำกับภาษี' },
  { value: 'RECEIPT', label: 'ใบเสร็จ' },
  { value: 'TRANSFER_RECEIPT', label: 'ใบโอน' },
] as const
const SLOT_KINDS = new Set<string>(DOC_SLOTS.map((s) => s.value))

const PAY = ['PENDING', 'INVOICED', 'PAID']
const RSTATUS = ['ACTIVE', 'RETURNED', 'ARCHIVED']
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
const THIS_YEAR = new Date().getFullYear()
const YEARS = Array.from({ length: THIS_YEAR + 1 - 2024 + 1 }, (_, i) => THIS_YEAR + 1 - i)

const amountNum = (a: Rental['amount']) => (a == null || a === '' ? 0 : Number(a)) || 0
const monthKeyOf = (d?: string | null) => (d ? d.slice(0, 7) : '') // 'YYYY-MM' from ISO date
const monthTitle = (key: string) => {
  if (!key) return 'ไม่ระบุเดือน'
  const [y, m] = key.split('-')
  return `${TH_MONTHS[Number(m) - 1] ?? '?'} ${y}`
}
const missingSlots = (r: Rental) => DOC_SLOTS.filter((s) => !(r.documents || []).some((d) => d.kind === s.value))

// ── the five document slots on a card ────────────────────────────────────────
// onAdd/onRemove mutate the parent via functional setState (not a replace-whole-
// array), so two uploads racing on different slots can't clobber each other.
function DocSlots({ rental, onAdd, onRemove }: { rental: Rental; onAdd: (doc: DocRef) => void; onRemove: (docId: string) => void }) {
  const [busyKind, setBusyKind] = useState<string | null>(null)
  const [error, setError] = useState('')

  const docs = rental.documents || []
  const byKind = (k: string) => docs.find((d) => d.kind === k)
  const extras = docs.filter((d) => !SLOT_KINDS.has(d.kind))

  const upload = useCallback(async (kind: string, file: File) => {
    setBusyKind(kind); setError('')
    try {
      const fd = new FormData()
      fd.append('file', file); fd.append('ownerType', 'rental'); fd.append('ownerId', rental.id); fd.append('kind', kind)
      const res = await fetch('/api/admin/documents', { method: 'POST', body: fd })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      onAdd(json.document)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyKind(null)
    }
  }, [rental.id, onAdd])

  const remove = useCallback(async (doc: DocRef) => {
    if (!confirm(`ลบ "${doc.fileName}" (ลบไฟล์ใน Drive ด้วย)?`)) return
    setError('')
    try {
      const res = await fetch(`/api/admin/documents?id=${doc.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      onRemove(doc.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [onRemove])

  const pick = (kind: string) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = () => { const f = input.files?.[0]; if (f) upload(kind, f) }
    input.click()
  }

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
        {DOC_SLOTS.map((slot) => {
          const doc = byKind(slot.value)
          const busy = busyKind === slot.value
          if (doc) {
            return (
              <div key={slot.value} className="group flex items-center gap-1 rounded-lg border border-green-200 bg-green-50 px-2 py-1.5 min-w-0">
                <Check className="w-3.5 h-3.5 text-green-600 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium text-green-800 leading-tight truncate">{slot.label}</div>
                  <div className="text-[10px] text-green-600/80 leading-tight truncate">{doc.fileName}</div>
                </div>
                {doc.driveUrl && (
                  <a href={doc.driveUrl} target="_blank" rel="noopener noreferrer" title="เปิดใน Drive"
                     className="text-green-600 hover:text-green-800 shrink-0"><ExternalLink className="w-3.5 h-3.5" /></a>
                )}
                <button onClick={() => remove(doc)} title="ลบ"
                        className="text-green-500/60 hover:text-red-600 shrink-0 opacity-0 group-hover:opacity-100 transition"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            )
          }
          return (
            <button key={slot.value} onClick={() => !busy && pick(slot.value)} disabled={busy}
                    className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-gray-300 bg-gray-50/60 px-2 py-1.5 text-[11px] text-gray-500 hover:border-[#673ab7] hover:text-[#673ab7] hover:bg-purple-50/50 transition disabled:opacity-60">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              <span className="truncate">{slot.label}</span>
            </button>
          )
        })}
      </div>

      {extras.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {extras.map((doc) => (
            <span key={doc.id} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
              <FileText className="w-3 h-3" />
              {doc.driveUrl
                ? <a href={doc.driveUrl} target="_blank" rel="noopener noreferrer" className="hover:underline max-w-[160px] truncate">{doc.fileName}</a>
                : <span className="max-w-[160px] truncate">{doc.fileName}</span>}
              <button onClick={() => remove(doc)} className="text-gray-400 hover:text-red-600"><X className="w-3 h-3" /></button>
            </span>
          ))}
        </div>
      )}
      {error && <div className="text-[11px] text-red-700">{error}</div>}
    </div>
  )
}

// ── booking picker (click to browse recent, filter by date, or type to search) ─
type PickerBooking = {
  id: string
  bookingCode: string | null
  shootDate?: string | null
  shootEndDate?: string | null
  producer?: string | null
  projectName?: string | null
  category?: string | null
  agencyRef?: string | null
  rentalGearNote?: string | null
  program: { name: string }
  outlet?: { code: string } | null
  episodes?: Array<{ episodeId?: string; title?: string | null; program?: { code?: string; name: string } | null }> | null
}

/** the display line used in picker rows + the auto job name */
function pickerBookingLabel(b: PickerBooking): string {
  const name = bookingDisplayName(b)
  const t = b.episodes?.[0]?.title?.trim()
  return t && !name.includes(t) ? `${name} — ${t}` : name
}
function BookingPicker({ value, label, onChange }: { value: string | null; label: string | null; onChange: (id: string | null, code: string | null, booking?: PickerBooking) => void }) {
  const [q, setQ] = useState('')
  const [dateFilter, setDateFilter] = useState('') // YYYY-MM-DD → /api/bookings?date= (exact shoot-day)
  const [results, setResults] = useState<PickerBooking[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false) // ≥1 fetch done — gates the "ไม่พบ" state so it can't flash pre-fetch
  const rootRef = useRef<HTMLDivElement | null>(null)
  const prevDateRef = useRef(dateFilter)

  // Dismissal: click-outside or Escape closes the list (before this, an unlinked
  // form had NO way to close it short of picking a row).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  useEffect(() => {
    if (!open) { setResults([]); return }
    // A changed date filter invalidates what's on screen NOW — clear before the
    // fetch so stale rows never sit under the new "งานวันที่ X" header.
    if (prevDateRef.current !== dateFilter) { prevDateRef.current = dateFilter; setResults([]) }
    let cancelled = false
    const query = q.trim()
    // Empty/1-char → show the most-recent bookings straight away (no typing
    // needed, "เลือกได้เลย"); ≥2 chars → debounced search; a date filter narrows
    // either mode to that shoot day. /api/bookings orders by shootDate desc.
    const t = setTimeout(async () => {
      setLoading(true)
      try {
        // hasCode=1 — only bookings with a Production ID (filtered SERVER-side,
        // so null-code legacy rows can't eat pagination slots; the client
        // .filter below stays as a type-narrowing safety net).
        const p = new URLSearchParams({ scope: 'all', hasCode: '1', limit: dateFilter ? '50' : (query.length >= 2 ? '12' : '15') })
        if (query.length >= 2) p.set('search', query)
        if (dateFilter) p.set('date', dateFilter)
        const res = await fetch(`/api/bookings?${p.toString()}`)
        const json = await res.json().catch(() => ({}))
        // rentals link by Production ID — rows without one can't be picked
        if (!cancelled) setResults((json.bookings || []).filter((b: PickerBooking) => b.bookingCode)) // ignore a stale response that lost the race
      } finally { if (!cancelled) { setLoading(false); setFetched(true) } }
    }, query.length >= 2 || dateFilter ? 250 : 0)
    return () => { cancelled = true; clearTimeout(t) }
  }, [q, open, dateFilter])

  if (value && !open) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-md bg-purple-50 border border-purple-200 px-2 py-1 text-sm font-medium text-[#673ab7]">
          <Link2 className="w-3.5 h-3.5" />{label || value}
        </span>
        <button type="button" onClick={() => { setOpen(true); setQ('') }} className="text-xs text-gray-500 hover:text-gray-800">เปลี่ยน</button>
        <button type="button" onClick={() => onChange(null, null)} className="text-xs text-gray-400 hover:text-red-600">ปลดลิงก์</button>
      </div>
    )
  }

  return (
    <div className="relative" ref={rootRef}>
      <div className="flex items-center gap-2 border border-gray-300 rounded-md px-2 py-1.5">
        <Search className="w-4 h-4 text-gray-400 shrink-0" />
        <input value={q} onFocus={() => setOpen(true)} onChange={(e) => setQ(e.target.value)}
               placeholder="ค้นหา Booking (รหัส / ชื่องาน / โปรดิวเซอร์)…"
               className="flex-1 min-w-0 text-sm outline-none bg-transparent" />
        {loading && <Loader2 className="w-4 h-4 animate-spin text-gray-400 shrink-0" />}
        {/* filter the list to one shoot day — "ฟิลเตอร์ตามวัน" */}
        <input type="date" value={dateFilter} title="กรองตามวันถ่าย"
               onChange={(e) => { setDateFilter(e.target.value); setOpen(true) }}
               onFocus={() => setOpen(true)}
               className="shrink-0 text-xs text-gray-500 border-l border-gray-200 pl-2 outline-none bg-transparent" />
        {dateFilter && (
          <button type="button" onClick={() => setDateFilter('')} title="ล้างตัวกรองวัน"
                  className="text-gray-400 hover:text-red-600 shrink-0"><X className="w-3.5 h-3.5" /></button>
        )}
        {/* explicit close — always available while the list is open (an unlinked
            form previously had NO dismiss path besides picking a row) */}
        {open && <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-400 hover:text-gray-700 shrink-0">ปิด</button>}
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg">
          <div className="sticky top-0 bg-gray-50 px-3 py-1 text-[11px] font-medium text-gray-400 border-b border-gray-100">
            {dateFilter ? `งานวันที่ ${dateFilter}` : 'เลือกงาน'} · พิมพ์เพื่อค้นหา
          </div>
          {results.map((b) => {
            const name = bookingDisplayName(b)
            // suffix only when the title isn't already part of the display name
            // (multi-episode generic bookings render "T1 / T2" as the name)
            const rawTitle = b.episodes?.[0]?.title?.trim()
            const epTitle = rawTitle && !name.includes(rawTitle) ? rawTitle : null
            return (
              <button key={b.id} type="button"
                      onClick={() => { onChange(b.id, b.bookingCode, b); setOpen(false); setQ('') }}
                      className="w-full text-left px-3 py-2 hover:bg-purple-50 border-b border-gray-50 last:border-0">
                <div className="text-sm font-medium text-gray-800 truncate">
                  {name}
                  {epTitle ? <span className="text-gray-500 font-normal"> — {epTitle}</span> : null}
                </div>
                <div className="text-xs text-gray-500 truncate">
                  {[b.bookingCode, b.shootDate ? ymd(b.shootDate) : null, b.producer].filter(Boolean).join(' · ')}
                </div>
              </button>
            )
          })}
        </div>
      )}
      {open && !loading && fetched && results.length === 0 && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg px-3 py-2 text-sm text-gray-400">
          {dateFilter ? `ไม่พบงานวันที่ ${dateFilter}` : 'ไม่พบ Booking'}
        </div>
      )}
    </div>
  )
}

// ── add / edit form ──────────────────────────────────────────────────────────
const emptyForm = (): Partial<Rental> => ({ paymentStatus: 'PENDING', status: 'ACTIVE' })

function RentalForm({ initial, vendors, onClose, onSaved }: {
  initial: Partial<Rental> | null; vendors: Vendor[]; onClose: () => void; onSaved: () => void
}) {
  // Editing: the stored outletId is a DB cuid but the select's options are
  // outlet CODES — map it back to the code so the current outlet shows selected
  // (and an untouched save round-trips the code, not an unknown id).
  // Honor `initial` for BOTH edit (has id) AND a pre-filled "add" (deep-link from
  // a booking sets bookingId+booking but no id) — otherwise the injected bookingId
  // is dropped and the rental saves unlinked. Plain "Add" passes emptyForm(), so
  // the spread is a no-op there.
  const [f, setF] = useState<Partial<Rental>>(initial
    ? { ...emptyForm(), ...initial, outletId: initial.outlet?.code ?? initial.outletId }
    : emptyForm())
  const [bookingCode, setBookingCode] = useState<string | null>(initial?.booking?.bookingCode ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = (k: keyof Rental, v: unknown) => setF((p) => ({ ...p, [k]: v }))

  // Picking a booking fills the form from it (ops: "เลือกงานแล้ว เติมมาให้เลย"):
  // job name ALWAYS mirrors the booking (that's what ชื่องาน means now); the rest
  // fill only when still empty so a half-typed form isn't clobbered.
  const applyBooking = (id: string | null, code: string | null, b?: PickerBooking) => {
    setBookingCode(code)
    setF((p) => {
      const next: Partial<Rental> = { ...p, bookingId: id }
      if (b) {
        next.jobName = pickerBookingLabel(b)
        if (!p.items?.trim() && b.rentalGearNote?.trim()) next.items = b.rentalGearNote
        if (!p.adType?.trim() && b.category) next.adType = b.category === 'ADVERTORIAL' ? 'AD' : 'NON-AD'
        if (!p.quoteNo?.trim() && b.agencyRef?.trim()) next.quoteNo = b.agencyRef
        if (!p.rentalDate && b.shootDate) next.rentalDate = String(b.shootDate).slice(0, 10)
        if (!p.returnDueDate && (b.shootEndDate || b.shootDate)) next.returnDueDate = String(b.shootEndDate || b.shootDate).slice(0, 10)
        if (!p.outletId && b.outlet?.code) next.outletId = b.outlet.code
      }
      return next
    })
  }

  // Deep-link "เพิ่มงานเช่า" from a booking page passes only id+code — fetch the
  // booking once so that path gets the same auto-fill as picking from the list.
  useEffect(() => {
    if (initial?.id || !initial?.bookingId || initial?.jobName) return
    let dead = false
    fetch(`/api/bookings/${initial.bookingId}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!dead && j?.booking) applyBooking(j.booking.id, j.booking.bookingCode, j.booking) })
      .catch(() => {})
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async () => {
    if (!f.jobName?.trim()) { setError('กรุณาใส่ชื่องาน'); return }
    setSaving(true); setError('')
    try {
      const body = {
        jobName: f.jobName, items: f.items ?? null, quoteNo: f.quoteNo, adType: f.adType, invoiceNo: f.invoiceNo,
        bookingId: f.bookingId ?? null, outletId: f.outletId ?? null, vendorId: f.vendorId ?? null,
        rentalDate: f.rentalDate ?? null, returnDueDate: f.returnDueDate ?? null, returnedAt: f.returnedAt ?? null,
        amount: f.amount ?? null, paymentStatus: f.paymentStatus, status: f.status, remark: f.remark,
      }
      const url = f.id ? `/api/admin/rentals/${f.id}` : '/api/admin/rentals'
      const res = await fetch(url, { method: f.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setSaving(false) }
  }

  const dateVal = (v: unknown) => (typeof v === 'string' ? v.slice(0, 10) : '')
  const inputCls = 'w-full border border-gray-300 rounded-md px-2.5 py-1.5 text-sm focus:border-[#673ab7] focus:ring-1 focus:ring-[#673ab7] outline-none'
  const lbl = 'block text-xs font-medium text-gray-600 mb-1'

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-3 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg my-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-800">{f.id ? 'แก้ไขงานเช่า' : 'เพิ่มงานเช่า'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3.5">
          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}

          <div>
            <label className={lbl}>ผูกกับ Booking <span className="font-normal text-gray-400">(เลือกแล้วเติมข้อมูลให้อัตโนมัติ)</span></label>
            <BookingPicker value={f.bookingId ?? null} label={bookingCode} onChange={applyBooking} />
          </div>

          <div>
            <label className={lbl}>ชื่องาน *</label>
            <input value={f.jobName || ''} onChange={(e) => set('jobName', e.target.value)} className={inputCls} placeholder="เติมอัตโนมัติเมื่อเลือก Booking" />
          </div>

          <div>
            <label className={lbl}>เช่าอะไร</label>
            <textarea value={f.items || ''} onChange={(e) => set('items', e.target.value)} rows={2} className={inputCls}
                      placeholder="เช่น เลนส์ 24-70 x1 · จอมอนิเตอร์ x2…" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>Vendor</label>
              <select value={f.vendorId || ''} onChange={(e) => set('vendorId', e.target.value || null)} className={inputCls}>
                <option value="">—</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div>
              <label className={lbl}>Outlet</label>
              <select value={f.outletId || ''} onChange={(e) => set('outletId', e.target.value || null)} className={inputCls}>
                <option value="">—</option>
                {OUTLETS.map((o) => <option key={o.code} value={o.code}>{o.code} · {o.name}</option>)}
              </select>
            </div>
            <div>
              <label className={lbl}>วันเช่า</label>
              <input type="date" value={dateVal(f.rentalDate)} onChange={(e) => set('rentalDate', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={lbl}>กำหนดคืน</label>
              <input type="date" value={dateVal(f.returnDueDate)} onChange={(e) => set('returnDueDate', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={lbl}>คืนแล้วเมื่อ</label>
              <input type="date" value={dateVal(f.returnedAt)} onChange={(e) => set('returnedAt', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={lbl}>ยอดเงิน (บาท)</label>
              <input type="number" value={f.amount == null ? '' : String(f.amount)} onChange={(e) => set('amount', e.target.value)} className={inputCls} placeholder="0" />
            </div>
            <div>
              <label className={lbl}>สถานะงาน</label>
              <select value={f.status || 'ACTIVE'} onChange={(e) => set('status', e.target.value)} className={inputCls}>
                {RSTATUS.map((s) => <option key={s} value={s}>{RENTAL_STATUS[s]?.th || s}</option>)}
              </select>
            </div>
            <div>
              <label className={lbl}>สถานะจ่าย</label>
              <select value={f.paymentStatus || 'PENDING'} onChange={(e) => set('paymentStatus', e.target.value)} className={inputCls}>
                {PAY.map((s) => <option key={s} value={s}>{PAYMENT_STATUS[s]?.th || s}</option>)}
              </select>
            </div>
            <div>
              <label className={lbl}>Quote No.</label>
              <input value={f.quoteNo || ''} onChange={(e) => set('quoteNo', e.target.value)} className={inputCls} placeholder="QU-xxxx" />
            </div>
            <div>
              <label className={lbl}>เลขใบแจ้งหนี้</label>
              <input value={f.invoiceNo || ''} onChange={(e) => set('invoiceNo', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={lbl}>AD / NON-AD</label>
              <input value={f.adType || ''} onChange={(e) => set('adType', e.target.value)} className={inputCls} placeholder="AD / NON-AD" />
            </div>
          </div>

          <div>
            <label className={lbl}>หมายเหตุ</label>
            <textarea value={f.remark || ''} onChange={(e) => set('remark', e.target.value)} rows={2} className={inputCls} />
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-md">ยกเลิก</button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-[#673ab7] text-white rounded-md hover:bg-[#5e35b1] disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} บันทึก
          </button>
        </div>
      </div>
    </div>
  )
}

// ── one rental card ──────────────────────────────────────────────────────────
function RentalCard({ rental, onAdd, onRemove, onPatch, onEdit }: {
  rental: Rental
  onAdd: (doc: DocRef) => void
  onRemove: (docId: string) => void
  onPatch: (patch: Partial<Rental>) => void
  onEdit: () => void
}) {
  const miss = missingSlots(rental)
  const money = amountNum(rental.amount)
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3.5 shadow-sm space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-800 truncate">{rental.jobName || rental.quoteNo || '(ไม่มีชื่อ)'}</span>
            {rental.booking?.bookingCode && (
              <a href={`/admin/${rental.booking.id}`} className="inline-flex items-center gap-1 rounded-md bg-purple-50 border border-purple-200 px-1.5 py-0.5 text-[11px] font-medium text-[#673ab7] hover:bg-purple-100">
                <Link2 className="w-3 h-3" />{rental.booking.bookingCode}
              </a>
            )}
            {rental.outlet?.code && <span className="text-[11px] text-gray-400">{rental.outlet.code}</span>}
          </div>
          {rental.items && <div className="mt-0.5 text-xs text-gray-700 whitespace-pre-line">📦 {rental.items}</div>}
          <div className="mt-0.5 flex items-center gap-x-3 gap-y-0.5 flex-wrap text-xs text-gray-500">
            {rental.vendor?.name && <span>🏢 {rental.vendor.name}</span>}
            {rental.rentalDate && <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" />{ymd(rental.rentalDate)}{rental.returnDueDate ? ` → คืน ${ymd(rental.returnDueDate)}` : ''}</span>}
            {rental.quoteNo && <span>{rental.quoteNo}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {money > 0 && <span className="text-sm font-semibold text-gray-800 tabular-nums">{baht(rental.amount)}</span>}
          <button onClick={onEdit} title="แก้ไข" className="text-gray-400 hover:text-[#673ab7] p-1"><Pencil className="w-4 h-4" /></button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <select value={rental.status} onChange={(e) => onPatch({ status: e.target.value })}
                className="text-[11px] rounded-full border border-gray-200 px-2 py-0.5 bg-gray-50 text-gray-700 focus:border-[#673ab7] outline-none">
          {RSTATUS.map((s) => <option key={s} value={s}>{RENTAL_STATUS[s]?.th || s}</option>)}
        </select>
        <select value={rental.paymentStatus} onChange={(e) => onPatch({ paymentStatus: e.target.value })}
                className="text-[11px] rounded-full border border-gray-200 px-2 py-0.5 bg-gray-50 text-gray-700 focus:border-[#673ab7] outline-none">
          {PAY.map((s) => <option key={s} value={s}>{PAYMENT_STATUS[s]?.th || s}</option>)}
        </select>
        {miss.length === 0
          ? <span className="inline-flex items-center gap-1 text-[11px] text-green-700"><Check className="w-3.5 h-3.5" />เอกสารครบ</span>
          : <span className="inline-flex items-center gap-1 text-[11px] text-amber-700"><AlertCircle className="w-3.5 h-3.5" />ขาด {miss.length}: {miss.map((m) => m.label).join(', ')}</span>}
      </div>

      <DocSlots rental={rental} onAdd={onAdd} onRemove={onRemove} />
      {rental.remark && <div className="text-xs text-gray-400 border-t border-gray-50 pt-2">{rental.remark}</div>}
    </div>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────
export default function RentalsPage() {
  const [year, setYear] = useState(THIS_YEAR)
  const [rentals, setRentals] = useState<Rental[]>([])
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Partial<Rental> | null>(null)
  // filters
  const [q, setQ] = useState('')
  const [fOutlet, setFOutlet] = useState('all')
  const [fStatus, setFStatus] = useState('live') // 'live' = hide ARCHIVED (fresh view); archived stay recoverable behind the filter
  const [fPay, setFPay] = useState('all')
  const [onlyIncomplete, setOnlyIncomplete] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)

  // Fetch every rental (low volume) and filter client-side. A server year filter
  // would silently drop rentals with no rentalDate — exactly the "ไม่ตกหล่น" gap
  // we're closing — so undated jobs always stay visible (in the ไม่ระบุเดือน group).
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/admin/rentals?status=all&payment=all')
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setRentals(json.rentals || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    fetch('/api/admin/vendors').then((r) => r.json()).then((j) => setVendors(j.vendors || [])).catch(() => {})
  }, [])

  // Deep-links from the booking side (BookingRentals on /admin/[id] + drawer):
  //   ?newForBooking=<id>&code=<bookingCode> → open the add form pre-linked
  //   ?focus=<rentalId>                      → open that rental for edit
  // URL is cleaned after so a refresh doesn't reopen. focus waits for the list.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const bId = p.get('newForBooking')
    const fId = p.get('focus')
    if (bId) setEditing({ ...emptyForm(), bookingId: bId, booking: { id: bId, bookingCode: p.get('code') || bId } })
    if (fId) setFocusId(fId)
    if (bId || fId) window.history.replaceState({}, '', '/admin/rentals')
  }, [])
  useEffect(() => {
    if (!focusId) return
    const r = rentals.find((x) => x.id === focusId)
    if (r) { setEditing(r); setFocusId(null) }
  }, [focusId, rentals])

  const patchRental = useCallback((id: string, patch: Partial<Rental>) => {
    setRentals((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    fetch(`/api/admin/rentals/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      .then((r) => { if (!r.ok) load() }).catch(() => load())
  }, [load])

  const addDoc = useCallback((id: string, doc: DocRef) => {
    setRentals((rs) => rs.map((r) => (r.id === id ? { ...r, documents: [doc, ...(r.documents || [])] } : r)))
  }, [])
  const removeDoc = useCallback((id: string, docId: string) => {
    setRentals((rs) => rs.map((r) => (r.id === id ? { ...r, documents: (r.documents || []).filter((d) => d.id !== docId) } : r)))
  }, [])

  // client-side filters
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const yr = String(year)
    return rentals.filter((r) => {
      // Dated rentals filter by their year. Undated rentals show only in the
      // current-year view — so nothing is ever lost, but they aren't counted
      // into every past year's summary/total (they're "unfiled → needs a date").
      if (r.rentalDate) { if (!monthKeyOf(r.rentalDate).startsWith(yr)) return false }
      else if (year !== THIS_YEAR) return false
      if (fOutlet !== 'all' && r.outlet?.code !== fOutlet) return false
      if (fStatus === 'live') { if (r.status === 'ARCHIVED') return false }
      else if (fStatus !== 'all' && r.status !== fStatus) return false
      if (fPay !== 'all' && r.paymentStatus !== fPay) return false
      if (onlyIncomplete && missingSlots(r).length === 0) return false
      if (needle) {
        const hay = [r.jobName, r.items, r.quoteNo, r.invoiceNo, r.vendor?.name, r.booking?.bookingCode].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [rentals, year, q, fOutlet, fStatus, fPay, onlyIncomplete])

  // group by month (rentalDate) — newest month first, undated last
  const groups = useMemo(() => {
    const map = new Map<string, Rental[]>()
    for (const r of filtered) {
      const k = monthKeyOf(r.rentalDate)
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(r)
    }
    return Array.from(map.entries()).sort((a, b) => {
      if (!a[0]) return 1
      if (!b[0]) return -1
      return b[0].localeCompare(a[0])
    })
  }, [filtered])

  const summary = useMemo(() => ({
    count: filtered.length,
    total: filtered.reduce((s, r) => s + amountNum(r.amount), 0),
    unpaid: filtered.filter((r) => r.paymentStatus !== 'PAID').length,
    incomplete: filtered.filter((r) => missingSlots(r).length > 0).length,
  }), [filtered])

  const selCls = 'text-sm border border-gray-300 rounded-md px-2 py-1.5 bg-white focus:border-[#673ab7] outline-none'

  return (
    <div className="max-w-5xl mx-auto px-4 py-5 space-y-4">
      {/* header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900">งานเช่า</h1>
          <p className="text-sm text-gray-500">จัดการงานเช่าอุปกรณ์ต่อ Booking · แนบเอกสารเข้า Drive แยกตามเดือน/งาน · เห็นเอกสารที่ขาดทันที</p>
        </div>
        <button onClick={() => setEditing(emptyForm())} className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm bg-[#673ab7] text-white rounded-md hover:bg-[#5e35b1]">
          <Plus className="w-4 h-4" /> เพิ่มงานเช่า
        </button>
      </div>

      {/* summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><div className="text-lg font-bold tabular-nums">{summary.count}</div><div className="text-[11px] text-gray-500">งานเช่า (ปี {year})</div></div>
        <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><div className="text-lg font-bold tabular-nums text-[#673ab7]">{baht(summary.total)}</div><div className="text-[11px] text-gray-500">ยอดรวม</div></div>
        <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><div className="text-lg font-bold tabular-nums text-red-600">{summary.unpaid}</div><div className="text-[11px] text-gray-500">ยังไม่จ่าย</div></div>
        <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><div className="text-lg font-bold tabular-nums text-amber-600">{summary.incomplete}</div><div className="text-[11px] text-gray-500">เอกสารไม่ครบ</div></div>
      </div>

      {/* filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 border border-gray-300 rounded-md px-2 py-1.5 bg-white flex-1 min-w-[180px]">
          <Search className="w-4 h-4 text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหา ชื่องาน / Booking / vendor / เลขเอกสาร" className="flex-1 text-sm outline-none" />
        </div>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={selCls}>{YEARS.map((y) => <option key={y} value={y}>ปี {y}</option>)}</select>
        <select value={fOutlet} onChange={(e) => setFOutlet(e.target.value)} className={selCls}><option value="all">ทุก Outlet</option>{OUTLETS.map((o) => <option key={o.code} value={o.code}>{o.code}</option>)}</select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className={selCls}><option value="live">กำลังใช้ (ซ่อนที่เก็บ)</option><option value="all">ทั้งหมด (รวมที่เก็บ)</option>{RSTATUS.map((s) => <option key={s} value={s}>{RENTAL_STATUS[s]?.th || s}</option>)}</select>
        <select value={fPay} onChange={(e) => setFPay(e.target.value)} className={selCls}><option value="all">การจ่ายทั้งหมด</option>{PAY.map((s) => <option key={s} value={s}>{PAYMENT_STATUS[s]?.th || s}</option>)}</select>
        <button onClick={() => setOnlyIncomplete((v) => !v)} className={`text-sm rounded-md px-2.5 py-1.5 border ${onlyIncomplete ? 'bg-amber-50 border-amber-300 text-amber-700' : 'bg-white border-gray-300 text-gray-600'}`}>เอกสารไม่ครบ</button>
        <button onClick={load} title="โหลดใหม่" className="p-2 text-gray-400 hover:text-gray-700"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></button>
      </div>

      {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}

      {/* body */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : groups.length === 0 ? (
        <div className="text-center py-16 text-gray-400 text-sm">ไม่มีงานเช่าตามตัวกรองนี้</div>
      ) : (
        <div className="space-y-6">
          {groups.map(([key, items]) => {
            const monthTotal = items.reduce((s, r) => s + amountNum(r.amount), 0)
            return (
              <div key={key || 'undated'}>
                <div className="flex items-baseline gap-2 mb-2 sticky top-0 bg-white/85 backdrop-blur py-1 z-10">
                  <h2 className="text-sm font-bold text-gray-800">{monthTitle(key)}</h2>
                  <span className="text-xs text-gray-400">{items.length} งาน · {baht(monthTotal)}</span>
                </div>
                <div className="grid gap-2.5 md:grid-cols-2">
                  {items.map((r) => (
                    <RentalCard key={r.id} rental={r}
                                onAdd={(doc) => addDoc(r.id, doc)}
                                onRemove={(docId) => removeDoc(r.id, docId)}
                                onPatch={(patch) => patchRental(r.id, patch)}
                                onEdit={() => setEditing(r)} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <RentalForm key={editing.id || 'new'} initial={editing} vendors={vendors}
                    onClose={() => setEditing(null)}
                    onSaved={() => { setEditing(null); load() }} />
      )}
    </div>
  )
}
