'use client'

import { useEffect, useState, use } from 'react'
import Link from 'next/link'
import { formatDisplayDate, shootTypeLabel } from '@/lib/utils'
import { ArrowLeft, Mail, CheckCircle2, Loader2 } from 'lucide-react'

interface Episode { id: string; episodeId: string; title: string }
interface BookingDetail {
  id: string; shootDate: string; callTime: string; estimatedWrap?: string
  status: string; shootType: string; locationName?: string
  producer: string; creative: string[]; crewRequired: string[]
  assignedEmails: string[]; agencyRef?: string; notes?: string; adminNotes?: string
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
  calendarEventId?: string
}

const TEAM_MEMBERS = [
  { name: 'Videographer 1', email: process.env.NEXT_PUBLIC_VG1_EMAIL || '' },
  { name: 'Videographer 2', email: process.env.NEXT_PUBLIC_VG2_EMAIL || '' },
].filter(m => m.email)

export default function AdminEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [booking, setBooking] = useState<BookingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [assignEmails, setAssignEmails] = useState<string[]>([])
  const [customEmail, setCustomEmail] = useState('')
  const [adminNotes, setAdminNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [approving, setApproving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [approved, setApproved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`/api/bookings/${id}`)
      .then(r => r.json())
      .then(d => {
        setBooking(d.booking)
        setAssignEmails(d.booking.assignedEmails || [])
        setAdminNotes(d.booking.adminNotes || '')
      })
      .finally(() => setLoading(false))
  }, [id])

  const toggleEmail = (email: string) =>
    setAssignEmails(prev => prev.includes(email) ? prev.filter(e => e !== email) : [...prev, email])

  const addCustomEmail = () => {
    if (customEmail && !assignEmails.includes(customEmail)) {
      setAssignEmails(prev => [...prev, customEmail])
      setCustomEmail('')
    }
  }

  const handleAssign = async () => {
    setError('')
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/${id}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignedEmails: assignEmails, adminNotes }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setBooking(prev => prev ? { ...prev, status: 'ASSIGNED', assignedEmails: data.booking.assignedEmails } : prev)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleApprove = async () => {
    if (!confirm('Approve? A Google Calendar event will be created and the booking will be confirmed.')) return
    setError('')
    setApproving(true)
    try {
      const res = await fetch(`/api/admin/${id}/approve`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setBooking(prev => prev ? { ...prev, status: 'CONFIRMED', calendarEventId: data.calendarEventId } : prev)
      setApproved(true)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setApproving(false)
    }
  }

  if (loading) return <div className="flex items-center justify-center min-h-96"><Loader2 className="w-8 h-8 animate-spin text-gray-400" /></div>
  if (!booking) return <div className="max-w-2xl mx-auto px-4 py-20 text-center text-gray-500">Booking not found.</div>

  const isConfirmed = booking.status === 'CONFIRMED' || approved

  return (
    <div className="max-w-[640px] mx-auto px-4 py-8 space-y-3">

      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-2">
        <ArrowLeft className="w-4 h-4" /> Admin Console
      </Link>

      {/* Header card */}
      <div className="gf-header p-6">
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            isConfirmed ? 'bg-green-100 text-green-700' :
            booking.status === 'ASSIGNED' ? 'bg-yellow-100 text-yellow-700' :
            'bg-red-100 text-red-700'
          }`}>
            {isConfirmed ? '✓ CONFIRMED' : booking.status === 'ASSIGNED' ? 'ASSIGNED' : '[REQUESTED]'}
          </span>
        </div>
        <h1 className="text-2xl font-normal text-gray-800">
          {booking.outlet.name} · {booking.program.name}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          {formatDisplayDate(booking.shootDate)} · {booking.callTime}
          {booking.estimatedWrap && ` → ${booking.estimatedWrap}`}
          {' · '}{shootTypeLabel(booking.shootType)}
          {booking.locationName && ` @ ${booking.locationName}`}
        </p>
      </div>

      {error && <div className="gf-card p-4 text-sm text-red-600 border-l-4 border-red-400">{error}</div>}
      {saved && <div className="gf-card p-4 text-sm text-green-600 border-l-4 border-green-400">✓ Saved — emails sent to assigned crew</div>}
      {approved && <div className="gf-card p-4 text-sm text-green-600 border-l-4 border-green-400">✓ Approved — Google Calendar event created</div>}

      {/* Episode IDs */}
      <div className="gf-card p-5">
        <div className="text-xs text-gray-500 font-medium mb-2 uppercase tracking-wide">Episode IDs</div>
        {booking.episodes.map(ep => (
          <div key={ep.id} className="flex items-center gap-3 py-1.5">
            <span className="episode-badge">{ep.episodeId}</span>
            <span className="text-sm text-gray-700">{ep.title}</span>
          </div>
        ))}
      </div>

      {/* Booking info */}
      <div className="gf-card p-5 grid grid-cols-2 gap-3 text-sm">
        <div><div className="text-xs text-gray-400 mb-0.5">Producer</div><div className="text-gray-800">{booking.producer}</div></div>
        <div><div className="text-xs text-gray-400 mb-0.5">Crew Requested</div><div className="text-gray-800">{booking.crewRequired.join(', ') || '—'}</div></div>
        <div><div className="text-xs text-gray-400 mb-0.5">Creative/Host</div><div className="text-gray-800">{booking.creative.join(', ') || '—'}</div></div>
        <div><div className="text-xs text-gray-400 mb-0.5">Agency Ref</div><div className="text-gray-800">{booking.agencyRef || '—'}</div></div>
        {booking.notes && <div className="col-span-2"><div className="text-xs text-gray-400 mb-0.5">Notes</div><div className="text-gray-800">{booking.notes}</div></div>}
      </div>

      {/* EDIT: Assign crew */}
      {!isConfirmed && (
        <div className="gf-card p-5 space-y-4">
          <div className="text-sm font-medium text-gray-700 border-b border-gray-100 pb-2 flex items-center gap-2">
            <Mail className="w-4 h-4 text-[#673ab7]" /> ASSIGN TEAM MEMBERS
          </div>

          {/* Preset team members */}
          {TEAM_MEMBERS.length > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-2">Team Members</div>
              {TEAM_MEMBERS.map(m => (
                <label key={m.email} className="gf-option">
                  <input type="checkbox" checked={assignEmails.includes(m.email)}
                    onChange={() => toggleEmail(m.email)} className="accent-[#673ab7]" />
                  <span className="text-sm text-gray-700">{m.name} <span className="text-gray-400 text-xs">({m.email})</span></span>
                </label>
              ))}
            </div>
          )}

          {/* Custom email input */}
          <div>
            <div className="text-xs text-gray-500 mb-2">Add by Email</div>
            <div className="flex gap-2">
              <input
                type="email"
                className="gf-input flex-1"
                placeholder="crew@thestandard.co"
                value={customEmail}
                onChange={e => setCustomEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addCustomEmail())}
              />
              <button type="button" onClick={addCustomEmail}
                className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">Add</button>
            </div>
          </div>

          {/* Assigned list */}
          {assignEmails.length > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-1">Will receive email:</div>
              <div className="flex flex-wrap gap-1">
                {assignEmails.map(e => (
                  <span key={e} className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded border border-blue-200">
                    {e}
                    <button onClick={() => setAssignEmails(prev => prev.filter(x => x !== e))} className="text-blue-400 hover:text-red-500">×</button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Admin notes */}
          <div>
            <div className="text-xs text-gray-500 mb-1">Admin Notes (sent in email)</div>
            <textarea className="gf-input resize-none" rows={2} placeholder="Additional instructions for crew..."
              value={adminNotes} onChange={e => setAdminNotes(e.target.value)} />
          </div>

          <button onClick={handleAssign} disabled={saving}
            className="px-4 py-2 text-sm border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white transition-colors disabled:opacity-50">
            {saving ? 'Saving…' : 'Save & Send Email'}
          </button>
        </div>
      )}

      {/* APPROVE */}
      {!isConfirmed && (
        <div className="gf-card p-5">
          <div className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-green-600" /> APPROVE BOOKING
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Approving will create a Google Calendar event and confirm the booking.
            {booking.assignedEmails.length === 0 && (
              <span className="text-yellow-600"> No crew assigned yet — you can still approve.</span>
            )}
          </p>
          <button onClick={handleApprove} disabled={approving}
            className="gf-submit flex items-center gap-2">
            {approving ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating Calendar Event…</> : '✓ Approve & Add to Calendar'}
          </button>
        </div>
      )}

      {/* Confirmed state */}
      {isConfirmed && (
        <div className="gf-card p-5 border-l-4 border-green-400">
          <div className="flex items-center gap-2 text-green-700 font-medium mb-2">
            <CheckCircle2 className="w-5 h-5" /> Booking Confirmed
          </div>
          {booking.calendarEventId && (
            <p className="text-sm text-gray-600">Calendar event created · ID: <code className="text-xs">{booking.calendarEventId}</code></p>
          )}
        </div>
      )}
    </div>
  )
}
