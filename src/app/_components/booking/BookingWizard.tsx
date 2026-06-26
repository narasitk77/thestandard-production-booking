'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle, Check, ChevronLeft, ChevronRight, Loader2,
  Briefcase, Calendar as CalendarIcon, MapPin, Users, ClipboardCheck,
  ChevronDown, ChevronUp,
} from 'lucide-react'
import { OUTLETS, CREW_OPTIONS } from '@/lib/data'
import { LOCATIONS, LOCATION_GROUPS, locationNeedsManualText, findLocation } from '@/lib/locations'
import NumberStepper from '@/app/_components/NumberStepper'

/* =============================================================================
   Booking Wizard — v1.28 redesign
   5 steps (Project → Schedule → Location → People/Crew → Review).
   Desktop: form on the left, sticky summary on the right.
   Mobile: single column with a fixed bottom action bar and a collapsible summary.
   Submit only fires after Confirm on the Review step.
   Payload + cascade logic preserved from v1.27 — no API change.
   ============================================================================= */

type ProjectOption = { projectId: string; projectName: string; producer?: string }
type Person = { email: string; nickname: string }
type OutletPerson = { email: string; name: string; nickname: string }
// One row in the non-CA episode list: each episode picks its own program (show)
// and is tagged Original Content or Advertorial (AD).
type EpContentType = 'ORIGINAL_CONTENT' | 'ADVERTORIAL'
type EpRow = { programCode: string; title: string; contentType: EpContentType }
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

type StepKey = 1 | 2 | 3 | 4 | 5
const STEPS: { key: StepKey; label: string; icon: any }[] = [
  { key: 1, label: 'Project', icon: Briefcase },
  { key: 2, label: 'Schedule', icon: CalendarIcon },
  { key: 3, label: 'Location', icon: MapPin },
  { key: 4, label: 'People & Crew', icon: Users },
  { key: 5, label: 'Review', icon: ClipboardCheck },
]

/* ---------- Small reusable bits ---------- */

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return (
    <p className="mt-1.5 text-xs text-red-600 flex items-start gap-1">
      <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
      <span>{message}</span>
    </p>
  )
}

function FieldHelp({ children }: { children: React.ReactNode }) {
  return <p className="ops-help">{children}</p>
}

function Label({ htmlFor, children, required }: { htmlFor?: string; children: React.ReactNode; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="ops-label">
      {children}{required && <span className="ops-required">*</span>}
    </label>
  )
}

function StepHeader({ step, title, subtitle }: { step: StepKey; title: string; subtitle?: string }) {
  return (
    <div className="pb-3 mb-3 border-b border-gray-100">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-900 text-white text-[10px] font-semibold tabular-nums">
          {step}
        </span>
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      </div>
      {subtitle && <p className="text-xs text-gray-500 mt-1 ml-7 leading-snug">{subtitle}</p>}
    </div>
  )
}

/** Stepper rail — desktop horizontal, mobile compact pill row. */
function Stepper({ current, completed, onJump }: {
  current: StepKey
  completed: Record<StepKey, boolean>
  onJump: (s: StepKey) => void
}) {
  return (
    <ol className="flex items-center gap-1 overflow-x-auto scrollbar-none -mx-3 px-3 sm:mx-0 sm:px-0">
      {STEPS.map(({ key, label, icon: Icon }, idx) => {
        const isCurrent = current === key
        const isDone = completed[key]
        const reachable = isCurrent || isDone || completed[(key - 1) as StepKey] || key === 1
        return (
          <li key={key} className="flex items-center flex-shrink-0">
            <button
              type="button"
              disabled={!reachable}
              onClick={() => reachable && onJump(key)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                isCurrent
                  ? 'bg-gray-900 text-white'
                  : isDone
                    ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                    : reachable
                      ? 'text-gray-600 hover:bg-gray-100'
                      : 'text-gray-400 cursor-not-allowed'
              }`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              {isDone && !isCurrent ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Icon className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">{label}</span>
              <span className="sm:hidden">{key}</span>
            </button>
            {idx < STEPS.length - 1 && (
              <span className="w-3 sm:w-4 h-px bg-gray-200 mx-0.5" aria-hidden />
            )}
          </li>
        )
      })}
    </ol>
  )
}

/* ---------- Main wizard ---------- */

export default function BookingWizard() {
  const router = useRouter()

  // ---- form state (same shape as v1.27 page.tsx) ----
  const [outletCode, setOutletCode] = useState('')
  const [programCode, setProgramCode] = useState('')
  const [shootDate, setShootDate] = useState('')
  const [shootEndDate, setShootEndDate] = useState('')
  const [category, setCategory] = useState('Original Content')
  const [videoType, setVideoType] = useState('')
  const [shootType, setShootType] = useState('Studio')
  const [locationId, setLocationId] = useState('')
  const [locationCustom, setLocationCustom] = useState('')
  // v1.58 — off-site (On Location) shoots collect a free-text Map location
  // instead of an office room.
  const [mapLocation, setMapLocation] = useState('')
  const [callTime, setCallTime] = useState('')
  const [estimatedWrap, setEstimatedWrap] = useState('')
  const [producerEmail, setProducerEmail] = useState('')
  const [directorEmail, setDirectorEmail] = useState('')
  const [producerName, setProducerName] = useState('')
  const [producerPhone, setProducerPhone] = useState('')
  const [producerEmailText, setProducerEmailText] = useState('')
  const [creative, setCreative] = useState('')
  const [crew, setCrew] = useState<string[]>([])
  const [videographerCount, setVideographerCount] = useState('1') // string so the field can be cleared & retyped
  const [cameraCount, setCameraCount] = useState('')
  const [micCount, setMicCount] = useState('')
  // v1.67 — Block Shot: relaxes the camera/mic requirement for flexible-queue shoots.
  const [isBlockShot, setIsBlockShot] = useState(false)
  const [needsVan, setNeedsVan] = useState(false)
  // v1.101 — Event shoots are "office" by default; tick this when the event is at
  // an EXTERNAL venue → behaves like On Location (Map location + van + validation).
  const [eventExternal, setEventExternal] = useState(false)
  const [specialEquipment, setSpecialEquipment] = useState<string[]>([])
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
  // v1.59 — per-outlet Producer / Co-Producer dropdowns (non-AGN), sourced from
  // GET /api/producers (Users tagged with the outlet). Falls back to free-text
  // when an outlet has no producers configured.
  const [outletProducers, setOutletProducers] = useState<OutletPerson[]>([])
  const [outletCoProducers, setOutletCoProducers] = useState<OutletPerson[]>([])
  const [outletPeopleLoading, setOutletPeopleLoading] = useState(false)
  const [producerSel, setProducerSel] = useState('')
  const [coProducerSel, setCoProducerSel] = useState('')
  const [notes, setNotes] = useState('')
  const [epCount, setEpCount] = useState(1)
  const [epRows, setEpRows] = useState<EpRow[]>([{ programCode: '', title: '', contentType: 'ORIGINAL_CONTENT' }])

  // ---- wizard state ----
  const [step, setStep] = useState<StepKey>(1)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [outletChangeWarning, setOutletChangeWarning] = useState('')
  const [summaryOpen, setSummaryOpen] = useState(false) // mobile-only
  // v1.78 — draft autosave/resume so closing the browser mid-edit (esp. mobile)
  // doesn't lose everything. draftDecided gates autosave until the user has
  // chosen to resume or discard a found draft (else empty state clobbers it).
  const [draftFound, setDraftFound] = useState(false)
  const [draftDecided, setDraftDecided] = useState(false)

  /* ---- data loads ---- */
  useEffect(() => {
    let cancelled = false
    fetch('/api/projects')
      .then(r => r.ok ? r.json() : { projects: [] })
      .then(d => { if (!cancelled) setProjectOptions(d.projects || []) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setProjectsLoading(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/people')
      .then(r => r.ok ? r.json() : { producers: [], directors: [] })
      .then(d => {
        if (!cancelled) {
          setProducers(d.producers || [])
          setDirectors(d.directors || [])
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setPeopleLoading(false) })
    return () => { cancelled = true }
  }, [])

  // v1.59 — load per-outlet producers/co-producers for the non-AGN dropdowns
  // whenever the outlet changes. AGN keeps its _Users-based producer flow.
  useEffect(() => {
    setProducerSel(''); setCoProducerSel('')
    if (!outletCode || outletCode === 'AGN') { setOutletProducers([]); setOutletCoProducers([]); return }
    let cancelled = false
    setOutletPeopleLoading(true)
    fetch(`/api/producers?outlet=${encodeURIComponent(outletCode)}`)
      .then(r => r.ok ? r.json() : { producers: [], coProducers: [] })
      .then(d => { if (!cancelled) { setOutletProducers(d.producers || []); setOutletCoProducers(d.coProducers || []) } })
      .catch(() => { if (!cancelled) { setOutletProducers([]); setOutletCoProducers([]) } })
      .finally(() => { if (!cancelled) setOutletPeopleLoading(false) })
    return () => { cancelled = true }
  }, [outletCode])

  useEffect(() => {
    if (!projectId) { setProjectEpisodes([]); setSelectedEpisodeIds([]); return }
    let cancelled = false
    setEpisodesLoading(true)
    setSelectedEpisodeIds([])
    fetch(`/api/projects/${encodeURIComponent(projectId)}/episodes`)
      .then(r => r.ok ? r.json() : { episodes: [] })
      .then(d => { if (!cancelled) setProjectEpisodes(d.episodes || []) })
      .catch(() => { if (!cancelled) setProjectEpisodes([]) })
      .finally(() => { if (!cancelled) setEpisodesLoading(false) })
    return () => { cancelled = true }
  }, [projectId])

  // v1.63.0 — live, NON-BLOCKING camera-overload check. Sums cameraCount across
  // time-overlapping active bookings (+ this one) and warns when total > 9.
  // Debounced; only sets a red banner — never blocks Next/Submit.
  useEffect(() => {
    const own = parseInt(cameraCount, 10)
    if (!shootDate || !callTime || cameraCount.trim() === '' || isNaN(own) || own <= 0) {
      setCameraLoadWarning('')
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      fetch('/api/camera-load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shootDate, shootEndDate: shootEndDate || null, callTime, estimatedWrap: estimatedWrap || null, cameraCount: own }),
      })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (cancelled || !d) return
          setCameraLoadWarning(d.exceedsLimit
            ? `⚠️ กล้องเต็ม / Cameras full — ช่วงเวลานี้จองรวม ${d.totalCameras}/${d.limit} ตัว (ของคุณ ${own} + งานอื่น ${d.otherCameras}) · ต้องเช่ากล้องเพิ่ม / rent extra cameras`
            : '')
        })
        .catch(() => {})
    }, 400)
    return () => { cancelled = true; clearTimeout(t) }
  }, [shootDate, shootEndDate, callTime, estimatedWrap, cameraCount])

  /* ---- derived ---- */
  const selectedOutlet = OUTLETS.find(o => o.code === outletCode)
  const programs = (selectedOutlet?.programs ?? []).filter(p => p.code.length === 1)
  const selectedProgram = programs.find(p => p.code === programCode)
  // Real show programs (3-char codes) for the per-episode program picker —
  // excludes the L/S/A/T Episode-Type aliases used by the step-1 picker.
  const epPrograms = (selectedOutlet?.programs ?? []).filter(p => p.code.length > 1)
  const isContentAgency = outletCode === 'AGN'
  // v1.59 — non-AGN outlets use the per-outlet Producer/Co-Producer dropdown
  // when the outlet has people configured; otherwise fall back to free text.
  // v1.85 — EVENT shoots always use the free-text producer: an event's producer
  // is often an ad-hoc person not in the outlet's regular producer roster
  // (brought back from the pre-v1.59 type-the-name input, per ops request).
  const useProducerDropdown = !isContentAgency && outletProducers.length > 0 && shootType !== 'Event'
  const selProd = outletProducers.find(p => p.email === producerSel)
  const selCoProd = outletCoProducers.find(p => p.email === coProducerSel)

  const selectedProject = projectOptions.find(p => p.projectId === projectId)
  const selectedProducerNickname = (
    producers.find(p => p.email === producerEmail)?.nickname || ''
  ).trim().toLowerCase()
  const visibleProjects = selectedProducerNickname
    ? projectOptions.filter(p => (p.producer || '').trim().toLowerCase() === selectedProducerNickname)
    : projectOptions
  const projectsUnavailable = !projectsLoading && projectOptions.length === 0
  const projectSelectable = !projectsLoading && visibleProjects.length > 0

  const selectedLocation = findLocation(locationId)
  const needsCustomText = !!selectedLocation && locationNeedsManualText(selectedLocation.id)
  // v1.58 — On Location = off-site: show a Map location box + van option, hide
  // the office-room picker. Studio/Event = office: pick a room, no external
  // options, no van.
  const offsite = shootType === 'On Location' || (shootType === 'Event' && eventExternal)
  const resolvedLocationName = offsite
    ? (mapLocation.trim() || null)
    : !selectedLocation
      ? null
      : needsCustomText
        ? (locationCustom ? `${selectedLocation.fullName} — ${locationCustom}` : selectedLocation.fullName)
        : selectedLocation.fullName

  /* ---- draft autosave / resume (v1.78) ---- */
  const DRAFT_KEY = 'booking-draft-v1'
  const draftSnapshot = () => ({
    outletCode, programCode, shootDate, shootEndDate, category, videoType, shootType,
    locationId, locationCustom, mapLocation, callTime, estimatedWrap,
    producerEmail, directorEmail, producerName, producerPhone, producerEmailText,
    creative, crew, videographerCount, cameraCount, micCount, isBlockShot, needsVan, eventExternal,
    specialEquipment, agencyRef, projectId, selectedEpisodeIds, producerSel, coProducerSel,
    notes, epCount, epRows, step,
  })

  // On mount: offer to resume a saved draft; if none, enable autosave right away.
  useEffect(() => {
    try { if (localStorage.getItem(DRAFT_KEY)) { setDraftFound(true); return } } catch {}
    setDraftDecided(true)
  }, [])

  // Autosave (debounced) — only after the user has resumed/discarded any prior
  // draft, so the empty initial state never clobbers a saved one.
  useEffect(() => {
    if (!draftDecided) return
    const t = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftSnapshot())) } catch {}
    }, 800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftDecided, outletCode, programCode, shootDate, shootEndDate, category, videoType, shootType, locationId, locationCustom, mapLocation, callTime, estimatedWrap, producerEmail, directorEmail, producerName, producerPhone, producerEmailText, creative, crew, videographerCount, cameraCount, micCount, isBlockShot, needsVan, eventExternal, specialEquipment, agencyRef, projectId, selectedEpisodeIds, producerSel, coProducerSel, notes, epCount, epRows, step])

  const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY) } catch {} }
  const discardDraft = () => { clearDraft(); setDraftFound(false); setDraftDecided(true) }
  const resumeDraft = () => {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}')
      // Raw setters only (NOT handleOutletChange) so the outlet cascade doesn't
      // wipe the very fields we're restoring.
      if (d.outletCode != null) setOutletCode(d.outletCode)
      if (d.programCode != null) setProgramCode(d.programCode)
      if (d.shootDate != null) setShootDate(d.shootDate)
      if (d.shootEndDate != null) setShootEndDate(d.shootEndDate)
      if (d.category != null) setCategory(d.category)
      if (d.videoType != null) setVideoType(d.videoType)
      if (d.shootType != null) setShootType(d.shootType)
      if (d.locationId != null) setLocationId(d.locationId)
      if (d.locationCustom != null) setLocationCustom(d.locationCustom)
      if (d.mapLocation != null) setMapLocation(d.mapLocation)
      if (d.callTime != null) setCallTime(d.callTime)
      if (d.estimatedWrap != null) setEstimatedWrap(d.estimatedWrap)
      if (d.producerEmail != null) setProducerEmail(d.producerEmail)
      if (d.directorEmail != null) setDirectorEmail(d.directorEmail)
      if (d.producerName != null) setProducerName(d.producerName)
      if (d.producerPhone != null) setProducerPhone(d.producerPhone)
      if (d.producerEmailText != null) setProducerEmailText(d.producerEmailText)
      if (d.creative != null) setCreative(d.creative)
      if (Array.isArray(d.crew)) setCrew(d.crew)
      if (d.videographerCount != null) setVideographerCount(d.videographerCount)
      if (d.cameraCount != null) setCameraCount(d.cameraCount)
      if (d.micCount != null) setMicCount(d.micCount)
      if (typeof d.isBlockShot === 'boolean') setIsBlockShot(d.isBlockShot)
      if (typeof d.needsVan === 'boolean') setNeedsVan(d.needsVan)
      if (typeof d.eventExternal === 'boolean') setEventExternal(d.eventExternal)
      if (Array.isArray(d.specialEquipment)) setSpecialEquipment(d.specialEquipment)
      if (d.agencyRef != null) setAgencyRef(d.agencyRef)
      if (d.projectId != null) setProjectId(d.projectId)
      if (Array.isArray(d.selectedEpisodeIds)) setSelectedEpisodeIds(d.selectedEpisodeIds)
      if (d.producerSel != null) setProducerSel(d.producerSel)
      if (d.coProducerSel != null) setCoProducerSel(d.coProducerSel)
      if (d.notes != null) setNotes(d.notes)
      if (typeof d.epCount === 'number') setEpCount(d.epCount)
      if (Array.isArray(d.epRows) && d.epRows.length) setEpRows(d.epRows)
      if (d.step) setStep(d.step)
    } catch {}
    setDraftFound(false)
    setDraftDecided(true)
  }

  /* ---- cascade: outlet change ---- */
  const handleOutletChange = (code: string) => {
    const wasContentAgency = isContentAgency
    const willBeContentAgency = code === 'AGN'
    const cleared: string[] = []
    if (programCode) cleared.push('Episode Type')
    if (projectId) cleared.push('Project ID')
    if (selectedEpisodeIds.length > 0) cleared.push(`${selectedEpisodeIds.length} Episode pick(s)`)
    if (!willBeContentAgency && epRows.some(r => r.programCode)) cleared.push('Episode program(s)')
    if (wasContentAgency && producerEmail) cleared.push('Producer (CA)')
    if (wasContentAgency && directorEmail) cleared.push('Director')
    if (!wasContentAgency && (producerName || producerPhone || producerEmailText)) cleared.push('Producer contact')

    setOutletCode(code)
    setProgramCode('')
    setProducerEmail('')
    setDirectorEmail('')
    setProducerName('')
    setProducerPhone('')
    setProducerEmailText('')
    setProjectId('')
    setSelectedEpisodeIds([])
    // Program options are outlet-specific, so the per-episode picks are no
    // longer valid — keep the titles/types but clear the program selection.
    setEpRows(prev => prev.map(r => ({ ...r, programCode: '' })))

    if (cleared.length > 0) {
      const flow = willBeContentAgency ? 'Content Agency' : 'standard'
      setOutletChangeWarning(`เปลี่ยน Outlet → ล้างค่า: ${cleared.join(', ')} (สวิทช์เป็น ${flow} flow)`)
      setTimeout(() => setOutletChangeWarning(''), 6000)
    }

    setFieldErrors(prev => {
      const next = { ...prev }
      ;['outletCode','programCode','producerEmail','directorEmail','producerName','producerPhone','producerEmailText','projectId','selectedEpisodeIds']
        .forEach(k => delete next[k])
      return next
    })
  }

  const handleEpCountChange = (n: number) => {
    setEpCount(n)
    setEpRows(prev => {
      const next = [...prev]
      while (next.length < n) next.push({ programCode: '', title: '', contentType: 'ORIGINAL_CONTENT' })
      return next.slice(0, n)
    })
  }

  const updateEpRow = (idx: number, patch: Partial<EpRow>) =>
    setEpRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))

  const toggleCrew = (c: string) =>
    setCrew(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])

  // v1.63.0 — special-gear checklist (power users tick what they already know they need)
  const SPECIAL_EQUIPMENT_OPTIONS = ['Gimbal/Ronin', 'Prompter', 'Clip-on Mic (DJI Mic)', 'ไฟดวงเล็ก'] as const
  const toggleSpecialEquipment = (item: string) =>
    setSpecialEquipment(prev => prev.includes(item) ? prev.filter(x => x !== item) : [...prev, item])

  // v1.63.0 — live, NON-BLOCKING camera-overload warning (set by the effect below)
  const [cameraLoadWarning, setCameraLoadWarning] = useState('')

  const toggleEpisode = (epId: string) =>
    setSelectedEpisodeIds(prev =>
      prev.includes(epId) ? prev.filter(x => x !== epId) : [...prev, epId],
    )

  /* ---- per-step validation ---- */
  // Returns the new errors map for the requested step (empty = valid).
  const validateStep = (s: StepKey): Record<string, string> => {
    const errs: Record<string, string> = {}
    if (s === 1) {
      if (!outletCode) errs.outletCode = 'กรุณาเลือก Outlet'
      if (!programCode) errs.programCode = 'กรุณาเลือก Episode Type'
      if (!category) errs.category = 'กรุณาเลือก Category'
      if (!videoType) errs.videoType = 'กรุณาเลือก Video Type'
    } else if (s === 2) {
      if (!shootDate) errs.shootDate = 'กรุณาเลือก Shoot Date'
      if (!shootEndDate) errs.shootEndDate = 'กรุณาเลือก Shoot End Date'
      if (shootDate && shootEndDate && shootEndDate < shootDate) {
        errs.shootEndDate = 'Shoot End Date ต้องไม่อยู่ก่อน Shoot Date'
      }
      if (!callTime) errs.callTime = 'กรุณาเลือก Call Time'
      // v1.41.0 — Estimated Wrap is now REQUIRED. When it was optional the
      // calendar fell back to "call time + 4h", which mis-stated the team's
      // workload/time calc (ops feedback). Force a real wrap time.
      if (!estimatedWrap) {
        errs.estimatedWrap = 'กรุณาเลือก Estimated Wrap'
      } else if (callTime && shootDate && shootEndDate && shootDate === shootEndDate && estimatedWrap <= callTime) {
        errs.estimatedWrap = 'Estimated Wrap ต้องอยู่หลัง Call Time (เมื่อถ่ายวันเดียว)'
      }
    } else if (s === 3) {
      if (offsite) {
        if (!mapLocation.trim()) errs.mapLocation = 'กรุณากรอกสถานที่ / Map location'
      } else {
        if (!locationId) errs.locationId = 'กรุณาเลือก Location / Room'
        if (needsCustomText && !locationCustom.trim()) errs.locationCustom = 'กรุณาระบุสถานที่จริง'
      }
    } else if (s === 4) {
      if (isContentAgency) {
        if (!producerEmail) errs.producerEmail = 'กรุณาเลือก Producer'
        // v1.54 — Director เป็น optional สำหรับ Content Agency
        if (projectSelectable && !projectId) errs.projectId = 'กรุณาเลือก Project ID'
        if (projectId && selectedEpisodeIds.length === 0) errs.selectedEpisodeIds = 'กรุณาเลือกอย่างน้อย 1 Episode'
      } else if (useProducerDropdown) {
        if (!producerSel) errs.producerSel = 'กรุณาเลือก Producer'
        const missing: string[] = []
        epRows.forEach((r, i) => {
          if (!r.programCode) missing.push(`โปรแกรม EP${i + 1}`)
          if (!r.title.trim()) missing.push(`ชื่อ EP${i + 1}`)
        })
        if (missing.length > 0) errs.epRows = `กรุณากรอก: ${missing.join(', ')}`
      } else {
        if (!producerName.trim()) errs.producerName = 'กรุณากรอกชื่อ Producer'
        if (!producerPhone.trim()) errs.producerPhone = 'กรุณากรอกเบอร์โทร Producer'
        if (!producerEmailText.trim()) errs.producerEmailText = 'กรุณากรอกอีเมล Producer'
        const missing: string[] = []
        epRows.forEach((r, i) => {
          if (!r.programCode) missing.push(`โปรแกรม EP${i + 1}`)
          if (!r.title.trim()) missing.push(`ชื่อ EP${i + 1}`)
        })
        if (missing.length > 0) errs.epRows = `กรุณากรอก: ${missing.join(', ')}`
      }
      // v1.66 — camera + mic counts are REQUIRED for every flow. Bookings
      // arriving without them broke the camera-overload check + crew planning.
      // 0 is allowed (audio-only / no-camera shoots) but the field can't be blank.
      // v1.67 — except a Block Shot booking, where gear isn't pinned down yet.
      if (!isBlockShot) {
        const camN = parseInt(cameraCount, 10)
        if (cameraCount.trim() === '' || isNaN(camN) || camN < 0) errs.cameraCount = 'กรุณาระบุจำนวนกล้อง (ใส่ 0 ถ้าไม่ใช้กล้อง)'
        const micN = parseInt(micCount, 10)
        if (micCount.trim() === '' || isNaN(micN) || micN < 0) errs.micCount = 'กรุณาระบุจำนวนไมค์ (ใส่ 0 ถ้าไม่ใช้ไมค์)'
      }
    }
    return errs
  }

  // Aggregate all steps — used right before submit to be certain.
  const validateAll = (): Record<string, string> => ({
    ...validateStep(1),
    ...validateStep(2),
    ...validateStep(3),
    ...validateStep(4),
  })

  const stepComplete: Record<StepKey, boolean> = useMemo(() => ({
    1: Object.keys(validateStep(1)).length === 0,
    2: Object.keys(validateStep(2)).length === 0,
    3: Object.keys(validateStep(3)).length === 0,
    4: Object.keys(validateStep(4)).length === 0,
    5: false,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [
    outletCode, programCode, category, videoType,
    shootDate, shootEndDate, callTime, estimatedWrap,
    locationId, locationCustom, needsCustomText, shootType, mapLocation,
    isContentAgency, producerEmail, directorEmail, projectId, selectedEpisodeIds,
    producerName, producerPhone, producerEmailText, epRows, projectSelectable,
    useProducerDropdown, producerSel, coProducerSel,
  ])

  /* ---- navigation ---- */
  const scrollTop = () => {
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const goNext = () => {
    const errs = validateStep(step)
    // Replace error map — each step owns its own keys, so old errors from past
    // steps can't have survived (we would not have been able to advance past
    // them) and future-step errors haven't been validated yet.
    setFieldErrors(errs)
    if (Object.keys(errs).length > 0) {
      setError('กรุณาตรวจสอบช่องที่ไฮไลต์สีแดง')
      return
    }
    setError('')
    setStep(s => (s < 5 ? ((s + 1) as StepKey) : s))
    scrollTop()
  }

  const goBack = () => {
    setError('')
    setStep(s => (s > 1 ? ((s - 1) as StepKey) : s))
    scrollTop()
  }

  const jumpTo = (target: StepKey) => {
    setError('')
    setStep(target)
    scrollTop()
  }

  const handleSubmit = async () => {
    const errs = validateAll()
    setFieldErrors(errs)
    if (Object.keys(errs).length > 0) {
      setError('ยังกรอกไม่ครบ — กลับไปแก้ขั้นที่ไฮไลต์')
      return
    }
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
            : useProducerDropdown
              ? (selProd?.nickname || selProd?.name || '')
              : producerName.trim(),
          producerEmail: isContentAgency
            ? producerEmail
            : useProducerDropdown
              ? (producerSel || null)
              : (producerEmailText.trim() || null),
          producerPhone: isContentAgency || useProducerDropdown ? null : (producerPhone.trim() || null),
          director: isContentAgency
            ? directors.find(d => d.email === directorEmail)?.nickname || ''
            : null,
          directorEmail: isContentAgency ? directorEmail : null,
          // v1.59 — Co-Producer (non-AGN dropdown only)
          coProducer: useProducerDropdown ? (selCoProd?.nickname || selCoProd?.name || null) : null,
          coProducerEmail: useProducerDropdown ? (coProducerSel || null) : null,
          creative: creative ? creative.split(',').map(s => s.trim()).filter(Boolean) : [],
          crewRequired: crew,
          videographerCount: crew.includes('Videographer') ? Math.max(1, parseInt(videographerCount, 10) || 1) : 1,
          cameraCount: cameraCount.trim() === '' ? null : Math.max(0, parseInt(cameraCount, 10) || 0),
          micCount: micCount.trim() === '' ? null : Math.max(0, parseInt(micCount, 10) || 0),
          isBlockShot,
          needsVan,
          specialEquipment,
          agencyRef: agencyRef || null,
          projectId: isContentAgency ? (projectId || null) : null,
          projectName: isContentAgency ? (selectedProject?.projectName || null) : null,
          episodeType: (isContentAgency && projectId && programCode.length === 1) ? programCode : null,
          notes: notes || null,
          episodes: epRows.map(r => ({
            programCode: r.programCode,
            title: r.title.trim(),
            contentType: r.contentType,
          })),
          selectedEpisodeIds,
        }),
      })
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('application/json')) {
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
      clearDraft() // booking created — drop the saved draft
      router.push(`/booking/success?id=${data.booking.id}`)
    } catch (err: any) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  /* ---- summary values (used by both panel + review step) ---- */
  const caProducer = producers.find(p => p.email === producerEmail)
  const caDirector = directors.find(d => d.email === directorEmail)
  const filledEpRows = epRows.filter(r => r.title.trim())
  const summary = {
    outlet: selectedOutlet ? `${selectedOutlet.name} (${selectedOutlet.code})` : '',
    episodeType: selectedProgram ? `${selectedProgram.code} · ${selectedProgram.name}` : '',
    category,
    videoType,
    dateRange: shootDate && shootEndDate
      ? (shootDate === shootEndDate ? shootDate : `${shootDate} → ${shootEndDate}`)
      : (shootDate || ''),
    timeRange: callTime ? (estimatedWrap ? `${callTime} → ${estimatedWrap}` : callTime) : '',
    shootType,
    location: resolvedLocationName || '',
    producer: isContentAgency
      ? (caProducer?.nickname ? `${caProducer.nickname} (${producerEmail})` : producerEmail)
      : useProducerDropdown
        ? (selProd ? `${selProd.nickname}` : '')
        : (producerName
            ? `${producerName}${producerPhone ? ` · ${producerPhone}` : ''}${producerEmailText ? ` · ${producerEmailText}` : ''}`
            : ''),
    coProducer: useProducerDropdown && selCoProd ? selCoProd.nickname : '',
    director: isContentAgency
      ? (caDirector?.nickname ? `${caDirector.nickname} (${directorEmail})` : directorEmail)
      : '',
    project: isContentAgency && selectedProject
      ? `${selectedProject.projectId} — ${selectedProject.projectName}`
      : '',
    episodes: isContentAgency
      ? selectedEpisodeIds.length > 0
          ? `${selectedEpisodeIds.length} ตอน · ${selectedEpisodeIds.join(', ')}`
          : ''
      : (filledEpRows.length > 0
          ? `${filledEpRows.length} ตอน · ${filledEpRows
              .map(r => `${r.programCode || '?'} · ${r.title.trim()}${r.contentType === 'ADVERTORIAL' ? ' (AD)' : ''}`)
              .join(', ')}`
          : ''),
    subject: creative,
    productCode: agencyRef,
    crew: crew.length > 0
      ? (() => { const vc = Math.max(1, parseInt(videographerCount, 10) || 1)
          return crew.map(c => c === 'Videographer' && vc > 1 ? `${c} ×${vc}` : c).join(', ') })()
      : '',
    equipment: [
      isBlockShot ? '📦 Block Shot (ไม่ระบุจำนวนกล้อง/ไมค์)' : '',
      cameraCount.trim() && Number(cameraCount) > 0 ? `🎥 ${parseInt(cameraCount, 10)}` : '',
      micCount.trim() && Number(micCount) > 0 ? `🎙 ${parseInt(micCount, 10)}` : '',
    ].filter(Boolean).join(' · '),
    specialEquipment: specialEquipment.length > 0 ? specialEquipment.join(', ') : '',
    van: needsVan ? '🚐 ต้องการรถตู้' : '',
    notes,
  }

  /* ============ Render ============ */
  return (
    <div className="max-w-[1180px] mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-24 md:pb-6">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl">New Booking</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            5 steps — Submit fires only on the Review step.
          </p>
        </div>
      </div>

      {/* Resume-draft prompt (v1.78) */}
      {draftFound && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap">
          <span className="text-sm text-amber-900">พบฉบับร่างที่ค้างไว้ — ทำต่อจากเดิมไหม?</span>
          <span className="flex items-center gap-2">
            <button type="button" onClick={resumeDraft} className="px-3 py-1.5 text-sm rounded bg-[#673ab7] text-white hover:bg-[#5e35b1]">ทำต่อ</button>
            <button type="button" onClick={discardDraft} className="px-3 py-1.5 text-sm rounded border border-gray-300 text-gray-600 hover:bg-white">เริ่มใหม่</button>
          </span>
        </div>
      )}

      {/* Stepper */}
      <div className="ops-card ops-card-pad mb-3">
        <Stepper current={step} completed={stepComplete} onJump={jumpTo} />
      </div>

      {/* Warnings / errors */}
      {outletChangeWarning && (
        <div className="ops-card px-3 py-2 mb-3 text-xs text-amber-800 bg-amber-50 border-amber-200 border-l-4 border-l-amber-400">
          ⚠ {outletChangeWarning}
        </div>
      )}
      {error && (
        <div className="ops-card px-3 py-2 mb-3 text-sm text-red-700 bg-red-50 border-red-200 border-l-4 border-l-red-500">
          {error}
        </div>
      )}
      {cameraLoadWarning && (
        <div className="ops-card px-3 py-2 mb-3 text-sm text-red-700 bg-red-50 border-red-200 border-l-4 border-l-red-500">
          {cameraLoadWarning}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* ============ LEFT — Form ============ */}
        <div>
          {step === 1 && (
            <div className="ops-card ops-card-pad">
              <StepHeader step={1} title="Project" subtitle="ระบุงานนี้เป็นของ Outlet ไหน Episode Type อะไร" />

              <div className="space-y-4">
                <div>
                  <Label htmlFor="outletCode" required>Outlet</Label>
                  <select
                    id="outletCode"
                    className={`ops-input ${fieldErrors.outletCode ? 'ops-input-invalid' : ''}`}
                    value={outletCode}
                    onChange={e => handleOutletChange(e.target.value)}
                    aria-invalid={!!fieldErrors.outletCode}
                  >
                    <option value="">— Select Outlet —</option>
                    {OUTLETS.map(o => <option key={o.code} value={o.code}>{o.name}</option>)}
                  </select>
                  <FieldError message={fieldErrors.outletCode} />
                </div>

                <div>
                  <Label htmlFor="programCode" required>Episode Type</Label>
                  <select
                    id="programCode"
                    className={`ops-input ${fieldErrors.programCode ? 'ops-input-invalid' : ''}`}
                    value={programCode}
                    onChange={e => setProgramCode(e.target.value)}
                    disabled={!outletCode}
                    aria-invalid={!!fieldErrors.programCode}
                  >
                    <option value="">{outletCode ? '— Select Episode Type —' : '— Select Outlet first —'}</option>
                    {programs.map(p => <option key={p.code} value={p.code}>{p.code} · {p.name}</option>)}
                  </select>
                  <FieldHelp>L · Long Form / S · Short Form / A · Audio / T · Talk — ใช้จัดหมวดเดียวกับ Dashboard</FieldHelp>
                  <FieldError message={fieldErrors.programCode} />
                </div>

                {/* v1.98.0 — Category radio shown ONLY for Content Agency (it drives
                    AGN Drive folder routing). Non-AGN outlets tag content per-episode
                    (Original Content / AD on each EP), so the booking-level category is
                    derived server-side from the episodes — the radio is redundant there. */}
                {isContentAgency && (
                <div>
                  <Label required>Category</Label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {CATEGORIES.map(c => (
                      <label key={c} className={`ops-choice ${category === c ? 'ops-choice-selected' : ''}`}>
                        <input
                          type="radio"
                          name="category"
                          value={c}
                          checked={category === c}
                          onChange={() => setCategory(c)}
                          className="accent-brand-primary mt-0.5"
                        />
                        <span className="text-xs text-gray-700">{c}</span>
                      </label>
                    ))}
                  </div>
                  <FieldHelp>
                    Original Content = งาน Outlet ของเราเอง · Advertorial = สปอนเซอร์ · Event = อีเวนต์ · Internal = ใช้ภายในองค์กร
                  </FieldHelp>
                  <FieldError message={fieldErrors.category} />
                </div>
                )}

                <div>
                  <Label required>Video Type</Label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {VIDEO_TYPES.map(v => (
                      <label key={v} className={`ops-choice ${videoType === v ? 'ops-choice-selected' : ''}`}>
                        <input
                          type="radio"
                          name="videoType"
                          value={v}
                          checked={videoType === v}
                          onChange={() => setVideoType(v)}
                          className="accent-brand-primary mt-0.5"
                        />
                        <span className="text-xs text-gray-700">{v}</span>
                      </label>
                    ))}
                  </div>
                  <FieldError message={fieldErrors.videoType} />
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="ops-card ops-card-pad">
              <StepHeader step={2} title="Schedule" subtitle="วันและเวลาถ่าย" />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="shootDate" required>Shoot Date</Label>
                  <input
                    id="shootDate"
                    type="date"
                    className={`ops-input ${fieldErrors.shootDate ? 'ops-input-invalid' : ''}`}
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
                  <Label htmlFor="shootEndDate" required>Shoot End Date</Label>
                  <input
                    id="shootEndDate"
                    type="date"
                    className={`ops-input ${fieldErrors.shootEndDate ? 'ops-input-invalid' : ''}`}
                    value={shootEndDate}
                    onChange={e => setShootEndDate(e.target.value)}
                    min={shootDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]}
                    aria-invalid={!!fieldErrors.shootEndDate}
                  />
                  <FieldHelp>ถ่ายวันเดียว = วันเดียวกับวันเริ่ม (เติมให้อัตโนมัติ)</FieldHelp>
                  <FieldError message={fieldErrors.shootEndDate} />
                </div>
                <div>
                  <Label htmlFor="callTime" required>Call Time</Label>
                  <input
                    id="callTime"
                    type="time"
                    className={`ops-input ${fieldErrors.callTime ? 'ops-input-invalid' : ''}`}
                    value={callTime}
                    onChange={e => setCallTime(e.target.value)}
                    aria-invalid={!!fieldErrors.callTime}
                  />
                  <FieldError message={fieldErrors.callTime} />
                </div>
                <div>
                  <Label htmlFor="estimatedWrap" required>Estimated Wrap</Label>
                  <input
                    id="estimatedWrap"
                    type="time"
                    className={`ops-input ${fieldErrors.estimatedWrap ? 'ops-input-invalid' : ''}`}
                    value={estimatedWrap}
                    onChange={e => setEstimatedWrap(e.target.value)}
                    aria-invalid={!!fieldErrors.estimatedWrap}
                  />
                  <FieldHelp>เวลาที่คาดว่าจะถ่ายเสร็จ — ใช้คำนวณเวลางาน/workload ของทีม</FieldHelp>
                  <FieldError message={fieldErrors.estimatedWrap} />
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="ops-card ops-card-pad">
              <StepHeader step={3} title="Location" subtitle="ประเภทการถ่าย + สถานที่จริง" />

              <div className="space-y-4">
                <div>
                  <Label required>Shoot Type</Label>
                  <div className="grid grid-cols-3 gap-2">
                    {SHOOT_TYPES.map(t => (
                      <label key={t} className={`ops-choice ${shootType === t ? 'ops-choice-selected' : ''}`}>
                        <input
                          type="radio"
                          name="shootType"
                          value={t}
                          checked={shootType === t}
                          onChange={() => {
                            setShootType(t)
                            // v1.58 — keep the two location modes from carrying
                            // stale values across a switch, and van is off-site only.
                            // v1.101 — a fresh shoot-type starts "office"; clear the
                            // Event-external flag too.
                            setEventExternal(false)
                            if (t === 'On Location') {
                              setLocationId(''); setLocationCustom('')
                            } else {
                              setMapLocation(''); setNeedsVan(false)
                            }
                          }}
                          className="accent-brand-primary mt-0.5"
                        />
                        <span className="text-xs text-gray-700">{t}</span>
                      </label>
                    ))}
                  </div>
                  <FieldHelp>ประเภทการผลิต — ไม่ใช่ห้อง/สถานที่ ใส่ตรงข้างล่าง</FieldHelp>
                </div>

                {/* v1.101 — Event at an external venue → behaves like On Location
                    (Map location + van). Office events keep the room picker. */}
                {shootType === 'Event' && (
                  <div>
                    <Label>สถานที่จัดงาน</Label>
                    <label className={`ops-choice ${eventExternal ? 'ops-choice-selected' : ''} cursor-pointer`}>
                      <input
                        type="checkbox"
                        checked={eventExternal}
                        onChange={e => {
                          const ext = e.target.checked
                          setEventExternal(ext)
                          if (ext) { setLocationId(''); setLocationCustom('') }   // → external: drop room
                          else { setMapLocation(''); setNeedsVan(false) }          // → office: drop map + van
                        }}
                        className="accent-brand-primary mt-0.5"
                      />
                      <span className="text-sm text-gray-700">📍 สถานที่ภายนอก (จัดงานนอกบริษัท)</span>
                    </label>
                    <FieldHelp>อีเวนต์นอกบริษัท — เลือกข้อนี้เพื่อใส่ Map location + ขอรถตู้</FieldHelp>
                  </div>
                )}

                {/* v1.41.0 — van request, v1.58 — off-site only. Adds 🚐 to the
                    calendar event title (web + Google) so logistics see it. */}
                {offsite && (
                  <div>
                    <Label>การเดินทาง</Label>
                    <label className={`ops-choice ${needsVan ? 'ops-choice-selected' : ''} cursor-pointer`}>
                      <input
                        type="checkbox"
                        checked={needsVan}
                        onChange={e => setNeedsVan(e.target.checked)}
                        className="accent-brand-primary mt-0.5"
                      />
                      <span className="text-sm text-gray-700">🚐 ต้องการรถตู้ (งานออกนอกสถานที่)</span>
                    </label>
                    <FieldHelp>ถ้าเลือก ชื่องานบนปฏิทินจะขึ้น 🚐 นำหน้า</FieldHelp>
                  </div>
                )}

                {offsite ? (
                  /* v1.58 — off-site: Map location box, no office-room picker */
                  <div>
                    <Label htmlFor="mapLocation" required>สถานที่ / Map location</Label>
                    <p className="text-xs text-gray-500 mb-2 leading-snug">สถานที่ถ่ายจริง — ใส่ชื่อสถานที่ ที่อยู่ หรือวางลิงก์ Google Maps</p>
                    <input
                      id="mapLocation"
                      type="text"
                      className={`ops-input ${fieldErrors.mapLocation ? 'ops-input-invalid' : ''}`}
                      placeholder="เช่น ICONSIAM · 299 ถ.เจริญนคร · https://maps.app.goo.gl/…"
                      value={mapLocation}
                      onChange={e => setMapLocation(e.target.value)}
                      aria-invalid={!!fieldErrors.mapLocation}
                    />
                    <FieldError message={fieldErrors.mapLocation} />
                  </div>
                ) : (
                  /* v1.58 — office: room picker only (no external options) */
                  <div>
                    <Label htmlFor="locationId" required>Location / Room</Label>
                    <p className="text-xs text-gray-500 mb-2 leading-snug">ห้อง/สถานที่ในออฟฟิศที่ใช้ถ่าย</p>
                    <select
                      id="locationId"
                      className={`ops-input ${fieldErrors.locationId ? 'ops-input-invalid' : ''}`}
                      value={locationId}
                      onChange={e => { setLocationId(e.target.value); setLocationCustom('') }}
                      aria-invalid={!!fieldErrors.locationId}
                    >
                      <option value="">Choose a room…</option>
                      {LOCATION_GROUPS.filter(g => g.key !== 'EXTERNAL').map(g => (
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
                      <p className="text-xs text-gray-500 mt-2 flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {selectedLocation.fullName}{selectedLocation.capacity ? ` · capacity ${selectedLocation.capacity}` : ''}
                      </p>
                    )}

                    {needsCustomText && (
                      <div className="mt-3">
                        <Label htmlFor="locationCustom" required>Specify Location</Label>
                        <input
                          id="locationCustom"
                          type="text"
                          className={`ops-input ${fieldErrors.locationCustom ? 'ops-input-invalid' : ''}`}
                          placeholder="ชื่อสถานที่ · ที่อยู่ · หรือลิงก์ Google Maps"
                          value={locationCustom}
                          onChange={e => setLocationCustom(e.target.value)}
                          aria-invalid={!!fieldErrors.locationCustom}
                        />
                        <FieldError message={fieldErrors.locationCustom} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="ops-card ops-card-pad">
              <StepHeader
                step={4}
                title="People & Crew"
                subtitle={isContentAgency
                  ? 'Producer/Director ของโปรเจกต์ · Project + Episodes ที่ถ่ายรอบนี้ · Crew'
                  : 'ผู้ติดต่อจากฝั่งคุณ · จำนวน Episodes · Crew'}
              />

              <div className="space-y-5">
                {/* Producer */}
                <div>
                  {!useProducerDropdown && <Label required>Producer</Label>}
                  {isContentAgency ? (
                    <>
                      <select
                        className={`ops-input ${fieldErrors.producerEmail ? 'ops-input-invalid' : ''}`}
                        value={producerEmail}
                        onChange={e => { setProducerEmail(e.target.value); setProjectId('') }}
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
                      <FieldHelp>ดึงจาก &ldquo;_Users&rdquo; tab ของ Dashboard · กรอง Project ID ด้านล่างให้</FieldHelp>
                      <FieldError message={fieldErrors.producerEmail} />
                    </>
                  ) : useProducerDropdown ? (
                    /* v1.59 — per-outlet Producer + Co-Producer dropdowns */
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="producerSel" required>Producer</Label>
                        <select
                          id="producerSel"
                          className={`ops-input ${fieldErrors.producerSel ? 'ops-input-invalid' : ''}`}
                          value={producerSel}
                          onChange={e => setProducerSel(e.target.value)}
                          disabled={outletPeopleLoading}
                          aria-invalid={!!fieldErrors.producerSel}
                        >
                          <option value="">{outletPeopleLoading ? 'Loading…' : '— เลือก Producer —'}</option>
                          {outletProducers.map(p => (
                            <option key={p.email} value={p.email}>{p.nickname}</option>
                          ))}
                        </select>
                        <FieldError message={fieldErrors.producerSel} />
                      </div>
                      <div>
                        <Label htmlFor="coProducerSel">
                          Co-Producer <span className="text-[11px] font-normal text-gray-400">(ถ้ามี)</span>
                        </Label>
                        <select
                          id="coProducerSel"
                          className="ops-input"
                          value={coProducerSel}
                          onChange={e => setCoProducerSel(e.target.value)}
                          disabled={outletPeopleLoading || outletCoProducers.length === 0}
                        >
                          <option value="">{outletCoProducers.length === 0 ? '— ไม่มี Co-Producer —' : '— ไม่มี / เลือก Co-Producer —'}</option>
                          {outletCoProducers.map(p => (
                            <option key={p.email} value={p.email}>{p.nickname}</option>
                          ))}
                        </select>
                        <FieldHelp>รายชื่อตาม Outlet — จัดการได้ที่ /admin/permissions</FieldHelp>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <Label htmlFor="producerName" required>Name</Label>
                        <input
                          id="producerName"
                          type="text"
                          className={`ops-input ${fieldErrors.producerName ? 'ops-input-invalid' : ''}`}
                          placeholder="ชื่อ-นามสกุล"
                          value={producerName}
                          onChange={e => setProducerName(e.target.value)}
                          aria-invalid={!!fieldErrors.producerName}
                        />
                        <FieldError message={fieldErrors.producerName} />
                      </div>
                      <div>
                        <Label htmlFor="producerPhone" required>Phone</Label>
                        <input
                          id="producerPhone"
                          type="tel"
                          className={`ops-input ${fieldErrors.producerPhone ? 'ops-input-invalid' : ''}`}
                          placeholder="เบอร์โทรศัพท์"
                          value={producerPhone}
                          onChange={e => setProducerPhone(e.target.value)}
                          aria-invalid={!!fieldErrors.producerPhone}
                        />
                        <FieldError message={fieldErrors.producerPhone} />
                      </div>
                      <div>
                        <Label htmlFor="producerEmailText" required>Email</Label>
                        <input
                          id="producerEmailText"
                          type="email"
                          className={`ops-input ${fieldErrors.producerEmailText ? 'ops-input-invalid' : ''}`}
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

                {/* Project ID + Episodes — CA only.
                    Ordered right after Producer so the project list filters by
                    the selected Producer; Director comes after this block. */}
                {isContentAgency && (
                  <div>
                    <Label htmlFor="projectId" required={projectSelectable}>Project ID
                      <span className="ml-2 text-[11px] font-normal text-gray-500">(from Producer Dashboard)</span>
                    </Label>
                    <select
                      id="projectId"
                      className={`ops-input ${fieldErrors.projectId ? 'ops-input-invalid' : ''}`}
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
                          {p.projectId} · {p.projectName}{p.producer ? ` (${p.producer})` : ''}
                        </option>
                      ))}
                    </select>
                    <FieldHelp>กรองตาม Producer ที่เลือกด้านบน</FieldHelp>
                    <FieldError message={fieldErrors.projectId} />

                    {projectsUnavailable && (
                      <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                        ⚠️ โหลดรายการ Project จาก Producer Dashboard ไม่ได้ตอนนี้ — จองคิวได้เลยโดยไม่ต้องระบุ Project ID
                      </div>
                    )}
                    {selectedProject && (
                      <div className="mt-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-700">
                        <div><span className="text-gray-500">Project:</span> {selectedProject.projectName}</div>
                        {selectedProject.producer && (
                          <div><span className="text-gray-500">Producer:</span> {selectedProject.producer}</div>
                        )}
                      </div>
                    )}

                    {projectId && (
                      <div className="mt-4">
                        <Label required>Episodes ที่จะถ่ายรอบนี้</Label>
                        {episodesLoading ? (
                          <p className="text-sm text-gray-400 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> กำลังโหลด episodes…</p>
                        ) : projectEpisodes.length === 0 ? (
                          <p className="text-sm text-gray-400">— ไม่มี episode ที่ถ่ายได้ (Published หมดแล้ว หรือยังไม่ถูกสร้างในชีต) —</p>
                        ) : (
                          <div className="max-h-72 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                            {projectEpisodes.map(ep => {
                              const checked = selectedEpisodeIds.includes(ep.episodeId)
                              return (
                                <label key={ep.episodeId} className={`flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50 ${checked ? 'bg-brand-primary/5' : ''}`}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleEpisode(ep.episodeId)}
                                    className="accent-brand-primary mt-0.5"
                                  />
                                  <span className="text-sm text-gray-700 leading-snug">
                                    <span className="font-mono font-medium">{ep.episodeId}</span>
                                    <span className="text-xs text-gray-500 ml-1">
                                      · {ep.status}
                                      {ep.productCode ? ` · ${ep.productCode}` : ''}
                                      {ep.ep && ep.ep !== '-' ? ` · ${ep.ep}` : ''}
                                    </span>
                                  </span>
                                </label>
                              )
                            })}
                          </div>
                        )}
                        {selectedEpisodeIds.length > 0 && (
                          <p className="text-xs text-gray-500 mt-2">เลือกแล้ว {selectedEpisodeIds.length} EP</p>
                        )}
                        <FieldError message={fieldErrors.selectedEpisodeIds} />
                      </div>
                    )}
                  </div>
                )}

                {/* Director — CA only.
                    Moved below Project so the producer→project filter chain
                    reads top-to-bottom: pick Producer, then Project (filtered),
                    then Episodes (depend on Project), then Director. */}
                {isContentAgency && (
                  <div>
                    <Label htmlFor="directorEmail">Director <span className="text-gray-400 font-normal">(ไม่บังคับ)</span></Label>
                    <select
                      id="directorEmail"
                      className={`ops-input ${fieldErrors.directorEmail ? 'ops-input-invalid' : ''}`}
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
                            : '— ไม่ระบุ / เลือก Director —'}
                      </option>
                      {directors.map(d => (
                        <option key={d.email} value={d.email}>{d.nickname} ({d.email})</option>
                      ))}
                    </select>
                    <FieldError message={fieldErrors.directorEmail} />
                  </div>
                )}

                {/* Episodes — non-CA. Each episode picks its own program (show)
                    and is tagged Original Content vs Advertorial (AD). */}
                {!isContentAgency && (
                  <div>
                    <Label htmlFor="epCount" required>Number of Episodes</Label>
                    <select
                      id="epCount"
                      className="ops-input mb-3"
                      value={epCount}
                      onChange={e => handleEpCountChange(Number(e.target.value))}
                    >
                      {Array.from({ length: 20 }, (_, i) => i + 1).map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    <div className="space-y-3">
                      {epRows.map((row, idx) => (
                        <div key={idx} className="rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-full bg-brand-primary/10 text-xs font-semibold text-brand-primary">
                              {idx + 1}
                            </span>
                            <select
                              className={`ops-input flex-1 ${fieldErrors.epRows && !row.programCode ? 'ops-input-invalid' : ''}`}
                              value={row.programCode}
                              disabled={!outletCode}
                              onChange={e => updateEpRow(idx, { programCode: e.target.value })}
                              aria-label={`Episode ${idx + 1} program`}
                            >
                              <option value="">{outletCode ? '— เลือกโปรแกรม —' : '— เลือก Outlet ก่อน —'}</option>
                              {epPrograms.map(p => (
                                <option key={p.code} value={p.code}>{p.code} · {p.name}</option>
                              ))}
                            </select>
                            {idx > 0 && (
                              <button
                                type="button"
                                title="คัดลอกโปรแกรม + ประเภทจาก EP ก่อนหน้า"
                                onClick={() => updateEpRow(idx, { programCode: epRows[idx - 1].programCode, contentType: epRows[idx - 1].contentType })}
                                className="shrink-0 text-xs text-brand-primary hover:underline whitespace-nowrap"
                              >
                                ↑ เหมือนก่อนหน้า
                              </button>
                            )}
                          </div>
                          <input
                            type="text"
                            className={`ops-input ${fieldErrors.epRows && !row.title.trim() ? 'ops-input-invalid' : ''}`}
                            placeholder={`Episode ${idx + 1} title`}
                            value={row.title}
                            onChange={e => updateEpRow(idx, { title: e.target.value })}
                            aria-label={`Episode ${idx + 1} title`}
                          />
                          <div className="flex gap-2">
                            {([['ORIGINAL_CONTENT', 'Original Content'], ['ADVERTORIAL', 'AD']] as const).map(([val, lbl]) => (
                              <button
                                key={val}
                                type="button"
                                onClick={() => updateEpRow(idx, { contentType: val })}
                                aria-pressed={row.contentType === val}
                                className={`flex-1 rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                                  row.contentType === val
                                    ? val === 'ADVERTORIAL'
                                      ? 'border-amber-400 bg-amber-50 text-amber-800'
                                      : 'border-brand-primary bg-brand-primary/10 text-brand-primary'
                                    : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                }`}
                              >
                                {lbl}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    <FieldHelp>เลือกโปรแกรม + ระบุว่าแต่ละ EP เป็น Original Content หรือ AD</FieldHelp>
                    <FieldError message={fieldErrors.epRows} />
                  </div>
                )}

                {/* Creative / Subject + Product Code */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="creative">แขก / Subject</Label>
                    <input
                      id="creative"
                      type="text"
                      className="ops-input"
                      placeholder="e.g. คุณ Ken, คุณแนน (คั่นด้วยจุลภาค)"
                      value={creative}
                      onChange={e => setCreative(e.target.value)}
                    />
                    <FieldHelp>คนหรือหัวข้อที่ถ่าย — แสดงในปฏิทินและอีเมล crew</FieldHelp>
                  </div>
                  <div>
                    <Label htmlFor="agencyRef">Product Code <span className="ml-1 text-[11px] font-normal text-gray-500">(optional)</span></Label>
                    <input
                      id="agencyRef"
                      type="text"
                      className="ops-input"
                      placeholder="e.g. QU-3108"
                      value={agencyRef}
                      onChange={e => setAgencyRef(e.target.value)}
                    />
                    <FieldHelp>เขียนลงคอลัมน์ &ldquo;Product Code&rdquo; (F) ของ PD tab</FieldHelp>
                  </div>
                </div>

                {/* Crew */}
                <div>
                  <Label>Crew Required</Label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {CREW_OPTIONS.map(c => {
                      const checked = crew.includes(c)
                      return (
                        <div key={c} className={`flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2 ${checked ? 'border-brand-primary bg-brand-primary/5' : ''}`}>
                          <label className="flex items-center gap-2 flex-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleCrew(c)}
                              className="accent-brand-primary"
                            />
                            <span className="text-sm text-gray-700">{c}</span>
                          </label>
                          {c === 'Videographer' && checked && (
                            <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 shrink-0">
                              <NumberStepper
                                value={videographerCount}
                                onChange={setVideographerCount}
                                min={1}
                                max={10}
                                allowEmpty={false}
                                ariaLabel="จำนวน Videographer"
                                className="w-36"
                              />
                              คน
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <FieldHelp>เลือก crew ทุกตำแหน่งที่ต้องใช้ · ระบุจำนวน Videographer ถ้าต้องมากกว่า 1</FieldHelp>
                </div>

                {/* v1.41.0 — equipment counts (🎥 / 🎙). Surfaced on the
                    calendar event title so crew see gear needs at a glance. */}
                <div>
                  <Label>อุปกรณ์ (Equipment)</Label>
                  <label className="flex items-center gap-2 mb-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="accent-[#673ab7]"
                      checked={isBlockShot}
                      onChange={e => {
                        setIsBlockShot(e.target.checked)
                        if (e.target.checked) setFieldErrors(p => { const n = { ...p }; delete n.cameraCount; delete n.micCount; return n })
                      }}
                    />
                    <span className="text-sm text-gray-700">📦 จองเป็นคิว Block Shot — ยังไม่ต้องระบุจำนวนกล้อง/ไมค์</span>
                  </label>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="cameraCount" required={!isBlockShot}>🎥 จำนวนกล้อง</Label>
                      <NumberStepper
                        id="cameraCount"
                        min={0}
                        max={50}
                        ariaLabel="จำนวนกล้อง"
                        invalid={!!fieldErrors.cameraCount}
                        placeholder="เช่น 2"
                        value={cameraCount}
                        onChange={v => { setCameraCount(v); if (fieldErrors.cameraCount) setFieldErrors(p => { const n = { ...p }; delete n.cameraCount; return n }) }}
                      />
                      <FieldError message={fieldErrors.cameraCount} />
                    </div>
                    <div>
                      <Label htmlFor="micCount" required={!isBlockShot}>🎙 จำนวนไมค์</Label>
                      <NumberStepper
                        id="micCount"
                        min={0}
                        max={50}
                        ariaLabel="จำนวนไมค์"
                        invalid={!!fieldErrors.micCount}
                        placeholder="เช่น 1"
                        value={micCount}
                        onChange={v => { setMicCount(v); if (fieldErrors.micCount) setFieldErrors(p => { const n = { ...p }; delete n.micCount; return n }) }}
                      />
                      <FieldError message={fieldErrors.micCount} />
                    </div>
                  </div>
                  <FieldHelp>{isBlockShot ? 'Block Shot — ระบุจำนวนกล้อง/ไมค์ภายหลังได้ (ไม่บังคับ)' : 'ระบุจำนวนกล้องและไมค์ที่ต้องใช้ (จำเป็น — ใส่ 0 ถ้าไม่ใช้) · จะแสดงบน Google Calendar'}</FieldHelp>
                  <div className="mt-3">
                    <Label>อุปกรณ์พิเศษ (Special Equipment)</Label>
                    <div className="grid grid-cols-2 gap-2">
                      {SPECIAL_EQUIPMENT_OPTIONS.map(item => {
                        const checked = specialEquipment.includes(item)
                        return (
                          <label key={item} className={`ops-choice ${checked ? 'ops-choice-selected' : ''} cursor-pointer`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleSpecialEquipment(item)}
                              className="accent-brand-primary mt-0.5"
                            />
                            <span className="text-sm text-gray-700">{item}</span>
                          </label>
                        )
                      })}
                    </div>
                    <FieldHelp>เลือกอุปกรณ์พิเศษที่ต้องใช้ (เลือกได้หลายอย่าง · เว้นว่างได้)</FieldHelp>
                  </div>
                </div>

                {/* Notes */}
                <div>
                  <Label htmlFor="notes">Notes for coordinator</Label>
                  <textarea
                    id="notes"
                    className="ops-input resize-none"
                    rows={3}
                    placeholder="Additional notes…"
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="ops-card ops-card-pad">
              <StepHeader step={5} title="Review" subtitle="ตรวจสอบรายละเอียดก่อน Submit — ยังไม่มีการบันทึกในระบบจนกว่าจะกด Confirm & Submit" />

              <div className="divide-y divide-gray-100">
                <ReviewBlock title="Project" onEdit={() => jumpTo(1)}>
                  <ReviewRow label="Outlet" value={summary.outlet} />
                  <ReviewRow label="Episode Type" value={summary.episodeType} />
                  {isContentAgency && <ReviewRow label="Category" value={summary.category} />}
                  <ReviewRow label="Video Type" value={summary.videoType} />
                </ReviewBlock>
                <ReviewBlock title="Schedule" onEdit={() => jumpTo(2)}>
                  <ReviewRow label="Shoot Date" value={summary.dateRange} />
                  <ReviewRow label="Time" value={summary.timeRange} />
                </ReviewBlock>
                <ReviewBlock title="Location" onEdit={() => jumpTo(3)}>
                  <ReviewRow label="Shoot Type" value={summary.shootType} />
                  <ReviewRow label="Location / Room" value={summary.location} />
                  <ReviewRow label="รถตู้" value={summary.van} />
                </ReviewBlock>
                <ReviewBlock title="People & Crew" onEdit={() => jumpTo(4)}>
                  <ReviewRow label="Producer" value={summary.producer} />
                  {!!summary.coProducer && <ReviewRow label="Co-Producer" value={summary.coProducer} />}
                  {isContentAgency && <ReviewRow label="Director" value={summary.director} />}
                  {isContentAgency && <ReviewRow label="Project" value={summary.project} />}
                  <ReviewRow label="Episodes" value={summary.episodes} />
                  <ReviewRow label="แขก / Subject" value={summary.subject} />
                  <ReviewRow label="Product Code" value={summary.productCode} />
                  <ReviewRow label="Crew" value={summary.crew} />
                  <ReviewRow label="Equipment" value={summary.equipment} />
                  {!!summary.specialEquipment && <ReviewRow label="Special Equipment" value={summary.specialEquipment} />}
                  <ReviewRow label="Notes" value={summary.notes} />
                </ReviewBlock>
              </div>
            </div>
          )}

          {/* Desktop action row — visible from md and up. */}
          <div className="hidden md:flex items-center justify-between mt-4">
            <button
              type="button"
              onClick={goBack}
              disabled={step === 1 || submitting}
              className="ops-btn-secondary"
            >
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Step {step} of 5</span>
              {step < 5 ? (
                <button type="button" onClick={goNext} className="ops-btn-primary">
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="ops-btn-primary"
                >
                  {submitting ? (<><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</>) : 'Confirm & Submit'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ============ RIGHT — Sticky live summary (desktop only) ============ */}
        <aside className="hidden lg:block">
          <div className="ops-card ops-card-pad sticky top-16 max-h-[calc(100vh-5rem)] overflow-y-auto">
            <div className="ops-section-title mb-3">Live Summary</div>
            <div className="space-y-3">
              <SummaryBlock title="Project" filled={!!selectedOutlet}>
                <KV k="Outlet" v={summary.outlet} />
                <KV k="Episode Type" v={summary.episodeType} />
                {isContentAgency && <KV k="Category" v={summary.category} />}
                <KV k="Video Type" v={summary.videoType} />
              </SummaryBlock>
              <SummaryBlock title="Schedule" filled={!!shootDate}>
                <KV k="Date" v={summary.dateRange} />
                <KV k="Time" v={summary.timeRange} />
              </SummaryBlock>
              <SummaryBlock title="Location" filled={offsite ? !!mapLocation.trim() : !!locationId}>
                <KV k="Shoot Type" v={summary.shootType} />
                <KV k={offsite ? 'Map location' : 'Room'} v={summary.location} />
                {offsite && needsVan && <KV k="Van" v="🚐 ต้องการรถตู้" />}
              </SummaryBlock>
              <SummaryBlock title="People" filled={!!(producerEmail || producerName || producerSel)}>
                <KV k="Producer" v={summary.producer} />
                {!!summary.coProducer && <KV k="Co-Producer" v={summary.coProducer} />}
                {isContentAgency && <KV k="Director" v={summary.director} />}
                <KV k="Crew" v={summary.crew} />
              </SummaryBlock>
              {isContentAgency && summary.project && (
                <SummaryBlock title="Project ID" filled>
                  <KV k="Project" v={summary.project} />
                  <KV k="Episodes" v={summary.episodes} />
                </SummaryBlock>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* Mobile collapsible summary — sits above the bottom action bar. */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-20 border-t border-gray-200 bg-white">
        {summaryOpen && (
          <div className="px-3 py-3 max-h-[50vh] overflow-y-auto border-b border-gray-100">
            <div className="ops-section-title mb-2">Live Summary</div>
            <div className="space-y-2 text-xs">
              <KV k="Outlet" v={summary.outlet} />
              <KV k="Episode Type" v={summary.episodeType} />
              <KV k="Schedule" v={[summary.dateRange, summary.timeRange].filter(Boolean).join(' · ')} />
              <KV k="Location" v={summary.location} />
              <KV k="Producer" v={summary.producer} />
              {isContentAgency && <KV k="Director" v={summary.director} />}
              {summary.crew && <KV k="Crew" v={summary.crew} />}
            </div>
          </div>
        )}
        <div className="px-3 py-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSummaryOpen(o => !o)}
            className="ops-btn-ghost ops-btn-sm"
            aria-expanded={summaryOpen}
          >
            {summaryOpen ? <><ChevronDown className="w-3.5 h-3.5" /> Hide</> : <><ChevronUp className="w-3.5 h-3.5" /> Summary</>}
          </button>
          <span className="text-xs text-gray-500 flex-1 truncate">Step {step}/5 · {STEPS[step - 1].label}</span>
          <button
            type="button"
            onClick={goBack}
            disabled={step === 1 || submitting}
            className="ops-btn-secondary ops-btn-sm"
            aria-label="Back"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          {step < 5 ? (
            <button type="button" onClick={goNext} className="ops-btn-primary ops-btn-sm">
              Next <ChevronRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button type="button" onClick={handleSubmit} disabled={submitting} className="ops-btn-primary ops-btn-sm">
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Submit'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---------- Review + Summary helpers ---------- */

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  const isEmpty = value === null || value === undefined || value === ''
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-2 text-sm">
      <div className="text-[11px] text-gray-500 uppercase tracking-wide pt-0.5">{label}</div>
      <div className="text-gray-800 break-words">{isEmpty ? <span className="text-gray-400">—</span> : value}</div>
    </div>
  )
}

function ReviewBlock({ title, children, onEdit }: { title: string; children: React.ReactNode; onEdit: () => void }) {
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between mb-1">
        <h3 className="ops-section-title">{title}</h3>
        <button type="button" onClick={onEdit} className="text-xs text-brand-primary hover:underline">Edit</button>
      </div>
      <div className="divide-y divide-gray-50">{children}</div>
    </div>
  )
}

function SummaryBlock({ title, filled, children }: { title: string; filled?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-1.5 h-1.5 rounded-full ${filled ? 'bg-emerald-500' : 'bg-gray-300'}`} aria-hidden />
        <span className="text-[11px] uppercase tracking-wider text-gray-500 font-medium">{title}</span>
      </div>
      <div className="space-y-1 pl-3">{children}</div>
    </div>
  )
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  const isEmpty = v === null || v === undefined || v === ''
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="text-gray-500 w-16 flex-shrink-0">{k}</span>
      <span className={`flex-1 break-words ${isEmpty ? 'text-gray-400' : 'text-gray-800'}`}>
        {isEmpty ? '—' : v}
      </span>
    </div>
  )
}
