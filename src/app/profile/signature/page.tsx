'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Trash2, Save, Upload, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'
import SignaturePad, { SignaturePadHandle } from '@/app/_components/SignaturePad'

const MAX_UPLOAD_BYTES = 200 * 1024

export default function SignaturePage() {
  const padRef = useRef<SignaturePadHandle>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [initialUrl, setInitialUrl] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [currentValue, setCurrentValue] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/me/signature')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      setInitialUrl(data.signaturePng)
      setCurrentValue(data.signaturePng)
      setUpdatedAt(data.signatureUpdatedAt)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    setError('')
    setSaving(true)
    try {
      // Prefer the canvas state if it's been drawn on since load; fall back
      // to whatever was uploaded into currentValue.
      const padUrl = padRef.current?.toDataUrl() ?? null
      const png = padRef.current?.isDirty() ? padUrl : currentValue
      if (!png) {
        throw new Error('ยังไม่มีลายเซ็น — กรุณาวาดหรืออัปโหลดก่อน')
      }
      const res = await fetch('/api/me/signature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ png }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save')
      setSavedAt(new Date())
      await load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const clearAll = async () => {
    if (!confirm('ลบลายเซ็นออกจากบัญชี? การ submit OT ครั้งต่อไปจะไม่มีลายเซ็นแนบ จนกว่าจะตั้งใหม่')) return
    setError('')
    setSaving(true)
    try {
      const res = await fetch('/api/me/signature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ png: null }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to clear')
      padRef.current?.clear()
      setInitialUrl(null)
      setCurrentValue(null)
      setUpdatedAt(null)
      setSavedAt(new Date())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleUpload = async (file: File) => {
    setError('')
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`ไฟล์ใหญ่เกิน ${Math.round(MAX_UPLOAD_BYTES / 1024)} KB`)
      return
    }
    if (file.type !== 'image/png') {
      setError('รองรับเฉพาะ PNG เท่านั้น')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result || '')
      if (!url.startsWith('data:image/png;base64,')) {
        setError('ไฟล์ไม่ใช่ PNG ที่ถูกต้อง')
        return
      }
      setInitialUrl(url)        // re-renders pad with the uploaded image
      setCurrentValue(url)
    }
    reader.onerror = () => setError('อ่านไฟล์ไม่สำเร็จ')
    reader.readAsDataURL(file)
  }

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3">
      <Link href="/ot" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="w-4 h-4" /> กลับหน้า OT
      </Link>

      <div className="gf-header p-4 sm:p-6">
        <h1 className="text-xl sm:text-2xl font-normal text-gray-800">ลายเซ็น</h1>
        <p className="text-xs sm:text-sm text-gray-500">
          ตั้งลายเซ็นที่ใช้เซ็นรับรองคำขอ OT ของตัวเอง (และเซ็นอนุมัติถ้าคุณเป็น manager) —
          เก็บไว้ครั้งเดียวแล้วระบบจะ snapshot ใส่ทุกครั้งที่ submit/approve
        </p>
      </div>

      {error && (
        <div className="gf-card p-3 text-sm text-red-600 border-l-4 border-red-400 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {savedAt && !error && (
        <div className="gf-card p-3 text-sm text-green-700 border-l-4 border-green-400 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          บันทึกแล้วเมื่อ {savedAt.toLocaleTimeString('th-TH')}
        </div>
      )}

      <div className="gf-card p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-sm font-medium text-gray-700">
            วาดลายเซ็น
            {updatedAt && (
              <span className="ml-2 text-[11px] text-gray-400">
                อัปเดตล่าสุด {new Date(updatedAt).toLocaleString('th-TH-u-ca-gregory')}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
              <Upload className="w-3 h-3" /> Upload PNG
            </button>
            <input
              ref={fileRef} type="file" accept="image/png" className="hidden"
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) handleUpload(f)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => {
                padRef.current?.clear()
                setCurrentValue(null)
                setInitialUrl(null)
              }}
              className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
              <Trash2 className="w-3 h-3" /> เคลียร์
            </button>
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center">
            <Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" />
          </div>
        ) : (
          <SignaturePad
            ref={padRef}
            initialDataUrl={initialUrl}
            onChange={(url) => setCurrentValue(url || null)}
          />
        )}

        <p className="text-[11px] text-gray-500">
          ใช้นิ้ว/เมาส์ลากบนกล่องด้านบนเพื่อวาดลายเซ็น — หรืออัปโหลด PNG (พื้นหลังโปร่งใส) ก็ได้
        </p>

        <div className="flex justify-end gap-2 pt-1 border-t border-gray-100">
          <button
            type="button"
            onClick={clearAll}
            disabled={saving || (!initialUrl && !currentValue)}
            className="text-xs px-3 py-1.5 border border-red-200 text-red-600 rounded hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1">
            <Trash2 className="w-3 h-3" /> ลบออกจากบัญชี
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="text-xs px-4 py-1.5 border border-[#673ab7] text-white bg-[#673ab7] rounded hover:bg-[#5e35b1] disabled:opacity-40 inline-flex items-center gap-1">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            บันทึกลายเซ็น
          </button>
        </div>
      </div>

      <div className="gf-card p-3 text-xs text-gray-500 border-l-4 border-blue-200">
        💡 ลายเซ็นนี้จะถูก snapshot ลงแต่ละแถวของ OT ทันทีตอน submit/approve —
        ถ้าเปลี่ยนภายหลังจะไม่กระทบรายการเก่าที่เซ็นไปแล้ว
      </div>
    </div>
  )
}
