'use client'

import { useRef, useState } from 'react'
import { Paperclip, Upload, Loader2, X, ExternalLink, Trash2, FileText } from 'lucide-react'

/* DocsCell — per-row document attachments stored in Google Drive (organized
   into one folder per job by the API). Drop it in a table cell with the owner's
   type + id; it seeds its count from the row's `documents` and manages its own
   upload/list/delete so the parent table doesn't need to reload. */

export type DocOwner = 'rental' | 'purchase' | 'repair' | 'loan'

export interface DocRef {
  id: string
  kind: string
  fileName: string
  driveUrl?: string | null
  driveFileId?: string | null
}

// DocKind enum → Thai label, in the order people file paperwork.
const KINDS: { value: string; label: string }[] = [
  { value: 'QUOTATION', label: 'ใบเสนอราคา' },
  { value: 'INVOICE', label: 'ใบแจ้งหนี้' },
  { value: 'TAX_INVOICE', label: 'ใบกำกับภาษี' },
  { value: 'TRANSFER_RECEIPT', label: 'สลิปโอน' },
  { value: 'RECEIPT', label: 'ใบเสร็จ' },
  { value: 'OTHER', label: 'อื่นๆ' },
]
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label || k

export default function DocsCell({ ownerType, ownerId, initial }: { ownerType: DocOwner; ownerId: string; initial?: DocRef[] }) {
  const [open, setOpen] = useState(false)
  const [docs, setDocs] = useState<DocRef[]>(initial || [])
  const [kind, setKind] = useState('QUOTATION')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const upload = async (file: File) => {
    setBusy(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('ownerType', ownerType)
      fd.append('ownerId', ownerId)
      fd.append('kind', kind)
      const res = await fetch('/api/admin/documents', { method: 'POST', body: fd })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setDocs((d) => [json.document, ...d])
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const remove = async (id: string) => {
    if (!confirm('ลบเอกสารนี้ (ลบไฟล์ใน Drive ด้วย)?')) return
    setError('')
    try {
      const res = await fetch(`/api/admin/documents?id=${id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setDocs((d) => d.filter((x) => x.id !== id))
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="เอกสารแนบ"
        className={`inline-flex items-center gap-1 text-xs rounded px-1.5 py-0.5 ${docs.length ? 'text-[#673ab7] hover:bg-purple-50' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'}`}
      >
        <Paperclip className="w-3.5 h-3.5" />
        {docs.length > 0 && <span className="tabular-nums">{docs.length}</span>}
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-start sm:items-center justify-center p-3 overflow-y-auto" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md my-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <h2 className="text-sm font-medium text-gray-800 flex items-center gap-1.5"><FileText className="w-4 h-4" /> เอกสารแนบ</h2>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700"><X className="w-4 h-4" /></button>
            </div>

            <div className="p-4 space-y-3">
              {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

              {/* Upload row */}
              <div className="flex items-center gap-2">
                <select value={kind} onChange={(e) => setKind(e.target.value)} className="border border-gray-300 rounded px-2 py-1.5 text-sm">
                  {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#673ab7] text-white rounded hover:bg-[#5e35b1] disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} อัปโหลด
                </button>
              </div>
              <p className="text-[11px] text-gray-400">เก็บใน Google Drive แยกโฟลเดอร์ตามงานให้อัตโนมัติ · ไฟล์ละไม่เกิน 25MB</p>

              {/* List */}
              {docs.length === 0 ? (
                <div className="py-6 text-center text-gray-400 text-sm">ยังไม่มีเอกสาร</div>
              ) : (
                <ul className="divide-y divide-gray-100 border border-gray-100 rounded">
                  {docs.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <span className="text-[10px] shrink-0 px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{kindLabel(d.kind)}</span>
                      <span className="flex-1 truncate text-gray-700" title={d.fileName}>{d.fileName}</span>
                      {d.driveUrl && (
                        <a href={d.driveUrl} target="_blank" rel="noreferrer" className="text-gray-400 hover:text-[#673ab7] p-1" title="เปิดใน Drive"><ExternalLink className="w-3.5 h-3.5" /></a>
                      )}
                      <button onClick={() => remove(d.id)} className="text-gray-400 hover:text-red-600 p-1" title="ลบ"><Trash2 className="w-3.5 h-3.5" /></button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
