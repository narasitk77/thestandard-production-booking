'use client'

import { useEffect, useState, useCallback } from 'react'
import BackButton from '@/app/_components/BackButton'
import { Loader2, AlertCircle, BellOff, Check, RefreshCw } from 'lucide-react'

/* =============================================================================
   /admin/reminders — anti-forget inbox.
   Lists open reminders raised by the daily scan engine (loans/rentals/invoices/
   repairs/upcoming shoots/warranties). Dismiss to silence, Resolve when handled,
   or run a scan on demand.
   ============================================================================= */

type Reminder = {
  id: string
  type: string
  status: string
  dueDate: string | null
  title: string
  body: string | null
  entityType: string | null
  entityId: string | null
  sentAt: string | null
}

const TYPE_LABEL: Record<string, string> = {
  LOAN_OVERDUE: '🔴 ยืมเกินกำหนด',
  LOAN_DUE: '🟡 ใกล้ครบกำหนดคืน',
  RENTAL_RETURN_DUE: '📦 ของเช่าถึงกำหนดคืน',
  INVOICE_AGING: '💸 ใบแจ้งหนี้ค้าง',
  REPAIR_OUTSTANDING: '🔧 งานซ่อมค้าง',
  SHOOT_MISSING_GEAR: '🎥 ยังไม่จัดอุปกรณ์',
  WARRANTY_EXPIRING: '🛡️ ประกันใกล้หมด',
}

export default function RemindersPage() {
  const [reminders, setReminders] = useState<Reminder[] | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'open' | 'all'>('open')
  const [busy, setBusy] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch(`/api/admin/reminders?status=${filter}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setReminders(json.reminders || [])
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }, [filter])

  useEffect(() => {
    load()
  }, [load])

  const update = async (id: string, status: string) => {
    setBusy(id)
    setError('')
    try {
      const res = await fetch(`/api/admin/reminders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      await load()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  const runScan = async () => {
    setScanning(true)
    setScanMsg('')
    setError('')
    try {
      const res = await fetch('/api/admin/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setScanMsg(
        `สแกนเสร็จ: เจอ ${json.detected} · สร้างใหม่ ${json.created} · ปิดอัตโนมัติ ${json.resolved} · ค้าง ${json.openCount} · Discord ${json.dispatched?.discord ? '✓' : '—'} · Email ${json.dispatched?.email ? '✓' : '—'}`,
      )
      await load()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setScanning(false)
    }
  }

  const rows = reminders || []

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-8">
      <div className="mb-4 flex items-center justify-between gap-2 flex-wrap">
        <div>
          <BackButton fallback="/admin/production-space" label="Admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700" />
          <h1 className="text-xl sm:text-2xl font-normal text-gray-800 mt-1">⏰ Reminders</h1>
          <p className="text-xs sm:text-sm text-gray-500">
            งานค้างที่ระบบเตือนให้ — กด Dismiss เพื่อปิดเสียง, Resolve เมื่อทำเสร็จ
          </p>
        </div>
        <button
          onClick={runScan}
          disabled={scanning}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-amber-500 text-amber-700 rounded hover:bg-amber-500 hover:text-white transition-colors disabled:opacity-50"
        >
          {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Run scan now
        </button>
      </div>

      <div className="flex items-center gap-2 mb-3 text-sm">
        <button
          onClick={() => setFilter('open')}
          className={`px-2.5 py-1 rounded border ${filter === 'open' ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-300 hover:bg-gray-50'}`}
        >
          Open
        </button>
        <button
          onClick={() => setFilter('all')}
          className={`px-2.5 py-1 rounded border ${filter === 'all' ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-300 hover:bg-gray-50'}`}
        >
          All
        </button>
      </div>

      {scanMsg && <div className="mb-3 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">{scanMsg}</div>}
      {error && (
        <div className="mb-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {reminders === null ? (
        <div className="py-12 text-center text-gray-400"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
      ) : rows.length === 0 ? (
        <div className="py-12 text-center text-gray-400 text-sm">ไม่มีรายการค้าง 🎉</div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const isOpen = r.status === 'PENDING' || r.status === 'SENT'
            return (
              <li
                key={r.id}
                className={`border rounded px-3 py-2.5 flex items-start justify-between gap-3 ${isOpen ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-70'}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 whitespace-nowrap">
                      {TYPE_LABEL[r.type] || r.type}
                    </span>
                    {!isOpen && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500">{r.status}</span>
                    )}
                  </div>
                  <div className="text-sm text-gray-800 mt-1">{r.title}</div>
                  {r.body && <div className="text-xs text-gray-500 whitespace-pre-line">{r.body}</div>}
                </div>
                {isOpen && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => update(r.id, 'RESOLVED')}
                      disabled={busy === r.id}
                      title="ทำเสร็จแล้ว"
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-green-300 text-green-700 rounded hover:bg-green-50 disabled:opacity-50"
                    >
                      <Check className="w-3.5 h-3.5" /> Resolve
                    </button>
                    <button
                      onClick={() => update(r.id, 'DISMISSED')}
                      disabled={busy === r.id}
                      title="ปิดเสียง"
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 text-gray-600 rounded hover:bg-gray-50 disabled:opacity-50"
                    >
                      <BellOff className="w-3.5 h-3.5" /> Dismiss
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
