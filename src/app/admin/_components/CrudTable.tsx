'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus, Loader2, AlertCircle, Pencil, Trash2, X, Search, ChevronUp, ChevronDown, ChevronsUpDown, RotateCcw } from 'lucide-react'
import DocsCell, { type DocOwner } from './DocsCell'

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
  sortable?: boolean // default true; set false for action/link-only columns
  sortValue?: (row: any) => string | number // custom sort key (else row[key])
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
  search?: boolean // render a text-search box that sends ?q= (endpoint must support it)
  docsOwnerType?: DocOwner // show a Drive document-attachment cell per row (uses row.documents for count)
}

export default function CrudTable({ config }: { config: CrudConfig }) {
  const rowKey = config.rowKey || 'id'
  const [rows, setRows] = useState<any[] | null>(null)
  const [error, setError] = useState('')
  const [filterVals, setFilterVals] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<'new' | any | null>(null)
  const [draft, setDraft] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState(false)
  const [q, setQ] = useState('')
  const [qApplied, setQApplied] = useState('') // debounced — drives the fetch + client filter
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  const [optionCache, setOptionCache] = useState<Record<string, { value: string; label: string }[]>>({})

  // Seed filter + search from the URL once (so the dashboard's alert chips can
  // deep-link straight to a filtered view, e.g. /admin/rentals?payment=PENDING).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const fv: Record<string, string> = {}
    for (const f of config.filters || []) { const v = sp.get(f.key); if (v) fv[f.key] = v }
    if (Object.keys(fv).length) setFilterVals(fv)
    const qq = sp.get('q'); if (qq) { setQ(qq); setQApplied(qq) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounce the search box so we don't fetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQApplied(q), 300)
    return () => clearTimeout(t)
  }, [q])

  const params = Object.entries(filterVals).filter(([, v]) => v && v !== 'all') as [string, string][]
  // Server-side search only for endpoints that support ?q= (config.search).
  // The client-side filter below always runs, so non-q endpoints still search.
  if (config.search && qApplied.trim()) params.push(['q', qApplied.trim()])
  const qs = new URLSearchParams(params).toString()

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

  // Client-side search (across every scalar field) + column sort, applied on top
  // of whatever the server returned. Keeps filtering instant + works for every
  // module even when its API has no ?q=.
  const displayRows = useMemo(() => {
    if (!rows) return null
    let out = rows
    const term = qApplied.trim().toLowerCase()
    if (term) {
      out = out.filter((r) =>
        Object.values(r).some((v) =>
          (typeof v === 'string' || typeof v === 'number') && String(v).toLowerCase().includes(term),
        ),
      )
    }
    if (sort) {
      const col = config.columns.find((c) => c.key === sort.key)
      const val = (r: any) => (col?.sortValue ? col.sortValue(r) : r[sort.key])
      const dir = sort.dir === 'asc' ? 1 : -1
      out = [...out].sort((a, b) => {
        const av = val(a), bv = val(b)
        if (av == null && bv == null) return 0
        if (av == null) return 1 // nulls last regardless of dir
        if (bv == null) return -1
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
        return String(av).localeCompare(String(bv), 'th', { numeric: true }) * dir
      })
    }
    return out
  }, [rows, qApplied, sort, config.columns])

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }))

  const activeFilters = Object.values(filterVals).filter((v) => v && v !== 'all').length + (qApplied.trim() ? 1 : 0) + (sort ? 1 : 0)
  const clearAll = () => { setFilterVals({}); setQ(''); setQApplied(''); setSort(null) }

  return (
    <div className="max-w-[1400px] mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <Link href="/admin/production-space" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3">
        <ArrowLeft className="w-4 h-4" /> Production Admin Space
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

      <div className="flex items-center gap-3 mb-3 flex-wrap text-sm">
        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหา ชื่อ / รหัส / ทุกคอลัมน์…"
            className="border border-gray-300 rounded pl-8 pr-7 py-1 text-sm w-72"
          />
          {q && (
            <button onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700" aria-label="ล้างคำค้น">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {(config.filters || []).map((flt) => (
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
        {activeFilters > 0 && (
          <button onClick={clearAll} className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 border border-gray-200 rounded px-2 py-1">
            <RotateCcw className="w-3.5 h-3.5" /> ล้างตัวกรอง ({activeFilters})
          </button>
        )}
      </div>

      {displayRows !== null && rows !== null && (
        <div className="text-xs text-gray-400 mb-2">
          แสดง {displayRows.length.toLocaleString('th-TH')} รายการ
          {displayRows.length !== rows.length && <span> (กรองจาก {rows.length.toLocaleString('th-TH')})</span>}
          {rows.length === 1000 && <span className="text-amber-600"> · จำกัด 1000 — ค้นหาเพื่อดูที่เหลือ</span>}
        </div>
      )}

      {error && (
        <div className="mb-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {displayRows === null ? (
        <div className="py-12 text-center text-gray-400"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
      ) : (rows?.length ?? 0) === 0 ? (
        <div className="py-12 text-center text-gray-400 text-sm">ยังไม่มีข้อมูล</div>
      ) : displayRows.length === 0 ? (
        <div className="py-12 text-center text-gray-400 text-sm">
          ไม่พบรายการที่ตรงกับตัวกรอง
          <button onClick={clearAll} className="block mx-auto mt-2 text-[#673ab7] hover:underline text-xs">ล้างตัวกรอง</button>
        </div>
      ) : (
        <div className="overflow-x-auto overflow-y-auto max-h-[72vh] border border-gray-200 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs sticky top-0 z-10">
              <tr>
                {config.columns.map((c) => {
                  const sortable = c.sortable !== false
                  return (
                    <th
                      key={c.key}
                      onClick={sortable ? () => toggleSort(c.key) : undefined}
                      className={`px-3 py-2 font-medium whitespace-nowrap ${c.align === 'right' ? 'text-right' : 'text-left'} ${sortable ? 'cursor-pointer select-none hover:text-gray-800' : ''}`}
                    >
                      <span className={`inline-flex items-center gap-1 ${c.align === 'right' ? 'flex-row-reverse' : ''}`}>
                        {c.label}
                        {sortable && (sort?.key === c.key
                          ? (sort.dir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)
                          : <ChevronsUpDown className="w-3 h-3 opacity-25" />)}
                      </span>
                    </th>
                  )
                })}
                <th className={`px-3 py-2 bg-gray-50 ${config.docsOwnerType ? 'w-28' : 'w-20'}`}></th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row) => (
                <tr key={row[rowKey]} className="border-t border-gray-100 hover:bg-gray-50">
                  {config.columns.map((c) => (
                    <td key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                      {c.render ? c.render(row) : (row[c.key] ?? '—')}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {config.docsOwnerType && <DocsCell ownerType={config.docsOwnerType} ownerId={row[rowKey]} initial={row.documents} />}
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
