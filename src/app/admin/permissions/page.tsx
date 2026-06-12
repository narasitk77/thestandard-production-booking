'use client'

import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Loader2, UserPlus, Lock,
  Search, Pencil, Check, X, Mail,
} from 'lucide-react'
import {
  ROLES, ROLE_RANK, ROLE_LABEL, canEditUser, assignableRoles,
  canApproveOTByRole, type Role,
} from '@/lib/roles'
import { OUTLETS } from '@/lib/data'

interface User {
  id: string
  email: string
  name: string | null
  thaiName: string | null
  employeeId: string | null
  position: string | null
  role: Role
  active: boolean
  producerOutlets: string[]
  createdAt: string
}

// v1.54 — outlet codes for the per-outlet Producer tag editor
const OUTLET_CODES = OUTLETS.map(o => o.code)
const OUTLET_NAME: Record<string, string> = Object.fromEntries(OUTLETS.map(o => [o.code, o.name]))

type SortKey = 'name' | 'role' | 'createdAt'

const ROLE_BADGE: Record<Role, string> = {
  ADMIN: 'bg-purple-100 text-purple-700',
  SUPPORT: 'bg-blue-100 text-blue-700',
  MANAGER: 'bg-indigo-100 text-indigo-700',
  COORDINATOR: 'bg-teal-100 text-teal-700',
  USER: 'bg-gray-100 text-gray-500',
}

export default function PermissionsPage() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [showDisabled, setShowDisabled] = useState(false)

  // Current actor (drives which controls are enabled — see role matrix).
  const [myRole, setMyRole] = useState<Role>('USER')
  const [myEmail, setMyEmail] = useState('')

  // Add-user form
  const [adding, setAdding] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState<Role>('USER')
  const [saving, setSaving] = useState(false)

  // Inline position edit
  const [editId, setEditId] = useState<string | null>(null)
  const [editPos, setEditPos] = useState('')
  const posInputRef = useRef<HTMLInputElement>(null)

  // v1.54 — inline producer-outlets edit (chip toggles)
  const [prodEditId, setProdEditId] = useState<string | null>(null)
  const [prodSel, setProdSel] = useState<string[]>([])

  const load = async () => {
    setLoading(true)
    const res = await fetch('/api/admin/users')
    const data = await res.json()
    if (res.ok) setUsers(data.users)
    setLoading(false)
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    fetch('/api/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.user) { setMyRole(d.user.role as Role); setMyEmail((d.user.email || '').toLowerCase()) } })
      .catch(() => {})
  }, [])
  useEffect(() => { if (editId) posInputRef.current?.focus() }, [editId])

  // ── actor capability helpers (mirror server matrix in src/lib/roles.ts) ──
  const myAssignable = assignableRoles(myRole)
  const canAdd = myRole === 'ADMIN' || myRole === 'MANAGER'

  const updateUser = async (id: string, patch: Record<string, unknown>) => {
    setError('')
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error); return false }
    setUsers(prev => prev.map(u => u.id === id ? { ...u, ...data.user } : u))
    return true
  }

  const addUser = async () => {
    if (!newEmail || saving) return
    setSaving(true); setError('')
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: newEmail.trim().toLowerCase(), role: newRole }),
    })
    const data = await res.json()
    setSaving(false)
    if (!res.ok) { setError(data.error); return }
    setNewEmail(''); setNewRole('USER'); setAdding(false)
    load()
  }

  const savePosition = async (id: string) => {
    const ok = await updateUser(id, { position: editPos.trim() || null })
    if (ok) setEditId(null)
  }

  const saveProducerOutlets = async (id: string) => {
    const ok = await updateUser(id, { producerOutlets: prodSel })
    if (ok) setProdEditId(null)
  }

  // ── derived helpers ───────────────────────────────────────
  const canApproveOT = (u: User) =>
    canApproveOTByRole(u.role) || (u.position || '').toLowerCase().includes('manager')

  const displayName = (u: User) =>
    u.thaiName || u.name || u.email.split('@')[0]

  // ── filter + sort ─────────────────────────────────────────
  const filtered = users
    .filter(u => showDisabled ? true : u.active)
    .filter(u => {
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return u.email.includes(q)
        || (u.thaiName || '').toLowerCase().includes(q)
        || (u.name || '').toLowerCase().includes(q)
        || (u.employeeId || '').toLowerCase().includes(q)
        || (u.position || '').toLowerCase().includes(q)
        || (u.producerOutlets || []).join(' ').toLowerCase().includes(q)
    })
    .sort((a, b) => {
      if (sortKey === 'role') {
        if (a.role !== b.role) return ROLE_RANK[a.role] - ROLE_RANK[b.role]
      }
      if (sortKey === 'createdAt') {
        return b.createdAt.localeCompare(a.createdAt)
      }
      return displayName(a).localeCompare(displayName(b), 'th')
    })

  const adminCount = users.filter(u => u.active && u.role === 'ADMIN').length
  const otCount    = users.filter(u => u.active && canApproveOT(u)).length

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="w-4 h-4" /> Admin Console
      </Link>

      {/* Header */}
      <div className="gf-header p-4 sm:p-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl sm:text-2xl font-normal text-gray-800">User Permissions</h1>
            <p className="text-xs sm:text-sm text-gray-500 mt-1">
              จัดการ role และสิทธิ์การเข้าถึงระบบของผู้ใช้แต่ละคน
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Stat chips */}
            <span className="text-[11px] px-2 py-1 bg-purple-50 text-purple-700 border border-purple-200 rounded">
              {adminCount} Admin
            </span>
            <span className="text-[11px] px-2 py-1 bg-amber-50 text-amber-700 border border-amber-200 rounded">
              {otCount} OT Approver
            </span>
            <TestEmailButton />
            {canAdd && (
              <button
                onClick={() => { setAdding(a => !a); setError('') }}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white transition-colors"
              >
                <UserPlus className="w-3.5 h-3.5" /> เพิ่มผู้ใช้
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="gf-card p-3 text-sm text-red-600 border-l-4 border-red-400">{error}</div>
      )}

      {/* Add-user form */}
      {adding && (
        <div className="gf-card p-4 border border-[#673ab7] bg-purple-50/20">
          <div className="text-xs font-medium text-[#673ab7] mb-3 flex items-center gap-1.5">
            <UserPlus className="w-3.5 h-3.5" /> เพิ่ม / อัปเดตผู้ใช้ (upsert ถ้ามีอยู่แล้วจะอัปเดต role)
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="email"
              className="gf-input flex-1 min-w-0"
              placeholder="email@thestandard.co"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addUser()}
              autoFocus
            />
            <select className="gf-input w-36 shrink-0" value={newRole}
              onChange={e => setNewRole(e.target.value as Role)}>
              {ROLES.filter(r => myAssignable.includes(r)).map(r => (
                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
              ))}
            </select>
            <button onClick={addUser} disabled={!newEmail || saving}
              className="px-4 py-1.5 text-sm bg-[#673ab7] text-white rounded disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              บันทึก
            </button>
            <button onClick={() => { setAdding(false); setNewEmail(''); setError('') }}
              className="px-3 py-1.5 text-sm border rounded text-gray-500 hover:bg-gray-50">
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      {/* Table card */}
      <div className="gf-card overflow-hidden">
        {/* Toolbar */}
        <div className="p-3 border-b border-gray-100 flex items-center gap-2 flex-wrap">
          <Search className="w-4 h-4 text-gray-400 shrink-0" />
          <input
            type="text"
            placeholder="ค้นหา email · ชื่อ · Employee ID · Position"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="flex-1 min-w-[160px] text-sm bg-transparent outline-none text-gray-700 placeholder-gray-400"
          />
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            {/* Sort */}
            <select
              value={sortKey}
              onChange={e => setSortKey(e.target.value as SortKey)}
              className="text-xs border border-gray-200 rounded px-2 py-1 text-gray-600 bg-white"
            >
              <option value="name">เรียงตามชื่อ</option>
              <option value="role">เรียงตาม Role</option>
              <option value="createdAt">เรียงตามวันที่สร้าง</option>
            </select>
            {/* Toggle disabled */}
            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
              <input type="checkbox" checked={showDisabled}
                onChange={e => setShowDisabled(e.target.checked)} className="w-3 h-3" />
              แสดง Disabled
            </label>
            <span className="text-xs text-gray-400">{filtered.length} / {users.length} คน</span>
          </div>
        </div>

        {/* Table */}
        {loading ? (
          <div className="py-12 text-center">
            <Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-400">
            {search ? 'ไม่พบผู้ใช้ที่ตรงกับคำค้น' : 'ยังไม่มีผู้ใช้'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead className="border-b border-gray-100 bg-gray-50/60">
                <tr className="text-[10px] text-gray-400 uppercase tracking-wider">
                  <th className="text-left px-4 py-2.5 font-medium">ผู้ใช้</th>
                  <th className="text-left px-3 py-2.5 font-medium">Role</th>
                  <th className="text-left px-3 py-2.5 font-medium">Position</th>
                  <th className="text-left px-3 py-2.5 font-medium">Producer (Outlet)</th>
                  <th className="text-left px-3 py-2.5 font-medium">สถานะ</th>
                  <th className="text-right px-4 py-2.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(u => {
                  const isEditing    = editId === u.id
                  const isOTApprover = canApproveOT(u)
                  const dName        = displayName(u)
                  const isSelf       = u.email.toLowerCase() === myEmail
                  // May the current actor edit this user's role / active / profile?
                  const mayEdit      = canEditUser(myRole, u.role) && !isSelf
                  // Roles the actor may switch this user to (always include current).
                  const roleChoices  = ROLES.filter(r => r === u.role || myAssignable.includes(r))

                  return (
                    <tr key={u.id}
                      className={`${!u.active ? 'opacity-40' : ''} hover:bg-gray-50/60 transition-colors`}>

                      {/* User info */}
                      <td className="px-4 py-3 min-w-[180px]">
                        <div className="font-medium text-gray-900 text-[13px] leading-tight">{dName}</div>
                        <div className="text-[11px] text-gray-400 mt-0.5">{u.email}</div>
                        {u.employeeId && (
                          <div className="text-[10px] text-gray-400 font-mono mt-0.5">{u.employeeId}</div>
                        )}
                      </td>

                      {/* System role */}
                      <td className="px-3 py-3">
                        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${ROLE_BADGE[u.role]}`}>
                          {ROLE_LABEL[u.role]}
                        </span>
                      </td>

                      {/* Position + OT badge */}
                      <td className="px-3 py-3 min-w-[160px]">
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <input
                              ref={posInputRef}
                              type="text"
                              className="border border-gray-300 rounded px-2 py-0.5 text-xs w-36 outline-none focus:border-[#673ab7]"
                              value={editPos}
                              onChange={e => setEditPos(e.target.value)}
                              placeholder="เช่น Manager, Producer"
                              onKeyDown={e => {
                                if (e.key === 'Enter') savePosition(u.id)
                                if (e.key === 'Escape') setEditId(null)
                              }}
                            />
                            <button
                              onClick={() => savePosition(u.id)}
                              className="p-0.5 text-green-600 hover:bg-green-50 rounded transition-colors"
                              title="บันทึก">
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setEditId(null)}
                              className="p-0.5 text-gray-400 hover:bg-gray-100 rounded transition-colors"
                              title="ยกเลิก">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 group">
                            <span className="text-xs text-gray-500">
                              {u.position || <span className="text-gray-300">—</span>}
                            </span>
                            {mayEdit && (
                              <button
                                onClick={() => { setEditId(u.id); setEditPos(u.position || '') }}
                                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 text-gray-400 hover:text-[#673ab7] rounded transition-all"
                                title="แก้ไข Position">
                                <Pencil className="w-2.5 h-2.5" />
                              </button>
                            )}
                            {isOTApprover && (
                              <span className="ml-0.5 text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded whitespace-nowrap">
                                OT Approver
                              </span>
                            )}
                          </div>
                        )}
                      </td>

                      {/* v1.54 — Producer outlets (dropdown data source) */}
                      <td className="px-3 py-3 min-w-[150px]">
                        {prodEditId === u.id ? (
                          <div className="flex items-center gap-1 flex-wrap max-w-[260px]">
                            {OUTLET_CODES.map(code => {
                              const on = prodSel.includes(code)
                              return (
                                <button
                                  key={code}
                                  onClick={() => setProdSel(prev => on ? prev.filter(c => c !== code) : [...prev, code])}
                                  title={OUTLET_NAME[code]}
                                  className={`text-[10px] px-1.5 py-0.5 rounded border font-mono transition-colors ${
                                    on
                                      ? 'bg-[#673ab7] text-white border-[#673ab7]'
                                      : 'bg-white text-gray-500 border-gray-200 hover:border-[#673ab7]'
                                  }`}>
                                  {code}
                                </button>
                              )
                            })}
                            <button
                              onClick={() => saveProducerOutlets(u.id)}
                              className="p-0.5 text-green-600 hover:bg-green-50 rounded transition-colors"
                              title="บันทึก">
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setProdEditId(null)}
                              className="p-0.5 text-gray-400 hover:bg-gray-100 rounded transition-colors"
                              title="ยกเลิก">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 group flex-wrap">
                            {(u.producerOutlets || []).length === 0 ? (
                              <span className="text-xs text-gray-300">—</span>
                            ) : (
                              (u.producerOutlets || []).map(code => (
                                <span key={code} title={OUTLET_NAME[code]}
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200 font-mono">
                                  {code}
                                </span>
                              ))
                            )}
                            {mayEdit && (
                              <button
                                onClick={() => { setProdEditId(u.id); setProdSel(u.producerOutlets || []) }}
                                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 text-gray-400 hover:text-[#673ab7] rounded transition-all"
                                title="แก้ไข outlet ที่เป็น Producer">
                                <Pencil className="w-2.5 h-2.5" />
                              </button>
                            )}
                          </div>
                        )}
                      </td>

                      {/* Status */}
                      <td className="px-3 py-3">
                        <span className={`text-[11px] px-2 py-0.5 rounded-full ${
                          u.active
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-600'
                        }`}>
                          {u.active ? 'Active' : 'Disabled'}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3 text-right">
                        {mayEdit ? (
                          <div className="inline-flex items-center gap-1.5">
                            {/* Role picker — only roles the actor may assign (+ current) */}
                            <select
                              value={u.role}
                              onChange={e => updateUser(u.id, { role: e.target.value })}
                              title="เปลี่ยน Role"
                              className="text-[11px] px-1.5 py-1 border border-gray-200 rounded text-gray-700 bg-white outline-none focus:border-[#673ab7]">
                              {roleChoices.map(r => (
                                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                              ))}
                            </select>
                            <button
                              onClick={() => updateUser(u.id, { active: !u.active })}
                              className={`text-[11px] px-2 py-1 border rounded transition-colors ${
                                u.active
                                  ? 'border-red-200 text-red-600 hover:bg-red-50'
                                  : 'border-green-200 text-green-600 hover:bg-green-50'
                              }`}>
                              {u.active ? 'Disable' : 'Enable'}
                            </button>
                          </div>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] text-gray-300"
                            title={isSelf ? 'แก้ไขตัวเองไม่ได้ (กัน lockout)' : `role ${myRole} แก้ ${ROLE_LABEL[u.role]} ไม่ได้`}>
                            <Lock className="w-3 h-3" /> {isSelf ? 'คุณ' : 'ล็อก'}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="text-[11px] text-gray-400 px-1 space-y-0.5">
        <div>• <strong>Admin</strong> — สิทธิ์เต็ม · จัดการได้ทุก role · approve OT</div>
        <div>• <strong>Support</strong> — เข้า console ได้ · <em>ไม่</em> approve OT · จัดการ role ใครไม่ได้ (read-only) · Manager/Coordinator แก้ Support ไม่ได้</div>
        <div>• <strong>Manager</strong> — เข้า console เต็ม · approve OT · จัดการได้แค่ Coordinator + User (ตั้งได้สูงสุด Coordinator)</div>
        <div>• <strong>Coordinator</strong> — เข้า console เต็ม · <em>ไม่</em> approve OT · แก้ได้แค่ User (เลื่อนขั้น/เพิ่มคนไม่ได้)</div>
        <div>• <strong>OT Approver</strong> — Admin หรือ Manager (หรือ position มีคำว่า "manager")</div>
        <div>• <strong>Producer (Outlet)</strong> — ติด tag outlet ที่ user คนนี้เป็น Producer · เป็นแหล่งข้อมูล dropdown Producer ในฟอร์มจอง (<code className="font-mono">GET /api/producers</code>) · ไม่มีผลต่อสิทธิ์เข้าระบบ</div>
        <div>• <strong>canUpload</strong> — ควบคุมที่ Admin → Team (role = video / sound) · Admin bypass อัตโนมัติ</div>
      </div>
    </div>
  )
}

// ── Test Email Button ─────────────────────────────────────────────────────────
function TestEmailButton() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string; hint?: string } | null>(null)

  const send = async () => {
    setLoading(true); setResult(null)
    try {
      const res = await fetch('/api/admin/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (res.ok) {
        setResult({ ok: true, msg: `✓ ส่งถึง ${data.sentTo} via ${data.provider || data.config?.provider || 'email'}` })
      } else {
        setResult({ ok: false, msg: `${data.error || 'Failed'}: ${data.detail || ''}`, hint: data.hint })
      }
    } catch (e: any) {
      setResult({ ok: false, msg: e?.message || 'Network error' })
    } finally {
      setLoading(false)
      setTimeout(() => setResult(null), 20000)
    }
  }

  return (
    <div className="relative">
      <button onClick={send} disabled={loading}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 text-gray-600">
        <Mail className="w-3.5 h-3.5" />
        {loading ? 'กำลังส่ง…' : 'Test Email'}
      </button>
      {result && (
        <div className={`absolute right-0 top-8 z-10 text-[11px] p-2 rounded border shadow-sm bg-white min-w-[220px] ${
          result.ok ? 'border-green-200 text-green-700' : 'border-red-200 text-red-600'
        }`}>
          <div>{result.msg}</div>
          {result.hint && <div className="mt-1 text-gray-500">{result.hint}</div>}
        </div>
      )}
    </div>
  )
}
