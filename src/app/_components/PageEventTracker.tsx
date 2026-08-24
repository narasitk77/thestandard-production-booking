'use client'

/**
 * v1.190 — ยิงบันทึกการเปิดหน้า (เฉพาะหน้าใน allowlist) เมื่อ route เปลี่ยน
 *
 * เงียบและไม่ขวางอะไรทั้งนั้น: ไม่ render อะไรเลย, ไม่ await, ล้มก็เงียบ
 * ตัวกรอง allowlist ทำสองชั้น (ที่นี่เพื่อไม่ให้ยิงเปล่า และที่ server เพื่อความถูกต้อง)
 *
 * ตั้งใจไม่เก็บ query string — normalizeTrackedPath ตัดให้อยู่แล้ว และ usePathname()
 * ก็ไม่รวม query อยู่แล้ว (กัน bookingId/token หลุดเข้าสถิติโดยไม่ตั้งใจ)
 */

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { normalizeTrackedPath } from '@/lib/page-events'

export default function PageEventTracker() {
  const pathname = usePathname()

  useEffect(() => {
    const path = normalizeTrackedPath(pathname)
    if (!path) return
    // keepalive: ให้ request รอดแม้ผู้ใช้กดออกจากหน้าทันที
    fetch('/api/page-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
      keepalive: true,
    }).catch(() => {})
  }, [pathname])

  return null
}
