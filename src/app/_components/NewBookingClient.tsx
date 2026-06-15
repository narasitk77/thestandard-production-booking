'use client'

/* =============================================================================
   NewBookingClient — v1.57.0
   Host for /new. Plain users get the single-booking wizard. Console users get
   a mode switch at the top to flip between "จองครั้งเดียว" (the wizard) and
   "Routine" (the recurring weekday planner). Routine generation bulk-creates
   many bookings and is a console power, so the toggle only appears for them;
   the planner's API is requireConsole-gated regardless.
   ============================================================================= */

import { useEffect, useState } from 'react'
import { CalendarDays, Repeat } from 'lucide-react'
import { hasConsoleAccess } from '@/lib/roles'
import BookingWizard from '@/app/_components/booking/BookingWizard'
import RoutinePlanner from '@/app/_components/RoutinePlanner'

export default function NewBookingClient() {
  const [isConsole, setIsConsole] = useState(false)
  const [mode, setMode] = useState<'single' | 'routine'>('single')

  useEffect(() => {
    fetch('/api/me', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (hasConsoleAccess(d?.user?.role)) setIsConsole(true) })
      .catch(() => {})
  }, [])

  // Single stable root so flipping isConsole (after /api/me) only adds the
  // toggle bar — it never remounts the wizard underneath. Plain users get
  // no toggle and only ever see the single-booking wizard (mode stays 'single').
  return (
    <div>
      {isConsole && (
        <div className="max-w-5xl mx-auto px-3 sm:px-4 pt-4">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 text-sm">
            <button onClick={() => setMode('single')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                mode === 'single' ? 'bg-[#673ab7] text-white' : 'text-gray-600 hover:text-gray-900'
              }`}>
              <CalendarDays className="w-4 h-4" /> จองครั้งเดียว
            </button>
            <button onClick={() => setMode('routine')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                mode === 'routine' ? 'bg-[#673ab7] text-white' : 'text-gray-600 hover:text-gray-900'
              }`}>
              <Repeat className="w-4 h-4" /> Routine (รายสัปดาห์)
            </button>
          </div>
        </div>
      )}
      {isConsole && mode === 'routine' ? <RoutinePlanner /> : <BookingWizard />}
    </div>
  )
}
