'use client'

import { useEffect, useState, useRef } from 'react'
import { Upload, X, CheckCircle2, AlertCircle, Loader2, Trash2, ExternalLink, RefreshCw, RotateCw } from 'lucide-react'
import { uploadToDrive as driveUpload, uploadToWasabi as wasabiUpload, type RetryStatus } from '@/lib/upload-client'

const CAMERAS = ['Cam1', 'Cam2', 'Cam3', 'Cam4', 'Sound', 'Drone', 'BTS', 'Switcher', 'Atem']

interface BookingContext {
  id: string
  bookingCode: string | null
  status: string
  outlet: { code: string; name: string; storagePolicy?: 'DRIVE_ONLY' | 'DUAL_WRITE' }
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

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes; let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
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

export default function UploadSection({ booking, defaultCamera = 'Cam1' }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [camera, setCamera] = useState(defaultCamera)
  const [includeWasabi, setIncludeWasabi] = useState(booking.outlet.storagePolicy === 'DUAL_WRITE')
  const [history, setHistory] = useState<UploadItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [queue, setQueue] = useState<InFlight[]>([])
  const [error, setError] = useState('')
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
    } finally {
      setHistoryLoading(false)
    }
  }
  useEffect(() => { fetchHistory() }, [booking.id])

  const startQueue = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    const items: InFlight[] = Array.from(fileList).map(file => ({
      localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      camera,
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

    // 3. COMPLETE — server finalizes both clouds + writes sheet row
    updateQueue(item.localId, q => ({ ...q, state: 'completing' }))
    const completeRes = await fetch('/api/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        drive: initData.targets?.drive ? { fileId: initData.targets.drive.fileId } : undefined,
        wasabi: initData.targets?.wasabi ? { parts: wasabiParts } : undefined,
      }),
    })
    const completeData = await completeRes.json()
    if (!completeRes.ok || !completeData.ok) {
      throw new Error(completeData.error || completeData.errors?.join(' · ') || 'complete failed')
    }
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
      {error && (
        <div className="gf-card p-3 text-sm text-red-600 border-l-4 border-red-400 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="gf-card p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-gray-700">Upload footage</span>
          <span className="text-[11px] text-gray-500">
            → {booking.bookingCode || booking.id} · {booking.outlet.name}
          </span>
        </div>

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
              startQueue(e.dataTransfer.files)
            }}
            className={`rounded border-2 border-dashed p-3 transition-colors ${
              dragOver ? 'border-[#673ab7] bg-purple-100/60' : 'border-gray-300 bg-gray-50/30'
            }`}
          >
            <input ref={fileInputRef} type="file" multiple
              onChange={e => startQueue(e.target.files)}
              className="block w-full text-sm text-gray-600
                file:mr-3 file:py-2 file:px-4 file:rounded file:border-0
                file:text-sm file:font-medium
                file:bg-[#673ab7] file:text-white
                hover:file:bg-[#5e35b1]
                file:cursor-pointer cursor-pointer" />
            <p className="text-[11px] text-gray-500 mt-2 text-center">
              {dragOver ? '⬇ ปล่อยไฟล์ที่นี่' : 'หรือ drag ไฟล์มาวางที่นี่'}
            </p>
          </div>
          <p className="text-[10px] text-gray-500 mt-1">
            จะ upload ตรงเข้า Drive {wasabiLocked || includeWasabi ? '+ Wasabi' : ''} ที่
            {' '}<code className="text-gray-700">{`<outlet>/${booking.bookingCode}/${camera}/`}</code>
            {' · '}
            <span className="text-gray-400">chunked + auto-retry (network drop ปลอดภัย)</span>
          </p>
        </div>
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

      {/* History */}
      <div className="gf-card p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium text-gray-700">
            ไฟล์ที่ upload แล้ว ({history.length})
          </div>
          <button onClick={fetchHistory} disabled={historyLoading}
            className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
            <RefreshCw className={`w-3 h-3 ${historyLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
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
