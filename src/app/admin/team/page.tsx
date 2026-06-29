'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus, Trash2, RotateCcw, Save, X, Loader2, AlertCircle } from 'lucide-react'
import { ROLE_LABEL, ROLE_ORDER, type RosterRole } from '@/lib/team-roster'

/* =============================================================================
   /admin/team — crew assignment roster manager
   Replaces the hardcoded TEAM constant in /admin/[id]/page.tsx (v1.30 and
   earlier). Admins can add/edit/deactivate members without a code deploy.
   ============================================================================= */

type Member = {
  id: string
  email: string
  name: string
  role: string
  active: boolean
  sort: number
  createdAt: string
  updatedAt: string
}

export default function TeamPage() {
  const [members, setMembers] = useState<Member[] | null>(null)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Partial<Member>>({})
  const [creating, setCreating] = useState(false)
  const [newDraft, setNewDraft] = useState<{ email: string; name: string; role: RosterRole }>({
    email: '', name: '', role: 'video',
  })
  const [showInactive, setShowInactive] = useState(false)

  const fetch_ = async () => {
    setError('')
    try {
      const res = await fetch('/api/admin/team', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setMembers(json.members || [])
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }
  useEffect(() => { fetch_() }, [])

  const beginEdit = (m: Member) => {
    setEditingId(m.id)
    setEditDraft({ name: m.name, role: m.role, active: m.active, sort: m.sort })
  }
  const cancelEdit = () => { setEditingId(null); setEditDraft({}) }

  const saveEdit = async (id: string) => {
    setError('')
    try {
      const res = await fetch(`/api/admin/team/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editDraft),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      cancelEdit()
      fetch_()
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  const deactivate = async (id: string, name: string) => {
    if (!confirm(`Deactivate ${name}? They'll be hidden from the assign UI but historical assignments stay intact.`)) return
    setError('')
    try {
      const res = await fetch(`/api/admin/team/${id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      fetch_()
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  const reactivate = async (id: string) => {
    setError('')
    try {
      const res = await fetch(`/api/admin/team/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      fetch_()
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  const createMember = async () => {
    setError('')
    if (!newDraft.email.trim() || !newDraft.name.trim()) {
      setError('Email and name are required')
      return
    }
    try {
      const res = await fetch('/api/admin/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newDraft),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setCreating(false)
      setNewDraft({ email: '', name: '', role: 'video' })
      fetch_()
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  // Group + filter for display
  const visibleMembers = (members || []).filter(m => showInactive || m.active)
  const grouped = ROLE_ORDER.map(role => ({
    role,
    members: visibleMembers.filter(m => m.role === role),
  })).filter(g => g.members.length > 0 || showInactive)

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <Link href="/admin/production-space" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3">
        <ArrowLeft className="w-4 h-4" /> Admin Console
      </Link>

      <div className="flex items-start justify-between gap-2 mb-4 flex-wrap">
        <div>
          <h1>Team Roster</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Crew that admins can assign to bookings on /admin/[id].
            Changes here take effect immediately — no redeploy needed.
            Deactivating preserves historical assignments.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={e => setShowInactive(e.target.checked)}
              className="accent-brand-primary"
            />
            Show inactive
          </label>
          <button onClick={() => setCreating(true)} className="ops-btn-primary ops-btn-sm">
            <Plus className="w-3.5 h-3.5" /> Add member
          </button>
        </div>
      </div>

      {error && (
        <div className="ops-card px-3 py-2 mb-3 text-sm text-red-700 bg-red-50 border-red-200 border-l-4 border-l-red-500 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Create new member */}
      {creating && (
        <div className="ops-card ops-card-pad mb-3">
          <div className="ops-section-title mb-3">New team member</div>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_160px] gap-3">
            <input
              className="ops-input"
              placeholder="email@thestandard.co"
              value={newDraft.email}
              onChange={e => setNewDraft({ ...newDraft, email: e.target.value })}
            />
            <input
              className="ops-input"
              placeholder="Display name (e.g. Nat · Narasit)"
              value={newDraft.name}
              onChange={e => setNewDraft({ ...newDraft, name: e.target.value })}
            />
            <select
              className="ops-input"
              value={newDraft.role}
              onChange={e => setNewDraft({ ...newDraft, role: e.target.value as RosterRole })}
            >
              {ROLE_ORDER.map(r => (
                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button onClick={() => setCreating(false)} className="ops-btn-secondary ops-btn-sm">
              Cancel
            </button>
            <button onClick={createMember} className="ops-btn-primary ops-btn-sm">
              <Save className="w-3.5 h-3.5" /> Create
            </button>
          </div>
        </div>
      )}

      {members === null && (
        <div className="ops-card ops-empty">
          <Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" />
        </div>
      )}

      {grouped.map(({ role, members: roleMembers }) => (
        <div key={role} className="ops-card overflow-hidden mb-3">
          <div className="px-4 py-2 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <div className="ops-section-title">{ROLE_LABEL[role as RosterRole]}</div>
            <div className="text-xs text-gray-500">{roleMembers.length}</div>
          </div>
          {roleMembers.length === 0 ? (
            <div className="ops-empty">No members in this role.</div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {roleMembers.map(m => {
                const isEditing = editingId === m.id
                return (
                  <li key={m.id} className={`px-4 py-3 ${!m.active ? 'opacity-60' : ''}`}>
                    {isEditing ? (
                      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_160px_auto] gap-2 items-center">
                        <input
                          className="ops-input"
                          value={editDraft.name as string}
                          onChange={e => setEditDraft({ ...editDraft, name: e.target.value })}
                          placeholder="Display name"
                        />
                        <div className="text-xs text-gray-500 sm:py-2">{m.email}</div>
                        <select
                          className="ops-input"
                          value={(editDraft.role as string) || m.role}
                          onChange={e => setEditDraft({ ...editDraft, role: e.target.value })}
                        >
                          {ROLE_ORDER.map(r => (
                            <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                          ))}
                        </select>
                        <div className="flex gap-1 justify-end">
                          <button onClick={cancelEdit} className="ops-btn-ghost ops-btn-sm" title="Cancel">
                            <X className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => saveEdit(m.id)} className="ops-btn-primary ops-btn-sm" title="Save">
                            <Save className="w-3.5 h-3.5" /> Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-gray-900 truncate">
                            {m.name}
                            {!m.active && <span className="ml-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5">inactive</span>}
                          </div>
                          <div className="text-xs text-gray-500 truncate">{m.email}</div>
                        </div>
                        <div className="flex gap-1 flex-shrink-0">
                          <button onClick={() => beginEdit(m)} className="ops-btn-ghost ops-btn-sm">Edit</button>
                          {m.active ? (
                            <button
                              onClick={() => deactivate(m.id, m.name)}
                              className="ops-btn-ghost ops-btn-sm text-red-600 hover:bg-red-50"
                              title="Deactivate (hides from assign UI; preserves history)"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <button
                              onClick={() => reactivate(m.id)}
                              className="ops-btn-ghost ops-btn-sm text-emerald-700 hover:bg-emerald-50"
                              title="Re-activate"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ))}

      {members !== null && grouped.length === 0 && (
        <div className="ops-card ops-empty">
          No team members. Click <strong>Add member</strong> above to get started.
        </div>
      )}
    </div>
  )
}
