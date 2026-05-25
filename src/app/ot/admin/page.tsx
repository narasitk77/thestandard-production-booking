'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Download, Loader2, Pencil, Save, X, UserPlus, ShieldOff, Shield, Trash2, RotateCcw, Users, CheckCircle2, Inbox, FileSignature, Eye } from 'lucide-react'
import { WEEKDAY_THRESHOLD_HOURS } from '@/lib/ot-calc'

interface PersonSummary {
  userId: string | null
  email: string
  thaiName: string
  employeeId: string
  position: string
  role: string
  active: boolean
  weekendHolidayDays: number
  weekdayOTDays: number
  totalDays: number
  totalAmount: number
  totalRecords: number
  // v1.33.0+ status breakdown — replaces the old single `pendingRecords`
  draftRecords?: number
  submittedRecords?: number
  rejectedRecords?: number
  pendingRecords: number   // legacy alias = submitted + rejected; kept for safety
  approvedRecords: number
}

const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม']

function currentMonth(): string { return new Date().toISOString().slice(0, 7) }
function prevMonth(): string {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1)
  return d.toISOString().slice(0, 7)
}
function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split('-')
  return `${THAI_MONTHS[parseInt(m) - 1]} ${y}`
}

export default function OTAdminPage() {
  const [summary, setSummary] = useState<PersonSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [month, setMonth] = useState(currentMonth())
  const [includeInactive, setIncludeInactive] = useState(false)
  const [error, setError] = useState('')
  const [meId, setMeId] = useState<string | undefined>()

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<Partial<PersonSummary>>({})

  // Add user form
  const [showAdd, setShowAdd] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newThai, setNewThai] = useState('')
  const [newEmpId, setNewEmpId] = useState('')
  const [newPos, setNewPos] = useState('')
  const [newRole, setNewRole] = useState<'USER' | 'ADMIN'>('USER')

  // v1.33.0 — bulk approve state. Selection is keyed by userId since
  // PersonSummary rows are per-user; on bulk approve we expand each
  // selected user to "every SUBMITTED row for this person, this month".
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkActing, setBulkActing] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/ot/summary?month=${month}${includeInactive ? '&includeInactive=1' : ''}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setSummary(data.summary || [])

      const me = await fetch('/api/me').then(r => r.json()).catch(() => null)
      if (me?.user) {
        const u = (data.summary || []).find((s: PersonSummary) => s.email === me.user.email)
        if (u) setMeId(u.userId || undefined)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // Reset selection whenever the underlying dataset changes
  useEffect(() => { setSelected(new Set()) }, [month, includeInactive])
  useEffect(() => { load() }, [month, includeInactive])

  const totals = summary.reduce(
    (a, s) => ({
      wh: a.wh + s.weekendHolidayDays,
      wd: a.wd + s.weekdayOTDays,
      amount: a.amount + s.totalAmount,
      people: a.people + (s.totalDays > 0 ? 1 : 0),
    }),
    { wh: 0, wd: 0, amount: 0, people: 0 }
  )

  // Inbox totals — surfaced as the top-of-page banner so a manager
  // landing here immediately sees "do I have approval work?"
  const inbox = useMemo(() => {
    let pendingRows = 0
    let pendingPeople = 0
    for (const s of summary) {
      const sub = s.submittedRecords ?? s.pendingRecords // fallback for transition window
      if (sub > 0) {
        pendingRows += sub
        pendingPeople += 1
      }
    }
    return { pendingRows, pendingPeople }
  }, [summary])

  const selectableRows = useMemo(
    () => summary.filter(s => s.userId && (s.submittedRecords ?? s.pendingRecords) > 0),
    [summary]
  )
  const allSelected = selectableRows.length > 0 && selectableRows.every(s => selected.has(s.userId!))

  const toggleOne = (userId: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }
  const toggleAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(selectableRows.map(s => s.userId!)))
  }

  // Bulk approve the selected people. For each selected user with
  // SUBMITTED records this month, fire a {email, month} approve. We do
  // these in parallel — the approve endpoint is idempotent so a partial
  // failure leaves clean state.
  const approveSelected = async () => {
    const targets = summary.filter(s => s.userId && selected.has(s.userId!) && (s.submittedRecords ?? s.pendingRecords) > 0)
    if (targets.length === 0) return
    const totalRows = targets.reduce((a, s) => a + (s.submittedRecords ?? s.pendingRecords), 0)
    if (!confirm(`อนุมัติ OT ${totalRows} รายการจาก ${targets.length} คน (${monthLabel(month)})?`)) return
    setBulkActing(true)
    setError('')
    try {
      const results = await Promise.allSettled(targets.map(s =>
        fetch('/api/ot/admin/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: s.email, month }),
        }).then(r => r.ok ? r.json() : r.json().then(d => { throw new Error(d.error) }))
      ))
      const failed = results.filter(r => r.status === 'rejected')
      if (failed.length > 0) {
        setError(`${failed.length} จาก ${results.length} คน อนุมัติไม่สำเร็จ — ลองอีกครั้ง`)
      }
      setSelected(new Set())
      load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBulkActing(false)
    }
  }

  // One-click "approve every SUBMITTED row in this month across all users"
  const approveEveryone = async () => {
    if (inbox.pendingRows === 0) return
    if (!confirm(`อนุมัติ OT ทั้งหมด ${inbox.pendingRows} รายการของ ${inbox.pendingPeople} คน (${monthLabel(month)})?\n\nการกระทำนี้จะ snapshot ลายเซ็นของคุณใส่ทุกแถว`)) return
    setBulkActing(true)
    setError('')
    try {
      const res = await fetch('/api/ot/admin/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, allSubmitted: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setSelected(new Set())
      load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBulkActing(false)
    }
  }

  const startEdit = (s: PersonSummary) => {
    setEditingId(s.userId)
    setEditValues({
      thaiName: s.thaiName,
      employeeId: s.employeeId,
      position: s.position,
      role: s.role,
    })
  }
  const cancelEdit = () => { setEditingId(null); setEditValues({}) }

  const saveEdit = async (userId: string) => {
    setError('')
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: userId, ...editValues }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      cancelEdit()
      load()
    } catch (e: any) { setError(e.message) }
  }

  const toggleRole = async (s: PersonSummary) => {
    if (!s.userId) return
    const next = s.role === 'ADMIN' ? 'USER' : 'ADMIN'
    if (!confirm(`เปลี่ยน ${s.thaiName || s.email} เป็น ${next}?`)) return
    setError('')
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.userId, role: next }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      load()
    } catch (e: any) { setError(e.message) }
  }

  const toggleActive = async (s: PersonSummary) => {
    if (!s.userId) return
    const action = s.active ? 'ลบออกจากรายการ' : 'นำกลับเข้ารายการ'
    if (!confirm(`${action}: ${s.thaiName || s.email}?`)) return
    setError('')
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.userId, active: !s.active }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      load()
    } catch (e: any) { setError(e.message) }
  }

  const addUser = async () => {
    if (!newEmail) return
    setError('')
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail,
          thaiName: newThai,
          employeeId: newEmpId,
          position: newPos,
          role: newRole,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setNewEmail(''); setNewThai(''); setNewEmpId(''); setNewPos(''); setNewRole('USER')
      setShowAdd(false)
      load()
    } catch (e: any) { setError(e.message) }
  }

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3 pb-24">
      <Link href="/ot" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="w-4 h-4" /> กลับหน้า OT
      </Link>

      <div className="gf-header p-4 sm:p-6">
        <h1 className="text-xl sm:text-2xl font-normal text-gray-800">OT Cover Sheet — Admin</h1>
        <p className="text-xs sm:text-sm text-gray-500">
          สรุปการขออนุมัติการทำงานวันหยุด · Production · {monthLabel(month)}
        </p>
      </div>

      {/* Inbox banner — manager's "do I have work?" at-a-glance */}
      {inbox.pendingRows > 0 ? (
        <div className="gf-card p-3 border-l-4 border-amber-400 bg-amber-50/60 flex items-center gap-3 flex-wrap">
          <Inbox className="w-5 h-5 text-amber-600 shrink-0" />
          <div className="text-sm text-amber-900">
            <strong>{inbox.pendingRows}</strong> รายการรออนุมัติจาก <strong>{inbox.pendingPeople}</strong> คน
          </div>
          <button
            type="button"
            onClick={approveEveryone}
            disabled={bulkActing}
            className="ml-auto text-xs px-3 py-1.5 border border-[#673ab7] text-white bg-[#673ab7] rounded hover:bg-[#5e35b1] disabled:opacity-40 inline-flex items-center gap-1">
            {bulkActing ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
            อนุมัติทุกคนในเดือนนี้
          </button>
        </div>
      ) : (
        <div className="gf-card p-3 border-l-4 border-green-300 bg-green-50/40 flex items-center gap-2 text-sm text-green-800">
          <CheckCircle2 className="w-4 h-4" /> ไม่มีคำขอ OT รออนุมัติในเดือนนี้
        </div>
      )}

      {error && <div className="gf-card p-3 text-sm text-red-600 border-l-4 border-red-400">{error}</div>}

      {/* Month + export controls */}
      <div className="gf-card p-4 flex items-center gap-2 flex-wrap">
        <span className="text-sm text-gray-700 font-medium">เดือน</span>
        <input type="month" value={month} onChange={e => setMonth(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1 text-sm" />
        <div className="flex gap-1 ml-1">
          <button onClick={() => setMonth(prevMonth())} className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50">เดือนก่อน</button>
          <button onClick={() => setMonth(currentMonth())} className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50">เดือนนี้</button>
        </div>

        <label className="flex items-center gap-1 text-xs text-gray-600 ml-2">
          <input type="checkbox" checked={includeInactive}
            onChange={e => setIncludeInactive(e.target.checked)}
            className="accent-[#673ab7]" />
          แสดงคนที่ disabled
        </label>

        <div className="ml-auto flex gap-2 flex-wrap">
          <a href={`/api/ot/export?month=${month}`} download
            className="px-3 py-1.5 text-xs border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white inline-flex items-center gap-1">
            <Download className="w-3 h-3" /> Cover Sheet CSV
          </a>
          <a href={`/api/ot/export?month=${month}&detail=1`} download
            className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
            <Download className="w-3 h-3" /> Detail CSV
          </a>
        </div>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">คนที่บันทึก</div>
          <div className="text-2xl font-medium text-gray-800">{totals.people}</div>
        </div>
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">หยุด/Hol (500/วัน)</div>
          <div className="text-2xl font-medium text-gray-800">{totals.wh}<span className="text-sm text-gray-400 ml-1">วัน</span></div>
        </div>
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">วันธรรมดา &gt;{WEEKDAY_THRESHOLD_HOURS}h (300/วัน)</div>
          <div className="text-2xl font-medium text-gray-800">{totals.wd}<span className="text-sm text-gray-400 ml-1">วัน</span></div>
        </div>
        <div className="gf-card p-4 bg-green-50">
          <div className="text-xs text-green-700 mb-1">รวม THB</div>
          <div className="text-2xl font-medium text-green-800">฿{totals.amount.toLocaleString('th-TH')}</div>
        </div>
      </div>

      {/* Add user form */}
      <div className="gf-card p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="text-sm font-medium text-gray-700 flex items-center gap-2">
            <Users className="w-4 h-4 text-[#673ab7]" /> Roster ({summary.length} คน)
          </div>
          <button onClick={() => setShowAdd(!showAdd)}
            className="text-xs px-3 py-1.5 border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white inline-flex items-center gap-1">
            <UserPlus className="w-3 h-3" /> เพิ่มชื่อ
          </button>
        </div>

        {showAdd && (
          <div className="bg-purple-50 border border-purple-200 rounded p-3 mb-3 space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input type="email" className="gf-input" placeholder="email@thestandard.co"
                value={newEmail} onChange={e => setNewEmail(e.target.value)} required />
              <input className="gf-input" placeholder="ชื่อ-นามสกุล (ไทย)"
                value={newThai} onChange={e => setNewThai(e.target.value)} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input className="gf-input" placeholder="รหัสพนักงาน TSDxxxxx"
                value={newEmpId} onChange={e => setNewEmpId(e.target.value)} />
              <input className="gf-input" placeholder="ตำแหน่ง"
                value={newPos} onChange={e => setNewPos(e.target.value)} />
              <select className="gf-input" value={newRole}
                onChange={e => setNewRole(e.target.value as any)}>
                <option value="USER">User</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>
            <div className="flex gap-2">
              <button onClick={addUser} disabled={!newEmail}
                className="text-xs px-3 py-1 border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white disabled:opacity-40">
                + บันทึก
              </button>
              <button onClick={() => setShowAdd(false)}
                className="text-xs px-3 py-1 border border-gray-300 rounded hover:bg-gray-50">
                ยกเลิก
              </button>
            </div>
          </div>
        )}

        {/* Roster table */}
        {loading ? (
          <div className="py-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <table className="w-full text-sm min-w-[950px]">
              <thead className="border-b border-gray-200">
                <tr className="text-xs text-gray-500">
                  <th className="text-left py-2 pr-2 w-8">
                    <input type="checkbox" checked={allSelected}
                      onChange={toggleAll}
                      disabled={selectableRows.length === 0}
                      title="เลือก/ยกเลิกเลือกทุกคนที่รออนุมัติ"
                      className="accent-[#673ab7]" />
                  </th>
                  <th className="text-left py-2 pr-2 w-8">#</th>
                  <th className="text-left py-2 pr-2">ชื่อ-นามสกุล</th>
                  <th className="text-left py-2 pr-2">Email</th>
                  <th className="text-left py-2 pr-2">รหัส</th>
                  <th className="text-left py-2 pr-2">ตำแหน่ง</th>
                  <th className="text-left py-2 pr-2">Role</th>
                  <th className="text-right py-2 pr-2">หยุด/Hol</th>
                  <th className="text-right py-2 pr-2">WD &gt;{WEEKDAY_THRESHOLD_HOURS}h</th>
                  <th className="text-right py-2 pr-2">THB</th>
                  <th className="text-right py-2 pr-2 w-40">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {summary.map((s, i) => {
                  const editing = editingId === s.userId
                  const isMe = meId && s.userId === meId
                  const submittedCount = s.submittedRecords ?? s.pendingRecords
                  const canSelect = !!s.userId && submittedCount > 0
                  const isSelected = !!s.userId && selected.has(s.userId)
                  return (
                    <tr key={s.userId || s.email} className={!s.active ? 'opacity-50' : isSelected ? 'bg-purple-50/50' : ''}>
                      <td className="py-2 pr-2">
                        <input type="checkbox"
                          checked={isSelected}
                          onChange={() => s.userId && toggleOne(s.userId)}
                          disabled={!canSelect}
                          title={canSelect ? 'เลือกเพื่อ bulk approve' : 'ไม่มีรายการรออนุมัติ'}
                          className="accent-[#673ab7]" />
                      </td>
                      <td className="py-2 pr-2 text-gray-400">{i + 1}</td>

                      <td className="py-2 pr-2">
                        {editing ? (
                          <input className="gf-input" value={editValues.thaiName ?? ''}
                            onChange={e => setEditValues({ ...editValues, thaiName: e.target.value })} />
                        ) : s.userId ? (
                          <Link
                            href={`/ot/admin/review/${encodeURIComponent(s.email)}?month=${month}`}
                            className="text-gray-800 hover:text-[#673ab7] hover:underline">
                            {s.thaiName || s.email}
                          </Link>
                        ) : (
                          <span className="text-gray-800">{s.thaiName || '—'}</span>
                        )}
                      </td>

                      <td className="py-2 pr-2 text-xs text-gray-500">{s.email}</td>

                      <td className="py-2 pr-2">
                        {editing ? (
                          <input className="gf-input w-24" value={editValues.employeeId ?? ''}
                            onChange={e => setEditValues({ ...editValues, employeeId: e.target.value })} />
                        ) : (
                          <span className="text-xs text-gray-500">{s.employeeId || '—'}</span>
                        )}
                      </td>

                      <td className="py-2 pr-2">
                        {editing ? (
                          <input className="gf-input" value={editValues.position ?? ''}
                            onChange={e => setEditValues({ ...editValues, position: e.target.value })} />
                        ) : (
                          <span className="text-xs text-gray-600">{s.position || '—'}</span>
                        )}
                      </td>

                      <td className="py-2 pr-2">
                        {editing ? (
                          <select className="gf-input"
                            value={(editValues.role ?? s.role) as string}
                            onChange={e => setEditValues({ ...editValues, role: e.target.value })}>
                            <option value="USER">User</option>
                            <option value="ADMIN">Admin</option>
                          </select>
                        ) : (
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                            s.role === 'ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'
                          }`}>
                            {s.role}
                          </span>
                        )}
                      </td>

                      <td className="py-2 pr-2 text-right tabular-nums font-medium">{s.weekendHolidayDays || 0}</td>
                      <td className="py-2 pr-2 text-right tabular-nums font-medium">{s.weekdayOTDays || 0}</td>
                      <td className="py-2 pr-2 text-right tabular-nums font-medium text-green-700">{s.totalAmount ? `฿${s.totalAmount.toLocaleString('th-TH')}` : '—'}</td>

                      <td className="py-2 pr-2 text-right">
                        {!s.userId ? (
                          <span className="text-[10px] text-yellow-600">orphan record</span>
                        ) : editing ? (
                          <div className="inline-flex gap-1">
                            <button onClick={() => saveEdit(s.userId!)}
                              className="text-xs px-2 py-1 border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white inline-flex items-center gap-0.5">
                              <Save className="w-3 h-3" /> Save
                            </button>
                            <button onClick={cancelEdit}
                              className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50">
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex gap-1">
                            {submittedCount > 0 && (
                              <Link
                                href={`/ot/admin/review/${encodeURIComponent(s.email)}?month=${month}`}
                                title={`ตรวจ ${submittedCount} รายการแบบรายแถว`}
                                className="text-xs px-2 py-1 border border-amber-400 text-amber-700 rounded hover:bg-amber-100 inline-flex items-center gap-1">
                                <Eye className="w-3 h-3" /> Review {submittedCount}
                              </Link>
                            )}
                            {submittedCount === 0 && s.approvedRecords > 0 && (
                              <span title={`${s.approvedRecords} รายการอนุมัติแล้ว`}
                                className="text-xs px-2 py-1 border border-green-300 text-green-700 rounded inline-flex items-center gap-1 bg-green-50">
                                <CheckCircle2 className="w-3 h-3" /> {s.approvedRecords}
                              </span>
                            )}
                            {(s.rejectedRecords ?? 0) > 0 && (
                              <span title={`${s.rejectedRecords} รายการตีกลับรอ user แก้`}
                                className="text-[10px] px-1.5 py-1 border border-red-200 text-red-600 rounded bg-red-50">
                                ตีกลับ {s.rejectedRecords}
                              </span>
                            )}
                            <button onClick={() => startEdit(s)} title="แก้ไข"
                              className="text-xs p-1.5 border border-gray-300 rounded hover:bg-gray-50">
                              <Pencil className="w-3 h-3" />
                            </button>
                            {!isMe && (
                              <button onClick={() => toggleRole(s)} title={s.role === 'ADMIN' ? 'Demote' : 'Make Admin'}
                                className="text-xs p-1.5 border border-gray-300 rounded hover:bg-gray-50">
                                {s.role === 'ADMIN' ? <ShieldOff className="w-3 h-3" /> : <Shield className="w-3 h-3" />}
                              </button>
                            )}
                            {!isMe && (
                              <button onClick={() => toggleActive(s)}
                                title={s.active ? 'ลบออก' : 'นำกลับ'}
                                className={`text-xs p-1.5 border rounded hover:bg-gray-50 ${
                                  s.active ? 'border-red-200 text-red-500 hover:bg-red-50' : 'border-green-200 text-green-600 hover:bg-green-50'
                                }`}>
                                {s.active ? <Trash2 className="w-3 h-3" /> : <RotateCcw className="w-3 h-3" />}
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 font-medium">
                  <td colSpan={7} className="py-2 pr-2 text-right text-gray-700">รวม</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{totals.wh}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{totals.wd}</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-green-700">฿{totals.amount.toLocaleString('th-TH')}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div className="gf-card p-3 text-xs text-gray-500 border-l-4 border-blue-200">
        💡 ลบคนออกจากรายการ = soft delete (ยังเก็บประวัติ OT) · กดปุ่ม "↺" เพื่อนำกลับมา ·
        คลิกชื่อคนเพื่อ <strong>review รายแถว</strong> · ติ๊ก checkbox เพื่อ <strong>bulk approve</strong>
      </div>

      {/* Sticky footer — only when bulk-select has something */}
      {selected.size > 0 && (() => {
        const targets = summary.filter(s => s.userId && selected.has(s.userId!) && (s.submittedRecords ?? s.pendingRecords) > 0)
        const totalRows = targets.reduce((a, s) => a + (s.submittedRecords ?? s.pendingRecords), 0)
        return (
          <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-40">
            <div className="max-w-6xl mx-auto px-3 sm:px-4 py-3 flex items-center gap-3 flex-wrap">
              <div className="text-sm text-gray-700">
                เลือก <strong>{targets.length}</strong> คน · รวม <strong className="text-amber-700">{totalRows}</strong> รายการรออนุมัติ
              </div>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-xs text-gray-500 hover:text-gray-800 px-2 py-1">
                ยกเลิกเลือก
              </button>
              <button
                type="button"
                onClick={approveSelected}
                disabled={bulkActing || totalRows === 0}
                className="ml-auto text-sm px-4 py-2 border border-[#673ab7] text-white bg-[#673ab7] rounded hover:bg-[#5e35b1] disabled:opacity-40 inline-flex items-center gap-1">
                {bulkActing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                อนุมัติที่เลือก ({totalRows})
              </button>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
