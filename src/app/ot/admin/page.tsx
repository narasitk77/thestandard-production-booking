'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Download, Loader2 } from 'lucide-react'

interface PersonSummary {
  email: string
  thaiName: string
  employeeId: string
  position: string
  holidayDays: number
  otHours: number
}

const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม']

function currentMonth(): string { return new Date().toISOString().slice(0, 7) }
function prevMonth(): string {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1)
  return d.toISOString().slice(0, 7)
}
function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split('-')
  return `${THAI_MONTHS[parseInt(m) - 1]} ${y}`
}

export default function OTAdminPage() {
  const [summary, setSummary] = useState<PersonSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [month, setMonth] = useState(currentMonth())

  useEffect(() => {
    setLoading(true)
    fetch(`/api/ot/summary?month=${month}`)
      .then(r => r.json())
      .then(d => setSummary(d.summary || []))
      .finally(() => setLoading(false))
  }, [month])

  const totals = summary.reduce(
    (a, s) => ({ holiday: a.holiday + s.holidayDays, ot: a.ot + s.otHours, people: a.people + ((s.holidayDays + s.otHours) > 0 ? 1 : 0) }),
    { holiday: 0, ot: 0, people: 0 }
  )

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3">
      <Link href="/ot" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="w-4 h-4" /> กลับหน้า OT
      </Link>

      <div className="gf-header p-4 sm:p-6">
        <h1 className="text-xl sm:text-2xl font-normal text-gray-800">OT Cover Sheet — Admin</h1>
        <p className="text-xs sm:text-sm text-gray-500">สรุปการขออนุมัติการทำงานวันหยุด · Production · {monthLabel(month)}</p>
      </div>

      {/* Month + export controls */}
      <div className="gf-card p-4 flex items-center gap-2 flex-wrap">
        <span className="text-sm text-gray-700 font-medium">เดือน</span>
        <input type="month" value={month} onChange={e => setMonth(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1 text-sm" />
        <div className="flex gap-1 ml-1">
          <button onClick={() => setMonth(prevMonth())} className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50">เดือนก่อน</button>
          <button onClick={() => setMonth(currentMonth())} className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50">เดือนนี้</button>
        </div>

        <div className="ml-auto flex gap-2 flex-wrap">
          <a href={`/api/ot/export?month=${month}`} download
            className="px-3 py-1.5 text-xs border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white inline-flex items-center gap-1">
            <Download className="w-3 h-3" /> Cover Sheet CSV
          </a>
          <a href={`/api/ot/export?month=${month}&detail=1`} download
            className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
            <Download className="w-3 h-3" /> Detail CSV
          </a>
        </div>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-3 gap-3">
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">คนที่บันทึก</div>
          <div className="text-2xl font-medium text-gray-800">{totals.people}</div>
        </div>
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">วันหยุดรวม</div>
          <div className="text-2xl font-medium text-gray-800">{totals.holiday} <span className="text-sm text-gray-400">วัน</span></div>
        </div>
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">OT รวม</div>
          <div className="text-2xl font-medium text-gray-800">{totals.ot} <span className="text-sm text-gray-400">ชม.</span></div>
        </div>
      </div>

      {/* Cover sheet table */}
      <div className="gf-card p-4 sm:p-5">
        {loading ? (
          <div className="py-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <table className="w-full text-sm min-w-[700px]">
              <thead className="border-b border-gray-200">
                <tr className="text-xs text-gray-500">
                  <th className="text-left py-2 pr-2">#</th>
                  <th className="text-left py-2 pr-2">ชื่อ-นามสกุล</th>
                  <th className="text-left py-2 pr-2">รหัส</th>
                  <th className="text-left py-2 pr-2">ตำแหน่ง</th>
                  <th className="text-right py-2 pr-2">วันหยุด</th>
                  <th className="text-right py-2 pr-2">OT (ชม.)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {summary.map((s, i) => {
                  const hasData = s.holidayDays > 0 || s.otHours > 0
                  return (
                    <tr key={s.email} className={hasData ? '' : 'text-gray-400'}>
                      <td className="py-2 pr-2 text-gray-400">{i + 1}</td>
                      <td className="py-2 pr-2 text-gray-800">{s.thaiName || s.email}</td>
                      <td className="py-2 pr-2 text-xs text-gray-500">{s.employeeId}</td>
                      <td className="py-2 pr-2 text-xs text-gray-600">{s.position}</td>
                      <td className="py-2 pr-2 text-right tabular-nums font-medium">{s.holidayDays || '0'}</td>
                      <td className="py-2 pr-2 text-right tabular-nums font-medium">{s.otHours || '0'}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 font-medium">
                  <td colSpan={4} className="py-2 pr-2 text-right text-gray-700">รวม</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{totals.holiday}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{totals.ot}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
