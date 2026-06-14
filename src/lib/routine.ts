// v1.56.0 — Routine date generator. Pure + shared by the planner UI (live
// preview) and POST /api/admin/routine (the real generate), so what the user
// previews is exactly what gets created.

import { isThaiHoliday, getHolidayName } from './thai-holidays'

export interface RoutinePlanInput {
  startDate: string            // 'YYYY-MM-DD' inclusive
  endDate: string              // 'YYYY-MM-DD' inclusive
  weekdays: number[]           // allowed weekdays, 1=Mon … 5=Fri (0=Sun, 6=Sat)
  skipHolidays: boolean        // skip Thai public holidays
  customSkip?: string[]        // extra 'YYYY-MM-DD' dates to skip
}

export interface RoutineSkip {
  date: string
  reason: 'weekday' | 'holiday' | 'custom'
  label?: string               // holiday name, when reason === 'holiday'
}

export interface RoutinePlan {
  dates: string[]              // dates a booking will be created for (sorted)
  skipped: RoutineSkip[]       // dates inside the weekday pattern that were skipped
  error?: string
}

const MAX_DAYS = 366           // hard cap on a single generate span

function pad(n: number): string { return String(n).padStart(2, '0') }

// Parse 'YYYY-MM-DD' into a UTC date at noon — TZ-agnostic calendar math
// (Thailand has no DST; noon avoids any midnight rollover ambiguity).
function parseISO(d: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  if (!m) return null
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12))
  return isNaN(dt.getTime()) ? null : dt
}

function fmt(dt: Date): string {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

export function generateRoutineDates(input: RoutinePlanInput): RoutinePlan {
  const { startDate, endDate, weekdays, skipHolidays } = input
  const customSkip = new Set(input.customSkip || [])
  const start = parseISO(startDate)
  const end = parseISO(endDate)
  if (!start) return { dates: [], skipped: [], error: 'วันเริ่มไม่ถูกต้อง' }
  if (!end) return { dates: [], skipped: [], error: 'วันสิ้นสุดไม่ถูกต้อง' }
  if (end < start) return { dates: [], skipped: [], error: 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม' }
  if (!weekdays || weekdays.length === 0) return { dates: [], skipped: [], error: 'เลือกวันในสัปดาห์อย่างน้อย 1 วัน' }

  const allow = new Set(weekdays)
  const dates: string[] = []
  const skipped: RoutineSkip[] = []
  let guard = 0
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (++guard > MAX_DAYS) {
      return { dates: [], skipped: [], error: `ช่วงวันยาวเกิน ${MAX_DAYS} วัน — แบ่งเป็นช่วงย่อย` }
    }
    const iso = fmt(d)
    const dow = d.getUTCDay()
    if (!allow.has(dow)) continue           // outside the weekday pattern → not even a "skip"
    if (customSkip.has(iso)) { skipped.push({ date: iso, reason: 'custom' }); continue }
    if (skipHolidays && isThaiHoliday(iso)) {
      skipped.push({ date: iso, reason: 'holiday', label: getHolidayName(iso) || 'วันหยุด' })
      continue
    }
    dates.push(iso)
  }
  return { dates, skipped }
}

export const ROUTINE_MAX_DAYS = MAX_DAYS
