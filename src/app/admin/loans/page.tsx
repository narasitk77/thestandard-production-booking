'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus, Loader2, AlertCircle, X, RotateCcw } from 'lucide-react'

/* /admin/loans — equipment checkout. Read-heavy (loans mostly arrive via import
   / the external generator); this page lists them, lets you check out new gear,
   and mark a loan returned (which frees its equipment back to AVAILABLE). */

type Item = { id: string; nameSnapshot: string; tagSnapshot?: string | null; equipment?: { name: string } | null }
type Loan = {
  id: string; loanCode: string; photographer: string; email?: string | null; jobName?: string | null
  dueDate?: string | null; returnedAt?: string | null; status: string; items: Item[]
}

const ymd = (v: unknown) => (v ? String(v).slice(0, 10) : '—')

export default function LoansPage() {
  const [loans, setLoans] = useState<Loan[] | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('ACTIVE')
  const [busy, setBusy] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState({ photographer: '', email: '', jobName: '', dueDate: '', items: '' })

  const load = useCallback(async () => {
    setError('')
    try {
      const q = filter === 'all' ? '' : `?status=${filter}`
      const res = await fetch(`/api/admin/loans${q}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setLoans(json.loans || [])
    } catch (e: any) { setError(e?.message || String(e)) }
  }, [filter])

  useEffect(() => { load() }, [load])

  const markReturned = async (id: string) => {
    setBusy(id); setError('')
    try {
      const res = await fetch(`/api/admin/loans/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'RETURNED' }) })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      await load()
    } catch (e: any) { setError(e?.message || String(e)) } finally { setBusy(null) }
  }

  const create = async () => {
    setSaving(true); setError('')
    try {
      // items: one per line, "name | tag"
      const items = draft.items.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, tag] = l.split('|').map((s) => s.trim())
        return { nameSnapshot: name, tagSnapshot: tag || null }
      })
      const res = await fetch('/api/admin/loans', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photographer: draft.photographer, email: draft.email, jobName: draft.jobName, dueDate: draft.dueDate, items }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setAdding(false)
      setDraft({ photographer: '', email: '', jobName: '', dueDate: '', items: '' })
      await load()
    } catch (e: any) { setError(e?.message || String(e)) } finally { setSaving(false) }
  }

  const rows = loans || []

  return (
    <div className="max-w-[1200px] mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3"><ArrowLeft className="w-4 h-4" /> Admin Console</Link>
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-normal text-gray-800">Equipment Loans</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-0.5">การยืม-คืนอุปกรณ์ · กดคืนแล้วเพื่อปล่อยอุปกรณ์กลับเป็นว่าง</p>
        </div>
        <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#673ab7] text-white rounded hover:bg-[#5e35b1]"><Plus className="w-4 h-4" /> ยืมอุปกรณ์</button>
      </div>

      <div className="flex items-center gap-2 mb-3 text-sm">
        {['ACTIVE', 'RETURNED', 'all'].map((s) => (
          <button key={s} onClick={() => setFilter(s)} className={`px-2.5 py-1 rounded border ${filter === s ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-300 hover:bg-gray-50'}`}>{s === 'all' ? 'ทั้งหมด' : s}</button>
        ))}
      </div>

      {error && <div className="mb-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-center gap-1.5"><AlertCircle className="w-4 h-4" /> {error}</div>}

      {loans === null ? (
        <div className="py-12 text-center text-gray-400"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
      ) : rows.length === 0 ? (
        <div className="py-12 text-center text-gray-400 text-sm">ไม่มีรายการ</div>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="px-3 py-2 text-left font-medium">รหัส</th>
                <th className="px-3 py-2 text-left font-medium">ผู้ยืม</th>
                <th className="px-3 py-2 text-left font-medium">งาน</th>
                <th className="px-3 py-2 text-left font-medium">อุปกรณ์</th>
                <th className="px-3 py-2 text-left font-medium">กำหนดคืน</th>
                <th className="px-3 py-2 text-left font-medium">สถานะ</th>
                <th className="px-3 py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className="border-t border-gray-100 hover:bg-gray-50 align-top">
                  <td className="px-3 py-2 font-mono text-xs">{l.loanCode}</td>
                  <td className="px-3 py-2">{l.photographer}</td>
                  <td className="px-3 py-2">{l.jobName || '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{l.items.map((it) => it.equipment?.name || it.nameSnapshot).join(', ')}</td>
                  <td className="px-3 py-2">{ymd(l.dueDate)}</td>
                  <td className="px-3 py-2">{l.status === 'RETURNED' ? <span className="text-gray-400">คืนแล้ว {ymd(l.returnedAt)}</span> : <span className="text-amber-700">ยืมอยู่</span>}</td>
                  <td className="px-3 py-2 text-right">
                    {l.status === 'ACTIVE' && (
                      <button onClick={() => markReturned(l.id)} disabled={busy === l.id} className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-green-300 text-green-700 rounded hover:bg-green-50 disabled:opacity-50">
                        <RotateCcw className="w-3.5 h-3.5" /> คืนแล้ว
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-start sm:items-center justify-center p-3 overflow-y-auto" onClick={() => setAdding(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg my-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <h2 className="text-sm font-medium text-gray-800">ยืมอุปกรณ์</h2>
              <button onClick={() => setAdding(false)} className="text-gray-400 hover:text-gray-700"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs text-gray-500 mb-1 block">ผู้ยืม *</label><input className="gf-input w-full" value={draft.photographer} onChange={(e) => setDraft({ ...draft, photographer: e.target.value })} /></div>
                <div><label className="text-xs text-gray-500 mb-1 block">อีเมล</label><input className="gf-input w-full" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></div>
                <div><label className="text-xs text-gray-500 mb-1 block">งาน</label><input className="gf-input w-full" value={draft.jobName} onChange={(e) => setDraft({ ...draft, jobName: e.target.value })} /></div>
                <div><label className="text-xs text-gray-500 mb-1 block">กำหนดคืน</label><input type="date" className="gf-input w-full" value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} /></div>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">อุปกรณ์ (บรรทัดละชิ้น — "ชื่อ | tag") · พิมพ์ tag/ชื่อให้ตรงคลัง ระบบจะผูกสถานะ ON_LOAN ให้อัตโนมัติ</label>
                <textarea className="gf-input resize-none w-full font-mono text-xs" rows={5} placeholder={'Sony FX3 No.1 | 25T&E-0026\nSony 24-70 GM | 25T&E-0029'} value={draft.items} onChange={(e) => setDraft({ ...draft, items: e.target.value })} />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-100">
              <button onClick={() => setAdding(false)} className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">ยกเลิก</button>
              <button onClick={create} disabled={saving || !draft.photographer || !draft.items.trim()} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#673ab7] text-white rounded hover:bg-[#5e35b1] disabled:opacity-50">{saving && <Loader2 className="w-4 h-4 animate-spin" />} บันทึก</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
