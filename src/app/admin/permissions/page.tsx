'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, Shield, ShieldOff, UserPlus } from 'lucide-react'

interface User {
  id: string
  email: string
  name: string | null
  role: 'USER' | 'ADMIN'
  active: boolean
  createdAt: string
}

export default function PermissionsPage() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState<'USER' | 'ADMIN'>('USER')
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    const res = await fetch('/api/admin/users')
    const data = await res.json()
    if (res.ok) setUsers(data.users)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const updateUser = async (id: string, patch: Partial<User>) => {
    setError('')
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error); return }
    setUsers(prev => prev.map(u => u.id === id ? data.user : u))
  }

  const addUser = async () => {
    if (!newEmail) return
    setError('')
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: newEmail, role: newRole }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error); return }
    setNewEmail(''); setNewRole('USER')
    load()
  }

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-2">
        <ArrowLeft className="w-4 h-4" /> Admin Console
      </Link>

      <div className="gf-header p-6">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <h1 className="text-2xl font-normal text-gray-800">Permissions</h1>
            <p className="text-sm text-gray-500 mt-1">Manage who can access the admin console</p>
          </div>
          <TestEmailButton />
        </div>
      </div>

      {error && <div className="gf-card p-3 text-sm text-red-600 border-l-4 border-red-400">{error}</div>}

      {/* Add user */}
      <div className="gf-card p-4 sm:p-5">
        <div className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-[#673ab7]" /> Add / Update User
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input type="email" className="gf-input flex-1" placeholder="email@thestandard.co"
            value={newEmail} onChange={e => setNewEmail(e.target.value)} />
          <div className="flex gap-2">
            <select className="gf-input flex-1 sm:flex-none" value={newRole} onChange={e => setNewRole(e.target.value as any)}>
              <option value="USER">User</option>
              <option value="ADMIN">Admin</option>
            </select>
            <button onClick={addUser} disabled={!newEmail}
              className="px-4 py-1 text-sm border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white disabled:opacity-40">
              Save
            </button>
          </div>
        </div>
      </div>

      {/* Users list */}
      <div className="gf-card p-4 sm:p-5">
        <div className="text-sm font-medium text-gray-700 mb-3">Users ({users.length})</div>
        {loading ? (
          <div className="py-8 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
        ) : users.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">No users yet. Anyone who signs in will be added automatically.</p>
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
          <table className="w-full text-sm min-w-[500px]">
            <thead className="border-b border-gray-100">
              <tr className="text-xs text-gray-400 uppercase tracking-wide">
                <th className="text-left py-2">Email</th>
                <th className="text-left py-2">Role</th>
                <th className="text-left py-2">Status</th>
                <th className="text-right py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map(u => (
                <tr key={u.id}>
                  <td className="py-3 text-gray-800">{u.email}</td>
                  <td className="py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      u.role === 'ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      u.active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}>
                      {u.active ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td className="py-3 text-right">
                    <div className="inline-flex gap-2">
                      <button
                        onClick={() => updateUser(u.id, { role: u.role === 'ADMIN' ? 'USER' : 'ADMIN' })}
                        className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
                        {u.role === 'ADMIN' ? <><ShieldOff className="w-3 h-3" /> Demote</> : <><Shield className="w-3 h-3" /> Make Admin</>}
                      </button>
                      <button
                        onClick={() => updateUser(u.id, { active: !u.active })}
                        className={`text-xs px-2 py-1 border rounded ${
                          u.active ? 'border-red-200 text-red-600 hover:bg-red-50' : 'border-green-200 text-green-600 hover:bg-green-50'
                        }`}>
                        {u.active ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  )
}

function TestEmailButton() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const send = async () => {
    setLoading(true); setResult(null)
    try {
      const res = await fetch('/api/admin/test-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      const data = await res.json()
      if (res.ok) setResult({ ok: true, msg: `✓ Sent to ${data.sentTo} (${data.config?.host}:${data.config?.port})` })
      else setResult({ ok: false, msg: `${data.error || 'Failed'}: ${data.detail || ''} [${data.code || ''}]` })
    } catch (e: any) {
      setResult({ ok: false, msg: e?.message || 'Network error' })
    } finally {
      setLoading(false)
      setTimeout(() => setResult(null), 12000)
    }
  }

  return (
    <div className="text-right">
      <button onClick={send} disabled={loading}
        className="text-xs px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50">
        {loading ? 'Testing…' : '✉︎ Test SMTP'}
      </button>
      {result && (
        <div className={`text-[11px] mt-1 max-w-xs ${result.ok ? 'text-green-700' : 'text-red-600'}`}>
          {result.msg}
        </div>
      )}
    </div>
  )
}
