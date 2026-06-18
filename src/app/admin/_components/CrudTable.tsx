'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus, Loader2, AlertCircle, Pencil, Trash2, X } from 'lucide-react'

/* =============================================================================
   CrudTable — config-driven list + create/edit/delete for the workspace admin
   pages (vendors / equipment / rentals / purchases / repairs). One component so
   the five near-identical pages don't get copy-pasted five times. Loans has its
   own page (nested items), so it does NOT use this.
   ============================================================================= */

export type FieldType = 'text' | 'number' | 'date' | 'textarea' | 'select' | 'checkbox'

export interface CrudField {
  key: string
  label: string
  type?: FieldType
  required?: boolean
  options?: { value: string; label: string }[] // for select (static, e.g. enums)
  optionsFrom?: string // endpoint returning { <plural>: [...] }; mapped via optionMap
  optionsKey?: string // response array key (e.g. 'vendors')
  optionMap?: (row: any) => { value: string; label: string }
  placeholder?: string
  half?: boolean // render at half width in the form grid
}

export interface CrudColumn {
  key: string
  label: string
  render?: (row: any) => React.ReactNode
  align?: 'right'
}

export interface CrudFilter {
  key: string
  label: string
  options: { value: string; label: string }[]
}

export interface CrudConfig {
  endpoint: string // e.g. /api/admin/vendors
  responseKey: string // array key in GET response, e.g. 'vendors'
  title: string
  subtitle?: string
  columns: CrudColumn[]
  fields: CrudField[]
  filters?: CrudFilter[]
  addLabel?: string
  rowKey?: string // default 'id'
}

export default function CrudTable({ config }: { config: CrudConfig }) {
  const rowKey = config.rowKey || 'id'
  const [rows, setRows] = useState<any[] | null>(null)
  const [error, setError] = useState('')
  const [filterVals, setFilterVals] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<'new' | any | null>(null)
  const [draft, setDraft] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState(false)
  const [optionCache, setOptionCache] = useState<Record<string, { value: string; label: string }[]>>({})

  const qs = new URLSearchParams(
    Object.entries(filterVals).filter(([, v]) => v && v !== 'all') as [string, string][],
  ).toString()

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch(`${config.endpoint}${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setRows(json[config.responseKey] || [])
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }, [config.endpoint, config.responseKey, qs])

  useEffect(() => { load() }, [load])

  // Load dynamic select options (vendors, outlets, …) once each.
  useEffect(() => {
    for (const f of config.fields) {
      if (!f.optionsFrom || optionCache[f.key]) continue
      fetch(f.optionsFrom, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => {
          const arr = j[f.optionsKey || 'items'] || []
          const map = f.optionMap || ((row: any) => ({ value: row.id, label: row.name }))
          setOptionCache((c) => ({ ...c, [f.key]: arr.map(map) }))
        })
        .catch(() => {})
    }
  }, [config.fields, optionCache])

  const beginNew = () => {
    const d: Record<string, any> = {}
    for (const f of config.fields) d[f.key] = f.type === 'checkbox' ? false : ''
    setDraft(d)
    setEditing('new')
  }
  const beginEdit = (row: any) => {
    const d: Record<string, any> = {}
    for (const f of config.fields) {
      const v = row[f.key]
      d[f.key] = f.type === 'date' && v ? String(v).slice(0, 10) : v ?? (f.type === 'checkbox' ? false : '')
    }
    setDraft(d)
    setEditing(row)
  }
  const close = () => { setEditing(null); setDraft({}) }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const isNew = editing === 'new'
      const url = isNew ? config.endpoint : `${config.endpoint}/${editing[rowKey]}`
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      close()
      await load()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row: any) => {
    if (!confirm('ลบรายการนี้?')) return
    setError('')
    try {
      const res = await fetch(`${config.endpoint}/${row[rowKey]}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      await load()
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  const fieldOptions = (f: CrudField) => f.options || optionCache[f.key] || []

  return (
    <div className="max-w-[1400px] mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3">
        <ArrowLeft className="w-4 h-4" /> Admin Console
      </Link>

      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-normal text-gray-800">{config.title}</h1>
          {config.subtitle && <p className="text-xs sm:text-sm text-gray-500 mt-0.5">{config.subtitle}</p>}
        </div>
        <button onClick={beginNew} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#673ab7] text-white rounded hover:bg-[#5e35b1]">
          <Plus className="w-4 h-4" /> {config.addLabel || 'เพิ่ม'}
        </button>
      </div>

      {config.filters && config.filters.length > 0 && (
        <div className="flex items-center gap-3 mb-3 flex-wrap text-sm">
          {config.filters.map((flt) => (
            <label key={flt.key} className="flex items-center gap-1.5">
              <span className="text-gray-500 text-xs">{flt.label}</span>
              <select
                className="border border-gray-300 rounded px-2 py-1 text-sm"
                value={filterVals[flt.key] || ''}
                onChange={(e) => setFilterVals((v) => ({ ...v, [flt.key]: e.target.value }))}
              >
                {flt.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}

      {error && (
        <div className="mb-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {rows === null ? (
        <div className="py-12 text-center text-gray-400"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
      ) : rows.length === 0 ? (
        <div className="py-12 text-center text-gray-400 text-sm">ยังไม่มีข้อมูล</div>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                {config.columns.map((c) => (
                  <th key={c.key} className={`px-3 py-2 text-left font-medium ${c.align === 'right' ? 'text-right' : ''}`}>{c.label}</th>
                ))}
                <th className="px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row[rowKey]} className="border-t border-gray-100 hover:bg-gray-50">
                  {config.columns.map((c) => (
                    <td key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                      {c.render ? c.render(row) : (row[c.key] ?? '—')}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button onClick={() => beginEdit(row)} className="text-gray-400 hover:text-[#673ab7] p-1" title="แก้ไข"><Pencil className="w-3.5 h-3.5" /></button>
                    <button onClick={() => remove(row)} className="text-gray-400 hover:text-red-600 p-1" title="ลบ"><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / edit modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-start sm:items-center justify-center p-3 overflow-y-auto" onClick={close}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg my-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <h2 className="text-sm font-medium text-gray-800">{editing === 'new' ? `${config.addLabel || 'เพิ่ม'}` : 'แก้ไข'}</h2>
              <button onClick={close} className="text-gray-400 hover:text-gray-700"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 grid grid-cols-2 gap-3">
              {config.fields.map((f) => (
                <div key={f.key} className={f.half ? 'col-span-1' : 'col-span-2'}>
                  <label className="text-xs text-gray-500 mb-1 block">{f.label}{f.required && <span className="text-red-500"> *</span>}</label>
                  {f.type === 'textarea' ? (
                    <textarea className="gf-input resize-none w-full" rows={3} value={draft[f.key] ?? ''} placeholder={f.placeholder}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />
                  ) : f.type === 'select' ? (
                    <select className="gf-input w-full" value={draft[f.key] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}>
                      <option value="">—</option>
                      {/* Show the current value even when it isn't an offered option
                          (e.g. a system-derived Equipment.status like ON_LOAN) so the
                          field never renders blank; disabled = can't be set by hand. */}
                      {draft[f.key] && !fieldOptions(f).some((o) => o.value === draft[f.key]) && (
                        <option value={draft[f.key]} disabled>{draft[f.key]} (ระบบจัดการ)</option>
                      )}
                      {fieldOptions(f).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : f.type === 'checkbox' ? (
                    <label className="flex items-center gap-2 h-[38px]">
                      <input type="checkbox" className="accent-[#673ab7]" checked={!!draft[f.key]} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.checked }))} />
                      <span className="text-sm text-gray-600">{f.placeholder || 'ใช่'}</span>
                    </label>
                  ) : (
                    <input
                      className="gf-input w-full"
                      type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                      value={draft[f.key] ?? ''}
                      placeholder={f.placeholder}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-100">
              <button onClick={close} className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">ยกเลิก</button>
              <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#673ab7] text-white rounded hover:bg-[#5e35b1] disabled:opacity-50">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />} บันทึก
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Shared money formatter for column renderers.
export function baht(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  return Number.isFinite(n) ? n.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : String(v)
}

export function ymd(v: unknown): string {
  if (!v) return '—'
  try { return new Date(v as string).toISOString().slice(0, 10) } catch { return '—' }
}
