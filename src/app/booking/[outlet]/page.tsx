'use client'

import { useState, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { OUTLETS, PRODUCERS, CREW_OPTIONS, CATEGORY_OPTIONS, SHOOT_TYPE_OPTIONS } from '@/lib/data'
import { ArrowLeft, Plus, Trash2, Loader2, ChevronRight } from 'lucide-react'

interface EpisodeInput {
  title: string
}

export default function BookingPage({ params }: { params: Promise<{ outlet: string }> }) {
  const { outlet: outletParam } = use(params)
  const router = useRouter()

  const outletCode = outletParam.toUpperCase()
  const outlet = OUTLETS.find(o => o.code === outletCode)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [shootDate, setShootDate] = useState('')
  const [category, setCategory] = useState('RECURRING')
  const [programCode, setProgramCode] = useState('')
  const [shootType, setShootType] = useState('STUDIO')
  const [locationName, setLocationName] = useState('')
  const [callTime, setCallTime] = useState('09:00')
  const [estimatedWrap, setEstimatedWrap] = useState('')
  const [producer, setProducer] = useState('')
  const [creative, setCreative] = useState('')
  const [crewRequired, setCrewRequired] = useState<string[]>([])
  const [agencyRef, setAgencyRef] = useState('')
  const [notes, setNotes] = useState('')
  const [episodes, setEpisodes] = useState<EpisodeInput[]>([{ title: '' }])

  if (!outlet) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-20 text-center">
        <div className="text-4xl mb-4">404</div>
        <p className="text-brand-gray-500 mb-4">Outlet "{outletParam}" not found.</p>
        <Link href="/" className="btn-primary">← Back to Home</Link>
      </div>
    )
  }

  const handleCrewToggle = (crew: string) => {
    setCrewRequired(prev =>
      prev.includes(crew) ? prev.filter(c => c !== crew) : [...prev, crew]
    )
  }

  const addEpisode = () => {
    if (episodes.length < 20) {
      setEpisodes(prev => [...prev, { title: '' }])
    }
  }

  const removeEpisode = (idx: number) => {
    if (episodes.length > 1) {
      setEpisodes(prev => prev.filter((_, i) => i !== idx))
    }
  }

  const updateEpisode = (idx: number, title: string) => {
    setEpisodes(prev => prev.map((ep, i) => (i === idx ? { title } : ep)))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!shootDate || !programCode || !producer || episodes.some(ep => !ep.title.trim())) {
      setError('Please fill in all required fields and episode titles.')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outletCode,
          programCode,
          shootDate,
          category,
          shootType,
          locationName: locationName || null,
          callTime,
          estimatedWrap: estimatedWrap || null,
          producer,
          creative: creative ? creative.split(',').map(s => s.trim()).filter(Boolean) : [],
          crewRequired,
          agencyRef: agencyRef || null,
          notes: notes || null,
          episodeTitles: episodes.map(ep => ep.title.trim()),
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create booking')

      router.push(`/booking/success?id=${data.booking.id}`)
    } catch (err: any) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  const needsLocation = shootType !== 'STUDIO'
  const isAgency = category === 'AGENCY_JOB'

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-brand-gray-500 hover:text-brand-black mb-4">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${outlet.bgColor} ${outlet.color} border ${outlet.borderColor} mb-3`}>
          <span className="font-mono font-bold">{outlet.code}</span>
          <span>{outlet.name}</span>
        </div>
        <h1 className="text-2xl font-bold text-brand-black">New Booking</h1>
        <p className="text-sm text-brand-gray-500 mt-1">
          กรอกข้อมูลให้ครบ — Episode ID จะถูก generate อัตโนมัติ
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Section 1: Basic */}
        <div className="card p-5 space-y-4">
          <h2 className="font-semibold text-sm text-brand-gray-700 border-b border-brand-gray-100 pb-2">
            1 · Basic Info
          </h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Shoot Date <span className="text-red-500">*</span></label>
              <input
                type="date"
                className="input"
                value={shootDate}
                onChange={e => setShootDate(e.target.value)}
                min={new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]}
                required
              />
            </div>
            <div>
              <label className="label">Category <span className="text-red-500">*</span></label>
              <select className="input" value={category} onChange={e => setCategory(e.target.value)} required>
                {CATEGORY_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Program <span className="text-red-500">*</span></label>
            <select
              className="input"
              value={programCode}
              onChange={e => setProgramCode(e.target.value)}
              required
            >
              <option value="">— Select Program —</option>
              {outlet.programs.map(p => (
                <option key={p.code} value={p.code}>
                  [{p.code}] {p.name}
                  {p.notes ? ` · ${p.notes}` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Section 2: Location */}
        <div className="card p-5 space-y-4">
          <h2 className="font-semibold text-sm text-brand-gray-700 border-b border-brand-gray-100 pb-2">
            2 · Shoot Details
          </h2>

          <div>
            <label className="label">Shoot Type <span className="text-red-500">*</span></label>
            <div className="grid grid-cols-2 gap-2">
              {SHOOT_TYPE_OPTIONS.map(opt => (
                <label
                  key={opt.value}
                  className={`flex items-center gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${
                    shootType === opt.value
                      ? 'border-brand-black bg-brand-black text-white'
                      : 'border-brand-gray-200 hover:border-brand-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="shootType"
                    value={opt.value}
                    checked={shootType === opt.value}
                    onChange={e => setShootType(e.target.value)}
                    className="sr-only"
                  />
                  <span className="text-sm">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          {needsLocation && (
            <div>
              <label className="label">Location Name <span className="text-red-500">*</span></label>
              <input
                type="text"
                className="input"
                placeholder="e.g., Studio B, Client Office, Grand Hyatt"
                value={locationName}
                onChange={e => setLocationName(e.target.value)}
                required={needsLocation}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Call Time <span className="text-red-500">*</span></label>
              <input
                type="time"
                className="input"
                value={callTime}
                onChange={e => setCallTime(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">Estimated Wrap</label>
              <input
                type="time"
                className="input"
                value={estimatedWrap}
                onChange={e => setEstimatedWrap(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Section 3: Episodes */}
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-brand-gray-100 pb-2">
            <h2 className="font-semibold text-sm text-brand-gray-700">
              3 · Episodes ({episodes.length})
            </h2>
            {programCode && shootDate && (
              <div className="text-xs text-brand-gray-400 font-mono">
                {outletCode}-{shootDate.replace(/-/g, '').slice(2)}-{programCode}-XX
              </div>
            )}
          </div>

          <div className="space-y-2">
            {episodes.map((ep, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="text-xs text-brand-gray-400 font-mono w-6 text-right flex-shrink-0">
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <input
                  type="text"
                  className="input flex-1"
                  placeholder={`EP ${idx + 1} Title`}
                  value={ep.title}
                  onChange={e => updateEpisode(idx, e.target.value)}
                  required
                />
                {episodes.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeEpisode(idx)}
                    className="p-2 text-brand-gray-400 hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={addEpisode}
            disabled={episodes.length >= 20}
            className="btn-secondary w-full justify-center text-xs"
          >
            <Plus className="w-3.5 h-3.5" /> Add Episode
          </button>
        </div>

        {/* Section 4: Crew & Notes */}
        <div className="card p-5 space-y-4">
          <h2 className="font-semibold text-sm text-brand-gray-700 border-b border-brand-gray-100 pb-2">
            4 · Crew & Notes
          </h2>

          <div>
            <label className="label">Producer <span className="text-red-500">*</span></label>
            <select className="input" value={producer} onChange={e => setProducer(e.target.value)} required>
              <option value="">— Select Producer —</option>
              {PRODUCERS.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Creative / Host</label>
            <input
              type="text"
              className="input"
              placeholder="e.g., Ken, แนน (comma separated)"
              value={creative}
              onChange={e => setCreative(e.target.value)}
            />
          </div>

          <div>
            <label className="label">Crew Required</label>
            <div className="flex flex-wrap gap-2">
              {CREW_OPTIONS.map(crew => (
                <button
                  key={crew}
                  type="button"
                  onClick={() => handleCrewToggle(crew)}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                    crewRequired.includes(crew)
                      ? 'bg-brand-black text-white border-brand-black'
                      : 'bg-white text-brand-gray-600 border-brand-gray-200 hover:border-brand-gray-300'
                  }`}
                >
                  {crew}
                </button>
              ))}
            </div>
          </div>

          {isAgency && (
            <div>
              <label className="label">Agency Reference <span className="text-red-500">*</span></label>
              <input
                type="text"
                className="input"
                placeholder="e.g., QU-3108"
                value={agencyRef}
                onChange={e => setAgencyRef(e.target.value)}
                required={isAgency}
              />
              <p className="text-xs text-brand-gray-400 mt-1">
                Agency Ref เก็บเป็น field แยก — ไม่ใช่ตัว Episode ID
              </p>
            </div>
          )}

          <div>
            <label className="label">Notes</label>
            <textarea
              className="input resize-none"
              rows={3}
              placeholder="Additional notes for coordinator..."
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>
        </div>

        {/* Submit */}
        <div className="flex items-center justify-between pt-2">
          <Link href="/" className="btn-secondary">Cancel</Link>
          <button type="submit" disabled={loading} className="btn-primary px-6">
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating Booking...
              </>
            ) : (
              <>
                Submit Booking
                <ChevronRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  )
}
