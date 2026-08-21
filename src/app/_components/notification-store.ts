'use client'

/**
 * v1.184 — สโตร์เล็ก ๆ ที่ทำให้กระดิ่ง "ยิง API รอบเดียว" ไม่ว่าจะ mount กี่ตัว
 *
 * WHY: Nav render กระดิ่งสองตัว (cluster desktop + cluster mobile) แล้วซ่อนตัวที่
 * ไม่ใช้ด้วย CSS — ทั้งคู่ mount จริงและ useEffect ก็ทำงานจริงทั้งคู่ ถ้าปล่อยให้แต่ละ
 * ตัว fetch เอง ผู้ใช้หนึ่งคนจะยิง GET /api/notifications สองครั้งทุกรอบ poll และ
 * แต่ละครั้งคือ 4-5 query — คูณจำนวนคนที่เปิดแท็บค้างไว้ทั้งวันแล้วมันไม่ฟรี
 *
 * ผลพลอยได้: เปิดกระดิ่งตัวไหนก็ตาม อีกตัวเห็นสถานะเดียวกันทันที ไม่มีทางโชว์เลข
 * ต่างกันสองที่บนหน้าจอเดียว
 *
 * poll เดินเฉพาะตอนมีคน subscribe อยู่ และเฉพาะตอนแท็บถูกมองอยู่
 */

import type { NotifItem } from '@/lib/notification-kinds'

export interface NotifState {
  items: NotifItem[]
  unread: number
  status: 'idle' | 'loading' | 'error'
}

const POLL_MS = 90_000

let state: NotifState = { items: [], unread: 0, status: 'idle' }
const listeners = new Set<(s: NotifState) => void>()
let timer: ReturnType<typeof setInterval> | null = null
let inFlight: Promise<void> | null = null

function emit() {
  // Array.from (ไม่ใช่ for..of บน Set): tsconfig target ของโปรเจกต์นี้ต่ำกว่า es2015
  // และ snapshot ก่อนวนก็กัน listener ที่ unsubscribe ตัวเองกลางลูปด้วย
  Array.from(listeners).forEach(l => l(state))
}

function set(patch: Partial<NotifState>) {
  state = { ...state, ...patch }
  emit()
}

export function getNotifState(): NotifState {
  return state
}

export async function refreshNotifications(showSpinner = false): Promise<void> {
  // ถ้ามีรอบที่ยังค้างอยู่ ให้เกาะรอบนั้น ไม่ยิงซ้อน
  if (inFlight) return inFlight
  if (showSpinner) set({ status: 'loading' })
  inFlight = (async () => {
    try {
      const r = await fetch('/api/notifications', { cache: 'no-store' })
      if (!r.ok) throw new Error(String(r.status))
      const d = await r.json()
      set({
        items: Array.isArray(d.items) ? d.items : [],
        unread: typeof d.unread === 'number' ? d.unread : 0,
        status: 'idle',
      })
    } catch {
      // "อ่านไม่ได้" ต้องไม่หน้าตาเหมือน "ไม่มีข่าว" — เก็บรายการเดิมไว้ แล้วบอกว่า error
      set({ status: 'error' })
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** เคลียร์ตัวเลข (รายการยังอยู่) + บันทึกฝั่ง server ว่าเปิดดูแล้ว */
export function markNotificationsSeen(): void {
  if (state.unread === 0) return
  set({ unread: 0 })
  fetch('/api/notifications', { method: 'POST' }).catch(() => {})
}

export function subscribeNotifications(fn: (s: NotifState) => void): () => void {
  listeners.add(fn)
  fn(state)
  if (listeners.size === 1) {
    void refreshNotifications(state.items.length === 0)
    const tick = () => { if (document.visibilityState === 'visible') void refreshNotifications() }
    timer = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    stopFns.push(() => {
      if (timer) clearInterval(timer)
      timer = null
      document.removeEventListener('visibilitychange', tick)
    })
  }
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0) {
      while (stopFns.length) stopFns.pop()!()
    }
  }
}

const stopFns: (() => void)[] = []
