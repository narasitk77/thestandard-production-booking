import { isThaiHoliday, getHolidayName } from './thai-holidays'

export type DayType = 'WEEKDAY' | 'WEEKEND' | 'HOLIDAY'

// Rates per Thai labor context — fixed daily, no stacking.
export const RATE_WEEKEND_OR_HOLIDAY_THB = 500
export const RATE_WEEKDAY_OT_THB = 300
export const WEEKDAY_THRESHOLD_HOURS = 9

export function getDayType(date: Date | string): DayType {
  // Holiday check first — if a date is BOTH weekend and holiday, treat as HOLIDAY (still 500 THB).
  if (isThaiHoliday(date)) return 'HOLIDAY'
  const d = typeof date === 'string' ? new Date(date) : date
  const day = d.getDay() // 0 = Sun, 6 = Sat (using local time)
  if (day === 0 || day === 6) return 'WEEKEND'
  return 'WEEKDAY'
}

export function dayTypeLabel(t: DayType): string {
  return t === 'HOLIDAY' ? 'Public Holiday' : t === 'WEEKEND' ? 'Weekend' : 'Weekday'
}

export function parseTimeToMinutes(t: string | null | undefined): number | null {
  if (!t) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(t)
  if (!m) return null
  const h = parseInt(m[1])
  const min = parseInt(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

export interface OTTaskInput {
  startTime: string  // HH:MM
  endTime: string    // HH:MM
  // v1.42.0 — how many days after the START date the shift ends. 0 = same day,
  // 1 = ends the next day (crossed midnight). The end time is interpreted as
  // (endOffsetDays × 24h + endTime), so an overnight shift is no longer dropped.
  endOffsetDays?: number
  jobTask?: string | null
  justification?: string | null
}

// Whole-day difference between two ISO date strings (YYYY-MM-DD or longer).
// Never negative; an end on/before the start returns 0. Used to turn a record's
// `endDate` into the `endOffsetDays` the day summary needs.
export function dateOffsetDays(startISO: string, endISO?: string | null): number {
  if (!endISO) return 0
  const s = startISO.slice(0, 10)
  const e = endISO.slice(0, 10)
  if (e <= s) return 0
  const ms = Date.parse(`${e}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)
  if (Number.isNaN(ms)) return 0
  return Math.max(0, Math.round(ms / 86_400_000))
}

export interface DaySummary {
  dayType: DayType
  dayLabel: string
  holidayName: string | null
  totalHours: number          // span: start of first task to end of last task
  workedMinutes: number       // sum of actual task durations (excludes gaps)
  gapMinutes: number          // total standby gap
  hasStandby: boolean
  otAmountTHB: number
  status: string              // human label e.g. "Weekday OT (Standby)"
  qualifies: boolean          // does it count toward OT pay
  taskCount: number
}

/**
 * Aggregate a list of tasks (for one user, one date) into a single OT day summary.
 *
 * Rules (Thai labor context):
 *  - Weekend or Public Holiday + ANY work → 500 THB (no stacking when both)
 *  - Weekday + (last_end - first_start) > 9 hours → 300 THB
 *  - Otherwise → no OT
 *  - "Standby" tag added when there are gaps between tasks within a qualifying day
 */
export function summarizeDay(date: Date | string, tasks: OTTaskInput[]): DaySummary {
  const dayType = getDayType(date)
  const holidayName = getHolidayName(date)
  const valid = tasks
    .map(t => {
      const startMin = parseTimeToMinutes(t.startTime)
      const endRaw = parseTimeToMinutes(t.endTime)
      // Absolute end minutes from the START date's midnight, so an overnight
      // shift (endRaw <= startMin but endOffsetDays >= 1) stays valid and its
      // duration spans the day boundary correctly.
      const offset = Math.max(0, Math.round(t.endOffsetDays ?? 0))
      const endMin = endRaw === null ? null : endRaw + offset * 1440
      return { ...t, startMin, endMin }
    })
    .filter(t => t.startMin !== null && t.endMin !== null && t.endMin! > t.startMin!) as Array<OTTaskInput & { startMin: number; endMin: number }>

  if (valid.length === 0) {
    return {
      dayType,
      dayLabel: dayTypeLabel(dayType),
      holidayName,
      totalHours: 0,
      workedMinutes: 0,
      gapMinutes: 0,
      hasStandby: false,
      otAmountTHB: 0,
      status: 'No tasks',
      qualifies: false,
      taskCount: 0,
    }
  }

  const sorted = valid.sort((a, b) => a.startMin - b.startMin)
  const firstStart = sorted[0].startMin
  const lastEnd = Math.max(...sorted.map(t => t.endMin))
  const spanMinutes = lastEnd - firstStart
  const totalHours = Math.round((spanMinutes / 60) * 100) / 100

  const workedMinutes = sorted.reduce((sum, t) => sum + (t.endMin - t.startMin), 0)
  const gapMinutes = Math.max(0, spanMinutes - workedMinutes)
  const hasStandby = gapMinutes > 0 && sorted.length > 1

  let otAmountTHB = 0
  let status = ''
  let qualifies = false

  if (dayType === 'HOLIDAY') {
    otAmountTHB = RATE_WEEKEND_OR_HOLIDAY_THB
    status = 'Public Holiday'
    qualifies = true
  } else if (dayType === 'WEEKEND') {
    otAmountTHB = RATE_WEEKEND_OR_HOLIDAY_THB
    status = 'Weekend'
    qualifies = true
  } else {
    // Weekday: needs SPAN > 9 hours
    if (totalHours > WEEKDAY_THRESHOLD_HOURS) {
      otAmountTHB = RATE_WEEKDAY_OT_THB
      status = `Weekday OT (>${WEEKDAY_THRESHOLD_HOURS}h)`
      qualifies = true
    } else {
      status = `Weekday — ${WEEKDAY_THRESHOLD_HOURS}h or less, no OT`
    }
  }

  if (hasStandby && qualifies) {
    status += ' · Standby'
  }

  return {
    dayType,
    dayLabel: dayTypeLabel(dayType),
    holidayName,
    totalHours,
    workedMinutes,
    gapMinutes,
    hasStandby,
    otAmountTHB,
    status,
    qualifies,
    taskCount: sorted.length,
  }
}

export function formatTHB(amount: number): string {
  return amount.toLocaleString('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 })
}
