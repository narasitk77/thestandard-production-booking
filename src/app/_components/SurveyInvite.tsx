'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'

/**
 * v1.278 — การ์ดชวนตอบแบบสำรวจบนหน้าแรก โผล่เฉพาะตอนเปิดรับ + ยังไม่ตอบ (ทุกคนที่ล็อกอิน — v1.285.1)
 * "ไว้ทีหลัง" = หลบไป 3 วันในเครื่องนี้ (localStorage — ถ้าใช้ไม่ได้ก็แค่โผล่ใหม่ครั้งหน้า)
 */
const SNOOZE_MS = 3 * 24 * 3_600_000

export default function SurveyInvite() {
  const [key, setKey] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/survey')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => {
        if (!d?.open || d.answered) return
        let until = 0
        try { until = Number(localStorage.getItem(`survey-snooze:${d.key}`)) || 0 } catch {}
        if (until < Date.now()) setKey(d.key)
      })
      // การ์ดเป็นแค่ตัวชวน — โหลดไม่ได้ก็ไม่โชว์ แต่บอกใน console ว่าทำไมไม่มี
      .catch(e => console.warn('[survey] invite status unavailable:', e?.message || e))
  }, [])

  if (!key) return null
  const snooze = () => {
    try { localStorage.setItem(`survey-snooze:${key}`, String(Date.now() + SNOOZE_MS)) } catch {}
    setKey(null)
  }

  return (
    <div className="mb-4 rounded-xl border border-[#0b8043]/30 bg-[#0b8043]/[0.04] p-4 flex items-start gap-3">
      <div className="text-2xl leading-none">📝</div>
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-medium text-gray-900">ขอความเห็นเรื่องการใช้งาน Production Booking</div>
        <div className="text-xs text-gray-600 mt-0.5">ประมาณ 1–2 นาที · ไม่ผูกชื่อกับคำตอบ</div>
        <div className="mt-3 flex items-center gap-4">
          <Link href="/survey" className="px-4 py-2 rounded-lg bg-[#0b8043] text-white text-sm font-medium">ตอบเลย →</Link>
          <button onClick={snooze} className="text-sm text-gray-500 hover:text-gray-800">ไว้ทีหลัง</button>
        </div>
      </div>
      <button onClick={snooze} aria-label="ปิด" className="p-1 text-gray-400 hover:text-gray-700"><X className="w-4 h-4" /></button>
    </div>
  )
}
