'use client'

/**
 * v1.184 — กระดิ่งแจ้งเตือนข้าง "New Booking"
 *
 * แอดมิน/คอนโซล: ขอยกเลิก → ขอแก้ไข → ระบบขัดข้อง (ลำดับที่ operator สั่ง)
 * เจ้าของงาน: ผลที่เกิดกับงานของตัวเอง
 *
 * ทั้งลิสต์และตัวเลขมาจาก GET /api/notifications ฝั่งเดียว — component นี้ไม่ตัดสิน
 * ว่าใครเห็นอะไรเลย (server ตัดสิน) มันแค่วาด
 *
 * การโหลด/poll อยู่ใน notification-store.ts — แชร์กันทุก instance (Nav mount กระดิ่ง
 * สองตัว: cluster desktop กับ cluster mobile) และ poll เฉพาะตอนแท็บถูกมองอยู่
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Bell, AlertTriangle, Clock, XCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { KIND_LABEL, type NotifItem, type NotifKind } from '@/lib/notification-kinds'
import {
  getNotifState, subscribeNotifications, refreshNotifications, markNotificationsSeen,
  type NotifState,
} from './notification-store'

const KIND_STYLE: Record<NotifKind, { icon: typeof Bell; cls: string; dot: string }> = {
  cancel_request: { icon: XCircle, cls: 'text-red-700', dot: 'bg-red-500' },
  edit_request: { icon: Clock, cls: 'text-amber-700', dot: 'bg-amber-500' },
  system_error: { icon: AlertTriangle, cls: 'text-orange-700', dot: 'bg-orange-500' },
  booking_outcome: { icon: CheckCircle2, cls: 'text-blue-700', dot: 'bg-blue-500' },
}

function timeAgo(at: string | null): string {
  if (!at) return 'ค้างอยู่'
  const ms = Date.now() - new Date(at).getTime()
  if (ms < 0) return 'เมื่อครู่'
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'เมื่อครู่'
  if (m < 60) return `${m} นาที`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} ชม.`
  return `${Math.floor(h / 24)} วัน`
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  // ข้อมูลมาจากสโตร์ที่แชร์กันทุก instance — Nav mount กระดิ่งสองตัว (desktop/mobile)
  // แต่ยิง API รอบเดียว และเลขบนกระดิ่งทั้งสองตัวตรงกันเสมอ
  const [feed, setFeed] = useState<NotifState>(getNotifState)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  // ตำแหน่ง panel คิดจาก rect ของปุ่มจริง แล้ว clamp เข้ากรอบจอ
  //
  // WHY ไม่ใช้ `absolute right-0`: บนมือถือกระดิ่ง**ไม่ได้อยู่ริมขวา** (ปุ่ม + กับ
  // แฮมเบอร์เกอร์อยู่ขวากว่า) → ขอบขวาของ panel ไปผูกกับกระดิ่ง ทำให้ขอบซ้ายไหล
  // ออกนอกจอที่ -55px แล้วตัวหนังสือด้านซ้ายถูกตัดหายไปเลย (วัดได้ที่ 375px)
  // ไม่ hardcode ความสูง nav เพราะ nav สูงไม่เท่ากันทุก breakpoint
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const { items, unread, status: state } = feed

  useEffect(() => subscribeNotifications(setFeed), [])

  useEffect(() => {
    if (!open) return
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      const margin = 12
      const width = Math.min(340, window.innerWidth - margin * 2)
      const wanted = r.right - width                                  // ขอบขวาชนกับปุ่ม
      const left = Math.max(margin, Math.min(wanted, window.innerWidth - width - margin))
      setPos({ top: r.bottom + 8, left, width })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])

  // ปิดเมื่อคลิกข้างนอก / กด Esc
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (!next) return
    await refreshNotifications(items.length === 0)
    // เปิดดูแล้ว = เคลียร์ตัวเลข (ตัวรายการยังอยู่ให้ตามงานต่อ)
    markNotificationsSeen()
  }

  const grouped: { kind: NotifKind; rows: NotifItem[] }[] = []
  for (const it of items) {
    const last = grouped[grouped.length - 1]
    if (last && last.kind === it.kind) last.rows.push(it)
    else grouped.push({ kind: it.kind, rows: [it] })
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-label={`แจ้งเตือน${unread > 0 ? ` ${unread} รายการใหม่` : ''}`}
        aria-expanded={open}
        className="ops-btn-secondary ops-btn-sm relative"
      >
        <Bell className="w-3.5 h-3.5" />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold leading-4 text-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
        {state === 'error' && unread === 0 && (
          <span
            title="โหลดแจ้งเตือนไม่ได้"
            className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-gray-400"
          />
        )}
      </button>

      {open && pos && (
        <div
          style={{ top: pos.top, left: pos.left, width: pos.width }}
          className="fixed max-h-[70vh] overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-lg z-50"
        >
          <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700">แจ้งเตือน</span>
            {state === 'loading' && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
          </div>

          {state === 'error' && (
            <div className="px-3 py-3 text-xs text-gray-600">
              โหลดแจ้งเตือนไม่ได้ —{' '}
              <button onClick={() => refreshNotifications(true)} className="text-brand-primary underline">ลองใหม่</button>
            </div>
          )}

          {state !== 'error' && items.length === 0 && (
            <div className="px-3 py-6 text-xs text-gray-400 text-center">ไม่มีอะไรค้าง 🎉</div>
          )}

          {grouped.map(g => {
            const S = KIND_STYLE[g.kind]
            return (
              <div key={g.kind}>
                <div className="px-3 pt-2 pb-1 flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${S.dot}`} />
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                    {KIND_LABEL[g.kind]} · {g.rows.length}
                  </span>
                </div>
                {g.rows.map(it => {
                  const Icon = S.icon
                  return (
                    <Link
                      key={it.id}
                      href={it.href}
                      onClick={() => setOpen(false)}
                      className="flex gap-2 px-3 py-2 hover:bg-gray-50 border-t border-gray-50"
                    >
                      <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${S.cls}`} />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-gray-800 truncate">{it.title}</div>
                        {it.detail && (
                          <div className="text-[11px] text-gray-500 line-clamp-2">{it.detail}</div>
                        )}
                      </div>
                      <div className="text-[10px] text-gray-400 shrink-0 mt-0.5">{timeAgo(it.at)}</div>
                    </Link>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
