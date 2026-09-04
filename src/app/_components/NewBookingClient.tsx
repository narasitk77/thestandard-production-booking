'use client'

/* =============================================================================
   NewBookingClient — v1.57.0, โหมดมิกซ์เพิ่ม v1.218
   Host for /new.

   v1.218 — เพิ่มโหมดที่สาม "ขอมิกซ์เสียง"

   ที่มา: คิวมิกซ์ (/mix) เปิดใช้ได้แต่คนขอต้อง **รู้เองว่ามีหน้านั้น** ซึ่งเป็น
   ปัญหาการค้นพบแบบเดียวกับที่ทำให้ /switcher มี 0 แถว · ส่วน /new คือที่ที่คนมา
   อยู่แล้วเวลา "อยากได้อะไรสักอย่างจากทีมโปรดักชัน" — ปุ่ม + New Booking อยู่บน
   nav ตลอด ฉะนั้นทางเข้าที่คนหาเจอจริงคือที่นี่ ไม่ใช่ URL ที่ต้องจำ

   สองข้อที่ตั้งใจ:
   - **`single` ยังเป็นค่าเริ่มต้น** คนจองกอง (ซึ่งคือทราฟฟิกเกือบทั้งหมด — bookings
     532 แถว เทียบกับ mix_jobs 0) ไม่ต้องคลิกเพิ่มแม้แต่ครั้งเดียว การเพิ่มทางเลือก
     ต้องไม่เก็บค่าผ่านทางจากเส้นทางหลัก
   - **โหมดมิกซ์เห็นได้ทุกคน** ต่างจาก Routine ที่เป็น console-only — เพราะคนขอมิกซ์
     คือโปรดิวเซอร์/คนตัด/ใครก็ได้ที่มีงาน ถ้ากั้นก็กลับไปที่ปัญหาเดิมคือคิวว่าง

   หมายเหตุเรื่องแกนของ toggle: สองปุ่มเดิมเป็นแกน "กี่ครั้ง" (ครั้งเดียว/ประจำ)
   ส่วนปุ่มใหม่เป็นแกน "งานอะไร" — คนละแกน จึงตั้งชื่อให้อ่านเป็นแกนเดียวกันว่า
   *จะขออะไร* ("จองคิวถ่าย" / "ขอมิกซ์เสียง" / "จองถ่ายแบบประจำ") ไม่ใช่ปล่อยให้
   อ่านว่า "ครั้งเดียว vs รายสัปดาห์ vs เสียง" ซึ่งไม่เข้าพวกกัน
   ============================================================================= */

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { CalendarDays, Repeat, SlidersHorizontal, CheckCircle2 } from 'lucide-react'
import { hasConsoleAccess } from '@/lib/roles'
import BookingWizard from '@/app/_components/booking/BookingWizard'
import RoutinePlanner from '@/app/_components/RoutinePlanner'
import MixRequestForm from '@/app/_components/MixRequestForm'

type Mode = 'single' | 'mix' | 'routine'

/**
 * v1.219 — เข้ามาที่โหมดมิกซ์ตรง ๆ ได้จาก `?mode=mix&booking=<รหัส>`
 *
 * ใช้โดยปุ่ม "ขอมิกซ์เสียง" บนหน้าใบจอง — เลือกวิธีนี้แทนการฝังฟอร์มลงหน้าใบจอง
 * เพราะฟอร์มมีที่อยู่ที่เดียว (MixRequestForm) และหน้าใบจองก็ยาวพออยู่แล้ว
 * ผลพลอยได้: ลิงก์นี้ส่งต่อในแชทได้ กดแล้วเปิดฟอร์มพร้อมรหัสเติมไว้
 *
 * Suspense ครอบเพราะ useSearchParams ต้องการ — ไม่มีแล้ว build จะเตือน
 */
export default function NewBookingClient() {
  return (
    <Suspense fallback={<div className="max-w-5xl mx-auto px-4 py-10 text-sm text-gray-400">กำลังโหลด…</div>}>
      <NewBookingInner />
    </Suspense>
  )
}

function NewBookingInner() {
  const params = useSearchParams()
  const wantMix = params.get('mode') === 'mix'
  const prefillBooking = params.get('booking')?.trim() || ''
  const [isConsole, setIsConsole] = useState(false)
  const [mode, setMode] = useState<Mode>(wantMix ? 'mix' : 'single')
  const [sent, setSent] = useState<{ code: string; notifiedTo: string[] } | null>(null)

  useEffect(() => {
    fetch('/api/me', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (hasConsoleAccess(d?.user?.role)) setIsConsole(true) })
      .catch(() => {})
  }, [])

  const tab = (m: Mode, icon: React.ReactNode, label: string) => (
    <button
      key={m}
      onClick={() => { setMode(m); setSent(null) }}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
        mode === m ? 'bg-[#673ab7] text-white' : 'text-gray-600 hover:text-gray-900'
      }`}
    >
      {icon} {label}
    </button>
  )

  // Single stable root so flipping isConsole (after /api/me) only adds the
  // Routine tab — it never remounts the wizard underneath.
  return (
    <div>
      <div className="max-w-5xl mx-auto px-3 sm:px-4 pt-4">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 text-sm">
          {tab('single', <CalendarDays className="w-4 h-4" />, 'จองคิวถ่าย')}
          {tab('mix', <SlidersHorizontal className="w-4 h-4" />, 'ขอมิกซ์เสียง')}
          {isConsole && tab('routine', <Repeat className="w-4 h-4" />, 'จองถ่ายแบบประจำ')}
        </div>
      </div>

      {mode === 'mix' ? (
        <div className="max-w-3xl mx-auto px-3 sm:px-4 py-5">
          {sent ? (
            /* ยืนยันตรงนี้แทนการเด้งไป /mix ทันที — คนที่มาจากหน้านี้ยังไม่ได้เปิดคิว
             * อยู่ และการโดนพาไปหน้าอื่นทันทีทำให้ไม่ทันเห็นว่าคำขอได้เลขอะไร
             * แสดง "แจ้งใครไปแล้วบ้าง" ด้วย เพราะ "ส่งแล้ว" ที่ไม่มีใครได้รับ
             * คือคำโกหกที่สุภาพ (บทเรียน v1.186) */
            <div className="border border-green-200 bg-green-50 rounded-lg p-5">
              <div className="flex items-start gap-2.5">
                <CheckCircle2 className="text-green-600 mt-0.5 shrink-0" size={20} />
                <div className="min-w-0">
                  <p className="font-medium text-gray-800">
                    ส่งคำขอแล้ว {sent.code && <span className="font-mono text-sm text-gray-500">{sent.code}</span>}
                  </p>
                  <p className="text-sm text-gray-600 mt-1">
                    {sent.notifiedTo.length > 0
                      ? <>แจ้งไปที่ {sent.notifiedTo.join(', ')} แล้ว — รอ coordinator แจกงาน</>
                      : <span className="text-amber-700">
                          บันทึกคำขอแล้ว แต่<b>ยังไม่ได้แจ้งใคร</b> (เมลไม่ออก) —
                          ทักทีมเสียงอีกทางด้วย แล้วบอกแอดมินให้ตรวจการตั้งค่าเมล
                        </span>}
                  </p>
                  <div className="mt-3 flex gap-3 text-sm">
                    <Link href="/mix" className="gf-link">ดูคิวมิกซ์ →</Link>
                    <button onClick={() => setSent(null)} className="gf-link">ขออีกงาน</button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
              <h1 className="text-lg font-medium text-gray-800 mb-1">🎚 ขอมิกซ์เสียง</h1>
              <p className="text-sm text-gray-500 mb-4">
                ขอที่นี่แทนการทักในแชท — ทีมเสียงจะได้รับแจ้งทันที และตามงานได้จากคิว
              </p>
              <MixRequestForm onDone={setSent} initialBookingCode={prefillBooking || undefined} />
            </>
          )}
        </div>
      ) : isConsole && mode === 'routine' ? (
        <RoutinePlanner />
      ) : (
        <BookingWizard />
      )}
    </div>
  )
}
