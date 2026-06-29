'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge, PURCHASE_STATUS as PURCHASE_BADGE } from '../_components/badges'
import DocsCell, { type DocRef } from '../_components/DocsCell'

type Item = {
  id: string
  item: string
  purchaseDate: string | null
  quantity: number
  vendor: { id: string; name: string } | null
  vendorId?: string | null
  productLink: string | null
  unitPrice: number | null
  total: number | null
  kind: string | null
  remark: string | null
  documents: DocRef[]
}
type Batch = {
  id: string
  month: string
  ownerEmail: string
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'
  rejectionNote: string | null
  driveFolderUrl: string | null
  approvedByEmail: string | null
  items: Item[]
  grandTotal: number
  itemCount: number
}
type Vendor = { id: string; name: string }

const baht = (n: number | null | undefined) =>
  n == null ? '—' : `฿${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function bangkokMonth(): string {
  // 'en-CA' gives YYYY-MM-DD; slice to YYYY-MM. Asia/Bangkok matches the server.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date()).slice(0, 7)
}

const EMPTY_FORM = { item: '', purchaseDate: '', quantity: '1', vendorId: '', unitPrice: '', total: '', kind: '', productLink: '', remark: '' }

export default function PurchasesClient({ currentEmail, isApprover }: { currentEmail: string; isApprover: boolean }) {
  const [month, setMonth] = useState(bangkokMonth())
  const [batch, setBatch] = useState<Batch | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const editable = !batch || batch.status === 'DRAFT' || batch.status === 'REJECTED'

  const loadMonth = useCallback(async (m: string) => {
    const res = await fetch(`/api/admin/purchases?month=${m}`)
    const json = await res.json()
    setBatch(json.batch || null)
  }, [])
  const loadOverview = useCallback(async () => {
    const res = await fetch('/api/admin/purchases')
    const json = await res.json()
    setBatches(json.batches || [])
  }, [])

  useEffect(() => { loadMonth(month) }, [month, loadMonth])
  useEffect(() => {
    loadOverview()
    fetch('/api/admin/vendors').then(r => r.json()).then(j => setVendors(j.vendors || [])).catch(() => {})
  }, [loadOverview])

  const refresh = async () => { await Promise.all([loadMonth(month), loadOverview()]) }

  const resetForm = () => { setForm({ ...EMPTY_FORM }); setEditingId(null) }

  const saveItem = async () => {
    setError(''); setBusy(true)
    try {
      const body: Record<string, unknown> = {
        month, item: form.item,
        purchaseDate: form.purchaseDate || null,
        quantity: form.quantity ? Number(form.quantity) : 1,
        vendorId: form.vendorId || null,
        unitPrice: form.unitPrice ? Number(form.unitPrice) : null,
        total: form.total ? Number(form.total) : null,
        kind: form.kind || null, productLink: form.productLink || null, remark: form.remark || null,
      }
      const url = editingId ? `/api/admin/purchases/${editingId}` : '/api/admin/purchases'
      const res = await fetch(url, { method: editingId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      resetForm(); await refresh()
    } catch (e: any) { setError(e?.message || String(e)) } finally { setBusy(false) }
  }

  const beginEdit = (it: Item) => {
    setEditingId(it.id)
    setForm({
      item: it.item, purchaseDate: it.purchaseDate ? it.purchaseDate.slice(0, 10) : '',
      quantity: String(it.quantity), vendorId: it.vendor?.id || '',
      unitPrice: it.unitPrice != null ? String(it.unitPrice) : '', total: it.total != null ? String(it.total) : '',
      kind: it.kind || '', productLink: it.productLink || '', remark: it.remark || '',
    })
  }

  const deleteItem = async (id: string) => {
    if (!confirm('ลบรายการนี้?')) return
    setError('')
    const res = await fetch(`/api/admin/purchases/${id}`, { method: 'DELETE' })
    if (!res.ok) { const j = await res.json().catch(() => ({})); setError(j.error || 'ลบไม่สำเร็จ'); return }
    await refresh()
  }

  const batchAction = async (payload: Record<string, unknown>, confirmMsg?: string) => {
    if (confirmMsg && !confirm(confirmMsg)) return
    setError(''); setBusy(true)
    try {
      const res = await fetch('/api/admin/purchases/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      if (payload.action === 'sync-folder' && json.driveFolderUrl) window.open(json.driveFolderUrl, '_blank')
      await refresh()
      return json
    } catch (e: any) { setError(e?.message || String(e)) } finally { setBusy(false) }
  }

  const submit = () => batchAction({ action: 'submit', month }, `ส่งรายการจัดซื้อเดือน ${month} ให้ Manager อนุมัติ?`)
  const syncFolder = () => batchAction({ action: 'sync-folder', month })
  const approve = (batchId: string, m: string) => batchAction({ action: 'approve', batchId }, `อนุมัติรายการเดือน ${m}?`)
  const reject = (batchId: string) => {
    const note = prompt('เหตุผลที่ไม่อนุมัติ:')
    if (note == null || !note.trim()) return
    batchAction({ action: 'reject', batchId, note: note.trim() })
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-medium text-gray-800">จัดซื้อรายเดือน · Purchases</h1>
          <p className="text-sm text-gray-500">เพิ่มรายการ → แนบใบเสร็จ → ส่งให้ Manager อนุมัติ</p>
        </div>
        <label className="text-sm text-gray-600 flex items-center gap-2">
          เดือน
          <input type="month" value={month} onChange={e => setMonth(e.target.value)} className="gf-input" />
        </label>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {/* Month summary + actions */}
      <div className="border border-gray-200 rounded-lg p-4 bg-white flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-4">
          <Badge map={PURCHASE_BADGE} value={batch?.status || 'DRAFT'} />
          <div className="text-sm text-gray-600">{batch?.itemCount || 0} รายการ</div>
          <div className="text-lg font-semibold tabular-nums text-gray-800">{baht(batch?.grandTotal ?? 0)}</div>
        </div>
        <div className="flex items-center gap-2">
          {batch?.driveFolderUrl && <a href={batch.driveFolderUrl} target="_blank" rel="noreferrer" className="text-sm inline-flex items-center px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">📁 โฟลเดอร์</a>}
          {editable && batch && batch.itemCount > 0 && (
            <>
              <button onClick={syncFolder} disabled={busy} className="text-sm inline-flex items-center px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">📁 สร้างโฟลเดอร์ Drive</button>
              <button onClick={submit} disabled={busy} className="text-sm inline-flex items-center px-3 py-1.5 rounded bg-[#673ab7] text-white hover:bg-[#5e35b1] disabled:opacity-50">ส่งให้ Manager อนุมัติ</button>
            </>
          )}
        </div>
      </div>

      {batch?.status === 'REJECTED' && batch.rejectionNote && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          ไม่อนุมัติ — {batch.rejectionNote} <span className="text-red-500">(แก้ไขแล้วส่งใหม่ได้)</span>
        </div>
      )}
      {batch?.status === 'APPROVED' && (
        <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
          อนุมัติแล้ว{batch.approvedByEmail ? ` โดย ${batch.approvedByEmail}` : ''} — เดือนนี้ปิดแล้ว
        </div>
      )}

      {/* Items table */}
      <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-left px-3 py-2">วันที่</th>
              <th className="text-left px-3 py-2">รายการ</th>
              <th className="text-right px-3 py-2">จำนวน</th>
              <th className="text-left px-3 py-2">ซื้อจาก</th>
              <th className="text-right px-3 py-2">รวม</th>
              <th className="text-left px-3 py-2">ใบเสร็จ</th>
              {editable && <th className="px-3 py-2"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(batch?.items || []).map(it => (
              <tr key={it.id} className="hover:bg-gray-50">
                <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{it.purchaseDate ? it.purchaseDate.slice(0, 10) : '—'}</td>
                <td className="px-3 py-2">
                  <div className="text-gray-800">{it.item}</div>
                  {it.productLink && <a href={it.productLink} target="_blank" rel="noreferrer" className="text-xs text-[#673ab7] hover:underline">ลิงก์สินค้า</a>}
                  {it.kind && <span className="text-xs text-gray-400 ml-2">{it.kind}</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{it.quantity}</td>
                <td className="px-3 py-2 text-gray-600">{it.vendor?.name || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{baht(it.total ?? (it.unitPrice != null ? it.unitPrice * it.quantity : null))}</td>
                <td className="px-3 py-2"><DocsCell ownerType="purchase" ownerId={it.id} initial={it.documents} readOnly={!editable} /></td>
                {editable && (
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    <button onClick={() => beginEdit(it)} className="text-xs text-gray-500 hover:text-gray-800 mr-2">แก้</button>
                    <button onClick={() => deleteItem(it.id)} className="text-xs text-red-500 hover:text-red-700">ลบ</button>
                  </td>
                )}
              </tr>
            ))}
            {(!batch || batch.items.length === 0) && (
              <tr><td colSpan={editable ? 7 : 6} className="px-3 py-6 text-center text-gray-400">ยังไม่มีรายการในเดือนนี้</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add / edit form */}
      {editable && (
        <div className="border border-gray-200 rounded-lg p-4 bg-white space-y-3">
          <div className="text-sm font-medium text-gray-700">{editingId ? 'แก้ไขรายการ' : 'เพิ่มรายการ'}</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <input className="gf-input col-span-2" placeholder="รายการ *" value={form.item} onChange={e => setForm({ ...form, item: e.target.value })} />
            <input className="gf-input" type="date" value={form.purchaseDate} onChange={e => setForm({ ...form, purchaseDate: e.target.value })} />
            <input className="gf-input" type="number" min="1" placeholder="จำนวน" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} />
            <select className="gf-input col-span-2" value={form.vendorId} onChange={e => setForm({ ...form, vendorId: e.target.value })}>
              <option value="">— ซื้อจาก (vendor) —</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <input className="gf-input" type="number" placeholder="ราคา/หน่วย" value={form.unitPrice} onChange={e => setForm({ ...form, unitPrice: e.target.value })} />
            <input className="gf-input" type="number" placeholder="ราคารวม (ถ้าไม่ใส่ = จำนวน×ราคา)" value={form.total} onChange={e => setForm({ ...form, total: e.target.value })} />
            <input className="gf-input" placeholder="ประเภท (ADD/REPLACE/FIX)" value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })} />
            <input className="gf-input col-span-3" placeholder="ลิงก์สินค้า" value={form.productLink} onChange={e => setForm({ ...form, productLink: e.target.value })} />
            <input className="gf-input col-span-4" placeholder="หมายเหตุ" value={form.remark} onChange={e => setForm({ ...form, remark: e.target.value })} />
          </div>
          <div className="flex items-center gap-2">
            <button onClick={saveItem} disabled={busy || !form.item.trim()} className="text-sm inline-flex items-center px-3 py-1.5 rounded bg-[#673ab7] text-white hover:bg-[#5e35b1] disabled:opacity-50">{editingId ? 'บันทึก' : '+ เพิ่มรายการ'}</button>
            {editingId && <button onClick={resetForm} className="text-sm inline-flex items-center px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">ยกเลิก</button>}
          </div>
        </div>
      )}

      {/* All months overview */}
      <div>
        <h2 className="text-sm font-medium text-gray-700 mb-2">ทุกเดือน</h2>
        <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="text-left px-3 py-2">เดือน</th>
                <th className="text-left px-3 py-2">ผู้ซื้อ</th>
                <th className="text-right px-3 py-2">รายการ</th>
                <th className="text-right px-3 py-2">รวม</th>
                <th className="text-left px-3 py-2">สถานะ</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {batches.map(b => (
                <tr key={b.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <button onClick={() => b.ownerEmail === currentEmail && setMonth(b.month)} className={b.ownerEmail === currentEmail ? 'text-[#673ab7] hover:underline' : ''}>{b.month}</button>
                  </td>
                  <td className="px-3 py-2 text-gray-600">{b.ownerEmail === currentEmail ? 'ฉัน' : b.ownerEmail}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{b.itemCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{baht(b.grandTotal)}</td>
                  <td className="px-3 py-2"><Badge map={PURCHASE_BADGE} value={b.status} /></td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    {b.driveFolderUrl && <a href={b.driveFolderUrl} target="_blank" rel="noreferrer" className="text-xs text-[#673ab7] hover:underline mr-3">📁</a>}
                    {isApprover && b.status === 'SUBMITTED' && b.ownerEmail !== currentEmail && (
                      <>
                        <button onClick={() => approve(b.id, b.month)} disabled={busy} className="text-xs text-green-600 hover:text-green-800 mr-2">อนุมัติ</button>
                        <button onClick={() => reject(b.id)} disabled={busy} className="text-xs text-red-500 hover:text-red-700">ไม่อนุมัติ</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {batches.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">ยังไม่มีข้อมูล</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
