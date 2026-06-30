'use client'

import { useCallback, useEffect, useState } from 'react'

type Eq = { id: string; name: string; category: string; serialNumber: string | null }
type Item = { id: string; nameSnapshot: string; tagSnapshot: string | null; equipment?: { name: string } | null }
type Loan = { id: string; loanCode: string; status: string; email: string | null; photographer: string; items: Item[] }

const STATUS: Record<string, { th: string; cls: string }> = {
  REQUESTED: { th: 'รออนุมัติเบิก', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  ACTIVE: { th: 'เบิกแล้ว (ถืออยู่)', cls: 'bg-green-50 text-green-700 border-green-200' },
  RETURNED: { th: 'คืนแล้ว', cls: 'bg-gray-50 text-gray-500 border-gray-200' },
}
const CATS: { code: string; label: string }[] = [
  { code: '', label: 'ทั้งหมด' }, { code: 'CAMERA', label: '📷 กล้อง' }, { code: 'LENS', label: 'เลนส์' },
  { code: 'AUDIO', label: '🎙️ เสียง' }, { code: 'LIGHTING', label: '💡 ไฟ' }, { code: 'GRIP_SUPPORT', label: 'ขาตั้ง/กริป' },
  { code: 'POWER', label: 'แบต/ไฟ' }, { code: 'STORAGE_MEDIA', label: 'การ์ด/สตอเรจ' },
]

export default function EquipmentRequest({ bookingId, myEmail }: { bookingId: string; myEmail: string }) {
  const [requests, setRequests] = useState<Loan[]>([])
  const [available, setAvailable] = useState<Eq[]>([])
  const [picking, setPicking] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadRequests = useCallback(async () => {
    const r = await fetch(`/api/bookings/${bookingId}/equipment-request`)
    const j = await r.json().catch(() => ({}))
    if (r.ok) setRequests(j.requests || [])
  }, [bookingId])

  const loadAvailable = useCallback(async () => {
    const p = new URLSearchParams()
    if (search.trim()) p.set('q', search.trim())
    if (category) p.set('category', category)
    const r = await fetch(`/api/bookings/${bookingId}/equipment-request?${p}`)
    const j = await r.json().catch(() => ({}))
    if (r.ok) setAvailable(j.available || [])
  }, [bookingId, search, category])

  useEffect(() => { loadRequests() }, [loadRequests])
  useEffect(() => { if (picking) loadAvailable() }, [picking, loadAvailable])

  const toggle = (id: string) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const submit = async () => {
    if (selected.size === 0) return
    setBusy(true); setError('')
    try {
      const r = await fetch(`/api/bookings/${bookingId}/equipment-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ equipmentIds: Array.from(selected) }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setSelected(new Set()); setPicking(false); await loadRequests()
    } catch (e: any) { setError(e?.message || String(e)) } finally { setBusy(false) }
  }

  const cancel = async (loanId: string) => {
    if (!confirm('ยกเลิกคำขอเบิกนี้?')) return
    setError('')
    const r = await fetch(`/api/bookings/${bookingId}/equipment-request?loanId=${loanId}`, { method: 'DELETE' })
    if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.error || 'ยกเลิกไม่สำเร็จ'); return }
    await loadRequests()
  }

  return (
    <div className="gf-card p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-gray-500 font-medium uppercase tracking-wide">🎒 เบิกอุปกรณ์</div>
        {!picking && (
          <button onClick={() => setPicking(true)} className="text-sm px-3 py-1.5 rounded bg-[#673ab7] text-white hover:bg-[#5e35b1]">+ เบิกอุปกรณ์</button>
        )}
      </div>

      {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1 mb-2">{error}</div>}

      {/* current requests */}
      {requests.length === 0 && !picking && <div className="text-sm text-gray-400">ยังไม่ได้เบิกอุปกรณ์สำหรับงานนี้</div>}
      <div className="space-y-2">
        {requests.map(l => {
          const st = STATUS[l.status] || STATUS.REQUESTED
          return (
            <div key={l.id} className="border border-gray-100 rounded px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className={`text-[11px] px-1.5 py-0.5 rounded border ${st.cls}`}>{st.th}</span>
                <span className="text-xs text-gray-400">{l.photographer} · {l.items.length} ชิ้น</span>
                {l.status === 'REQUESTED' && (l.email || '').toLowerCase() === myEmail.toLowerCase() && (
                  <button onClick={() => cancel(l.id)} className="text-xs text-red-500 hover:text-red-700 ml-auto">ยกเลิก</button>
                )}
              </div>
              <div className="text-xs text-gray-600 mt-1">{l.items.map(i => i.equipment?.name || i.nameSnapshot).join(', ')}</div>
            </div>
          )
        })}
      </div>

      {/* picker */}
      {picking && (
        <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
          <div className="flex gap-2 flex-wrap items-center">
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหาอุปกรณ์ / serial"
              className="border border-gray-300 rounded px-2 py-1 text-sm flex-1 min-w-[160px]" />
          </div>
          <div className="flex gap-1 flex-wrap">
            {CATS.map(c => (
              <button key={c.code} onClick={() => setCategory(c.code)}
                className={`text-[11px] px-2 py-0.5 rounded-full border ${category === c.code ? 'bg-[#673ab7] text-white border-[#673ab7]' : 'border-gray-300 text-gray-600'}`}>{c.label}</button>
            ))}
          </div>
          <div className="max-h-64 overflow-y-auto border border-gray-100 rounded divide-y divide-gray-100">
            {available.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-gray-400">ไม่มีอุปกรณ์ว่างตรงเงื่อนไข</div>
            ) : available.map(e => (
              <label key={e.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 cursor-pointer">
                <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} className="accent-[#673ab7]" />
                <span className="flex-1 text-gray-700">{e.name}</span>
                {e.serialNumber && <span className="text-[10px] text-gray-400">{e.serialNumber}</span>}
                <span className="text-[10px] text-gray-400">{e.category}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={submit} disabled={busy || selected.size === 0} className="text-sm px-3 py-1.5 rounded bg-[#673ab7] text-white hover:bg-[#5e35b1] disabled:opacity-50">
              ส่งคำขอเบิก ({selected.size})
            </button>
            <button onClick={() => { setPicking(false); setSelected(new Set()) }} className="text-sm px-3 py-1.5 text-gray-500 hover:text-gray-700">ยกเลิก</button>
            <span className="text-[11px] text-gray-400 ml-auto">เบิกแล้วผู้ดูแลอุปกรณ์จะเช็คเอาท์ให้</span>
          </div>
        </div>
      )}
    </div>
  )
}
