'use client'

import { useEffect, useState, useRef } from 'react'
import { Upload, X, CheckCircle2, AlertCircle, Loader2, Trash2, ExternalLink, RefreshCw } from 'lucide-react'

const CAMERAS = ['Cam1', 'Cam2', 'Cam3', 'Cam4', 'Sound', 'Drone', 'BTS']

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

    // 2. UPLOAD — parallel Drive resumable + Wasabi multipart
    const tasks: Array<Promise<any>> = []

    if (initData.targets?.drive?.sessionUrl) {
      tasks.push(uploadToDrive(
        initData.targets.drive.sessionUrl,
        item.file,
        (frac) => updateQueue(item.localId, q => ({ ...q, driveProgress: frac })),
      ))
    }

    let wasabiParts: Array<{ n: number; etag: string }> = []
    if (initData.targets?.wasabi) {
      const w = initData.targets.wasabi
      tasks.push(uploadToWasabi(
        item.file,
        w.parts,
        w.chunkSize,
        (frac) => updateQueue(item.localId, q => ({ ...q, wasabiProgress: frac })),
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
          <input ref={fileInputRef} type="file" multiple
            onChange={e => startQueue(e.target.files)}
            className="block w-full text-sm text-gray-600
              file:mr-3 file:py-2 file:px-4 file:rounded file:border-0
              file:text-sm file:font-medium
              file:bg-[#673ab7] file:text-white
              hover:file:bg-[#5e35b1]
              file:cursor-pointer cursor-pointer" />
          <p className="text-[10px] text-gray-500 mt-1">
            จะ upload ตรงเข้า Drive {wasabiLocked || includeWasabi ? '+ Wasabi' : ''} ที่
            {' '}<code className="text-gray-700">{`<outlet>/${booking.bookingCode}/${camera}/`}</code>
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
                  {q.driveActive && <ProgressBar label="Drive" frac={q.driveProgress} />}
                  {q.wasabiActive && <ProgressBar label="Wasabi" frac={q.wasabiProgress} />}
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

function ProgressBar({ label, frac }: { label: string; frac: number }) {
  const pct = Math.min(100, Math.max(0, Math.round(frac * 100)))
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-500 w-12">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-200 rounded overflow-hidden">
        <div className="h-full bg-[#673ab7] transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-gray-500 tabular-nums w-10 text-right">{pct}%</span>
    </div>
  )
}

/**
 * Drive resumable upload — single PUT with the whole file. For very
 * large files we'd want chunked PUTs with Content-Range, but the
 * single-PUT path is simpler and works for the common case of files
 * the browser can fit in memory.
 */
async function uploadToDrive(sessionUrl: string, file: File, onProgress: (frac: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', sessionUrl, true)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1)
        resolve()
      } else {
        reject(new Error(`Drive upload ${xhr.status}: ${xhr.responseText?.slice(0, 200)}`))
      }
    }
    xhr.onerror = () => reject(new Error('Drive upload network error'))
    xhr.onabort = () => reject(new Error('Drive upload aborted'))
    xhr.send(file)
  })
}

/**
 * Wasabi multipart upload — PUT each chunk to its presigned URL in parallel
 * (capped at 4 concurrent). Returns the parts list with ETags to feed back
 * into /api/upload/complete.
 */
async function uploadToWasabi(
  file: File,
  parts: Array<{ partNumber: number; url: string }>,
  chunkSize: number,
  onProgress: (frac: number) => void,
): Promise<Array<{ n: number; etag: string }>> {
  const PARALLEL = 4
  const total = file.size
  const loaded = new Array<number>(parts.length).fill(0)
  const out = new Array<{ n: number; etag: string }>(parts.length)

  let cursor = 0
  let active = 0
  return new Promise((resolve, reject) => {
    let failed = false
    const startNext = () => {
      if (failed) return
      if (cursor >= parts.length && active === 0) {
        onProgress(1)
        resolve(out.filter(Boolean))
        return
      }
      while (active < PARALLEL && cursor < parts.length) {
        const idx = cursor++
        const part = parts[idx]
        const start = idx * chunkSize
        const end = Math.min(start + chunkSize, file.size)
        const chunk = file.slice(start, end)
        active++
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', part.url, true)
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            loaded[idx] = e.loaded
            const sum = loaded.reduce((a, b) => a + b, 0)
            onProgress(Math.min(1, sum / total))
          }
        }
        xhr.onload = () => {
          active--
          if (xhr.status >= 200 && xhr.status < 300) {
            const etag = (xhr.getResponseHeader('ETag') || '').replace(/"/g, '')
            out[idx] = { n: part.partNumber, etag }
            loaded[idx] = end - start
            const sum = loaded.reduce((a, b) => a + b, 0)
            onProgress(Math.min(1, sum / total))
            startNext()
          } else {
            failed = true
            reject(new Error(`Wasabi part ${part.partNumber} upload ${xhr.status}`))
          }
        }
        xhr.onerror = () => {
          active--
          failed = true
          reject(new Error(`Wasabi part ${part.partNumber} network error`))
        }
        xhr.send(chunk)
      }
    }
    startNext()
  })
}
