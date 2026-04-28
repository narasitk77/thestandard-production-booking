'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { OUTLETS, PRODUCERS, CREW_OPTIONS } from '@/lib/data'
import { LOCATIONS, LOCATION_GROUPS, locationNeedsManualText, findLocation } from '@/lib/locations'

const CATEGORIES = ['Recurring', 'Agency Job', 'Service Job', 'Internal']
const SHOOT_TYPES = ['Studio', 'On Location', 'Remote / Online', 'Event']
const SHOOT_TYPE_VALUES: Record<string, string> = {
  'Studio': 'STUDIO',
  'On Location': 'ON_LOCATION',
  'Remote / Online': 'REMOTE_ONLINE',
  'Event': 'EVENT',
}
const CATEGORY_VALUES: Record<string, string> = {
  'Recurring': 'RECURRING',
  'Agency Job': 'AGENCY_JOB',
  'Service Job': 'SERVICE_JOB',
  'Internal': 'INTERNAL',
}

export default function BookingForm() {
  const router = useRouter()

  const [outletCode, setOutletCode] = useState('')
  const [programCode, setProgramCode] = useState('')
  const [shootDate, setShootDate] = useState('')
  const [category, setCategory] = useState('Recurring')
  const [shootType, setShootType] = useState('Studio')
  const [locationId, setLocationId] = useState('')
  const [locationCustom, setLocationCustom] = useState('')
  const [callTime, setCallTime] = useState('')
  const [estimatedWrap, setEstimatedWrap] = useState('')
  const [producer, setProducer] = useState('')
  const [creative, setCreative] = useState('')
  const [crew, setCrew] = useState<string[]>([])
  const [agencyRef, setAgencyRef] = useState('')
  const [notes, setNotes] = useState('')
  const [epCount, setEpCount] = useState(1)
  const [epTitles, setEpTitles] = useState<string[]>([''])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const selectedOutlet = OUTLETS.find(o => o.code === outletCode)
  const programs = selectedOutlet?.programs ?? []

  const handleOutletChange = (code: string) => {
    setOutletCode(code)
    setProgramCode('')
  }

  const handleEpCountChange = (n: number) => {
    setEpCount(n)
    setEpTitles(prev => {
      const next = [...prev]
      while (next.length < n) next.push('')
      return next.slice(0, n)
    })
  }

  const toggleCrew = (c: string) =>
    setCrew(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])

  const selectedLocation = findLocation(locationId)
  const needsCustomText = !!selectedLocation && locationNeedsManualText(selectedLocation.id)
  const resolvedLocationName = !selectedLocation
    ? null
    : needsCustomText
      ? (locationCustom ? `${selectedLocation.fullName} — ${locationCustom}` : selectedLocation.fullName)
      : selectedLocation.fullName

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!outletCode || !programCode || !shootDate || !producer) {
      setError('Please fill in all required fields.')
      return
    }
    if (!locationId) {
      setError('Please choose a Location / Room.')
      return
    }
    if (needsCustomText && !locationCustom.trim()) {
      setError('Please specify the location.')
      return
    }
    if (epTitles.some(t => !t.trim())) {
      setError('Please fill in all episode titles.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outletCode,
          programCode,
          shootDate,
          category: CATEGORY_VALUES[category],
          shootType: SHOOT_TYPE_VALUES[shootType],
          locationName: resolvedLocationName,
          callTime,
          estimatedWrap: estimatedWrap || null,
          producer,
          creative: creative ? creative.split(',').map(s => s.trim()).filter(Boolean) : [],
          crewRequired: crew,
          agencyRef: agencyRef || null,
          notes: notes || null,
          episodeTitles: epTitles.map(t => t.trim()),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      router.push(`/booking/success?id=${data.booking.id}`)
    } catch (err: any) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  const isAgency = category === 'Agency Job'

  return (
    <div className="max-w-[640px] mx-auto px-4 py-8 space-y-3">

      {/* Header card */}
      <div className="gf-header p-6">
        <h1 className="text-3xl font-normal text-gray-800 mb-1">PRODUCTION BOOKING</h1>
        <p className="text-sm text-gray-500">ระบบการ Booking การผลิตของ THE STANDARD</p>
        <div className="mt-3 pt-3 border-t border-gray-200 text-xs text-[#db4437]">
          * Indicates required question
        </div>
      </div>

      {error && (
        <div className="gf-card p-4 text-sm text-[#db4437] border-l-4 border-[#db4437]">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">

        {/* OUTLET */}
        <div className="gf-card p-6">
          <label className="gf-label">
            OUTLET <span className="gf-required">*</span>
          </label>
          <div className="relative">
            <select
              className="gf-select pr-6"
              value={outletCode}
              onChange={e => handleOutletChange(e.target.value)}
              required
            >
              <option value="">— Select Outlet —</option>
              {OUTLETS.map(o => (
                <option key={o.code} value={o.code}>{o.name}</option>
              ))}
            </select>
            <span className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none text-xs">▾</span>
          </div>
        </div>

        {/* PROGRAM */}
        <div className="gf-card p-6">
          <label className="gf-label">
            PROGRAM <span className="gf-required">*</span>
          </label>
          <div className="relative">
            <select
              className="gf-select pr-6"
              value={programCode}
              onChange={e => setProgramCode(e.target.value)}
              required
              disabled={!outletCode}
            >
              <option value="">{outletCode ? '— Select Program —' : '— Select Outlet first —'}</option>
              {programs.map(p => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none text-xs">▾</span>
          </div>
        </div>

        {/* SHOOT DATE */}
        <div className="gf-card p-6">
          <label className="gf-label">
            SHOOT DATE <span className="gf-required">*</span>
          </label>
          <input
            type="date"
            className="gf-input"
            value={shootDate}
            onChange={e => setShootDate(e.target.value)}
            min={new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]}
            required
          />
        </div>

        {/* CATEGORY */}
        <div className="gf-card p-6">
          <label className="gf-label">
            CATEGORY <span className="gf-required">*</span>
          </label>
          {CATEGORIES.map(c => (
            <label key={c} className="gf-option">
              <input
                type="radio"
                name="category"
                value={c}
                checked={category === c}
                onChange={() => setCategory(c)}
                className="accent-[#673ab7]"
              />
              <span className="text-sm text-gray-700">{c}</span>
            </label>
          ))}
        </div>

        {/* SHOOT TYPE */}
        <div className="gf-card p-6">
          <label className="gf-label">
            SHOOT TYPE <span className="gf-required">*</span>
          </label>
          {SHOOT_TYPES.map(t => (
            <label key={t} className="gf-option">
              <input
                type="radio"
                name="shootType"
                value={t}
                checked={shootType === t}
                onChange={() => setShootType(t)}
                className="accent-[#673ab7]"
              />
              <span className="text-sm text-gray-700">{t}</span>
            </label>
          ))}
        </div>

        {/* LOCATION / ROOM */}
        <div className="gf-card p-6">
          <label className="gf-label">
            LOCATION / ROOM <span className="gf-required">*</span>
          </label>
          <p className="text-xs text-gray-400 mb-3">Where the shoot happens (independent of Shoot Type above)</p>
          <select
            className="gf-input"
            value={locationId}
            onChange={e => { setLocationId(e.target.value); setLocationCustom('') }}
            required
          >
            <option value="">Choose a room / location…</option>
            {LOCATION_GROUPS.map(g => (
              <optgroup key={g.key} label={g.label}>
                {LOCATIONS.filter(l => l.group === g.key).map(l => (
                  <option key={l.id} value={l.id}>
                    {l.name}{l.capacity ? ` · cap. ${l.capacity}` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          {selectedLocation && selectedLocation.group !== 'EXTERNAL' && (
            <p className="text-xs text-gray-500 mt-2">
              📍 {selectedLocation.fullName}{selectedLocation.capacity ? ` · capacity ${selectedLocation.capacity}` : ''}
            </p>
          )}

          {needsCustomText && (
            <div className="mt-3">
              <label className="gf-label">SPECIFY LOCATION <span className="gf-required">*</span></label>
              <input
                type="text"
                className="gf-input"
                placeholder="e.g. Grand Hyatt, Client Office, BACC"
                value={locationCustom}
                onChange={e => setLocationCustom(e.target.value)}
                required
              />
            </div>
          )}
        </div>

        {/* TIME */}
        <div className="gf-card p-6 grid grid-cols-2 gap-6">
          <div>
            <label className="gf-label">
              CALL TIME <span className="gf-required">*</span>
            </label>
            <input
              type="time"
              className="gf-input"
              value={callTime}
              onChange={e => setCallTime(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="gf-label">ESTIMATED WRAP</label>
            <input
              type="time"
              className="gf-input"
              value={estimatedWrap}
              onChange={e => setEstimatedWrap(e.target.value)}
            />
          </div>
        </div>

        {/* NUMBER OF EPISODES */}
        <div className="gf-card p-6">
          <label className="gf-label">
            NUMBER OF EPISODES <span className="gf-required">*</span>
          </label>
          <div className="relative mb-4">
            <select
              className="gf-select pr-6"
              value={epCount}
              onChange={e => handleEpCountChange(Number(e.target.value))}
            >
              {Array.from({ length: 20 }, (_, i) => i + 1).map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none text-xs">▾</span>
          </div>
          {epTitles.map((title, idx) => (
            <div key={idx} className="mb-3">
              <label className="text-xs text-gray-500 mb-1 block">
                EP {idx + 1} TITLE <span className="gf-required">*</span>
              </label>
              <input
                type="text"
                className="gf-input"
                placeholder={`Episode ${idx + 1} title`}
                value={title}
                onChange={e => {
                  const next = [...epTitles]
                  next[idx] = e.target.value
                  setEpTitles(next)
                }}
                required
              />
            </div>
          ))}
        </div>

        {/* PRODUCER */}
        <div className="gf-card p-6">
          <label className="gf-label">
            PRODUCER <span className="gf-required">*</span>
          </label>
          <div className="relative">
            <select
              className="gf-select pr-6"
              value={producer}
              onChange={e => setProducer(e.target.value)}
              required
            >
              <option value="">— Select Producer —</option>
              {PRODUCERS.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <span className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none text-xs">▾</span>
          </div>
        </div>

        {/* CREATIVE / HOST */}
        <div className="gf-card p-6">
          <label className="gf-label">CREATIVE / HOST</label>
          <input
            type="text"
            className="gf-input"
            placeholder="e.g. Ken, แนน  (comma separated)"
            value={creative}
            onChange={e => setCreative(e.target.value)}
          />
        </div>

        {/* CREW */}
        <div className="gf-card p-6">
          <label className="gf-label">CREW REQUIRED</label>
          {CREW_OPTIONS.map(c => (
            <label key={c} className="gf-option">
              <input
                type="checkbox"
                checked={crew.includes(c)}
                onChange={() => toggleCrew(c)}
                className="accent-[#673ab7]"
              />
              <span className="text-sm text-gray-700">{c}</span>
            </label>
          ))}
        </div>

        {/* AGENCY REF (conditional) */}
        {isAgency && (
          <div className="gf-card p-6">
            <label className="gf-label">
              AGENCY REFERENCE <span className="gf-required">*</span>
            </label>
            <input
              type="text"
              className="gf-input"
              placeholder="e.g. QU-3108"
              value={agencyRef}
              onChange={e => setAgencyRef(e.target.value)}
              required
            />
          </div>
        )}

        {/* NOTES */}
        <div className="gf-card p-6">
          <label className="gf-label">NOTES</label>
          <textarea
            className="gf-input resize-none"
            rows={3}
            placeholder="Additional notes for the coordinator..."
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        {/* Submit */}
        <div className="flex items-center justify-between py-2">
          <button type="submit" disabled={submitting} className="gf-submit">
            {submitting ? 'Submitting...' : 'Submit'}
          </button>
          <button
            type="button"
            onClick={() => {
              setOutletCode(''); setProgramCode(''); setShootDate('')
              setCategory('Recurring'); setShootType('Studio')
              setLocationId(''); setLocationCustom(''); setCallTime(''); setEstimatedWrap('')
              setProducer(''); setCreative(''); setCrew([])
              setAgencyRef(''); setNotes(''); setEpCount(1); setEpTitles([''])
            }}
            className="text-sm text-[#673ab7] hover:underline"
          >
            Clear form
          </button>
        </div>

      </form>
    </div>
  )
}
