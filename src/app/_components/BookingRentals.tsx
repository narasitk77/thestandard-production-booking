'use client'

/* งานเช่า ของ booking หนึ่งงาน — the reverse side of the rental↔booking link.
   Rentals live on /admin/rentals (one card each), linked to a booking. This shows
   the SAME link from the booking's side: open a job → see what it rented, from
   whom, how much, paid?, docs complete?, plus a one-click "เพิ่มงานเช่า" that lands
   on the rentals page with THIS booking pre-linked. Data comes from the console-
   gated /api/bookings/[id]/rentals so producer/crew views never see rental money. */

import { useEffect, useState } from 'react'
import { Loader2, Plus, Link2, ExternalLink, Check, AlertCircle, Calendar, Building2 } from 'lucide-react'
import { PAYMENT_STATUS, RENTAL_STATUS } from '@/app/admin/_components/badges'

type Rental = {
  id: string; jobName?: string | null; quoteNo?: string | null; invoiceNo?: string | null; adType?: string | null
  paymentStatus: string; status: string; amount?: number | null
  rentalDate?: string | null; returnDueDate?: string | null; returnedAt?: string | null
  vendor?: { id: string; name: string } | null; outlet?: { code: string } | null
  documents?: { kind: string }[]
}

// The five finance papers a rental tracks (mirrors DOC_SLOTS on /admin/rentals).
const DOC_KINDS = ['QUOTATION', 'INVOICE', 'TAX_INVOICE', 'RECEIPT', 'TRANSFER_RECEIPT']
const baht = (n?: number | null) => (n ? `฿${Number(n).toLocaleString('th-TH')}` : '')
const ymd = (d?: string | null) => (d ? String(d).slice(0, 10) : '')
const isOverdue = (r: Rental) => r.status === 'ACTIVE' && !r.returnedAt && !!r.returnDueDate && ymd(r.returnDueDate) < new Date().toISOString().slice(0, 10)

function Badge({ map, value }: { map: typeof PAYMENT_STATUS; value: string }) {
  const e = map[value]
  return <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${e?.c || 'bg-gray-100 text-gray-600'}`}>{e?.th || value}</span>
}

export default function BookingRentals({ bookingId, bookingCode, variant = 'full' }: {
  bookingId: string; bookingCode?: string | null; variant?: 'full' | 'compact'
}) {
  const [rentals, setRentals] = useState<Rental[] | null>(null)
  const [error, setError] = useState('')
  // Rentals are console-only. A producer/crew who can view this booking (but not
  // its finance) gets 403 → render NOTHING (no card, no error) so the section
  // stays invisible to them rather than flashing a scary "Console only".
  const [forbidden, setForbidden] = useState(false)

  useEffect(() => {
    let dead = false
    setRentals(null); setError(''); setForbidden(false)
    fetch(`/api/bookings/${bookingId}/rentals`, { credentials: 'include' })
      .then(async r => {
        if (r.status === 401 || r.status === 403) { if (!dead) setForbidden(true); return null }
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
        return r.json()
      })
      .then(j => { if (!dead && j) setRentals(j.rentals || []) })
      .catch(e => { if (!dead) { setError(String(e.message || e)); setRentals([]) } })
    return () => { dead = true }
  }, [bookingId])

  if (forbidden) return null

  const addHref = `/admin/rentals?newForBooking=${encodeURIComponent(bookingId)}${bookingCode ? `&code=${encodeURIComponent(bookingCode)}` : ''}`
  const total = (rentals || []).reduce((s, r) => s + (r.amount || 0), 0)
  const compact = variant === 'compact'

  const header = (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className={`font-medium text-gray-700 ${compact ? 'text-xs' : 'text-sm'}`}>📦 งานเช่า</span>
        {rentals && rentals.length > 0 && (
          <span className="text-[11px] text-gray-400">{rentals.length} รายการ{total > 0 ? ` · ${baht(total)}` : ''}</span>
        )}
      </div>
      <a href={addHref} className="inline-flex items-center gap-1 rounded-md border border-[#673ab7] px-2 py-0.5 text-[11px] font-medium text-[#673ab7] hover:bg-[#673ab7] hover:text-white transition">
        <Plus className="w-3 h-3" /> เพิ่มงานเช่า
      </a>
    </div>
  )

  const body = () => {
    if (rentals === null) return <div className="flex items-center gap-2 text-xs text-gray-400 py-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> กำลังโหลด…</div>
    if (error) return <div className="text-[11px] text-red-600 py-1">{error}</div>
    if (rentals.length === 0) return <div className="text-xs text-gray-400 py-1.5">ยังไม่มีงานเช่าผูกกับงานนี้ — กด “เพิ่มงานเช่า” เพื่อเริ่ม</div>
    return (
      <div className="space-y-1.5">
        {rentals.map(r => {
          const missing = DOC_KINDS.filter(k => !(r.documents || []).some(d => d.kind === k)).length
          const overdue = isOverdue(r)
          return (
            <a key={r.id} href={`/admin/rentals?focus=${r.id}`}
               className="block rounded-lg border border-gray-200 bg-white px-2.5 py-2 hover:border-[#673ab7] hover:bg-purple-50/40 transition">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[13px] font-medium text-gray-800 truncate">{r.jobName || r.quoteNo || '(ไม่มีชื่อ)'}</span>
                    {r.adType && <span className="text-[10px] text-gray-400">{r.adType}</span>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-x-2.5 gap-y-0.5 flex-wrap text-[11px] text-gray-500">
                    {r.vendor?.name && <span className="inline-flex items-center gap-1"><Building2 className="w-3 h-3" />{r.vendor.name}</span>}
                    {r.rentalDate && <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" />{ymd(r.rentalDate)}{r.returnDueDate ? ` → คืน ${ymd(r.returnDueDate)}` : ''}</span>}
                    {r.quoteNo && <span>{r.quoteNo}</span>}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  {r.amount ? <div className="text-[13px] font-semibold text-gray-800 tabular-nums">{baht(r.amount)}</div> : null}
                  <ExternalLink className="w-3 h-3 text-gray-300 inline-block" />
                </div>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                <Badge map={RENTAL_STATUS} value={r.status} />
                <Badge map={PAYMENT_STATUS} value={r.paymentStatus} />
                {missing === 0
                  ? <span className="inline-flex items-center gap-1 text-[10px] text-green-700"><Check className="w-3 h-3" />เอกสารครบ</span>
                  : <span className="inline-flex items-center gap-1 text-[10px] text-amber-700"><AlertCircle className="w-3 h-3" />เอกสารขาด {missing}</span>}
                {overdue && <span className="inline-flex items-center gap-1 text-[10px] text-red-700"><AlertCircle className="w-3 h-3" />เกินกำหนดคืน</span>}
              </div>
            </a>
          )
        })}
      </div>
    )
  }

  if (compact) {
    // Nothing to show (no rentals, still loading fine) → keep the drawer quiet but
    // always offer the add affordance so the link can be started from the calendar.
    // Hide ONLY the genuine empty state to keep the drawer quiet; loading, error,
    // and the actual list still render (an error must not look like "no rentals").
    return <div className="border-t border-gray-100 pt-2 space-y-1.5">{header}{rentals && rentals.length === 0 && !error ? null : body()}</div>
  }
  return (
    <div className="gf-card p-4 sm:p-5 space-y-2.5">
      {header}
      {body()}
    </div>
  )
}
