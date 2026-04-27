import Link from 'next/link'
import { OUTLETS } from '@/lib/data'
import { ArrowRight, Film, Calendar, Upload, LayoutDashboard } from 'lucide-react'

export default function HomePage() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      {/* Hero */}
      <div className="mb-10">
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-brand-gold/10 text-brand-gold text-xs font-medium rounded-full mb-4">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-gold"></span>
          Production Pipeline · Phase 1
        </div>
        <h1 className="text-3xl font-bold text-brand-black mb-2">
          Production Booking
        </h1>
        <p className="text-brand-gray-500 max-w-xl">
          Book a shoot once — Episode ID generates automatically.
          ข้อมูลเดินทางได้ด้วยตัวเอง จาก Booking ถึง Folder
        </p>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12">
        <Link
          href="/dashboard"
          className="card p-5 flex items-center gap-4 hover:border-brand-gray-300 transition-colors group"
        >
          <div className="p-2.5 bg-brand-gray-100 rounded-lg group-hover:bg-brand-black transition-colors">
            <LayoutDashboard className="w-5 h-5 text-brand-gray-600 group-hover:text-white transition-colors" />
          </div>
          <div>
            <div className="font-medium text-sm text-brand-black">Dashboard</div>
            <div className="text-xs text-brand-gray-500">View all bookings</div>
          </div>
          <ArrowRight className="w-4 h-4 text-brand-gray-400 ml-auto" />
        </Link>

        <Link
          href="/upload"
          className="card p-5 flex items-center gap-4 hover:border-brand-gray-300 transition-colors group"
        >
          <div className="p-2.5 bg-brand-gray-100 rounded-lg group-hover:bg-brand-black transition-colors">
            <Upload className="w-5 h-5 text-brand-gray-600 group-hover:text-white transition-colors" />
          </div>
          <div>
            <div className="font-medium text-sm text-brand-black">Upload Footage</div>
            <div className="text-xs text-brand-gray-500">Log files by Episode ID</div>
          </div>
          <ArrowRight className="w-4 h-4 text-brand-gray-400 ml-auto" />
        </Link>

        <div className="card p-5 flex items-center gap-4 bg-brand-black text-white border-brand-black">
          <div className="p-2.5 bg-brand-gray-800 rounded-lg">
            <Film className="w-5 h-5 text-brand-gold" />
          </div>
          <div>
            <div className="font-medium text-sm">56 Programs</div>
            <div className="text-xs text-brand-gray-400">9 Outlets registered</div>
          </div>
        </div>
      </div>

      {/* Outlet grid */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-brand-black">Select Outlet to Book</h2>
        <span className="text-xs text-brand-gray-400">กดปุ่ม Outlet เพื่อเริ่ม Booking</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {OUTLETS.sort((a, b) => a.sort - b.sort).map((outlet) => (
          <Link
            key={outlet.code}
            href={`/booking/${outlet.code.toLowerCase()}`}
            className={`card p-6 border-2 ${outlet.borderColor} ${outlet.bgColor} hover:shadow-md transition-all group relative overflow-hidden`}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className={`text-xs font-mono font-bold ${outlet.color} mb-1`}>{outlet.code}</div>
                <div className="text-lg font-bold text-brand-black">{outlet.name}</div>
                <div className="text-xs text-brand-gray-500 mt-0.5">{outlet.description}</div>
              </div>
              <ArrowRight className={`w-5 h-5 ${outlet.color} opacity-0 group-hover:opacity-100 transition-opacity mt-1`} />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex flex-wrap gap-1">
                {outlet.programs.slice(0, 3).map(p => (
                  <span
                    key={p.code}
                    className="text-xs px-2 py-0.5 bg-white/70 rounded text-brand-gray-600 font-mono"
                  >
                    {p.code}
                  </span>
                ))}
                {outlet.programs.length > 3 && (
                  <span className="text-xs px-2 py-0.5 bg-white/70 rounded text-brand-gray-400">
                    +{outlet.programs.length - 3}
                  </span>
                )}
              </div>
              <span className="text-xs text-brand-gray-400">{outlet.programs.length} programs</span>
            </div>

            <div className="mt-4 pt-4 border-t border-white/50">
              <span className={`text-sm font-medium ${outlet.color} group-hover:underline`}>
                Book — {outlet.name} →
              </span>
            </div>
          </Link>
        ))}
      </div>

      {/* Episode ID explainer */}
      <div className="mt-12 card p-6 border-2 border-brand-gold/30 bg-brand-gold/5">
        <div className="flex items-start gap-4">
          <div className="p-2 bg-brand-gold/10 rounded-lg">
            <Calendar className="w-5 h-5 text-brand-gold" />
          </div>
          <div>
            <h3 className="font-semibold text-brand-black mb-1">Episode ID Format</h3>
            <div className="font-mono text-xl font-bold text-brand-black mb-3 tracking-wider">
              TSS–260423–EXE–01
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              {[
                { label: 'TSS', desc: 'Outlet Code' },
                { label: '260423', desc: 'Shoot Date (YYMMDD)' },
                { label: 'EXE', desc: 'Program Code' },
                { label: '01', desc: 'Episode Sequence' },
              ].map(item => (
                <div key={item.label} className="bg-white rounded-lg p-2 border border-brand-gray-200">
                  <div className="font-mono font-bold text-brand-black">{item.label}</div>
                  <div className="text-brand-gray-500">{item.desc}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-brand-gray-500 mt-3">
              ID ปรากฏบน Calendar event · ชื่อโฟลเดอร์ใน Drive/NAS · Airtable record —
              ถ้ารู้ ID ก็หาทุกอย่างเจอ
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
