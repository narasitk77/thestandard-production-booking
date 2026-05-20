'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { OUTLETS, CREW_OPTIONS } from '@/lib/data'
import { LOCATIONS, LOCATION_GROUPS, locationNeedsManualText, findLocation } from '@/lib/locations'

type ProjectOption = {
  projectId: string
  projectName: string
  producer?: string
}

// Producer / Director — sourced from the Dashboard "_Users" tab.
type Person = { email: string; nickname: string }

const CATEGORIES = ['Original Content', 'Advertorial', 'Event', 'Internal']
const SHOOT_TYPES = ['Studio', 'On Location', 'Event']
const SHOOT_TYPE_VALUES: Record<string, string> = {
  'Studio': 'STUDIO',
  'On Location': 'ON_LOCATION',
  'Event': 'EVENT',
}
const CATEGORY_VALUES: Record<string, string> = {
  'Original Content': 'ORIGINAL_CONTENT',
  'Advertorial': 'ADVERTORIAL',
  'Event': 'EVENT',
  'Internal': 'INTERNAL',
}

export default function BookingForm() {
  const router = useRouter()

  const [outletCode, setOutletCode] = useState('')
  const [programCode, setProgramCode] = useState('')
  const [shootDate, setShootDate] = useState('')
  const [shootEndDate, setShootEndDate] = useState('')
  const [category, setCategory] = useState('Original Content')
  const [shootType, setShootType] = useState('Studio')
  const [locationId, setLocationId] = useState('')
  const [locationCustom, setLocationCustom] = useState('')
  const [callTime, setCallTime] = useState('')
  const [estimatedWrap, setEstimatedWrap] = useState('')
  const [producerEmail, setProducerEmail] = useState('')
  const [directorEmail, setDirectorEmail] = useState('')
  // Non-Content-Agency outlets: producer entered as free text.
  const [producerName, setProducerName] = useState('')
  const [producerPhone, setProducerPhone] = useState('')
  const [producerEmailText, setProducerEmailText] = useState('')
  const [creative, setCreative] = useState('')
  const [crew, setCrew] = useState<string[]>([])
  // จำนวน Videographer (ช่างภาพ) ที่ขอ — ใช้ได้เมื่อ Videographer อยู่ใน CREW REQUIRED
  const [videographerCount, setVideographerCount] = useState(1)
  const [agencyRef, setAgencyRef] = useState('')
  const [projectId, setProjectId] = useState('')
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [producers, setProducers] = useState<Person[]>([])
  const [directors, setDirectors] = useState<Person[]>([])
  const [peopleLoading, setPeopleLoading] = useState(true)
  const [notes, setNotes] = useState('')

  // Load Project ID dropdown options from Producer Dashboard
  useEffect(() => {
    let cancelled = false
    fetch('/api/projects')
      .then(r => r.ok ? r.json() : { projects: [] })
      .then(data => {
        if (!cancelled) setProjectOptions(data.projects || [])
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setProjectsLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // Load Producer / Director options from Dashboard "_Users" tab
  useEffect(() => {
    let cancelled = false
    fetch('/api/people')
      .then(r => r.ok ? r.json() : { producers: [], directors: [] })
      .then(data => {
        if (!cancelled) {
          setProducers(data.producers || [])
          setDirectors(data.directors || [])
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setPeopleLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const selectedProject = projectOptions.find(p => p.projectId === projectId)
  // Project picker is filtered by the selected Producer (Content Agency only):
  // if the user picked ไนซ์, the dropdown shows only ไนซ์'s projects.
  // Producer match is on the nickname (case/whitespace-tolerant).
  const selectedProducerNickname = (
    producers.find(p => p.email === producerEmail)?.nickname || ''
  ).trim().toLowerCase()
  const visibleProjects = selectedProducerNickname
    ? projectOptions.filter(p => (p.producer || '').trim().toLowerCase() === selectedProducerNickname)
    : projectOptions
  const [epCount, setEpCount] = useState(1)
  const [epTitles, setEpTitles] = useState<string[]>([''])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const selectedOutlet = OUTLETS.find(o => o.code === outletCode)
  // Hide single-char "Episode-Type" program codes (L/S/A/T on AGN) from the
  // Program dropdown — those are only used as programCode aliases when a
  // project-linked booking sends the chosen Episode Type to the backend.
  // Show ONLY the universal Episode Type picks (L / S / A / T). The longer
  // legacy show codes (DTW, MNW, EVT, etc.) stay in data.ts for backward
  // compat with old bookings but never appear in the dropdown.
  const programs = (selectedOutlet?.programs ?? []).filter(p => p.code.length === 1)
  // Content Agency (AGN) books people from the Dashboard _Users tab; every
  // other outlet types the producer in by hand and has no Director field.
  const isContentAgency = outletCode === 'AGN'

  const handleOutletChange = (code: string) => {
    setOutletCode(code)
    setProgramCode('')
    // Producer/Director inputs differ per outlet — reset so stale values
    // from the previous outlet's input shape don't carry over.
    setProducerEmail('')
    setDirectorEmail('')
    setProducerName('')
    setProducerPhone('')
    setProducerEmailText('')
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
    if (!outletCode || !programCode || !shootDate || !shootEndDate) {
      setError('Please fill in all required fields.')
      return
    }
    if (isContentAgency) {
      if (!producerEmail || !directorEmail) {
        setError('Please select a Producer and Director.')
        return
      }
    } else if (!producerName.trim() || !producerPhone.trim() || !producerEmailText.trim()) {
      setError('Please fill in the Producer name, phone, and email.')
      return
    }
    if (shootEndDate && shootEndDate < shootDate) {
      setError('Shoot End Date must be on or after Shoot Date.')
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
          shootEndDate: shootEndDate || null,
          category: CATEGORY_VALUES[category],
          shootType: SHOOT_TYPE_VALUES[shootType],
          locationName: resolvedLocationName,
          callTime,
          estimatedWrap: estimatedWrap || null,
          producer: isContentAgency
            ? producers.find(p => p.email === producerEmail)?.nickname || ''
            : producerName.trim(),
          producerEmail: isContentAgency ? producerEmail : (producerEmailText.trim() || null),
          producerPhone: isContentAgency ? null : (producerPhone.trim() || null),
          director: isContentAgency
            ? directors.find(d => d.email === directorEmail)?.nickname || ''
            : null,
          directorEmail: isContentAgency ? directorEmail : null,
          creative: creative ? creative.split(',').map(s => s.trim()).filter(Boolean) : [],
          crewRequired: crew,
          videographerCount: crew.includes('Videographer') ? videographerCount : 1,
          agencyRef: agencyRef || null,
          projectId: projectId || null,
          projectName: selectedProject?.projectName || null,
          // For Content Agency + Project, the chosen Episode Type (programCode)
          // also identifies the L/S/A/T series the Web App should mint into.
          episodeType: (isContentAgency && projectId && programCode.length === 1) ? programCode : null,
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

  const isAdvertorial = category === 'Advertorial'

  return (
    <div className="max-w-[640px] mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3">

      {/* Header card */}
      <div className="gf-header p-4 sm:p-6">
        <h1 className="text-2xl sm:text-3xl font-normal text-gray-800 mb-1">PRODUCTION BOOKING</h1>
        <p className="text-xs sm:text-sm text-gray-500">ระบบการ Booking การผลิตของ THE STANDARD</p>
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
        <div className="gf-section">
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

        {/* EPISODE TYPE — universal picker (L / S / A / T) used for every
            outlet and every booking. Replaces the old per-outlet Program
            dropdown. Codes align with the Dashboard sheet so the same
            classification flows form → app → sheet. */}
        <div className="gf-section">
          <label className="gf-label">
            EPISODE TYPE <span className="gf-required">*</span>
          </label>
          <div className="relative">
            <select
              className="gf-select pr-6"
              value={programCode}
              onChange={e => setProgramCode(e.target.value)}
              required
              disabled={!outletCode}
            >
              <option value="">{outletCode ? '— Select Episode Type —' : '— Select Outlet first —'}</option>
              {programs.map(p => (
                <option key={p.code} value={p.code}>
                  {p.code} · {p.name}
                </option>
              ))}
            </select>
            <span className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none text-xs">▾</span>
          </div>
        </div>

        {/* SHOOT DATE / END DATE */}
        <div className="gf-section grid grid-cols-2 gap-6">
          <div>
            <label className="gf-label">
              SHOOT DATE <span className="gf-required">*</span>
            </label>
            <input
              type="date"
              className="gf-input"
              value={shootDate}
              onChange={e => {
                const v = e.target.value
                setShootDate(v)
                // auto-fill end date to the start date; user bumps it for
                // multi-day shoots. Keeps end >= start.
                if (!shootEndDate || shootEndDate < v) setShootEndDate(v)
              }}
              min={new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]}
              required
            />
          </div>
          <div>
            <label className="gf-label">
              SHOOT END DATE <span className="gf-required">*</span>
            </label>
            <input
              type="date"
              className="gf-input"
              value={shootEndDate}
              onChange={e => setShootEndDate(e.target.value)}
              min={shootDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]}
              required
            />
            <p className="text-xs text-gray-400 mt-1">ถ่ายวันเดียว = วันเดียวกับวันเริ่ม (เติมให้อัตโนมัติ)</p>
          </div>
        </div>

        {/* CATEGORY */}
        <div className="gf-section">
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
        <div className="gf-section">
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
        <div className="gf-section">
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
                placeholder="ชื่อสถานที่ · ที่อยู่ · หรือลิงก์ Google Maps"
                value={locationCustom}
                onChange={e => setLocationCustom(e.target.value)}
                required
              />
            </div>
          )}
        </div>

        {/* TIME */}
        <div className="gf-section grid grid-cols-2 gap-6">
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
        <div className="gf-section">
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

        {/* PRODUCER — Content Agency: pick from the Dashboard _Users tab.
            Other outlets: type the name, phone and email by hand. */}
        <div className="gf-section">
          <label className="gf-label">
            PRODUCER <span className="gf-required">*</span>
          </label>
          {isContentAgency ? (
            <div className="relative">
              <select
                className="gf-select pr-6"
                value={producerEmail}
                onChange={e => {
                  setProducerEmail(e.target.value)
                  // Project is scoped to the Producer — when the Producer changes,
                  // drop the previous pick so the user can't accidentally submit
                  // a booking against a different Producer's project.
                  setProjectId('')
                }}
                required
                disabled={peopleLoading}
              >
                <option value="">
                  {peopleLoading
                    ? 'Loading…'
                    : producers.length === 0
                      ? '— No producers loaded (sheet unreachable) —'
                      : '— Select Producer —'}
                </option>
                {producers.map(p => (
                  <option key={p.email} value={p.email}>{p.nickname} ({p.email})</option>
                ))}
              </select>
              <span className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none text-xs">▾</span>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">
                  NAME <span className="gf-required">*</span>
                </label>
                <input
                  type="text"
                  className="gf-input"
                  placeholder="ชื่อ-นามสกุล โปรดิวเซอร์"
                  value={producerName}
                  onChange={e => setProducerName(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">
                  PHONE <span className="gf-required">*</span>
                </label>
                <input
                  type="tel"
                  className="gf-input"
                  placeholder="เบอร์โทรศัพท์"
                  value={producerPhone}
                  onChange={e => setProducerPhone(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">
                  EMAIL <span className="gf-required">*</span>
                </label>
                <input
                  type="email"
                  className="gf-input"
                  placeholder="email@example.com"
                  value={producerEmailText}
                  onChange={e => setProducerEmailText(e.target.value)}
                  required
                />
              </div>
            </div>
          )}
        </div>

        {/* DIRECTOR — Content Agency only (from Dashboard _Users tab) */}
        {isContentAgency && (
          <div className="gf-section">
            <label className="gf-label">
              DIRECTOR <span className="gf-required">*</span>
            </label>
            <div className="relative">
              <select
                className="gf-select pr-6"
                value={directorEmail}
                onChange={e => setDirectorEmail(e.target.value)}
                required
                disabled={peopleLoading}
              >
                <option value="">
                  {peopleLoading
                    ? 'Loading…'
                    : directors.length === 0
                      ? '— No directors loaded (sheet unreachable) —'
                      : '— Select Director —'}
                </option>
                {directors.map(d => (
                  <option key={d.email} value={d.email}>{d.nickname} ({d.email})</option>
                ))}
              </select>
              <span className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none text-xs">▾</span>
            </div>
          </div>
        )}

        {/* แขก / Subject  (formerly Creative / Host) — the people/topic being
            shot. Stored as `creative` for backward compatibility. */}
        <div className="gf-section">
          <label className="gf-label">แขก / SUBJECT</label>
          <input
            type="text"
            className="gf-input"
            placeholder="e.g. คุณ Ken, คุณแนน (คั่นด้วยจุลภาค)"
            value={creative}
            onChange={e => setCreative(e.target.value)}
          />
        </div>

        {/* CREW */}
        <div className="gf-section">
          <label className="gf-label">CREW REQUIRED</label>
          {CREW_OPTIONS.map(c => (
            <div key={c} className="flex items-center gap-3">
              <label className="gf-option flex-1 mb-0">
                <input
                  type="checkbox"
                  checked={crew.includes(c)}
                  onChange={() => toggleCrew(c)}
                  className="accent-[#673ab7]"
                />
                <span className="text-sm text-gray-700">{c}</span>
              </label>
              {c === 'Videographer' && crew.includes(c) && (
                <span className="inline-flex items-center gap-1 text-xs text-gray-500 shrink-0">
                  ×
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={videographerCount}
                    onChange={e => setVideographerCount(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                    className="w-14 border border-gray-300 rounded px-1.5 py-0.5 text-sm tabular-nums"
                  />
                  คน
                </span>
              )}
            </div>
          ))}
        </div>

        {/* PROJECT ID — links to Producer Dashboard "All Projects" */}
        <div className="gf-section">
          <label className="gf-label">
            PROJECT ID
            <span className="ml-2 text-xs font-normal text-gray-500">
              (linked to Producer Dashboard · optional but recommended)
            </span>
          </label>
          <select
            className="gf-input"
            value={projectId}
            onChange={e => setProjectId(e.target.value)}
            disabled={projectsLoading}
          >
            <option value="">
              {projectsLoading
                ? 'Loading projects…'
                : projectOptions.length === 0
                  ? '— No projects loaded (sheet unreachable) —'
                  : visibleProjects.length === 0
                    ? `— No projects for this Producer —`
                    : '— Select Project —'}
            </option>
            {visibleProjects.map(p => (
              <option key={p.projectId} value={p.projectId}>
                {p.projectId} · {p.projectName}
                {p.producer ? ` (${p.producer})` : ''}
              </option>
            ))}
          </select>
          {selectedProject && (
            <div className="mt-2 rounded bg-purple-50 px-3 py-2 text-xs text-gray-700">
              <div><strong>Project:</strong> {selectedProject.projectName}</div>
              {selectedProject.producer && (
                <div><strong>Producer:</strong> {selectedProject.producer}</div>
              )}
            </div>
          )}
        </div>

        {/* AGENCY REF (conditional) */}
        {isAdvertorial && (
          <div className="gf-section">
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
        <div className="gf-section">
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
              setOutletCode(''); setProgramCode(''); setShootDate(''); setShootEndDate('')
              setCategory('Original Content'); setShootType('Studio')
              setLocationId(''); setLocationCustom(''); setCallTime(''); setEstimatedWrap('')
              setProducerEmail(''); setDirectorEmail('')
              setProducerName(''); setProducerPhone(''); setProducerEmailText('')
              setCreative(''); setCrew([]); setVideographerCount(1)
              setAgencyRef(''); setProjectId(''); setNotes(''); setEpCount(1); setEpTitles([''])
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
