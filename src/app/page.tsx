'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, ChevronRight, ChevronLeft } from 'lucide-react'
import { OUTLETS, CREW_OPTIONS } from '@/lib/data'
import { LOCATIONS, LOCATION_GROUPS, locationNeedsManualText, findLocation } from '@/lib/locations'

type ProjectOption = {
  projectId: string
  projectName: string
  producer?: string
}

// Producer / Director — sourced from the Dashboard "_Users" tab.
type Person = { email: string; nickname: string }

// An existing episode of a project (from the "_EPs" tab), Published ones excluded.
type ProjectEpisode = {
  episodeId: string
  type: string
  status: string
  ep: string
  productCode: string
  projectName: string
}

const CATEGORIES = ['Original Content', 'Advertorial', 'Event', 'Internal']
const VIDEO_TYPES = [
  'Teaser / Highlight',
  'Vlog / On Location',
  'Report (Host + Insert)',
  'Interview',
  'Documentary',
  'Commercial',
  'Others',
]
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

type FormStep = 'form' | 'review'

// Numbered section header used to chunk the long form into 6 named groups.
// Kept compact — this is an internal tool, not a marketing landing.
function SectionHeader({ index, title, hint }: { index: number; title: string; hint?: string }) {
  return (
    <div className="pt-4 pb-1 px-1 mt-2 first:mt-0">
      <div className="flex items-baseline gap-2">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-200 text-[10px] font-mono font-medium text-gray-600 tabular-nums">{index}</span>
        <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">{title}</h2>
      </div>
      {hint && <p className="text-xs text-gray-400 mt-1 ml-7 leading-snug">{hint}</p>}
    </div>
  )
}

function FieldHelp({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-gray-500 mt-2 leading-snug">{children}</p>
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return (
    <p className="mt-2 text-xs text-[#db4437] flex items-start gap-1">
      <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
      <span>{message}</span>
    </p>
  )
}

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-2 text-sm">
      <div className="text-xs text-gray-500 uppercase tracking-wide pt-0.5">{label}</div>
      <div className="text-gray-800 break-words">
        {value === null || value === undefined || value === '' ? <span className="text-gray-400">—</span> : value}
      </div>
    </div>
  )
}

function ReviewSection({ index, title, children }: { index: number; title: string; children: React.ReactNode }) {
  return (
    <div className="gf-section">
      <div className="flex items-baseline gap-2 mb-2 pb-2 border-b border-gray-100">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-200 text-[10px] font-mono font-medium text-gray-600 tabular-nums">{index}</span>
        <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">{title}</h3>
      </div>
      <div className="divide-y divide-gray-100">{children}</div>
    </div>
  )
}

export default function BookingForm() {
  const router = useRouter()
  const [step, setStep] = useState<FormStep>('form')

  const [outletCode, setOutletCode] = useState('')
  const [programCode, setProgramCode] = useState('')
  const [shootDate, setShootDate] = useState('')
  const [shootEndDate, setShootEndDate] = useState('')
  const [category, setCategory] = useState('Original Content')
  const [videoType, setVideoType] = useState('')
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
  const [videographerCount, setVideographerCount] = useState(1)
  const [agencyRef, setAgencyRef] = useState('')
  const [projectId, setProjectId] = useState('')
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectEpisodes, setProjectEpisodes] = useState<ProjectEpisode[]>([])
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState<string[]>([])
  const [episodesLoading, setEpisodesLoading] = useState(false)
  const [producers, setProducers] = useState<Person[]>([])
  const [directors, setDirectors] = useState<Person[]>([])
  const [peopleLoading, setPeopleLoading] = useState(true)
  const [notes, setNotes] = useState('')
  const [epCount, setEpCount] = useState(1)
  const [epTitles, setEpTitles] = useState<string[]>([''])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // Per-field errors keyed by the same name we expose in JSX (id-able).
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  // Transient banner when Outlet change cascades-clears dependent fields.
  const [outletChangeWarning, setOutletChangeWarning] = useState('')

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

  useEffect(() => {
    if (!projectId) { setProjectEpisodes([]); setSelectedEpisodeIds([]); return }
    let cancelled = false
    setEpisodesLoading(true)
    setSelectedEpisodeIds([])
    fetch(`/api/projects/${encodeURIComponent(projectId)}/episodes`)
      .then(r => (r.ok ? r.json() : { episodes: [] }))
      .then(data => { if (!cancelled) setProjectEpisodes(data.episodes || []) })
      .catch(() => { if (!cancelled) setProjectEpisodes([]) })
      .finally(() => { if (!cancelled) setEpisodesLoading(false) })
    return () => { cancelled = true }
  }, [projectId])

  const toggleEpisode = (epId: string) =>
    setSelectedEpisodeIds(prev =>
      prev.includes(epId) ? prev.filter(x => x !== epId) : [...prev, epId],
    )

  const selectedProject = projectOptions.find(p => p.projectId === projectId)
  const selectedProducerNickname = (
    producers.find(p => p.email === producerEmail)?.nickname || ''
  ).trim().toLowerCase()
  const visibleProjects = selectedProducerNickname
    ? projectOptions.filter(p => (p.producer || '').trim().toLowerCase() === selectedProducerNickname)
    : projectOptions
  const projectsUnavailable = !projectsLoading && projectOptions.length === 0
  const projectSelectable = !projectsLoading && visibleProjects.length > 0

  const selectedOutlet = OUTLETS.find(o => o.code === outletCode)
  const programs = (selectedOutlet?.programs ?? []).filter(p => p.code.length === 1)
  const selectedProgram = programs.find(p => p.code === programCode)
  const isContentAgency = outletCode === 'AGN'

  const selectedLocation = findLocation(locationId)
  const needsCustomText = !!selectedLocation && locationNeedsManualText(selectedLocation.id)
  const resolvedLocationName = !selectedLocation
    ? null
    : needsCustomText
      ? (locationCustom ? `${selectedLocation.fullName} — ${locationCustom}` : selectedLocation.fullName)
      : selectedLocation.fullName

  const handleOutletChange = (code: string) => {
    const wasContentAgency = isContentAgency
    const willBeContentAgency = code === 'AGN'

    const cleared: string[] = []
    if (programCode) cleared.push('Episode Type')
    if (projectId) cleared.push('Project ID')
    if (selectedEpisodeIds.length > 0) cleared.push(`${selectedEpisodeIds.length} Episode pick(s)`)
    if (wasContentAgency && producerEmail) cleared.push('Producer (CA)')
    if (wasContentAgency && directorEmail) cleared.push('Director')
    if (!wasContentAgency && (producerName || producerPhone || producerEmailText)) {
      cleared.push('Producer contact')
    }

    setOutletCode(code)
    setProgramCode('')
    setProducerEmail('')
    setDirectorEmail('')
    setProducerName('')
    setProducerPhone('')
    setProducerEmailText('')
    setProjectId('')
    setSelectedEpisodeIds([])

    // Brief banner so the user knows exactly which fields were wiped.
    // (Outlet change always cascades because programs / project / producer rosters
    // are scoped to the outlet — keeping stale picks would silently submit
    // mismatching data.)
    if (cleared.length > 0) {
      const flow = willBeContentAgency ? 'Content Agency' : 'standard'
      setOutletChangeWarning(
        `เปลี่ยน Outlet → ล้างค่า: ${cleared.join(', ')} (สวิทช์เป็น ${flow} flow)`,
      )
      setTimeout(() => setOutletChangeWarning(''), 6000)
    }

    // Field errors tied to cleared fields are no longer accurate; reset them.
    setFieldErrors(prev => {
      const next = { ...prev }
      delete next.outletCode
      delete next.programCode
      delete next.producerEmail
      delete next.directorEmail
      delete next.producerName
      delete next.producerPhone
      delete next.producerEmailText
      delete next.projectId
      delete next.selectedEpisodeIds
      return next
    })
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

  // Validate by collecting per-field errors. Returns true when nothing is wrong.
  // Single source of truth for "is the form ready to submit?" — also used to
  // decide whether to advance to the Review step.
  const validate = (): boolean => {
    const errs: Record<string, string> = {}

    if (!outletCode) errs.outletCode = 'กรุณาเลือก Outlet'
    if (!programCode) errs.programCode = 'กรุณาเลือก Episode Type'
    if (!category) errs.category = 'กรุณาเลือก Category'
    if (!videoType) errs.videoType = 'กรุณาเลือก Video Type'

    if (!shootDate) errs.shootDate = 'กรุณาเลือก Shoot Date'
    if (!shootEndDate) errs.shootEndDate = 'กรุณาเลือก Shoot End Date'
    if (shootDate && shootEndDate && shootEndDate < shootDate) {
      errs.shootEndDate = 'Shoot End Date ต้องไม่อยู่ก่อน Shoot Date'
    }
    if (!callTime) errs.callTime = 'กรุณาเลือก Call Time'
    if (callTime && estimatedWrap && shootDate && shootEndDate && shootDate === shootEndDate && estimatedWrap <= callTime) {
      errs.estimatedWrap = 'Estimated Wrap ต้องอยู่หลัง Call Time (เมื่อถ่ายวันเดียว)'
    }

    if (!locationId) errs.locationId = 'กรุณาเลือก Location / Room'
    if (needsCustomText && !locationCustom.trim()) {
      errs.locationCustom = 'กรุณาระบุสถานที่จริง'
    }

    if (isContentAgency) {
      if (projectSelectable && !projectId) errs.projectId = 'กรุณาเลือก Project ID'
      if (projectId && selectedEpisodeIds.length === 0) {
        errs.selectedEpisodeIds = 'กรุณาเลือกอย่างน้อย 1 Episode'
      }
    } else {
      const blank: number[] = []
      epTitles.forEach((t, i) => { if (!t.trim()) blank.push(i + 1) })
      if (blank.length > 0) errs.epTitles = `กรุณากรอกชื่อ Episode ${blank.join(', ')}`
    }

    if (isContentAgency) {
      if (!producerEmail) errs.producerEmail = 'กรุณาเลือก Producer'
      if (!directorEmail) errs.directorEmail = 'กรุณาเลือก Director'
    } else {
      if (!producerName.trim()) errs.producerName = 'กรุณากรอกชื่อ Producer'
      if (!producerPhone.trim()) errs.producerPhone = 'กรุณากรอกเบอร์โทร Producer'
      if (!producerEmailText.trim()) errs.producerEmailText = 'กรุณากรอกอีเมล Producer'
    }

    setFieldErrors(errs)
    if (Object.keys(errs).length > 0) {
      setError('ยังกรอกไม่ครบ — ดูช่องที่ไฮไลต์สีแดงด้านล่าง')
      return false
    }
    setError('')
    return true
  }

  const handleProceedToReview = (e: React.FormEvent) => {
    e.preventDefault()
    if (validate()) {
      setStep('review')
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  const handleBackToEdit = () => {
    setStep('form')
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleConfirmSubmit = async () => {
    setSubmitting(true)
    setError('')
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
          videoType,
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
          projectId: isContentAgency ? (projectId || null) : null,
          projectName: isContentAgency ? (selectedProject?.projectName || null) : null,
          // For Content Agency + Project, the chosen Episode Type (programCode)
          // also identifies the L/S/A/T series the Web App should mint into.
          episodeType: (isContentAgency && projectId && programCode.length === 1) ? programCode : null,
          notes: notes || null,
          episodeTitles: epTitles.map(t => t.trim()),
          selectedEpisodeIds,
        }),
      })
      const contentType = res.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        const transient = res.status === 502 || res.status === 503 || res.status === 504
        throw new Error(
          `เซิร์ฟเวอร์ตอบกลับผิดปกติ (HTTP ${res.status || 'no response'})` +
            (transient
              ? ' — แอปอาจกำลังรีสตาร์ทหลัง deploy ลองใหม่อีกครั้งใน ~1 นาที'
              : ' — ลองใหม่อีกครั้ง หรือแจ้งแอดมินพร้อมเวลาที่เกิด'),
        )
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      router.push(`/booking/success?id=${data.booking.id}`)
    } catch (err: any) {
      setError(err.message)
      setSubmitting(false)
      // Send the user back to the form so they can correct the issue.
      setStep('form')
    }
  }

  const clearForm = () => {
    setOutletCode(''); setProgramCode(''); setShootDate(''); setShootEndDate('')
    setCategory('Original Content'); setShootType('Studio')
    setLocationId(''); setLocationCustom(''); setCallTime(''); setEstimatedWrap('')
    setProducerEmail(''); setDirectorEmail('')
    setProducerName(''); setProducerPhone(''); setProducerEmailText('')
    setCreative(''); setCrew([]); setVideographerCount(1)
    setAgencyRef(''); setProjectId(''); setNotes(''); setEpCount(1); setEpTitles([''])
    setSelectedEpisodeIds([])
    setFieldErrors({}); setError(''); setOutletChangeWarning('')
    setStep('form')
  }

  // === Review summary values (computed for the Review step) ===
  const reviewValues = {
    outlet: selectedOutlet ? `${selectedOutlet.name} (${selectedOutlet.code})` : '',
    episodeType: selectedProgram ? `${selectedProgram.code} · ${selectedProgram.name}` : '',
    category,
    videoType,
    dateRange: shootDate && shootEndDate
      ? (shootDate === shootEndDate ? shootDate : `${shootDate} → ${shootEndDate}`)
      : '',
    timeRange: callTime ? (estimatedWrap ? `${callTime} → ${estimatedWrap}` : callTime) : '',
    shootType,
    location: resolvedLocationName || '',
    producer: isContentAgency
      ? (producers.find(p => p.email === producerEmail)?.nickname
          ? `${producers.find(p => p.email === producerEmail)?.nickname} (${producerEmail})`
          : producerEmail)
      : (producerName ? `${producerName}${producerPhone ? ` · ${producerPhone}` : ''}${producerEmailText ? ` · ${producerEmailText}` : ''}` : ''),
    director: isContentAgency
      ? (directors.find(d => d.email === directorEmail)?.nickname
          ? `${directors.find(d => d.email === directorEmail)?.nickname} (${directorEmail})`
          : directorEmail)
      : '',
    project: isContentAgency && selectedProject
      ? `${selectedProject.projectId} — ${selectedProject.projectName}`
      : '',
    episodes: isContentAgency
      ? selectedEpisodeIds.length > 0
          ? `${selectedEpisodeIds.length} ตอน · ${selectedEpisodeIds.join(', ')}`
          : ''
      : epTitles.filter(t => t.trim()).length > 0
          ? `${epTitles.filter(t => t.trim()).length} ตอน · ${epTitles.filter(t => t.trim()).join(', ')}`
          : '',
    subject: creative,
    productCode: agencyRef,
    crew: crew.length > 0
      ? crew.map(c => c === 'Videographer' && videographerCount > 1 ? `${c} ×${videographerCount}` : c).join(', ')
      : '',
    notes,
  }

  return (
    <div className="max-w-[640px] mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3">

      {/* Header card */}
      <div className="gf-header p-4 sm:p-6">
        <h1 className="text-2xl sm:text-3xl font-normal text-gray-800 mb-1">PRODUCTION BOOKING</h1>
        <p className="text-xs sm:text-sm text-gray-500">ระบบการ Booking การผลิตของ THE STANDARD</p>
        <div className="mt-3 pt-3 border-t border-gray-200 flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xs text-[#db4437]">* Indicates required question</span>
          {/* Two-step indicator: Fill → Review. Compact, no marketing vibe. */}
          <span className="text-xs text-gray-500 inline-flex items-center gap-1.5">
            <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-medium ${step === 'form' ? 'bg-[#673ab7] text-white' : 'bg-gray-200 text-gray-500'}`}>1</span>
            Fill
            <ChevronRight className="w-3 h-3 text-gray-400" />
            <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-medium ${step === 'review' ? 'bg-[#673ab7] text-white' : 'bg-gray-200 text-gray-500'}`}>2</span>
            Review
          </span>
        </div>
      </div>

      {outletChangeWarning && (
        <div className="rounded bg-amber-50 border-l-4 border-amber-400 px-3 py-2 text-xs text-amber-800">
          ⚠ {outletChangeWarning}
        </div>
      )}

      {error && (
        <div className="gf-card p-3 text-sm text-[#db4437] border-l-4 border-[#db4437]">
          {error}
        </div>
      )}

      {step === 'review' ? (
        <>
          <div className="gf-card p-3 text-xs text-gray-600 bg-purple-50 border-l-4 border-[#673ab7]">
            ตรวจสอบรายละเอียดก่อน Submit · ยังไม่มีการบันทึกในระบบจนกว่าจะกด <span className="font-medium">Confirm & Submit</span>
          </div>

          <ReviewSection index={1} title="Project">
            <ReviewRow label="Outlet" value={reviewValues.outlet} />
            <ReviewRow label="Episode Type" value={reviewValues.episodeType} />
            <ReviewRow label="Category" value={reviewValues.category} />
            <ReviewRow label="Video Type" value={reviewValues.videoType} />
          </ReviewSection>

          <ReviewSection index={2} title="Schedule">
            <ReviewRow label="Shoot Date" value={reviewValues.dateRange} />
            <ReviewRow label="Time" value={reviewValues.timeRange} />
          </ReviewSection>

          <ReviewSection index={3} title="Location">
            <ReviewRow label="Shoot Type" value={reviewValues.shootType} />
            <ReviewRow label="Location / Room" value={reviewValues.location} />
          </ReviewSection>

          <ReviewSection index={4} title="Production Details">
            {isContentAgency && <ReviewRow label="Project" value={reviewValues.project} />}
            <ReviewRow label="Episodes" value={reviewValues.episodes} />
            <ReviewRow label="แขก / Subject" value={reviewValues.subject} />
            <ReviewRow label="Product Code" value={reviewValues.productCode} />
          </ReviewSection>

          <ReviewSection index={5} title="People / Crew">
            <ReviewRow label="Producer" value={reviewValues.producer} />
            {isContentAgency && <ReviewRow label="Director" value={reviewValues.director} />}
            <ReviewRow label="Crew" value={reviewValues.crew} />
          </ReviewSection>

          <ReviewSection index={6} title="Notes">
            <ReviewRow label="Notes" value={reviewValues.notes} />
          </ReviewSection>

          <div className="gf-card p-4 flex items-center justify-between gap-3 flex-wrap">
            <button
              type="button"
              onClick={handleBackToEdit}
              disabled={submitting}
              className="px-4 py-2 text-sm text-[#673ab7] border border-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white transition-colors disabled:opacity-50 inline-flex items-center gap-1"
            >
              <ChevronLeft className="w-4 h-4" /> Back to edit
            </button>
            <button
              type="button"
              onClick={handleConfirmSubmit}
              disabled={submitting}
              className="gf-submit"
            >
              {submitting ? 'Submitting…' : 'Confirm & Submit'}
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={handleProceedToReview} className="space-y-3" noValidate>

          {/* ============ 1. PROJECT ============ */}
          <SectionHeader index={1} title="Project" hint="ระบุงานนี้เป็นของ Outlet ไหน Episode Type อะไร" />

          <div className="gf-section">
            <label htmlFor="outletCode" className="gf-label">
              OUTLET <span className="gf-required">*</span>
            </label>
            <div className="relative">
              <select
                id="outletCode"
                className="gf-select pr-6"
                value={outletCode}
                onChange={e => handleOutletChange(e.target.value)}
                aria-invalid={!!fieldErrors.outletCode}
              >
                <option value="">— Select Outlet —</option>
                {OUTLETS.map(o => (
                  <option key={o.code} value={o.code}>{o.name}</option>
                ))}
              </select>
              <span className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none text-xs">▾</span>
            </div>
            <FieldError message={fieldErrors.outletCode} />
          </div>

          <div className="gf-section">
            <label htmlFor="programCode" className="gf-label">
              EPISODE TYPE <span className="gf-required">*</span>
            </label>
            <div className="relative">
              <select
                id="programCode"
                className="gf-select pr-6"
                value={programCode}
                onChange={e => setProgramCode(e.target.value)}
                disabled={!outletCode}
                aria-invalid={!!fieldErrors.programCode}
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
            <FieldHelp>
              L · Long Form / S · Short Form / A · Audio / T · Talk — ใช้จัดหมวดเดียวกับ Dashboard
            </FieldHelp>
            <FieldError message={fieldErrors.programCode} />
          </div>

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
            <FieldHelp>
              Original Content = งาน Outlet ของเราเอง · Advertorial = สปอนเซอร์ · Event = อีเวนต์ · Internal = ใช้ภายในองค์กร
            </FieldHelp>
            <FieldError message={fieldErrors.category} />
          </div>

          <div className="gf-section">
            <label className="gf-label">
              VIDEO TYPE <span className="gf-required">*</span>
            </label>
            {VIDEO_TYPES.map(v => (
              <label key={v} className="gf-option">
                <input
                  type="radio"
                  name="videoType"
                  value={v}
                  checked={videoType === v}
                  onChange={() => setVideoType(v)}
                  className="accent-[#673ab7]"
                />
                <span className="text-sm text-gray-700">{v}</span>
              </label>
            ))}
            <FieldError message={fieldErrors.videoType} />
          </div>

          {/* ============ 2. SCHEDULE ============ */}
          <SectionHeader index={2} title="Schedule" hint="วันและเวลาถ่าย" />

          <div className="gf-section grid grid-cols-2 gap-6">
            <div>
              <label htmlFor="shootDate" className="gf-label">
                SHOOT DATE <span className="gf-required">*</span>
              </label>
              <input
                id="shootDate"
                type="date"
                className="gf-input"
                value={shootDate}
                onChange={e => {
                  const v = e.target.value
                  setShootDate(v)
                  if (!shootEndDate || shootEndDate < v) setShootEndDate(v)
                }}
                min={new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]}
                aria-invalid={!!fieldErrors.shootDate}
              />
              <FieldError message={fieldErrors.shootDate} />
            </div>
            <div>
              <label htmlFor="shootEndDate" className="gf-label">
                SHOOT END DATE <span className="gf-required">*</span>
              </label>
              <input
                id="shootEndDate"
                type="date"
                className="gf-input"
                value={shootEndDate}
                onChange={e => setShootEndDate(e.target.value)}
                min={shootDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]}
                aria-invalid={!!fieldErrors.shootEndDate}
              />
              <FieldHelp>ถ่ายวันเดียว = วันเดียวกับวันเริ่ม (เติมให้อัตโนมัติ)</FieldHelp>
              <FieldError message={fieldErrors.shootEndDate} />
            </div>
          </div>

          <div className="gf-section grid grid-cols-2 gap-6">
            <div>
              <label htmlFor="callTime" className="gf-label">
                CALL TIME <span className="gf-required">*</span>
              </label>
              <input
                id="callTime"
                type="time"
                className="gf-input"
                value={callTime}
                onChange={e => setCallTime(e.target.value)}
                aria-invalid={!!fieldErrors.callTime}
              />
              <FieldError message={fieldErrors.callTime} />
            </div>
            <div>
              <label htmlFor="estimatedWrap" className="gf-label">ESTIMATED WRAP</label>
              <input
                id="estimatedWrap"
                type="time"
                className="gf-input"
                value={estimatedWrap}
                onChange={e => setEstimatedWrap(e.target.value)}
                aria-invalid={!!fieldErrors.estimatedWrap}
              />
              <FieldHelp>ไม่บังคับ — ใช้คำนวณ workload ของทีม</FieldHelp>
              <FieldError message={fieldErrors.estimatedWrap} />
            </div>
          </div>

          {/* ============ 3. LOCATION ============ */}
          <SectionHeader index={3} title="Location" hint="ประเภทการถ่าย + สถานที่จริง" />

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
            <FieldHelp>ประเภทการผลิต — ไม่ใช่ห้อง/สถานที่ ใส่ตรงข้างล่างได้อิสระ</FieldHelp>
          </div>

          <div className="gf-section">
            <label htmlFor="locationId" className="gf-label">
              LOCATION / ROOM <span className="gf-required">*</span>
            </label>
            <p className="text-xs text-gray-500 mb-3 leading-snug">ห้อง/สถานที่จริงที่ใช้ถ่าย (ไม่ขึ้นกับ Shoot Type ข้างบน)</p>
            <select
              id="locationId"
              className="gf-input"
              value={locationId}
              onChange={e => { setLocationId(e.target.value); setLocationCustom('') }}
              aria-invalid={!!fieldErrors.locationId}
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
            <FieldError message={fieldErrors.locationId} />

            {selectedLocation && selectedLocation.group !== 'EXTERNAL' && (
              <p className="text-xs text-gray-500 mt-2">
                📍 {selectedLocation.fullName}{selectedLocation.capacity ? ` · capacity ${selectedLocation.capacity}` : ''}
              </p>
            )}

            {needsCustomText && (
              <div className="mt-3">
                <label htmlFor="locationCustom" className="gf-label">SPECIFY LOCATION <span className="gf-required">*</span></label>
                <input
                  id="locationCustom"
                  type="text"
                  className="gf-input"
                  placeholder="ชื่อสถานที่ · ที่อยู่ · หรือลิงก์ Google Maps"
                  value={locationCustom}
                  onChange={e => setLocationCustom(e.target.value)}
                  aria-invalid={!!fieldErrors.locationCustom}
                />
                <FieldError message={fieldErrors.locationCustom} />
              </div>
            )}
          </div>

          {/* ============ 4. PRODUCTION DETAILS ============ */}
          <SectionHeader
            index={4}
            title="Production Details"
            hint={isContentAgency
              ? 'ระบุ Project ในระบบ + เลือก Episodes ที่จะถ่ายรอบนี้'
              : 'จำนวน Episodes / ชื่อแขก / Product Code'}
          />

          {isContentAgency && (
            <div className="gf-section">
              <label htmlFor="projectId" className="gf-label">
                PROJECT ID {projectSelectable && <span className="gf-required">*</span>}
                <span className="ml-2 text-xs font-normal text-gray-500">
                  (linked to Producer Dashboard)
                </span>
              </label>
              <select
                id="projectId"
                className="gf-input"
                value={projectId}
                onChange={e => setProjectId(e.target.value)}
                disabled={projectsLoading}
                aria-invalid={!!fieldErrors.projectId}
              >
                <option value="">
                  {projectsLoading
                    ? 'Loading projects…'
                    : projectOptions.length === 0
                      ? '— No projects loaded (sheet unreachable) —'
                      : visibleProjects.length === 0
                        ? '— No projects for this Producer —'
                        : '— Select Project —'}
                </option>
                {visibleProjects.map(p => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.projectId} · {p.projectName}
                    {p.producer ? ` (${p.producer})` : ''}
                  </option>
                ))}
              </select>
              <FieldHelp>
                ดึงรายการจาก &ldquo;All Projects&rdquo; ของ Producer Dashboard sheet · กรองตาม Producer ที่เลือกใน People / Crew
              </FieldHelp>
              <FieldError message={fieldErrors.projectId} />

              {projectsUnavailable && (
                <div className="mt-2 rounded bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                  ⚠️ โหลดรายการ Project จาก Producer Dashboard ไม่ได้ตอนนี้ — จองคิวได้เลยโดยไม่ต้องระบุ Project ID
                  (ระบบจะออก Episode ID แบบ local ให้ และเชื่อม Project ภายหลังได้)
                </div>
              )}
              {selectedProject && (
                <div className="mt-2 rounded bg-purple-50 px-3 py-2 text-xs text-gray-700">
                  <div><strong>Project:</strong> {selectedProject.projectName}</div>
                  {selectedProject.producer && (
                    <div><strong>Producer:</strong> {selectedProject.producer}</div>
                  )}
                </div>
              )}
            </div>
          )}

          {isContentAgency && projectId && (
            <div className="gf-section">
              <label className="gf-label">
                EPISODES ที่จะถ่ายรอบนี้ <span className="gf-required">*</span>
              </label>
              {episodesLoading ? (
                <p className="text-sm text-gray-400">กำลังโหลด episodes…</p>
              ) : projectEpisodes.length === 0 ? (
                <p className="text-sm text-gray-400">
                  — ไม่มี episode ที่ถ่ายได้ (Published หมดแล้ว หรือยังไม่ถูกสร้างในชีต) —
                </p>
              ) : (
                <div className="space-y-1">
                  {projectEpisodes.map(ep => (
                    <label key={ep.episodeId} className="gf-option flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={selectedEpisodeIds.includes(ep.episodeId)}
                        onChange={() => toggleEpisode(ep.episodeId)}
                        className="accent-[#673ab7] mt-0.5"
                      />
                      <span className="text-sm text-gray-700">
                        <span className="font-mono font-medium">{ep.episodeId}</span>
                        <span className="text-xs text-gray-500">
                          {' · '}{ep.status}
                          {ep.productCode ? ` · ${ep.productCode}` : ''}
                          {ep.ep && ep.ep !== '-' ? ` · ${ep.ep}` : ''}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {selectedEpisodeIds.length > 0 && (
                <p className="text-xs text-gray-500 mt-2">เลือกแล้ว {selectedEpisodeIds.length} EP</p>
              )}
              <FieldError message={fieldErrors.selectedEpisodeIds} />
            </div>
          )}

          {!isContentAgency && (
            <div className="gf-section">
              <label htmlFor="epCount" className="gf-label">
                NUMBER OF EPISODES <span className="gf-required">*</span>
              </label>
              <div className="relative mb-4">
                <select
                  id="epCount"
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
                    aria-invalid={!!fieldErrors.epTitles}
                  />
                </div>
              ))}
              <FieldError message={fieldErrors.epTitles} />
            </div>
          )}

          <div className="gf-section">
            <label htmlFor="creative" className="gf-label">แขก / SUBJECT</label>
            <input
              id="creative"
              type="text"
              className="gf-input"
              placeholder="e.g. คุณ Ken, คุณแนน (คั่นด้วยจุลภาค)"
              value={creative}
              onChange={e => setCreative(e.target.value)}
            />
            <FieldHelp>คนหรือหัวข้อที่ถ่าย — ใช้แสดงในปฏิทินและอีเมล crew</FieldHelp>
          </div>

          <div className="gf-section">
            <label htmlFor="agencyRef" className="gf-label">
              PRODUCT CODE
              <span className="ml-2 text-xs font-normal text-gray-500">(optional)</span>
            </label>
            <input
              id="agencyRef"
              type="text"
              className="gf-input"
              placeholder="e.g. QU-3108"
              value={agencyRef}
              onChange={e => setAgencyRef(e.target.value)}
            />
            <FieldHelp>เขียนลงคอลัมน์ &ldquo;Product Code&rdquo; (F) ของ PD tab — สำหรับ Agency / Sponsor ref</FieldHelp>
          </div>

          {/* ============ 5. PEOPLE / CREW ============ */}
          <SectionHeader
            index={5}
            title="People / Crew"
            hint={isContentAgency
              ? 'Producer / Director ของโปรเจกต์ + Crew ที่ต้องใช้'
              : 'ผู้ติดต่อจากฝั่งคุณ + Crew ที่ต้องใช้'}
          />

          <div className="gf-section">
            <label className="gf-label">
              PRODUCER <span className="gf-required">*</span>
            </label>
            {isContentAgency ? (
              <>
                <div className="relative">
                  <select
                    id="producerEmail"
                    className="gf-select pr-6"
                    value={producerEmail}
                    onChange={e => {
                      setProducerEmail(e.target.value)
                      // Project is scoped to the Producer — when the Producer changes,
                      // drop the previous pick so the user can't accidentally submit
                      // a booking against a different Producer's project.
                      setProjectId('')
                    }}
                    disabled={peopleLoading}
                    aria-invalid={!!fieldErrors.producerEmail}
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
                <FieldHelp>ดึงจาก &ldquo;_Users&rdquo; tab ของ Dashboard · เลือกแล้วจะกรอง Project ID ในข้อ 4 ให้</FieldHelp>
                <FieldError message={fieldErrors.producerEmail} />
              </>
            ) : (
              <div className="space-y-3">
                <div>
                  <label htmlFor="producerName" className="text-xs text-gray-500 mb-1 block">
                    NAME <span className="gf-required">*</span>
                  </label>
                  <input
                    id="producerName"
                    type="text"
                    className="gf-input"
                    placeholder="ชื่อ-นามสกุล โปรดิวเซอร์"
                    value={producerName}
                    onChange={e => setProducerName(e.target.value)}
                    aria-invalid={!!fieldErrors.producerName}
                  />
                  <FieldError message={fieldErrors.producerName} />
                </div>
                <div>
                  <label htmlFor="producerPhone" className="text-xs text-gray-500 mb-1 block">
                    PHONE <span className="gf-required">*</span>
                  </label>
                  <input
                    id="producerPhone"
                    type="tel"
                    className="gf-input"
                    placeholder="เบอร์โทรศัพท์"
                    value={producerPhone}
                    onChange={e => setProducerPhone(e.target.value)}
                    aria-invalid={!!fieldErrors.producerPhone}
                  />
                  <FieldError message={fieldErrors.producerPhone} />
                </div>
                <div>
                  <label htmlFor="producerEmailText" className="text-xs text-gray-500 mb-1 block">
                    EMAIL <span className="gf-required">*</span>
                  </label>
                  <input
                    id="producerEmailText"
                    type="email"
                    className="gf-input"
                    placeholder="email@example.com"
                    value={producerEmailText}
                    onChange={e => setProducerEmailText(e.target.value)}
                    aria-invalid={!!fieldErrors.producerEmailText}
                  />
                  <FieldError message={fieldErrors.producerEmailText} />
                </div>
              </div>
            )}
          </div>

          {isContentAgency && (
            <div className="gf-section">
              <label htmlFor="directorEmail" className="gf-label">
                DIRECTOR <span className="gf-required">*</span>
              </label>
              <div className="relative">
                <select
                  id="directorEmail"
                  className="gf-select pr-6"
                  value={directorEmail}
                  onChange={e => setDirectorEmail(e.target.value)}
                  disabled={peopleLoading}
                  aria-invalid={!!fieldErrors.directorEmail}
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
              <FieldError message={fieldErrors.directorEmail} />
            </div>
          )}

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
            <FieldHelp>เลือก crew ทุกตำแหน่งที่ต้องใช้ · ระบุจำนวน Videographer ถ้าต้องมากกว่า 1</FieldHelp>
          </div>

          {/* ============ 6. NOTES ============ */}
          <SectionHeader index={6} title="Notes" hint="ข้อมูลเพิ่มเติมสำหรับ coordinator" />

          <div className="gf-section">
            <label htmlFor="notes" className="gf-label">NOTES</label>
            <textarea
              id="notes"
              className="gf-input resize-none"
              rows={3}
              placeholder="Additional notes for the coordinator..."
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>

          {/* Submit row */}
          <div className="flex items-center justify-between py-2 mt-2">
            <button type="submit" className="gf-submit inline-flex items-center gap-1.5">
              Review <ChevronRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={clearForm}
              className="text-sm text-[#673ab7] hover:underline"
            >
              Clear form
            </button>
          </div>

        </form>
      )}
    </div>
  )
}
