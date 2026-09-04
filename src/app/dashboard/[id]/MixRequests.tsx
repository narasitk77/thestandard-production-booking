'use client'

/**
 * v1.219 — การ์ด "มิกซ์เสียง" บนหน้าใบจอง
 *
 * ปิดข้อสุดท้ายของ journey ที่ไล่ไว้กับ operator: ใบจองกับคิวมิกซ์ไม่เคยรู้จักกัน
 * คนที่กำลังเปิดงานอยู่ต้องจำว่ามี /mix แล้วไปพิมพ์รหัสใบจองเองอีกที
 *
 * การ์ดนี้ทำสองอย่างที่ต้องมาคู่กัน:
 *  1. **ปุ่มขอ** — พาไป /new?mode=mix&booking=<รหัส> ซึ่งเติมรหัสไว้ให้แล้ว
 *  2. **แสดงคำขอที่มีอยู่** — สำคัญกว่าปุ่มด้วยซ้ำ: ถ้าไม่โชว์ คนที่สองจะขอซ้ำ
 *     เพราะไม่มีทางรู้ว่าคนแรกขอไปแล้ว แล้วทีมเสียงจะได้งานซ้ำสองใบ
 *
 * โชว์ **ทุกสถานะรวมที่จบแล้ว** โดยตั้งใจ — งานที่ส่งไปแล้วคือคำตอบของคำถาม
 * "ไฟล์มิกซ์อยู่ไหน" ซึ่งเป็นสิ่งที่คนเปิดหน้านี้อยากรู้พอ ๆ กับการขอใหม่
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { SlidersHorizontal, Plus } from 'lucide-react'
import { MIX_STATUS_LABEL, type MixStatus } from '@/lib/mix-jobs'

type Job = {
  id: string
  code: string
  title: string
  status: string
  dueDate: string | null
  assigneeEmail: string | null
  deliveryLink: string | null
}

const STATUS_STYLE: Record<string, string> = {
  QUEUED: 'bg-slate-100 text-slate-700',
  IN_PROGRESS: 'bg-blue-50 text-blue-700',
  DONE: 'bg-green-50 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-400 line-through',
}

export default function MixRequests({ bookingId, bookingCode }: { bookingId: string; bookingCode: string | null }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')

  const load = useCallback(async () => {
    setState('loading')
    try {
      const res = await fetch(`/api/mix?bookingId=${encodeURIComponent(bookingId)}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const data = await res.json()
      setJobs(data.jobs || [])
      setState('ok')
    } catch {
      // v1.210 — "โหลดไม่ได้" ต้องไม่ถูกวาดให้เหมือน "ไม่มีคำขอ" ไม่งั้นคนจะขอซ้ำ
      // ทั้งที่มีอยู่แล้ว ซึ่งคือความเสียหายที่การ์ดนี้ตั้งใจจะกัน
      setState('error')
    }
  }, [bookingId])

  useEffect(() => { load() }, [load])

  const askHref = `/new?mode=mix${bookingCode ? `&booking=${encodeURIComponent(bookingCode)}` : ''}`

  return (
    <div className="gf-card p-5">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-gray-500" />
          <h2 className="text-sm font-medium text-gray-700">มิกซ์เสียง</h2>
        </div>
        <Link
          href={askHref}
          className="inline-flex items-center gap-1 px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
        >
          <Plus className="w-3.5 h-3.5" /> ขอมิกซ์งานนี้
        </Link>
      </div>

      {state === 'loading' ? (
        <p className="text-xs text-gray-400">กำลังดูว่ามีคำขออยู่แล้วไหม…</p>
      ) : state === 'error' ? (
        <p className="text-xs text-amber-700">
          ดูคำขอที่มีอยู่ไม่ได้ตอนนี้ — <b>เช็คที่คิวก่อนขอใหม่</b> จะได้ไม่ขอซ้ำ{' '}
          <Link href="/mix" className="gf-link">เปิดคิวมิกซ์ →</Link>
        </p>
      ) : jobs.length === 0 ? (
        <p className="text-xs text-gray-400">ยังไม่มีคำขอมิกซ์สำหรับงานนี้</p>
      ) : (
        <ul className="space-y-2">
          {jobs.map(j => (
            <li key={j.id} className="flex items-start justify-between gap-3 text-xs">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-gray-400">{j.code}</span>
                  <span className={`px-1.5 py-0.5 rounded ${STATUS_STYLE[j.status] || ''}`}>
                    {MIX_STATUS_LABEL[j.status as MixStatus] || j.status}
                  </span>
                </div>
                <div className="text-gray-700 mt-0.5 break-words">{j.title}</div>
                <div className="text-gray-400 mt-0.5">
                  {j.assigneeEmail ? `มิกซ์โดย ${j.assigneeEmail.split('@')[0]}` : 'รอ coordinator แจกงาน'}
                  {j.dueDate && ` · ส่ง ${j.dueDate.slice(0, 10)}`}
                </div>
              </div>
              {j.deliveryLink && (
                <a
                  href={j.deliveryLink}
                  target="_blank"
                  rel="noreferrer"
                  className="gf-link shrink-0 font-medium text-green-700"
                >
                  ไฟล์ที่มิกซ์แล้ว →
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
