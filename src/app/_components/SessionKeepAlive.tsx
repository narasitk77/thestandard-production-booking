'use client'

/**
 * v1.273 — ต่ออายุล็อกอินให้คนที่ยังใช้งานอยู่
 *
 * session เป็น JWT อายุ 7 วัน (auth.ts) แต่ทั้งแอปไม่มีใครเรียก /api/auth/session เลย
 * และ getServerSession ใน App Router เขียน cookie ไม่ได้ → อายุนับจาก "ตอนล็อกอิน" ตายตัว
 * คนที่เปิดฟอร์มค้างข้ามวันที่ 7 กด Submit แล้วได้ "Unauthorized" (เคสจริง 22 ต.ค. 2569:
 * ใบ Shark Ninja ของ LIFE ไม่เข้าระบบ) · /api/auth/session ของ next-auth (JWT) ออก cookie ใหม่
 * อายุ maxAge นับจากตอนนี้ทุกครั้ง → เรียกตอนเปิดหน้า/กลับมาที่แท็บ = นับ 7 วันจากการใช้ล่าสุด
 */

import { useEffect } from 'react'

const EVERY_MS = 60 * 60 * 1000 // ponytail: ต่อได้อย่างมากชั่วโมงละครั้งต่อแท็บ พอสำหรับอายุ 7 วัน

export default function SessionKeepAlive() {
  useEffect(() => {
    let last = 0
    const refresh = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < EVERY_MS) return
      last = Date.now()
      fetch('/api/auth/session', { cache: 'no-store' }).catch(() => {})
    }
    refresh()
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  return null
}
