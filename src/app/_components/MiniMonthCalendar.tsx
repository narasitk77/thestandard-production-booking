'use client'

// v1.120 — a compact month picker for filtering a list by day. Click a day to
// select it (click again to clear); days that have items show a dot. Sunday-
// first grid to match the rest of ops' mental model. Pure/self-contained.
import { useState } from 'react'
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval,
  format, addMonths, isSameMonth, isSameDay, parseISO,
} from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export default function MiniMonthCalendar({
  markedDates,
  selected,
  onSelect,
}: {
  markedDates?: Set<string>          // 'yyyy-MM-dd' that have items → dot
  selected: string | null           // 'yyyy-MM-dd'
  onSelect: (dateStr: string | null) => void
}) {
  const [cursor, setCursor] = useState<Date>(() => {
    try { return selected ? parseISO(selected) : new Date() } catch { return new Date() }
  })
  const gridStart = startOfWeek(startOfMonth(cursor), { weekStartsOn: 0 })
  const gridEnd = endOfWeek(endOfMonth(cursor), { weekStartsOn: 0 })
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd })
  const today = new Date()

  return (
    <div className="inline-block bg-white border border-gray-200 rounded-xl p-3 shadow-sm select-none">
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="text-sm font-medium text-gray-800">{format(cursor, 'MMMM yyyy')}</div>
        <div className="flex items-center gap-1">
          <button onClick={() => setCursor(c => addMonths(c, -1))} className="p-1 rounded hover:bg-gray-100 text-gray-500" aria-label="เดือนก่อน"><ChevronLeft className="w-4 h-4" /></button>
          <button onClick={() => setCursor(new Date())} className="px-2 py-0.5 text-[11px] rounded hover:bg-gray-100 text-gray-500">วันนี้</button>
          <button onClick={() => setCursor(c => addMonths(c, 1))} className="p-1 rounded hover:bg-gray-100 text-gray-500" aria-label="เดือนถัดไป"><ChevronRight className="w-4 h-4" /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {DOW.map((d, i) => <div key={i} className="w-9 text-center text-[11px] text-gray-400">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {days.map(day => {
          const key = format(day, 'yyyy-MM-dd')
          const inMonth = isSameMonth(day, cursor)
          const isToday = isSameDay(day, today)
          const isSel = selected === key
          const marked = markedDates?.has(key)
          return (
            <button
              key={key}
              onClick={() => onSelect(isSel ? null : key)}
              title={marked ? 'มีงานวันนี้' : undefined}
              className={`relative w-9 h-9 rounded-full text-sm flex items-center justify-center transition-colors ${
                isSel ? 'bg-[#673ab7] text-white font-medium'
                : isToday ? 'bg-[#673ab7]/10 text-[#673ab7] font-medium'
                : inMonth ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-50'}`}>
              {format(day, 'd')}
              {marked && !isSel && <span className="absolute bottom-1 w-1 h-1 rounded-full bg-[#673ab7]" />}
            </button>
          )
        })}
      </div>
      {selected && (
        <button onClick={() => onSelect(null)} className="mt-2 w-full text-xs text-gray-500 hover:text-gray-800 border-t border-gray-100 pt-2">
          ✕ ล้างวันที่เลือก · ดูทั้งหมด
        </button>
      )}
    </div>
  )
}
