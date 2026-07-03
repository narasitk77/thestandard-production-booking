'use client'

import { useEffect, useState, useRef } from 'react'
import { X, CheckCircle2, AlertCircle, Loader2, Trash2, ExternalLink, RefreshCw, RotateCw } from 'lucide-react'
import { uploadToDrive as driveUpload, uploadToWasabi as wasabiUpload, completeWithRetry, type RetryStatus } from '@/lib/upload-client'
import { cameraUploadOptions } from '@/lib/outlet-folders'

interface BookingContext {
  id: string
  bookingCode: string | null
  status: string
  // v1.70 — drive the camera dropdown: CAM-A..CAM-{cameraCount} + AUDIO (if mics) + specials.
  cameraCount?: number | null
  micCount?: number | null
  outlet: { code: string; name: string; storagePolicy?: 'DRIVE_ONLY' | 'DUAL_WRITE' }
  // v1.93 — episodes drive the EP picker; footage lands in <booking>/<EP>/<camera>/.
  episodes?: Array<{ id: string; episodeId: string; title: string; sequence: number }>
}

interface UploadItem {
  id: string
  fileName: string
  fileSize: number | null
  camera: string
  status: string
  driveFileId: string | null
  driveUrl: string | null
  wasabiBucket: string | null
  wasabiKey: string | null
  wasabiEtag: string | null
  uploadedBy: string
  initiatedAt: string
  completedAt: string | null
  failureReason: string | null
}

interface InFlight {
  localId: string         // browser-side temporary id (for queue rendering)
  uploadId?: string       // server-side Upload.id, set after /init
  file: File
  camera: string
  episodeRowId: string    // v1.93 — Episode.id this file is filed under ('' = none)
  driveProgress: number   // 0..1
  wasabiProgress: number  // 0..1
  driveActive: boolean
  wasabiActive: boolean
  state: 'pending' | 'initiating' | 'uploading' | 'completing' | 'done' | 'failed' | 'cancelled'
  error: string | null
  // v1.35.6 — surface auto-retry attempts so user sees recovery is happening
  driveRetry: RetryStatus | null
  wasabiRetry: RetryStatus | null
}

interface Props {
  booking: BookingContext
  /** Default camera selection — passed in when crew member's role hints at it */
  defaultCamera?: string
}

// v1.81 — folder drag-drop. dataTransfer.files does NOT recurse into a dropped
// folder; webkitGetAsEntry does. Walk every entry, collect Files, flatten into
// the existing per-file queue (Drive path stays <camera>/<filename>). Falls back
// to dt.files when the entries API is unavailable.
async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items)
    .map(it => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean) as any[]
  if (entries.length === 0) return Array.from(dt.files)
  const out: File[] = []
  const walk = (entry: any): Promise<void> => new Promise(resolve => {
    if (entry.isFile) {
      entry.file((f: File) => { out.push(f); resolve() }, () => resolve())
    } else if (entry.isDirectory) {
      const reader = entry.createReader()
      // readEntries returns in batches; call until it yields an empty batch.
      const readBatch = () => reader.readEntries(async (batch: any[]) => {
        if (!batch.length) return resolve()
        await Promise.all(batch.map(walk))
        readBatch()
      }, () => resolve())
      readBatch()
    } else resolve()
  })
  await Promise.all(entries.map(walk))
  return out
}

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes; let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

// v1.89 — footage report shape (client view) + duration formatter.
interface FootageReportView {
  cameras: Array<{
    camera: string; folderUrl: string | null
    files: Array<{ name: string; sizeBytes: number | null; durationMillis: number | null; width: number | null; height: number | null }>
  }>
  totalFiles: number
  totalBytes: number
  deliveredAt: string | null
  deliveredBy: string | null
}
function formatDur(ms: number | null): string {
  if (ms == null) return '—'
  const t = Math.round(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}

function statusChip(status: string) {
  const base = 'text-[10px] px-1.5 py-0.5 rounded-full border'
  switch (status) {
    case 'COMPLETE':  return <span className={`${base} bg-green-50 text-green-700 border-green-200`}>Complete</span>
    case 'UPLOADING': return <span className={`${base} bg-amber-50 text-amber-700 border-amber-200`}>Uploading</span>
    case 'DRIVE_OK':  return <span className={`${base} bg-blue-50 text-blue-700 border-blue-200`}>Drive OK · Wasabi pending</span>
    case 'WASABI_OK': return <span className={`${base} bg-blue-50 text-blue-700 border-blue-200`}>Wasabi OK · Drive pending</span>
    case 'FAILED':    return <span className={`${base} bg-red-50 text-red-700 border-red-200`}>Failed</span>
    case 'ORPHANED':  return <span className={`${base} bg-red-50 text-red-700 border-red-200`}>Orphaned</span>
    case 'PENDING':   return <span className={`${base} bg-gray-100 text-gray-600 border-gray-200`}>Pending</span>
    default:          return <span className={`${base} bg-gray-100 text-gray-600 border-gray-200`}>{status}</span>
  }
}

export default function UploadSection({ booking, defaultCamera }: Props) {
  // v1.70 — camera options derived from the booking: CAM-A..CAM-{cameraCount}
  // (min CAM-A) + AUDIO (if mics) + specials (DRONE/SWITCHER/PHOTO/SCREEN).
  const CAMERAS = cameraUploadOptions(booking.cameraCount, booking.micCount)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // v1.81 — folder upload. webkitdirectory isn't a typed React prop, so set it
  // on the DOM node directly; this input's `files` is every file in the picked
  // folder (recursive).
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  // v1.111 — monotonic id so out-of-order detect-footage responses are ignored.
  const detectSeqRef = useRef(0)
  useEffect(() => {
    const el = folderInputRef.current
    if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', '') }
  }, [])
  const [camera, setCamera] = useState(defaultCamera && CAMERAS.includes(defaultCamera) ? defaultCamera : CAMERAS[0])
  // v1.93 — which episode footage is filed under. Default to the first; only
  // shown as a picker when the shoot records more than one EP.
  const episodes = booking.episodes ?? []
  const [episodeRowId, setEpisodeRowId] = useState(episodes[0]?.id ?? '')
  // v1.94 — Content Agency labels EPs by their project EP ID (matches the Drive
  // folder, e.g. "PP-26-008-L04"); every other outlet uses the running EP01.
  const isAgency = booking.outlet.code === 'AGN'
  const epLabel = (ep: { episodeId: string; title: string; sequence: number }) => {
    const lead = isAgency && ep.episodeId ? ep.episodeId : `EP${String(ep.sequence).padStart(2, '0')}`
    return ep.title ? `${lead} · ${ep.title}` : lead
  }
  // (no top-level error banner — per-queue-item errors render inline below)
  const [includeWasabi, setIncludeWasabi] = useState(booking.outlet.storagePolicy === 'DUAL_WRITE')
  const [history, setHistory] = useState<UploadItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  // v1.82 — per-camera Drive folder links for cameras with completed uploads.
  const [folders, setFolders] = useState<Array<{ camera: string; count: number; folderUrl: string | null }>>([])
  // v1.89 — footage report (files + size + duration) + "ส่งงาน" delivery state.
  const [report, setReport] = useState<FootageReportView | null>(null)
  const [delivering, setDelivering] = useState(false)
  const [deliverMsg, setDeliverMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // v1.111 — per-booking "รวมไฟล์เข้ากล่องนี้": MOVE this job's NAS footage into
  // the box, then fold its staged sound into AUDIO. Scoped to one booking so it's
  // fast (the old system-wide sweeps timed out at the 60s proxy). The system-wide
  // sweeps moved to /admin/footage-tools.
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)
  // v1.101 — "Detect": scan THIS booking's Drive folders for footage (incl. files
  // moved from NAS into the boxes, which have no Upload row).
  const [detecting, setDetecting] = useState(false)
  const [detected, setDetected] = useState<{ found: number; fileCount?: number; folders: Array<{ label: string; url: string; fileCount: number; totalBytes: number }>; bookingFolderUrl: string | null; soundStagingUrl?: string | null; cached?: boolean; cachedAt?: string | null; error?: string } | null>(null)
  // v1.102.4 — "แจ้งทุกคนว่าไฟล์พร้อม"
  const [notifying, setNotifying] = useState(false)
  const [notifyMsg, setNotifyMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [queue, setQueue] = useState<InFlight[]>([])
  // v1.35.6 — drag/drop visual feedback
  const [dragOver, setDragOver] = useState(false)

  const policy = booking.outlet.storagePolicy ?? 'DRIVE_ONLY'
  const wasabiLocked = policy === 'DUAL_WRITE'

  const fetchHistory = async () => {
    setHistoryLoading(true)
    try {
      const res = await fetch(`/api/upload/list?bookingId=${booking.id}`)
      const data = await res.json()
      if (res.ok) setHistory(data.uploads || [])
      // v1.82 — refresh per-camera Drive folder links (best-effort)
      fetch(`/api/upload/folders?bookingId=${booking.id}`)
        .then(r => (r.ok ? r.json() : { folders: [] }))
        .then(d => setFolders(d.folders || []))
        .catch(() => {})
      // v1.89 — footage report (files + size + duration) + delivery state
      fetch(`/api/upload/report?bookingId=${booking.id}`)
        .then(r => (r.ok ? r.json() : { report: null }))
        .then(d => setReport(d.report || null))
        .catch(() => {})
    } finally {
      setHistoryLoading(false)
    }
  }

  // v1.89 — "ส่งงาน": email the Producer (+ CC self) the file report, record delivery.
  const deliver = async () => {
    setDelivering(true)
    setDeliverMsg(null)
    try {
      const res = await fetch(`/api/bookings/${booking.id}/deliver`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setDeliverMsg({ ok: false, text: data.error || 'ส่งงานไม่สำเร็จ' })
      } else {
        const who = (data.recipients || []).join(', ')
        const warn = data.producerMissing ? ' ⚠️ งานนี้ไม่มีอีเมล Producer — ส่งถึงตัวเองอย่างเดียว' : ''
        const noMail = !data.emailConfigured ? ' (ระบบอีเมลยังไม่ตั้งค่า — บันทึกการส่งงานแล้วแต่ยังไม่ได้ส่งเมล)' : ''
        setDeliverMsg({ ok: true, text: `ส่งงานแล้ว — เมลถึง ${data.emailed} คน${who ? ` (${who})` : ''}${warn}${noMail}` })
        fetchHistory() // refresh deliveredAt
      }
    } catch (e: any) {
      setDeliverMsg({ ok: false, text: e?.message || 'ส่งงานไม่สำเร็จ' })
    } finally {
      setDelivering(false)
    }
  }
  useEffect(() => { fetchHistory() }, [booking.id])

  // v1.111 — per-booking consolidate: MOVE this job's NAS footage into the box,
  // then fold its staged sound into AUDIO.
  // v1.113.4 — the server runs it as a BACKGROUND job (a big landing takes
  // minutes; the reverse proxy cut the old synchronous call at 60s so the UI
  // said 504 while the move kept going). POST starts/joins the job; poll GET
  // every 5s until it lands, then render the same summary as before.
  const renderMergeResult = (res: any) => {
    const v = res?.video || {}, s = res?.sound || {}
    const vTxt = v.skipped ? `ข้าม (${v.reason || ''})` : `ย้าย ${v.moved ?? 0}/${v.seen ?? 0}${v.err ? ` · error ${v.err}` : ''}`
    const sTxt = s.skipped ? `ข้าม (${s.reason || ''})` : `รวม ${s.copied ?? 0}/${s.staged ?? 0}${s.err ? ` · error ${s.err}` : ''}`
    setScanMsg(`วิดีโอ: ${vTxt} · เสียง: ${sTxt}`)
  }
  const triggerMerge = async () => {
    if (!confirm('รวมไฟล์เข้ากล่องของงานนี้?\n\n• ย้ายวิดีโอจาก Production Team (NAS) เข้ากล่อง — เป็นการ MOVE (ไฟล์จะหายจาก Production Team)\n• รวมไฟล์เสียงจาก Staging เข้าโฟลเดอร์ AUDIO\n\nทำเมื่อ NAS sync เสร็จแล้ว')) return
    setMerging(true)
    setScanMsg(null)
    try {
      const r = await fetch(`/api/bookings/${booking.id}/merge`, { method: 'POST', credentials: 'include' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok && r.status !== 202) { setScanMsg(d.error || `รวมไฟล์ไม่สำเร็จ (HTTP ${r.status})`); return }
      // Poll the background job (up to ~15 min for a huge landing).
      for (let i = 1; i <= 180; i++) {
        setScanMsg(`⏳ กำลังย้ายไฟล์อยู่เบื้องหลัง… ${i > 12 ? `(~${Math.round((i * 5) / 60)} นาที) ` : ''}— ปิดหน้านี้ได้ งานไม่หยุด`)
        await new Promise(res => setTimeout(res, 5000))
        const sr = await fetch(`/api/bookings/${booking.id}/merge`, { credentials: 'include' })
        const sd = await sr.json().catch(() => ({}))
        const job = sd.job || {}
        if (job.done) {
          if (job.error) setScanMsg(`รวมไฟล์ไม่สำเร็จ: ${job.error}`)
          else renderMergeResult(job.result)
          return
        }
        if (!job.running) { setScanMsg('งานย้ายถูกรีเซ็ต (ระบบรีสตาร์ทระหว่างทาง) — กดปุ่มอีกครั้งเพื่อย้ายส่วนที่เหลือ'); return }
      }
      setScanMsg('งานใหญ่มาก ยังย้ายอยู่เบื้องหลัง — กด Refresh ภายหลังเพื่อดูไฟล์ที่เข้าแล้ว')
    } catch (e: any) {
      setScanMsg(e?.message || 'รวมไฟล์ไม่สำเร็จ')
    } finally {
      setMerging(false)
      detectFootage()
      fetchHistory()
    }
  }

  // v1.101 — Detect footage in THIS booking's Drive folders (path-resolved, so it
  // sees NAS-moved files too — not just app uploads). v1.111 — the result is cached
  // server-side; on open we read the cache (instant) and only re-walk Drive when the
  // user presses "ตรวจใหม่" (refresh=true). Keep the old list visible while refreshing.
  const detectFootage = async (refresh = false) => {
    // Guard against out-of-order responses: if a newer detect (e.g. a manual
    // "ตรวจใหม่") starts before this one resolves, ignore this stale result so a
    // slow cached mount-fetch can't overwrite a fresh refresh.
    const seq = ++detectSeqRef.current
    setDetecting(true)
    try {
      const r = await fetch(`/api/bookings/${booking.id}/detect-footage${refresh ? '?refresh=1' : ''}`)
      const d = await r.json().catch(() => ({}))
      if (seq !== detectSeqRef.current) return
      if (!r.ok) setDetected({ found: 0, folders: [], bookingFolderUrl: null, error: d.error || `HTTP ${r.status}` })
      else setDetected(d)
    } catch (e: any) {
      if (seq === detectSeqRef.current) setDetected({ found: 0, folders: [], bookingFolderUrl: null, error: e?.message || 'ตรวจหาไม่สำเร็จ' })
    } finally {
      if (seq === detectSeqRef.current) setDetecting(false)
    }
  }

  // v1.102.3 — auto-detect on open so the footage folder list + links are ALWAYS
  // there; ops shouldn't have to press Detect every visit. v1.111 — this hits the
  // cache (fast); the "ตรวจใหม่" button forces a fresh Drive walk.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { detectFootage(false) }, [booking.id])

  // v1.102.4 — email EVERYONE on the booking the footage links ("ไฟล์พร้อมแล้ว").
  // Preview first (who gets it) → confirm → send. Server resolves the links + list.
  const notifyReady = async () => {
    setNotifyMsg(null)
    let preview: any
    try {
      const pr = await fetch(`/api/bookings/${booking.id}/notify-ready?preview=1`, { method: 'POST' })
      preview = await pr.json().catch(() => ({}))
      if (!pr.ok) { setNotifyMsg({ ok: false, text: preview.error || `ไม่สำเร็จ (HTTP ${pr.status})` }); return }
    } catch (e: any) { setNotifyMsg({ ok: false, text: e?.message || 'ไม่สำเร็จ' }); return }
    const who = (preview.recipients || [])
    if (!confirm(`ส่งลิงก์แจ้ง "footage พร้อมแล้ว" ถึง ${who.length} คน?\n\n${who.join('\n')}`)) return
    setNotifying(true)
    try {
      const r = await fetch(`/api/bookings/${booking.id}/notify-ready`, { method: 'POST' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) setNotifyMsg({ ok: false, text: d.error || `ส่งไม่สำเร็จ (HTTP ${r.status})` })
      else setNotifyMsg({ ok: true, text: `แจ้งแล้ว — เมลถึง ${d.emailed} คน${(d.recipients || []).length ? ` (${d.recipients.join(', ')})` : ''}${d.emailConfigured ? '' : ' · ⚠️ ระบบอีเมลยังไม่ตั้งค่า (บันทึกแล้วแต่ยังไม่ส่ง)'}` })
    } catch (e: any) { setNotifyMsg({ ok: false, text: e?.message || 'ส่งไม่สำเร็จ' }) }
    finally { setNotifying(false) }
  }

  const startQueue = (fileList: FileList | File[] | null) => {
    if (!fileList || fileList.length === 0) return
    // v1.81 — folder picks/drops include OS cruft (.DS_Store, ._*, Thumbs.db).
    // The server's filename validator rejects leading-dot names anyway, so drop
    // them here instead of surfacing a failed queue row per junk file.
    const files = Array.from(fileList).filter(f => f.name && !f.name.startsWith('.') && f.name !== 'Thumbs.db')
    if (files.length === 0) return
    const items: InFlight[] = files.map(file => ({
      localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      camera,
      episodeRowId,
      driveProgress: 0,
      wasabiProgress: 0,
      driveActive: false,
      wasabiActive: false,
      state: 'pending',
      error: null,
      driveRetry: null,
      wasabiRetry: null,
    }))
    setQueue(prev => [...prev, ...items])
    // fire-and-forget — process each item sequentially (browser parallel
    // PUTs the chunks WITHIN a file, but files run one-at-a-time so a
    // big batch doesn't saturate the uplink).
    items.forEach(item => runOne(item).catch(e => updateQueue(item.localId, q => ({ ...q, state: 'failed', error: e?.message || String(e) }))))
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (folderInputRef.current) folderInputRef.current.value = ''
  }

  const updateQueue = (localId: string, fn: (q: InFlight) => InFlight) => {
    setQueue(prev => prev.map(q => q.localId === localId ? fn(q) : q))
  }

  const runOne = async (item: InFlight) => {
    // 1. INIT — server creates Upload row + returns presigned URLs
    updateQueue(item.localId, q => ({ ...q, state: 'initiating' }))
    const initRes = await fetch('/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookingId: booking.id,
        camera: item.camera,
        episodeRowId: item.episodeRowId || undefined, // v1.93 — per-EP folder
        filename: item.file.name,
        size: item.file.size,
        mimeType: item.file.type || 'application/octet-stream',
        includeWasabi: wasabiLocked || includeWasabi,
      }),
    })
    const initData = await initRes.json()
    if (!initRes.ok) throw new Error(initData.error || `init failed: ${initRes.status}`)
    const uploadId: string = initData.uploadId
    updateQueue(item.localId, q => ({ ...q, uploadId, state: 'uploading',
      driveActive: !!initData.targets?.drive,
      wasabiActive: !!initData.targets?.wasabi }))

    // 2. UPLOAD — parallel Drive resumable + Wasabi multipart, both with
    //    chunked + retried PUTs (see src/lib/upload-client.ts).
    const tasks: Array<Promise<any>> = []

    if (initData.targets?.drive?.sessionUrl) {
      tasks.push(driveUpload(
        initData.targets.drive.sessionUrl,
        item.file,
        {
          onProgress: (frac) => updateQueue(item.localId, q => ({ ...q, driveProgress: frac })),
          onRetry: (status) => updateQueue(item.localId, q => ({ ...q, driveRetry: status.active ? status : null })),
        },
      ))
    }

    let wasabiParts: Array<{ n: number; etag: string }> = []
    if (initData.targets?.wasabi) {
      const w = initData.targets.wasabi
      tasks.push(wasabiUpload(
        item.file,
        w.parts,
        w.chunkSize,
        {
          onProgress: (frac) => updateQueue(item.localId, q => ({ ...q, wasabiProgress: frac })),
          onRetry: (status) => updateQueue(item.localId, q => ({ ...q, wasabiRetry: status.active ? status : null })),
        },
      ).then(parts => { wasabiParts = parts }))
    }

    await Promise.all(tasks)

    // 3. COMPLETE — server finalizes both clouds + writes sheet row.
    //    v1.83 — retried: the bytes are already in the cloud, so a transient
    //    blip here (server restart/deploy → 502, momentary network drop) must
    //    NOT mark a finished upload as failed. /complete is idempotent so
    //    re-calling is safe.
    updateQueue(item.localId, q => ({ ...q, state: 'completing' }))
    await completeWithRetry({
      uploadId,
      drive: initData.targets?.drive ? { fileId: initData.targets.drive.fileId } : undefined,
      wasabi: initData.targets?.wasabi ? { parts: wasabiParts } : undefined,
    })
    updateQueue(item.localId, q => ({ ...q, state: 'done' }))
    fetchHistory()  // refresh the bottom list
  }

  const cancelOne = async (item: InFlight) => {
    if (!item.uploadId) {
      updateQueue(item.localId, q => ({ ...q, state: 'cancelled' }))
      return
    }
    try {
      await fetch(`/api/upload/${item.uploadId}/cancel`, { method: 'POST' })
    } catch {}
    updateQueue(item.localId, q => ({ ...q, state: 'cancelled' }))
    fetchHistory()
  }

  const removeFromQueue = (localId: string) => setQueue(prev => prev.filter(q => q.localId !== localId))

  // v1.35.10 — defensive guard against a malformed booking prop. If the
  // parent passed { booking: {...} } (mistake observed in /admin/[id]'s
  // onResynced + Mark-as-Done callbacks pre-v1.35.10) or outlet field is
  // missing, render a clear error instead of crashing on `.outlet.name`.
  if (!booking || !booking.outlet || typeof booking.outlet.name !== 'string') {
    return (
      <div className="gf-card p-3 text-sm text-red-600 border-l-4 border-red-400 flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          Upload section can&apos;t render — booking is missing outlet data.
          Refresh the page; if it persists, the API response is malformed.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">

      <div className="gf-card p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-gray-700">Upload footage</span>
          <span className="text-[11px] text-gray-500">
            → {booking.bookingCode || booking.id} · {booking.outlet.name}
          </span>
        </div>

        {/* v1.93 — pick which EP the footage belongs to (multi-EP shoots only).
            Single-EP / no-EP bookings file everything automatically. */}
        {episodes.length > 1 && (
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">ตอน / Episode</label>
            <select className="gf-input" value={episodeRowId} onChange={e => setEpisodeRowId(e.target.value)}>
              {episodes.map(ep => (
                <option key={ep.id} value={ep.id}>{epLabel(ep)}</option>
              ))}
            </select>
            <p className="text-[10px] text-gray-400 mt-0.5">ไฟล์จะเข้าโฟลเดอร์แยกตามตอนที่เลือก</p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Camera / Source</label>
            <select className="gf-input" value={camera} onChange={e => setCamera(e.target.value)}>
              {CAMERAS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="sm:col-span-2 flex items-end">
            <label className="text-xs text-gray-600 flex items-center gap-1 mt-1">
              <input
                type="checkbox"
                checked={wasabiLocked || includeWasabi}
                disabled={wasabiLocked}
                onChange={e => setIncludeWasabi(e.target.checked)}
                className="accent-[#673ab7]" />
              ส่ง Wasabi ด้วย {wasabiLocked && <span className="text-[10px] text-amber-700">(บังคับ — outlet นี้เป็น DUAL_WRITE)</span>}
            </label>
          </div>
        </div>

        <div>
          {/* v1.35.6 — drag/drop zone wrapping the file picker. Native
              <input type="file"> handles the click; the surrounding div
              handles drop. */}
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDragEnd={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault()
              setDragOver(false)
              // v1.81 — recurse dropped folders (camera card = nested dirs)
              filesFromDataTransfer(e.dataTransfer).then(startQueue)
            }}
            className={`rounded border-2 border-dashed p-3 transition-colors ${
              dragOver ? 'border-[#673ab7] bg-purple-100/60' : 'border-gray-300 bg-gray-50/30'
            }`}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <input ref={fileInputRef} type="file" multiple
                onChange={e => startQueue(e.target.files)}
                className="block flex-1 min-w-[200px] text-sm text-gray-600
                  file:mr-3 file:py-2 file:px-4 file:rounded file:border-0
                  file:text-sm file:font-medium
                  file:bg-[#673ab7] file:text-white
                  hover:file:bg-[#5e35b1]
                  file:cursor-pointer cursor-pointer" />
              {/* v1.81 — folder picker (webkitdirectory attr set via ref) */}
              <input ref={folderInputRef} type="file" multiple className="hidden"
                onChange={e => startQueue(e.target.files)} />
              <button type="button" onClick={() => folderInputRef.current?.click()}
                className="py-2 px-4 rounded text-sm font-medium border border-[#673ab7] text-[#673ab7] hover:bg-purple-50 whitespace-nowrap">
                📁 เลือกทั้งโฟลเดอร์
              </button>
            </div>
            <p className="text-[11px] text-gray-500 mt-2 text-center">
              {dragOver ? '⬇ ปล่อยไฟล์/โฟลเดอร์ที่นี่' : 'หรือ drag ไฟล์ — หรือทั้งโฟลเดอร์ — มาวางที่นี่'}
            </p>
          </div>
          <p className="text-[10px] text-gray-500 mt-1">
            จะ upload ตรงเข้า Drive {wasabiLocked || includeWasabi ? '+ Wasabi' : ''} ที่
            {/* v1.70 — hint reflects the new "VIDEO 2026 [JUL–DEC]" layout:
                <NN · Outlet>/<program|category>/<Production ID · ชื่องาน>/<camera>/.
                Exact outlet/program/job are resolved server-side (placeholders). */}
            {' '}<code className="text-gray-700">{(() => {
              const ep = episodes.find(e => e.id === episodeRowId)
              const epSeg = ep ? `/${epLabel(ep)}` : ''
              // v1.112 — AGN: category box → Project box → per-booking layer
              // "<ชื่องาน> (AGN-…)"; other outlets keep show + Production ID.
              return isAgency
                ? `[outlet]/[Advertorial·Event]/[Project ID · โปรเจค]/[ชื่องาน (${booking.bookingCode})]${epSeg}/${camera}/`
                : `[outlet]/[program]/${booking.bookingCode} · [ชื่องาน]${epSeg}/${camera}/`
            })()}</code>
            {' · '}
            <span className="text-gray-400">chunked + auto-retry (network drop ปลอดภัย)</span>
          </p>
        </div>
      </div>

      {/* v1.101 — Detect footage already in this booking's Drive folders (incl. NAS-moved) */}
      <div className="gf-card p-4 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-medium text-gray-700">
            🔍 ตรวจหา footage บน Drive <span className="text-[11px] text-gray-400 font-normal">(รวมไฟล์ที่ย้ายมาจาก NAS — ไม่ต้องอัปผ่านระบบ)</span>
          </div>
          <div className="flex items-center gap-2">
            {detected?.cachedAt && !detected.error && (
              <span className="text-[10px] text-gray-400" title={new Date(detected.cachedAt).toLocaleString('th-TH')}>
                อัปเดต {new Date(detected.cachedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <button onClick={() => detectFootage(true)} disabled={detecting}
              title="สแกน Drive ใหม่ (ปกติใช้ลิงก์ที่บันทึกไว้ ไม่ต้องสแกนทุกครั้ง)"
              className="text-xs px-3 py-1.5 rounded font-medium bg-[#673ab7] text-white hover:bg-[#5e35b1] disabled:opacity-50 inline-flex items-center gap-1">
              {detecting && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {detecting ? 'กำลังตรวจ…' : '🔄 ตรวจใหม่'}
            </button>
          </div>
        </div>
        {detecting && !detected && (
          <div className="text-[11px] text-gray-400 inline-flex items-center gap-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> กำลังตรวจหาโฟลเดอร์ footage บน Drive…
          </div>
        )}
        {detected?.soundStagingUrl && (
          <div className="text-[11px] bg-green-50 border border-green-200 rounded p-2 text-green-900 flex items-center gap-2 flex-wrap">
            🎙️ <span className="flex-1">ทีมเสียง: ลงไฟล์เสียงที่โฟลเดอร์นี้ (ลากไฟล์ใส่ได้เลย) — ระบบจะรวมเข้ากล่องงานให้อัตโนมัติทุกชั่วโมง</span>
            <a href={detected.soundStagingUrl} target="_blank" rel="noreferrer" className="underline font-medium whitespace-nowrap">เปิดโฟลเดอร์เสียง ↗</a>
          </div>
        )}
        {detected && (
          detected.error ? (
            <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded p-2">{detected.error}</div>
          ) : detected.found === 0 ? (
            <div className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded p-2">
              ยังไม่เจอไฟล์ในโฟลเดอร์ Drive ของงานนี้
              {detected.bookingFolderUrl && (
                <> · <a href={detected.bookingFolderUrl} target="_blank" rel="noreferrer" className="text-[#673ab7] hover:underline">เปิดโฟลเดอร์</a></>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-[11px] text-green-700">
                🟢 เจอ {detected.found} โฟลเดอร์{detected.fileCount ? ` · ${detected.fileCount} ไฟล์` : ''}
              </div>
              <div className="border border-gray-200 rounded divide-y divide-gray-100">
                {detected.folders.map(fo => (
                  <div key={fo.url} className="flex items-center justify-between gap-2 px-2 py-1.5">
                    <a href={fo.url} target="_blank" rel="noreferrer"
                      className="text-[11px] text-[#673ab7] hover:underline truncate flex-1 min-w-0">
                      📁 {fo.label}
                    </a>
                    <span className="text-[10px] text-gray-500 whitespace-nowrap">{fo.fileCount} ไฟล์ · {formatSize(fo.totalBytes)}</span>
                  </div>
                ))}
              </div>
              {detected.bookingFolderUrl && (
                <a href={detected.bookingFolderUrl} target="_blank" rel="noreferrer" className="text-[11px] text-gray-500 hover:underline">เปิดกล่องงานทั้งหมด ↗</a>
              )}
              {/* v1.102.4 — notify everyone on the booking that footage is ready */}
              <div className="pt-1 border-t border-gray-100 space-y-1">
                <button onClick={notifyReady} disabled={notifying}
                  className="text-xs px-3 py-1.5 rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 inline-flex items-center gap-1">
                  {notifying && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 📣 แจ้งทุกคนว่าไฟล์พร้อม
                </button>
                {notifyMsg && (
                  <div className={`text-[11px] ${notifyMsg.ok ? 'text-green-700' : 'text-red-700'}`}>{notifyMsg.text}</div>
                )}
              </div>
            </div>
          )
        )}
      </div>

      {/* In-flight queue */}
      {queue.length > 0 && (
        <div className="gf-card p-4 space-y-2">
          <div className="text-sm font-medium text-gray-700">กำลัง upload ({queue.length})</div>
          {queue.map(q => (
            <div key={q.localId} className="border border-gray-200 rounded p-2 text-xs">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-gray-800 truncate flex-1 min-w-[150px]">{q.file.name}</span>
                <span className="text-gray-500">{formatSize(q.file.size)}</span>
                <span className="text-gray-500">· {q.camera}</span>
                {q.state === 'done' && <CheckCircle2 className="w-4 h-4 text-green-600" />}
                {q.state === 'failed' && <AlertCircle className="w-4 h-4 text-red-600" />}
                {(q.state === 'initiating' || q.state === 'uploading' || q.state === 'completing') && (
                  <Loader2 className="w-4 h-4 animate-spin text-amber-600" />
                )}
                {(q.state === 'initiating' || q.state === 'uploading') && (
                  <button onClick={() => cancelOne(q)} className="text-red-500 hover:text-red-700 p-1">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
                {(q.state === 'done' || q.state === 'failed' || q.state === 'cancelled') && (
                  <button onClick={() => removeFromQueue(q.localId)} className="text-gray-400 hover:text-gray-700 p-1">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {q.error && <div className="text-red-700 text-[11px] mt-1">{q.error}</div>}
              {(q.state === 'uploading' || q.state === 'completing' || q.state === 'done') && (
                <div className="space-y-1 mt-1.5">
                  {q.driveActive && <ProgressBar label="Drive" frac={q.driveProgress} retry={q.driveRetry} />}
                  {q.wasabiActive && <ProgressBar label="Wasabi" frac={q.wasabiProgress} retry={q.wasabiRetry} />}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* v1.82 — per-camera Drive folder links (cameras with completed uploads) */}
      {folders.length > 0 && (
        <div className="gf-card p-4">
          <div className="text-sm font-medium text-gray-700 mb-2">📁 โฟลเดอร์ footage บน Drive</div>
          <div className="flex flex-wrap gap-2">
            {folders.map(f => f.folderUrl ? (
              <a key={f.camera} href={f.folderUrl} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-[#673ab7] text-[#673ab7] hover:bg-purple-50">
                📁 {f.camera} <span className="text-gray-400">({f.count})</span> <ExternalLink className="w-3 h-3" />
              </a>
            ) : (
              <span key={f.camera} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-400">
                {f.camera} ({f.count})
              </span>
            ))}
          </div>
          <p className="text-[10px] text-gray-400 mt-1.5">เปิดโฟลเดอร์กล้องบน Google Drive ของงานนี้</p>
        </div>
      )}

      {/* v1.89 — footage report + ส่งงาน (email Producer + CC self) */}
      {report && report.totalFiles > 0 && (
        <div className="gf-card p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm font-medium text-gray-700">
              📋 รายงานไฟล์ footage
              <span className="text-gray-400 font-normal"> ({report.totalFiles} ไฟล์ · {formatSize(report.totalBytes)})</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {report.deliveredAt && (
                <span className="text-[11px] text-green-700">
                  ✅ ส่งงานแล้ว {new Date(report.deliveredAt).toLocaleString('th-TH-u-ca-gregory', { dateStyle: 'short', timeStyle: 'short' })}
                </span>
              )}
              <button onClick={deliver} disabled={delivering}
                className="text-xs px-3 py-1.5 rounded font-medium bg-[#673ab7] text-white hover:bg-[#5e35b1] disabled:opacity-50 inline-flex items-center gap-1">
                {delivering && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {report.deliveredAt ? 'ส่งงานอีกครั้ง' : 'ส่งงาน'}
              </button>
            </div>
          </div>
          {deliverMsg && (
            <div className={`text-[11px] rounded p-2 ${deliverMsg.ok ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
              {deliverMsg.text}
            </div>
          )}
          <div className="space-y-2">
            {report.cameras.map(cam => (
              <div key={cam.camera} className="border border-gray-200 rounded p-2">
                <div className="text-xs font-medium text-gray-700 mb-1 flex items-center gap-1">
                  {cam.camera} <span className="text-gray-400">({cam.files.length})</span>
                  {cam.folderUrl && (
                    <a href={cam.folderUrl} target="_blank" rel="noreferrer"
                      className="text-[#673ab7] hover:underline inline-flex items-center gap-0.5 ml-1">📁<ExternalLink className="w-3 h-3" /></a>
                  )}
                </div>
                {cam.files.length === 0 ? (
                  <div className="text-[11px] text-gray-400">ยังไม่มีไฟล์</div>
                ) : (
                  <table className="w-full text-[11px]">
                    <tbody>
                      {cam.files.map((f, i) => (
                        <tr key={i} className="border-t border-gray-100">
                          <td className="py-1 pr-2 font-mono text-gray-800 truncate max-w-[220px]">{f.name}</td>
                          <td className="py-1 pr-2 text-right text-gray-600 whitespace-nowrap">{formatSize(f.sizeBytes)}</td>
                          <td className="py-1 pr-2 text-right text-gray-600 whitespace-nowrap tabular-nums">{formatDur(f.durationMillis)}</td>
                          <td className="py-1 text-right text-gray-400 whitespace-nowrap">{f.width ? `${f.width}×${f.height}` : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* History */}
      <div className="gf-card p-4">
        <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
          <div className="text-sm font-medium text-gray-700">
            ไฟล์ที่ upload แล้ว ({history.length})
          </div>
          <div className="flex items-center gap-2">
            {/* v1.111 — per-booking consolidate: MOVE this job's NAS footage into
                the box, then fold its staged sound into AUDIO. Scoped to one job →
                fast (the old system-wide sweeps timed out; they moved to
                /admin/footage-tools). */}
            <button onClick={triggerMerge} disabled={merging} title="ย้ายวิดีโอจาก Production Team (NAS) เข้ากล่อง แล้วรวมไฟล์เสียงจาก Staging เข้า AUDIO — เฉพาะงานนี้"
              className="text-xs px-2 py-1 border border-[#673ab7] text-[#673ab7] rounded hover:bg-purple-50 inline-flex items-center gap-1 disabled:opacity-50">
              {merging ? <Loader2 className="w-3 h-3 animate-spin" /> : <span>🎬🎙️</span>} รวมไฟล์เข้ากล่องนี้
            </button>
            <button onClick={fetchHistory} disabled={historyLoading}
              className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
              <RefreshCw className={`w-3 h-3 ${historyLoading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
        </div>
        {scanMsg && <div className="text-[11px] text-gray-600 bg-gray-50 border border-gray-200 rounded p-2 mb-2">{scanMsg}</div>}
        {historyLoading ? (
          <div className="py-6 text-center"><Loader2 className="w-4 h-4 animate-spin text-gray-400 mx-auto" /></div>
        ) : history.length === 0 ? (
          <div className="py-4 text-center text-xs text-gray-400">ยังไม่มีไฟล์</div>
        ) : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-xs min-w-[700px]">
              <thead className="border-b border-gray-200">
                <tr className="text-[10px] text-gray-500 uppercase">
                  <th className="text-left py-1.5 pr-2">ชื่อไฟล์</th>
                  <th className="text-left py-1.5 pr-2">Camera</th>
                  <th className="text-right py-1.5 pr-2">ขนาด</th>
                  <th className="text-left py-1.5 pr-2">โดย</th>
                  <th className="text-left py-1.5 pr-2">สถานะ</th>
                  <th className="text-right py-1.5 pr-2">ลิงก์</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {history.map(u => (
                  <tr key={u.id}>
                    <td className="py-1.5 pr-2 font-mono text-gray-800 truncate max-w-[280px]">{u.fileName}</td>
                    <td className="py-1.5 pr-2 text-gray-600">{u.camera}</td>
                    <td className="py-1.5 pr-2 text-right text-gray-600">{formatSize(u.fileSize)}</td>
                    <td className="py-1.5 pr-2 text-gray-500 truncate max-w-[160px]">{u.uploadedBy}</td>
                    <td className="py-1.5 pr-2">{statusChip(u.status)}</td>
                    <td className="py-1.5 pr-2 text-right whitespace-nowrap">
                      {u.driveUrl && (
                        <a href={u.driveUrl} target="_blank" rel="noreferrer"
                          className="text-[#673ab7] hover:underline inline-flex items-center gap-0.5">
                          Drive <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
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

function ProgressBar({ label, frac, retry }: { label: string; frac: number; retry?: RetryStatus | null }) {
  const pct = Math.min(100, Math.max(0, Math.round(frac * 100)))
  // v1.35.6 — retry hint colors the bar amber so the user notices a
  // recovering chunk without thinking "stalled".
  const isRetrying = !!retry?.active
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-500 w-12">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-200 rounded overflow-hidden">
        <div className={`h-full transition-all ${isRetrying ? 'bg-amber-500' : 'bg-[#673ab7]'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-gray-500 tabular-nums w-10 text-right">{pct}%</span>
      {isRetrying && (
        <span className="text-[9px] text-amber-700 inline-flex items-center gap-0.5 whitespace-nowrap"
              title={retry?.lastError || ''}>
          <RotateCw className="w-2.5 h-2.5 animate-spin" />
          retry {retry?.attempt}/{retry?.maxAttempts}
        </span>
      )}
    </div>
  )
}

// v1.35.6 — uploadToDrive + uploadToWasabi moved to src/lib/upload-client.ts.
// That file holds the chunked + retry logic so the component focuses on
// queue UI / rendering. See `driveUpload` / `wasabiUpload` imports at top.
