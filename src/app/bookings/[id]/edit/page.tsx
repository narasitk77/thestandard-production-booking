'use client'

// Producer self-edit of THEIR OWN booking while it is in REQUESTED status.
// Edits the same detail fields the admin edit UI exposes EXCEPT the immutable
// Episode-ID determinants (outlet/program/shoot date/episode identity) and
// admin-only fields (status/assign/admin notes). Server route
// /api/bookings/[id]/producer-edit is the authority; this page gates the UI
// and emails the queue team on save.
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2, ArrowLeft, Save } from 'lucide-react'
import { bookingShowName } from '@/lib/display'
import { shootTypeLabel } from '@/lib/utils'
import NumberStepper from '@/app/_components/NumberStepper'

const SHOOT_TYPES = ['STUDIO', 'ON_LOCATION', 'REMOTE_ONLINE', 'EVENT']
const SPECIAL_EQUIPMENT_OPTIONS = ['Gimbal/Ronin', 'Prompter', 'Clip-on Mic (DJI Mic)', 'ไฟดวงเล็ก']

interface Episode { id: string; episodeId: string; title: string; program?: { code?: string; name: string } | null }
interface Booking {
  id: string; bookingCode?: string | null; shootDate: string; shootEndDate?: string | null
  status: string; createdByEmail?: string | null; producerEmail?: string | null
  callTime: string; estimatedWrap?: string; shootType: string; locationName?: string
  producer: string; creative: string[]; crewRequired: string[]
  cameraCount?: number | null; micCount?: number | null; needsVan?: boolean; specialEquipment?: string[]
  agencyRef?: string; notes?: string; projectName?: string | null
  outlet: { code: string; name: string }; program: { code: string; name: string }
  episodes: Episode[]
}

export default function ProducerEditPage({ params }: { params: { id: string } }) {
  const { id } = params
  const router = useRouter()
  const [booking, setBooking] = useState<Booking | null>(null)
  const [meEmail, setMeEmail] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const [form, setForm] = useState({
    callTime: '', estimatedWrap: '', shootType: '', locationName: '', producer: '',
    creative: '', crewRequired: '', cameraCount: '', micCount: '', needsVan: false,
    specialEquipment: [] as string[], agencyRef: '', notes: '',
    episodeTitles: [] as { id: string; episodeId: string; title: string }[],
  })

  useEffect(() => {
    fetch('/api/me').then(r => r.ok ? r.json() : null).then(d => setMeEmail((d?.user?.email || '').toLowerCase())).catch(() => {})
  }, [])

  useEffect(() => {
    fetch(`/api/bookings/${id}`)
      .then(r => r.json())
      .then(d => {
        if (!d?.booking) { setLoadError(d?.error || 'ไม่พบงานนี้'); return }
        const b: Booking = d.booking
        setBooking(b)
        setForm({
          callTime: b.callTime || '',
          estimatedWrap: b.estimatedWrap || '',
          shootType: b.shootType,
          locationName: b.locationName || '',
          producer: b.producer || '',
          creative: (b.creative || []).join(', '),
          crewRequired: (b.crewRequired || []).join(', '),
          cameraCount: b.cameraCount === null || b.cameraCount === undefined ? '' : String(b.cameraCount),
          micCount: b.micCount === null || b.micCount === undefined ? '' : String(b.micCount),
          needsVan: !!b.needsVan,
          specialEquipment: b.specialEquipment || [],
          agencyRef: b.agencyRef || '',
          notes: b.notes || '',
          episodeTitles: (b.episodes || []).map(e => ({ id: e.id, episodeId: e.episodeId, title: e.title })),
        })
      })
      .catch(() => setLoadError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false))
  }, [id])

  const isOwner = useMemo(() => {
    if (!booking || !meEmail) return false
    return (booking.createdByEmail || '').toLowerCase() === meEmail || (booking.producerEmail || '').toLowerCase() === meEmail
  }, [booking, meEmail])
  const editable = !!booking && booking.status === 'REQUESTED' && isOwner

  const toggleSpecial = (item: string) =>
    setForm(f => ({ ...f, specialEquipment: f.specialEquipment.includes(item) ? f.specialEquipment.filter(x => x !== item) : [...f.specialEquipment, item] }))

  async function handleSave() {
    setSaving(true)
    setSaveError('')
    try {
      const body = {
        callTime: form.callTime,
        estimatedWrap: form.estimatedWrap || null,
        shootType: form.shootType,
        locationName: form.locationName || null,
        producer: form.producer,
        creative: form.creative ? form.creative.split(',').map(s => s.trim()).filter(Boolean) : [],
        crewRequired: form.crewRequired ? form.crewRequired.split(',').map(s => s.trim()).filter(Boolean) : [],
        cameraCount: form.cameraCount.trim() === '' ? null : Math.max(0, parseInt(form.cameraCount, 10) || 0),
        micCount: form.micCount.trim() === '' ? null : Math.max(0, parseInt(form.micCount, 10) || 0),
        needsVan: form.needsVan,
        specialEquipment: form.specialEquipment,
        agencyRef: form.agencyRef || null,
        notes: form.notes || null,
        episodeTitles: form.episodeTitles.map(e => ({ id: e.id, title: e.title })),
      }
      const res = await fetch(`/api/bookings/${id}/producer-edit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setSaveError(data?.error || 'บันทึกไม่สำเร็จ'); return }
      router.push(`/dashboard/${id}`)
    } catch {
      setSaveError('บันทึกไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="max-w-3xl mx-auto px-4 py-10 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
  }
  if (loadError || !booking) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="ops-card ops-card-pad text-sm text-gray-600">{loadError || 'ไม่พบงานนี้'} <Link href="/my-bookings" className="text-brand-primary hover:underline ml-1">กลับ My Bookings</Link></div>
      </div>
    )
  }
  if (!editable) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="ops-card ops-card-pad">
          <h1 className="text-lg font-medium text-gray-800 mb-1">แก้ไขไม่ได้</h1>
          <p className="text-sm text-gray-600">
            {booking.status !== 'REQUESTED'
              ? `งานนี้อยู่ในสถานะ ${booking.status} แล้ว — แก้ไขได้เฉพาะงานที่ยังเป็น Requested หากต้องการเปลี่ยน กรุณาแจ้งทีมงาน`
              : 'คุณไม่ใช่เจ้าของงานนี้ จึงแก้ไขไม่ได้'}
          </p>
          <Link href={`/dashboard/${id}`} className="ops-btn-secondary mt-3 inline-flex"><ArrowLeft className="w-4 h-4" /> กลับไปดูรายละเอียด</Link>
        </div>
      </div>
    )
  }

  const shootDate = new Date(booking.shootDate).toISOString().slice(0, 10)
  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <Link href="/my-bookings" className="text-xs text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 mb-3"><ArrowLeft className="w-3.5 h-3.5" /> My Bookings</Link>

      {/* Locked identity — read-only */}
      <div className="ops-card ops-card-pad mb-3">
        <div className="text-sm font-medium text-gray-900">
          <span className="text-gray-500 font-normal mr-1">[{booking.outlet.code}]</span>{bookingShowName(booking)}
        </div>
        <div className="text-xs text-gray-500 mt-1">
          {shootDate} · {booking.episodes.map(e => e.episodeId).join(' · ')}
          {booking.bookingCode && <> · {booking.bookingCode}</>}
        </div>
        <p className="text-[11px] text-gray-400 mt-1">วันถ่าย / Outlet / Program / Episode ID แก้ไม่ได้ (กำหนดตายตัว) — ถ้าต้องเปลี่ยน กรุณาแจ้งทีมงาน · การบันทึกจะส่งอีเมลแจ้งทีมงานอัตโนมัติ</p>
      </div>

      <div className="ops-card ops-card-pad space-y-4">
        {saveError && <div className="ops-card px-3 py-2 text-sm text-red-700 bg-red-50 border-red-200 border-l-4 border-l-red-500">{saveError}</div>}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">เวลาเรียก (Call)</label>
            <input type="time" className="ops-input tabular-nums" value={form.callTime} onChange={e => setForm({ ...form, callTime: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">เวลาเลิก (Wrap)</label>
            <input type="time" className="ops-input tabular-nums" value={form.estimatedWrap} onChange={e => setForm({ ...form, estimatedWrap: e.target.value })} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">ประเภทงานถ่าย</label>
            <select className="ops-input" value={form.shootType} onChange={e => setForm({ ...form, shootType: e.target.value })}>
              {SHOOT_TYPES.map(t => <option key={t} value={t}>{shootTypeLabel(t)}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">สถานที่</label>
            <input className="ops-input" value={form.locationName} onChange={e => setForm({ ...form, locationName: e.target.value })} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Producer</label>
            <input className="ops-input" value={form.producer} onChange={e => setForm({ ...form, producer: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Agency Ref</label>
            <input className="ops-input" value={form.agencyRef} onChange={e => setForm({ ...form, agencyRef: e.target.value })} />
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-500 mb-1 block">Creative (คั่นด้วย ,)</label>
          <input className="ops-input" value={form.creative} onChange={e => setForm({ ...form, creative: e.target.value })} />
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">ทีมงาน / Crew (คั่นด้วย ,)</label>
          <input className="ops-input" value={form.crewRequired} onChange={e => setForm({ ...form, crewRequired: e.target.value })} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">🎥 จำนวนกล้อง</label>
            <NumberStepper min={0} max={50} ariaLabel="จำนวนกล้อง" value={form.cameraCount} onChange={v => setForm({ ...form, cameraCount: v })} />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">🎙 จำนวนไมค์</label>
            <NumberStepper min={0} max={50} ariaLabel="จำนวนไมค์" value={form.micCount} onChange={v => setForm({ ...form, micCount: v })} />
          </div>
        </div>

        <div>
          <label className="flex items-center gap-2 cursor-pointer w-fit">
            <input type="checkbox" className="accent-brand-primary" checked={form.needsVan} onChange={e => setForm({ ...form, needsVan: e.target.checked })} />
            <span className="text-sm text-gray-700">🚐 ต้องการรถตู้</span>
          </label>
        </div>

        <div>
          <label className="text-xs text-gray-500 mb-1 block">อุปกรณ์พิเศษ</label>
          <div className="grid grid-cols-2 gap-2">
            {SPECIAL_EQUIPMENT_OPTIONS.map(item => (
              <label key={item} className="flex items-center gap-2 px-2 py-1 cursor-pointer">
                <input type="checkbox" className="accent-brand-primary" checked={form.specialEquipment.includes(item)} onChange={() => toggleSpecial(item)} />
                <span className="text-sm text-gray-700">{item}</span>
              </label>
            ))}
          </div>
        </div>

        {form.episodeTitles.length > 0 && (
          <div>
            <label className="text-xs text-gray-500 mb-1 block">ชื่อตอน (Episode titles)</label>
            <div className="space-y-2">
              {form.episodeTitles.map((ep, i) => (
                <div key={ep.id} className="flex items-center gap-2">
                  <span className="text-[11px] font-mono text-gray-400 shrink-0 w-40 truncate" title={ep.episodeId}>{ep.episodeId}</span>
                  <input className="ops-input" value={ep.title} onChange={e => {
                    const next = [...form.episodeTitles]; next[i] = { ...next[i], title: e.target.value }; setForm({ ...form, episodeTitles: next })
                  }} />
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="text-xs text-gray-500 mb-1 block">Notes</label>
          <textarea className="ops-input resize-none" rows={3} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Link href={`/dashboard/${id}`} className="ops-btn-secondary">ยกเลิก</Link>
          <button type="button" onClick={handleSave} disabled={saving} className="ops-btn-primary">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} บันทึก
          </button>
        </div>
      </div>
    </div>
  )
}
