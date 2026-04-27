'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Upload, CheckCircle2, Loader2, ArrowLeft, Film } from 'lucide-react'

interface Episode {
  id: string
  episodeId: string
  title: string
}

interface Booking {
  id: string
  shootDate: string
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
}

const CAMERAS = ['Cam1', 'Cam2', 'Cam3', 'Cam4', 'Sound', 'Drone', 'BTS']

function UploadContent() {
  const searchParams = useSearchParams()
  const preselectedBookingId = searchParams.get('bookingId')

  const [bookings, setBookings] = useState<Booking[]>([])
  const [selectedBookingId, setSelectedBookingId] = useState(preselectedBookingId || '')
  const [selectedEpisodeId, setSelectedEpisodeId] = useState('')
  const [camera, setCamera] = useState('Cam1')
  const [uploadedBy, setUploadedBy] = useState('')
  const [notes, setNotes] = useState('')
  const [files, setFiles] = useState<FileList | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadedCount, setUploadedCount] = useState(0)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    fetch('/api/bookings?limit=50&status=CONFIRMED')
      .then(r => r.json())
      .then(data => {
        const allBookings = data.bookings || []
        setBookings(allBookings)
        if (preselectedBookingId && allBookings.find((b: Booking) => b.id === preselectedBookingId)) {
          setSelectedBookingId(preselectedBookingId)
        } else if (!preselectedBookingId) {
          // Also fetch PENDING
          fetch('/api/bookings?limit=50&status=PENDING')
            .then(r => r.json())
            .then(d => setBookings(prev => [...prev, ...(d.bookings || [])]))
        }
      })
  }, [preselectedBookingId])

  const selectedBooking = bookings.find(b => b.id === selectedBookingId)

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!files || files.length === 0 || !selectedBookingId || !camera || !uploadedBy) {
      setError('Please fill all required fields and select files.')
      return
    }

    setUploading(true)
    setError('')
    setUploadedCount(0)

    let successCount = 0
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const formData = new FormData()
      formData.append('file', file)
      formData.append('bookingId', selectedBookingId)
      formData.append('camera', camera)
      formData.append('uploadedBy', uploadedBy)
      if (selectedEpisodeId) formData.append('episodeId', selectedEpisodeId)
      if (notes) formData.append('notes', notes)

      try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData })
        if (res.ok) successCount++
        setUploadedCount(successCount)
      } catch {
        // continue
      }
    }

    setUploading(false)
    if (successCount > 0) {
      setSuccess(true)
      setFiles(null)
      const input = document.getElementById('file-input') as HTMLInputElement
      if (input) input.value = ''
    } else {
      setError('All uploads failed. Check server logs.')
    }
  }

  if (success) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-brand-black mb-2">
          {uploadedCount} file{uploadedCount !== 1 ? 's' : ''} uploaded!
        </h2>
        <p className="text-brand-gray-500 text-sm mb-6">
          Footage logged to {selectedBooking?.outlet.code}-{selectedBooking?.program.code}
          {selectedEpisodeId ? ` → ${selectedEpisodeId}` : ''}
        </p>
        <div className="flex gap-3 justify-center">
          <button onClick={() => setSuccess(false)} className="btn-secondary">Upload More</button>
          {selectedBookingId && (
            <Link href={`/dashboard/${selectedBookingId}`} className="btn-primary">View Booking</Link>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto px-4 sm:px-6 py-8">
      <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-brand-gray-500 hover:text-brand-black mb-5">
        <ArrowLeft className="w-4 h-4" /> Dashboard
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-brand-black mb-1">Upload Footage</h1>
        <p className="text-sm text-brand-gray-500">
          ลง footage โดยผูกกับ Booking + Episode ID · เข้า Mimir/NAS อัตโนมัติ
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">{error}</div>
      )}

      <form onSubmit={handleUpload} className="space-y-5">
        {/* Select booking */}
        <div className="card p-5 space-y-4">
          <h2 className="font-semibold text-sm text-brand-gray-700 border-b border-brand-gray-100 pb-2">
            1 · Select Booking
          </h2>
          <div>
            <label className="label">Booking <span className="text-red-500">*</span></label>
            <select
              className="input"
              value={selectedBookingId}
              onChange={e => { setSelectedBookingId(e.target.value); setSelectedEpisodeId('') }}
              required
            >
              <option value="">— Select Booking —</option>
              {bookings.map(b => (
                <option key={b.id} value={b.id}>
                  {b.outlet.code}-{b.shootDate.slice(2, 4)}{b.shootDate.slice(5, 7)}{b.shootDate.slice(8, 10)}-{b.program.code} · {b.program.name} ({b.shootDate.slice(0, 10)})
                </option>
              ))}
            </select>
          </div>

          {selectedBooking && (
            <div>
              <label className="label">Episode (optional)</label>
              <select
                className="input"
                value={selectedEpisodeId}
                onChange={e => setSelectedEpisodeId(e.target.value)}
              >
                <option value="">— All episodes / Unassigned —</option>
                {selectedBooking.episodes.map(ep => (
                  <option key={ep.id} value={ep.episodeId}>
                    {ep.episodeId} — {ep.title}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Camera slot */}
        <div className="card p-5 space-y-4">
          <h2 className="font-semibold text-sm text-brand-gray-700 border-b border-brand-gray-100 pb-2">
            2 · Camera / Source
          </h2>
          <div>
            <label className="label">Camera Slot <span className="text-red-500">*</span></label>
            <div className="flex flex-wrap gap-2">
              {CAMERAS.map(cam => (
                <button
                  key={cam}
                  type="button"
                  onClick={() => setCamera(cam)}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                    camera === cam
                      ? 'bg-brand-black text-white border-brand-black'
                      : 'bg-white text-brand-gray-600 border-brand-gray-200 hover:border-brand-gray-300'
                  }`}
                >
                  {cam}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Uploaded By <span className="text-red-500">*</span></label>
            <input
              type="text"
              className="input"
              placeholder="Your name"
              value={uploadedBy}
              onChange={e => setUploadedBy(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">Notes</label>
            <input
              type="text"
              className="input"
              placeholder="e.g., Card 1 of 2, B-roll only..."
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>
        </div>

        {/* File select */}
        <div className="card p-5">
          <h2 className="font-semibold text-sm text-brand-gray-700 border-b border-brand-gray-100 pb-3 mb-4">
            3 · Select Files
          </h2>
          <label
            htmlFor="file-input"
            className={`flex flex-col items-center justify-center w-full h-36 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${
              files && files.length > 0
                ? 'border-brand-gold bg-brand-gold/5'
                : 'border-brand-gray-200 hover:border-brand-gray-300 bg-brand-gray-50'
            }`}
          >
            {files && files.length > 0 ? (
              <div className="text-center">
                <Film className="w-8 h-8 text-brand-gold mx-auto mb-2" />
                <p className="text-sm font-medium text-brand-black">{files.length} file{files.length !== 1 ? 's' : ''} selected</p>
                <p className="text-xs text-brand-gray-500">{Array.from(files).map(f => f.name).join(', ').slice(0, 60)}</p>
              </div>
            ) : (
              <div className="text-center">
                <Upload className="w-8 h-8 text-brand-gray-300 mx-auto mb-2" />
                <p className="text-sm text-brand-gray-500">Click to select footage files</p>
                <p className="text-xs text-brand-gray-400 mt-1">MP4, MOV, MXF, R3D, BRAW supported</p>
              </div>
            )}
            <input
              id="file-input"
              type="file"
              className="sr-only"
              multiple
              accept="video/*,.mxf,.r3d,.braw"
              onChange={e => setFiles(e.target.files)}
            />
          </label>
          <p className="text-xs text-brand-gray-400 mt-2">
            กฎ: ไฟล์ข้างในเก็บ <strong>ชื่อเดิมของกล้อง</strong> — ไม่ต้อง rename (Folder-only policy)
          </p>
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={uploading || !files || files.length === 0}
          className="btn-primary w-full justify-center py-3"
        >
          {uploading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Uploading {uploadedCount}/{files?.length ?? 0}...
            </>
          ) : (
            <>
              <Upload className="w-4 h-4" />
              Upload {files ? `${files.length} file${files.length !== 1 ? 's' : ''}` : 'Files'}
            </>
          )}
        </button>
      </form>
    </div>
  )
}

export default function UploadPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-96">
        <Loader2 className="w-8 h-8 animate-spin text-brand-gray-400" />
      </div>
    }>
      <UploadContent />
    </Suspense>
  )
}
