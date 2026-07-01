'use client'

/* =============================================================================
   /admin/workspace — v1.55.0
   The "everything" desk for coordinators: one dense, filterable, selectable,
   exportable table of every booking. Filter by freelance presence, status,
   outlet, date range, or free text; toggle any of ~35 columns; sort; select
   rows; export exactly what you see (or the full field set) to CSV.
   ============================================================================= */

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import BackButton from '@/app/_components/BackButton'
import {
  Search, X, Download, Columns3, RotateCcw,
  ChevronUp, ChevronDown, Loader2, Check, Users, Filter,
} from 'lucide-react'
import { OUTLETS } from '@/lib/data'
import { statusColor, statusLabel } from '@/lib/utils'
import { normalizeFreelancers } from '@/lib/freelancers'
import {
  WORKSPACE_COLUMNS, WORKSPACE_COLUMN_MAP, COLUMN_GROUP_ORDER,
  hasFreelancers, type WorkspaceBooking,
} from '@/lib/workspace-columns'

type Row = WorkspaceBooking & { id: string }

const STATUSES = ['REQUESTED', 'ASSIGNED', 'CONFIRMED', 'COMPLETED', 'CANCELLED'] as const
const VIS_KEY = 'probook.workspace.columns.v1'
const DENSITY_KEY = 'probook.workspace.density.v1'

export default function WorkspacePage() {
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // ── filters ───────────────────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [statusSel, setStatusSel] = useState<Set<string>>(new Set())
  const [outletSel, setOutletSel] = useState<Set<string>>(new Set())
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [freelanceOnly, setFreelanceOnly] = useState(false)
  const [unassignedOnly, setUnassignedOnly] = useState(false)
  const [routineFilter, setRoutineFilter] = useState<'all' | 'only' | 'exclude'>('all')

  // ── table state ───────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'shootDate', dir: 'desc' })
  const [visible, setVisible] = useState<Set<string>>(
    () => new Set(WORKSPACE_COLUMNS.filter(c => c.defaultVisible).map(c => c.key)),
  )
  const [dense, setDense] = useState(false)
  const [colMenu, setColMenu] = useState(false)
  const [exportMenu, setExportMenu] = useState(false)
  const [exporting, setExporting] = useState(false)
  const colMenuRef = useRef<HTMLDivElement>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)

  // ── load data + persisted prefs ─────────────────────────────────────
  useEffect(() => {
    fetch('/api/bookings?limit=500', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(d => { setRows(d.bookings || []); setTotal(d.total || 0) })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
    try {
      const v = localStorage.getItem(VIS_KEY)
      if (v) {
        const keys = JSON.parse(v) as string[]
        const valid = keys.filter(k => WORKSPACE_COLUMN_MAP[k])
        if (valid.length) setVisible(new Set(valid))
      }
      if (localStorage.getItem(DENSITY_KEY) === '1') setDense(true)
    } catch {}
  }, [])

  // close popovers on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) setColMenu(false)
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) setExportMenu(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const persistVisible = (next: Set<string>) => {
    setVisible(next)
    try { localStorage.setItem(VIS_KEY, JSON.stringify(Array.from(next))) } catch {}
  }
  const toggleDensity = () => {
    setDense(d => {
      try { localStorage.setItem(DENSITY_KEY, d ? '0' : '1') } catch {}
      return !d
    })
  }

  // ── filtering ───────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out = rows.filter(b => {
      if (statusSel.size && !statusSel.has(b.status || '')) return false
      if (outletSel.size && !outletSel.has(b.outlet?.code || '')) return false
      const day = (b.shootDate ? String(b.shootDate) : '').slice(0, 10)
      if (dateFrom && day && day < dateFrom) return false
      if (dateTo && day && day > dateTo) return false
      if (freelanceOnly && !hasFreelancers(b)) return false
      if (unassignedOnly && (b.assignedEmails || []).length > 0) return false
      if (routineFilter === 'only' && !b.isRoutine) return false
      if (routineFilter === 'exclude' && b.isRoutine) return false
      if (q) {
        const hay = [
          b.bookingCode, b.projectId, b.projectName, b.producer, b.producerEmail,
          b.director, b.directorEmail, b.mainVideographerEmail,
          b.notes, b.adminNotes, b.locationName, b.agencyRef,
          b.outlet?.name, b.program?.name,
          (b.assignedEmails || []).join(' '),
          (b.crewRequired || []).join(' '),
          (b.episodes || []).map(e => e.episodeId).join(' '),
          normalizeFreelancers(b.freelancers).map(f => `${f.name} ${f.email || ''}`).join(' '),
        ].join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })

    const col = WORKSPACE_COLUMN_MAP[sort.key]
    const dir = sort.dir === 'asc' ? 1 : -1
    out.sort((a, b) => {
      if (col?.num) return (col.num(a) - col.num(b)) * dir
      const av = col ? col.value(a) : ''
      const bv = col ? col.value(b) : ''
      return av.localeCompare(bv, 'th') * dir
    })
    return out
  }, [rows, search, statusSel, outletSel, dateFrom, dateTo, freelanceOnly, unassignedOnly, routineFilter, sort])

  const filteredIds = useMemo(() => filtered.map(r => r.id), [filtered])
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every(id => selected.has(id))
  const someFilteredSelected = filteredIds.some(id => selected.has(id))

  const visibleCols = WORKSPACE_COLUMNS.filter(c => visible.has(c.key))
  const activeFilterCount =
    (statusSel.size ? 1 : 0) + (outletSel.size ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0) + (freelanceOnly ? 1 : 0) +
    (unassignedOnly ? 1 : 0) + (search.trim() ? 1 : 0) +
    (routineFilter !== 'all' ? 1 : 0)

  // ── actions ─────────────────────────────────────────────────────────
  const toggleInSet = (set: Set<string>, key: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set)
    next.has(key) ? next.delete(key) : next.add(key)
    setter(next)
  }
  const toggleRow = (id: string) => {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelected(next)
  }
  const toggleAllFiltered = () => {
    if (allFilteredSelected) {
      const next = new Set(selected)
      filteredIds.forEach(id => next.delete(id))
      setSelected(next)
    } else {
      setSelected(new Set(Array.from(selected).concat(filteredIds)))
    }
  }
  const clearFilters = () => {
    setSearch(''); setStatusSel(new Set()); setOutletSel(new Set())
    setDateFrom(''); setDateTo(''); setFreelanceOnly(false); setUnassignedOnly(false)
    setRoutineFilter('all')
  }
  const setSortKey = (key: string) => {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })
  }

  const doExport = async (scope: 'selected' | 'filtered', cols: 'visible' | 'all') => {
    const ids = scope === 'selected'
      ? filteredIds.filter(id => selected.has(id))   // selected ∩ filtered
      : filteredIds
    if (ids.length === 0) { setError('ไม่มีแถวสำหรับ export'); return }
    const columns = (cols === 'all' ? WORKSPACE_COLUMNS : visibleCols).map(c => c.key)
    setExporting(true); setError(''); setExportMenu(false)
    try {
      const res = await fetch('/api/admin/workspace/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // send ids already in screen order + the sort so the CSV matches the table
        body: JSON.stringify({ ids, columns, sortKey: sort.key, sortDir: sort.dir }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.headers.get('Content-Disposition')?.match(/filename="(.+?)"/)?.[1] || 'workspace.csv'
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setError('Export ล้มเหลว: ' + (e?.message || e))
    } finally {
      setExporting(false)
    }
  }

  const selectedCount = filteredIds.filter(id => selected.has(id)).length
  const cellPad = dense ? 'px-2 py-1' : 'px-3 py-2'

  // ── render ──────────────────────────────────────────────────────────
  return (
    <div className="max-w-[1500px] mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <BackButton fallback="/admin" label="คิวงาน" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3" />

      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-normal text-gray-800">รายงาน</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-0.5">
            ตารางงานทั้งหมด — กรอง เลือก export · <Link href="/dashboard" className="text-[#673ab7] hover:underline">📊 ดูกราฟสรุป</Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={toggleDensity}
            className="ops-btn ops-btn-secondary ops-btn-sm" title="สลับความหนาแน่นของตาราง">
            {dense ? 'Comfortable' : 'Compact'}
          </button>

          {/* Columns picker */}
          <div className="relative" ref={colMenuRef}>
            <button onClick={() => setColMenu(o => !o)}
              className="ops-btn ops-btn-secondary ops-btn-sm inline-flex items-center gap-1">
              <Columns3 className="w-3.5 h-3.5" /> Columns
              <span className="text-gray-400">({visibleCols.length})</span>
            </button>
            {colMenu && (
              <div className="absolute right-0 mt-1 w-64 max-h-[70vh] overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg z-40 p-2">
                <div className="flex items-center justify-between px-1 pb-2 mb-1 border-b border-gray-100">
                  <span className="text-xs font-medium text-gray-500">เลือกคอลัมน์</span>
                  <div className="flex gap-2 text-[11px]">
                    <button className="text-[#673ab7] hover:underline"
                      onClick={() => persistVisible(new Set(WORKSPACE_COLUMNS.map(c => c.key)))}>ทั้งหมด</button>
                    <button className="text-gray-500 hover:underline"
                      onClick={() => persistVisible(new Set(WORKSPACE_COLUMNS.filter(c => c.defaultVisible).map(c => c.key)))}>ค่าเริ่มต้น</button>
                  </div>
                </div>
                {COLUMN_GROUP_ORDER.map(group => (
                  <div key={group} className="mb-1.5">
                    <div className="text-[10px] uppercase tracking-wide text-gray-400 px-1 mb-0.5">{group}</div>
                    {WORKSPACE_COLUMNS.filter(c => c.group === group).map(c => (
                      <label key={c.key}
                        className="flex items-center gap-2 px-1 py-1 text-[13px] text-gray-700 hover:bg-gray-50 rounded cursor-pointer">
                        <input type="checkbox" checked={visible.has(c.key)}
                          onChange={() => {
                            const next = new Set(visible)
                            next.has(c.key) ? next.delete(c.key) : next.add(c.key)
                            if (next.size === 0) return
                            persistVisible(next)
                          }} />
                        {c.label}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Export */}
          <div className="relative" ref={exportMenuRef}>
            <button onClick={() => setExportMenu(o => !o)} disabled={exporting || filtered.length === 0}
              className="ops-btn ops-btn-primary ops-btn-sm inline-flex items-center gap-1 disabled:opacity-50">
              {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              Export
            </button>
            {exportMenu && (
              <div className="absolute right-0 mt-1 w-60 bg-white border border-gray-200 rounded-lg shadow-lg z-40 p-2 text-sm">
                <div className="text-xs font-medium text-gray-500 px-1 pb-1.5 mb-1 border-b border-gray-100">Export CSV</div>
                {selectedCount > 0 && (
                  <>
                    <button onClick={() => doExport('selected', 'visible')}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50">
                      {selectedCount} ที่เลือก · คอลัมน์ที่แสดง
                    </button>
                    <button onClick={() => doExport('selected', 'all')}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50">
                      {selectedCount} ที่เลือก · ทุกคอลัมน์
                    </button>
                    <div className="border-t border-gray-100 my-1" />
                  </>
                )}
                <button onClick={() => doExport('filtered', 'visible')}
                  className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50">
                  ทั้งหมดที่กรอง ({filtered.length}) · คอลัมน์ที่แสดง
                </button>
                <button onClick={() => doExport('filtered', 'all')}
                  className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50">
                  ทั้งหมดที่กรอง ({filtered.length}) · ทุกคอลัมน์
                </button>
                {/* v1.62.0 — legacy planning-sheet format for the transition */}
                <div className="border-t border-gray-100 my-1" />
                <a href="/api/admin/workspace/export-planning" download
                  className="block w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 text-gray-600">
                  📋 Planning sheet (รูปแบบเดิม)
                </a>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="ops-card ops-card-pad mb-3 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="ค้นหา: Production ID, project, producer, crew, notes, episode…"
              className="ops-input pl-8 w-full" />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <span>ถ่าย</span>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="ops-input py-1 text-xs" />
            <span>–</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="ops-input py-1 text-xs" />
          </div>
          {activeFilterCount > 0 && (
            <button onClick={clearFilters}
              className="ops-btn ops-btn-ghost ops-btn-sm inline-flex items-center gap-1 text-gray-500">
              <RotateCcw className="w-3.5 h-3.5" /> ล้างตัวกรอง ({activeFilterCount})
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* status chips */}
          <div className="flex items-center gap-1 flex-wrap">
            {STATUSES.map(s => {
              const on = statusSel.has(s)
              return (
                <button key={s} onClick={() => toggleInSet(statusSel, s, setStatusSel)}
                  className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
                    on ? `${statusColor(s)} border-transparent font-medium` : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                  }`}>
                  {statusLabel(s)}
                </button>
              )
            })}
          </div>
          <div className="w-px h-5 bg-gray-200 mx-1 hidden sm:block" />
          {/* outlet chips */}
          <div className="flex items-center gap-1 flex-wrap">
            {OUTLETS.map(o => {
              const on = outletSel.has(o.code)
              return (
                <button key={o.code} onClick={() => toggleInSet(outletSel, o.code, setOutletSel)}
                  title={o.name}
                  className={`text-[11px] px-2 py-1 rounded border font-mono transition-colors ${
                    on ? 'bg-[#673ab7] text-white border-[#673ab7]' : 'bg-white text-gray-500 border-gray-200 hover:border-[#673ab7]'
                  }`}>
                  {o.code}
                </button>
              )
            })}
          </div>
          <div className="w-px h-5 bg-gray-200 mx-1 hidden sm:block" />
          {/* toggles */}
          <button onClick={() => setFreelanceOnly(v => !v)}
            className={`text-[11px] px-2.5 py-1 rounded-full border inline-flex items-center gap-1 transition-colors ${
              freelanceOnly ? 'bg-amber-100 text-amber-800 border-amber-300 font-medium' : 'bg-white text-gray-500 border-gray-200 hover:border-amber-300'
            }`}>
            <Users className="w-3 h-3" /> มี Freelance
          </button>
          <button onClick={() => setUnassignedOnly(v => !v)}
            className={`text-[11px] px-2.5 py-1 rounded-full border inline-flex items-center gap-1 transition-colors ${
              unassignedOnly ? 'bg-red-100 text-red-700 border-red-300 font-medium' : 'bg-white text-gray-500 border-gray-200 hover:border-red-300'
            }`}>
            <Filter className="w-3 h-3" /> ยังไม่ assign
          </button>
          <button onClick={() => setRoutineFilter(f => f === 'all' ? 'only' : f === 'only' ? 'exclude' : 'all')}
            title="คลิกสลับ: ทั้งหมด → เฉพาะ Routine → ไม่เอา Routine"
            className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
              routineFilter === 'only' ? 'bg-[#673ab7] text-white border-[#673ab7] font-medium'
                : routineFilter === 'exclude' ? 'bg-gray-200 text-gray-700 border-gray-300 font-medium'
                : 'bg-white text-gray-500 border-gray-200 hover:border-[#673ab7]'
            }`}>
            🔁 {routineFilter === 'only' ? 'เฉพาะ Routine' : routineFilter === 'exclude' ? 'ไม่เอา Routine' : 'Routine'}
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="flex items-center gap-4 text-xs text-gray-500 mb-2 px-1 flex-wrap">
        <span>แสดง <strong className="text-gray-800">{filtered.length}</strong> จาก {rows.length} งาน</span>
        {total > rows.length && (
          <span className="text-amber-700">โหลด {rows.length} จากทั้งหมด {total} — กรองให้แคบลงเพื่อดูส่วนที่เหลือ</span>
        )}
        {selectedCount > 0 && <span className="text-[#673ab7]">เลือก <strong>{selectedCount}</strong></span>}
        <span>มี Freelance <strong className="text-gray-800">{filtered.filter(hasFreelancers).length}</strong></span>
        <span>ยังไม่ assign <strong className="text-gray-800">{filtered.filter(b => (b.assignedEmails || []).length === 0).length}</strong></span>
      </div>

      {error && (
        <div className="ops-card px-3 py-2 mb-3 text-sm text-red-700 bg-red-50 border-red-200 border-l-4 border-l-red-500">
          {error}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="py-20 text-center text-gray-400 text-sm">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> กำลังโหลด…
        </div>
      ) : filtered.length === 0 ? (
        <div className="ops-card py-16 text-center text-gray-400 text-sm">
          ไม่พบงานที่ตรงกับตัวกรอง
          {activeFilterCount > 0 && (
            <button onClick={clearFilters} className="block mx-auto mt-2 text-[#673ab7] hover:underline text-xs">ล้างตัวกรอง</button>
          )}
        </div>
      ) : (
        <div className="ops-card overflow-hidden">
          <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-10 bg-gray-50 border-b border-gray-200">
                <tr className="text-[11px] text-gray-500">
                  <th className={`${cellPad} sticky left-0 bg-gray-50 z-20 w-10`}>
                    <input type="checkbox" checked={allFilteredSelected}
                      ref={el => { if (el) el.indeterminate = !allFilteredSelected && someFilteredSelected }}
                      onChange={toggleAllFiltered} aria-label="เลือกทั้งหมด" />
                  </th>
                  {visibleCols.map((c, i) => (
                    <th key={c.key}
                      onClick={() => setSortKey(c.key)}
                      className={`${cellPad} font-medium whitespace-nowrap cursor-pointer select-none hover:text-gray-900 ${
                        c.align === 'right' ? 'text-right' : 'text-left'
                      } ${i === 0 ? 'sticky left-10 bg-gray-50 z-20' : ''}`}>
                      <span className="inline-flex items-center gap-0.5">
                        {c.label}
                        {sort.key === c.key && (sort.dir === 'asc'
                          ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(b => {
                  const isSel = selected.has(b.id)
                  return (
                    <tr key={b.id}
                      className={`border-b border-gray-50 transition-colors ${isSel ? 'bg-[#673ab7]/5' : 'hover:bg-gray-50/60'} ${b.status === 'CANCELLED' ? 'opacity-50' : ''}`}>
                      <td className={`${cellPad} sticky left-0 z-10 ${isSel ? 'bg-[#f3f0fb]' : 'bg-white'} w-10`}>
                        <input type="checkbox" checked={isSel} onChange={() => toggleRow(b.id)}
                          aria-label={`เลือก ${b.bookingCode || b.id}`} />
                      </td>
                      {visibleCols.map((c, i) => {
                        const stickyFirst = i === 0 ? `sticky left-10 z-10 ${isSel ? 'bg-[#f3f0fb]' : 'bg-white'}` : ''
                        if (c.key === 'code') {
                          return (
                            <td key={c.key} className={`${cellPad} whitespace-nowrap font-medium ${stickyFirst}`}>
                              <Link href={`/admin/${b.id}`} className="text-[#673ab7] hover:underline font-mono text-[12px]">
                                {c.value(b)}
                              </Link>
                            </td>
                          )
                        }
                        if (c.key === 'status') {
                          return (
                            <td key={c.key} className={`${cellPad} whitespace-nowrap ${stickyFirst}`}>
                              <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${statusColor(b.status || '')}`}>
                                {statusLabel(b.status || '')}
                              </span>
                            </td>
                          )
                        }
                        if (c.key === 'freelancerCount') {
                          const n = c.num ? c.num(b) : 0
                          return (
                            <td key={c.key} className={`${cellPad} text-right ${stickyFirst}`}>
                              {n > 0
                                ? <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 font-medium">{n}</span>
                                : <span className="text-gray-300">—</span>}
                            </td>
                          )
                        }
                        const txt = c.value(b)
                        const isLong = ['notes', 'adminNotes', 'freelancers', 'assignedEmails', 'creative', 'projectName'].includes(c.key)
                        return (
                          <td key={c.key}
                            className={`${cellPad} text-gray-700 ${c.align === 'right' ? 'text-right' : ''} ${isLong ? 'max-w-[260px] truncate' : 'whitespace-nowrap'} ${stickyFirst}`}
                            title={isLong ? txt : undefined}>
                            {txt || <span className="text-gray-300">—</span>}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
