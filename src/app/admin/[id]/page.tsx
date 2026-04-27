'use client'

import { useEffect, useState, use } from 'react'
import Link from 'next/link'
import { formatDisplayDate, shootTypeLabel } from '@/lib/utils'
import { ArrowLeft, Mail, CheckCircle2, Loader2, UserPlus, X } from 'lucide-react'

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

interface Freelancer { id: string; name: string; contract: string; email: string }

const TEAM = {
  video: [
    { name: 'Bird · Nuttapong', email: 'nuttapong.k@thestandard.co' },
    { name: 'Arm · Sakdipat', email: 'sakdipat.p@thestandard.co' },
    { name: 'Noom · Thanakorn', email: 'thanakorn.s@thestandard.co' },
    { name: 'Dome · Phuridej', email: 'phuridej.p@thestandard.co' },
    { name: 'F · Panathorn', email: 'panathorn.c@thestandard.co' },
    { name: 'P · Ratchaseth', email: 'ratchaseth.c@thestandard.co' },
    { name: 'Kim · Chaiyaphat', email: 'chaiyaphat.t@thestandard.co' },
    { name: 'Tew · Watcharapol', email: 'watcharapol.c@thestandard.co' },
  ],
  director: [
    { name: 'Pook · Panu (Head Director)', email: 'panu.w@thestandard.co' },
    { name: 'Top · Tanapak', email: 'tanapak.I@thestandard.co' },
    { name: 'PAT · Worased', email: 'worased.p@thestandard.co' },
    { name: 'Paii · Panyapohn', email: 'panyapohn.s@thestandard.co' },
  ],
  sound: [
    { name: 'Art · Krittapon (Sr. Sound Eng.)', email: 'krittapon.j@thestandard.co' },
    { name: 'Note · Daejarnat', email: 'daejarnat.d@thestandard.co' },
    { name: 'Thee · Thaphat', email: 'thaphat.t@thestandard.co' },
    { name: 'Peace · Nuthkitta', email: 'nuthkitta.c@thestandard.co' },
  ],
  photo: [
    { name: 'Mod · Saluk (Photographer)', email: 'saluk.k@thestandard.co' },
  ],
  switcher: [
    { name: 'Dream · Kamonwan', email: 'kamonwan.l@thestandard.co' },
    { name: 'Ting · Jaruwan', email: 'jaruwan.k@thestandard.co' },
  ],
}

function TeamSection({ label, members, checked, onToggle }: {
  label: string
  members: { name: string; email: string }[]
  checked: string[]
  onToggle: (email: string) => void
}) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">{label}</div>
      <div className="grid grid-cols-2 gap-x-4">
        {members.map(m => (
          <label key={m.email} className="gf-option">
            <input type="checkbox" checked={checked.includes(m.email)}
              onChange={() => onToggle(m.email)} className="accent-[#673ab7]" />
            <span className="text-sm text-gray-700">{m.name}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

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

  // Freelancers
  const [freelancers, setFreelancers] = useState<Freelancer[]>([])
  const [flName, setFlName] = useState('')
  const [flContract, setFlContract] = useState('')
  const [flEmail, setFlEmail] = useState('')

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

  const addFreelancer = () => {
    if (!flName.trim()) return
    setFreelancers(prev => [...prev, {
      id: crypto.randomUUID(),
      name: flName.trim(),
      contract: flContract.trim(),
      email: flEmail.trim(),
    }])
    setFlName(''); setFlContract(''); setFlEmail('')
  }

  const removeFreelancer = (id: string) =>
    setFreelancers(prev => prev.filter(f => f.id !== id))

  const handleAssign = async () => {
    setError('')
    setSaving(true)
    try {
      // Combine staff emails + freelancer emails
      const allEmails = [
        ...assignEmails,
        ...freelancers.filter(f => f.email).map(f => f.email),
      ]

      // Append freelancer info to adminNotes
      let notes = adminNotes
      if (freelancers.length > 0) {
        const fl = freelancers.map(f =>
          `• ${f.name}${f.contract ? ` (Contract: ${f.contract})` : ''}${f.email ? ` <${f.email}>` : ''}`
        ).join('\n')
        notes = notes ? `${notes}\n\nFreelancers:\n${fl}` : `Freelancers:\n${fl}`
      }

      const res = await fetch(`/api/admin/${id}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignedEmails: allEmails, adminNotes: notes }),
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
  const totalAssigned = assignEmails.length + freelancers.length

  return (
    <div className="max-w-[680px] mx-auto px-4 py-8 space-y-3">

      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-2">
        <ArrowLeft className="w-4 h-4" /> Admin Console
      </Link>

      {/* Header */}
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

      {/* ASSIGN */}
      {!isConfirmed && (
        <div className="gf-card p-5 space-y-5">
          <div className="text-sm font-medium text-gray-700 border-b border-gray-100 pb-2 flex items-center gap-2">
            <Mail className="w-4 h-4 text-[#673ab7]" /> ASSIGN TEAM
            {totalAssigned > 0 && (
              <span className="ml-auto text-xs bg-[#673ab7] text-white px-2 py-0.5 rounded-full">{totalAssigned} assigned</span>
            )}
          </div>

          {/* Video Team */}
          <TeamSection label="Videographer" members={TEAM.video} checked={assignEmails} onToggle={toggleEmail} />
          <TeamSection label="Video Director" members={TEAM.director} checked={assignEmails} onToggle={toggleEmail} />
          <TeamSection label="Sound Team" members={TEAM.sound} checked={assignEmails} onToggle={toggleEmail} />
          <TeamSection label="Photographer" members={TEAM.photo} checked={assignEmails} onToggle={toggleEmail} />
          <TeamSection label="Switcher" members={TEAM.switcher} checked={assignEmails} onToggle={toggleEmail} />

          {/* Freelance */}
          <div>
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1">
              <UserPlus className="w-3.5 h-3.5" /> Freelance
            </div>
            <div className="grid grid-cols-3 gap-2 mb-2">
              <input className="gf-input col-span-1" placeholder="Name *"
                value={flName} onChange={e => setFlName(e.target.value)} />
              <input className="gf-input col-span-1" placeholder="Contract No."
                value={flContract} onChange={e => setFlContract(e.target.value)} />
              <input className="gf-input col-span-1" placeholder="Email (optional)"
                value={flEmail} onChange={e => setFlEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addFreelancer())} />
            </div>
            <button type="button" onClick={addFreelancer} disabled={!flName.trim()}
              className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40">
              + Add Freelancer
            </button>
            {freelancers.length > 0 && (
              <div className="mt-2 space-y-1">
                {freelancers.map(f => (
                  <div key={f.id} className="flex items-center gap-2 text-xs bg-orange-50 border border-orange-200 rounded px-2 py-1">
                    <span className="font-medium text-orange-800">{f.name}</span>
                    {f.contract && <span className="text-orange-600">#{f.contract}</span>}
                    {f.email && <span className="text-orange-500">{f.email}</span>}
                    <button onClick={() => removeFreelancer(f.id)} className="ml-auto text-orange-400 hover:text-red-500">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Custom email */}
          <div>
            <div className="text-xs text-gray-500 mb-1">Add by Email (Other)</div>
            <div className="flex gap-2">
              <input type="email" className="gf-input flex-1" placeholder="email@thestandard.co"
                value={customEmail} onChange={e => setCustomEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addCustomEmail())} />
              <button type="button" onClick={addCustomEmail}
                className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">Add</button>
            </div>
          </div>

          {/* Selected staff emails */}
          {assignEmails.length > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-1">Staff emails — will receive notification:</div>
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
            {totalAssigned === 0 && (
              <span className="text-yellow-600"> No crew assigned yet — you can still approve.</span>
            )}
          </p>
          <button onClick={handleApprove} disabled={approving}
            className="gf-submit flex items-center gap-2">
            {approving ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating Calendar Event…</> : '✓ Approve & Add to Calendar'}
          </button>
        </div>
      )}

      {/* Confirmed */}
      {isConfirmed && (
        <div className="gf-card p-5 border-l-4 border-green-400">
          <div className="flex items-center gap-2 text-green-700 font-medium mb-2">
            <CheckCircle2 className="w-5 h-5" /> Booking Confirmed
          </div>
          {booking.calendarEventId && (
            <p className="text-sm text-gray-600">Calendar event created · ID: <code className="text-xs">{booking.calendarEventId}</code></p>
          )}
          {booking.assignedEmails.length > 0 && (
            <p className="text-sm text-gray-500 mt-1">Assigned: {booking.assignedEmails.join(', ')}</p>
          )}
        </div>
      )}
    </div>
  )
}
