'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, RefreshCw, Loader2, CheckCircle2, AlertTriangle, AlertCircle, Trash2 } from 'lucide-react'

/* =============================================================================
   /admin/health — diagnostic dashboard
   Pulls /api/health and renders live config + check results.
   Primary use case: verify a sheet-swap deploy actually pointed the running
   container at the right Producer Dashboard sheet.
   ============================================================================= */

type CheckResult =
  | { ok: true; latencyMs: number; detail?: string }
  | { ok: false; latencyMs: number; error: string }

type HealthResponse = {
  ok: boolean
  checkedAt: string
  config: {
    nodeEnv: string
    version: string
    producerDashboardSheet: {
      id: string
      source: 'env' | 'hardcoded-fallback'
      isSandbox: boolean
      sandboxId: string
      bookingsTab: string
    }
    calendar: {
      id: string
      impersonateSubject: string
      impersonateSource: 'env' | 'hardcoded-fallback'
    }
    auth: {
      nextauthUrl: string
      nextauthSecretSet: boolean
      calendarReconcileSecretSet: boolean
    }
    email: {
      provider: string
      smtpHost: string
      smtpUserSet: boolean
      smtpPassSet: boolean
    }
  }
  checks: {
    db: CheckResult
    // v1.32.1 — keys renamed to expose the auth model. The same sheet
    // is checked twice (write-path + read-path) because production code
    // uses BOTH auth models for different operations.
    googleCalendarDwd: CheckResult
    producerDashboardSheetWrite: CheckResult
    producerDashboardSheetRead: CheckResult
  }
}

export default function HealthPage() {
  const [data, setData] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>('')

  const fetch_ = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok && !json.config) throw new Error(json.error || `HTTP ${res.status}`)
      setData(json)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetch_() }, [])

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3">
        <ArrowLeft className="w-4 h-4" /> Admin Console
      </Link>

      <div className="flex items-start justify-between gap-2 mb-4 flex-wrap">
        <div>
          <h1>System Health</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Runtime config + live checks. Use after a deploy to verify
            production is pointed at the right sheets, DWD is alive, and
            DB/Calendar/Sheets API round-trips succeed.
          </p>
        </div>
        <button onClick={fetch_} disabled={loading} className="ops-btn-secondary ops-btn-sm">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Re-check
        </button>
      </div>

      {error && (
        <div className="ops-card p-3 mb-3 text-sm text-red-700 bg-red-50 border-red-200 border-l-4 border-l-red-500">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Top-line status */}
          <div className={`ops-card ops-card-pad mb-3 ${data.ok ? '' : 'border-red-200'}`}>
            <div className="flex items-center gap-3">
              {data.ok ? (
                <CheckCircle2 className="w-8 h-8 text-emerald-500 flex-shrink-0" />
              ) : (
                <AlertTriangle className="w-8 h-8 text-red-500 flex-shrink-0" />
              )}
              <div>
                <div className={`text-base font-semibold ${data.ok ? 'text-emerald-700' : 'text-red-700'}`}>
                  {data.ok ? 'All systems operational' : 'One or more checks failed'}
                </div>
                <div className="text-xs text-gray-500">
                  Checked {new Date(data.checkedAt).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' })} BKK
                  {' · '}v{data.config.version}{' · '}NODE_ENV={data.config.nodeEnv}
                </div>
              </div>
            </div>

            {/* Sandbox warning */}
            {data.config.producerDashboardSheet.isSandbox && (
              <div className="mt-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>
                  This deploy is pointed at the <strong>SANDBOX</strong> Producer Dashboard sheet
                  ({data.config.producerDashboardSheet.sandboxId}). To switch to production,
                  set <code className="px-1 bg-amber-100 rounded">PRODUCER_DASHBOARD_SHEET_ID</code> in
                  the Portainer stack env and redeploy.
                </span>
              </div>
            )}
          </div>

          {/* Live checks */}
          <Section title="Live checks">
            {/* v1.32.1 — two distinct Google auth models in this app:
                calendar uses DWD impersonate, sheets uses the service
                account directly. Surfacing them separately so a green
                row means production code's matching path actually works. */}
            <div className="px-4 py-2 text-[11px] text-gray-500 border-b border-gray-100 bg-gray-50/60">
              Two Google auth models below: Calendar uses DWD impersonate
              (needed to invite attendees). Sheets use the service account
              directly (it's shared with the sheet as Editor).
            </div>
            <CheckRow name="Database (Postgres)" result={data.checks.db} />
            <CheckRow
              name="Google Calendar — full scope · DWD impersonate"
              result={data.checks.googleCalendarDwd}
            />
            <CheckRow
              name="Producer Dashboard sheet — writes (full scope · service-account direct)"
              result={data.checks.producerDashboardSheetWrite}
            />
            <CheckRow
              name="Producer Dashboard sheet — reads (readonly scope · service-account direct)"
              result={data.checks.producerDashboardSheetRead}
            />
          </Section>

          {/* Config */}
          <Section title="Producer Dashboard sheet">
            <KV k="Sheet ID" v={<code className="text-xs">{data.config.producerDashboardSheet.id}</code>} />
            <KV k="Source" v={<SourceBadge source={data.config.producerDashboardSheet.source} />} />
            <KV k="Bookings tab" v={data.config.producerDashboardSheet.bookingsTab} />
            <KV k="Mode" v={data.config.producerDashboardSheet.isSandbox
              ? <span className="text-amber-700">⚠ SANDBOX</span>
              : <span className="text-emerald-700">✓ Production</span>} />
          </Section>

          <Section title="Google Calendar">
            <KV k="Calendar ID" v={<code className="text-xs">{data.config.calendar.id}</code>} />
            <KV k="Impersonate subject" v={data.config.calendar.impersonateSubject} />
            <KV k="Source" v={<SourceBadge source={data.config.calendar.impersonateSource} />} />
            {/* v1.32.4 — explicit warning when DWD impersonate falls back to the
                hardcoded narasit.k@thestandard.co default. The fallback exists
                for resilience (Portainer dropped the env var in v1.29.4 — that
                bug shipped to production) but it creates a single-person
                dependency. Surface it visibly so a future admin knows to
                set the env var before the current impersonate user leaves. */}
            {data.config.calendar.impersonateSource === 'hardcoded-fallback' && (
              <div className="px-4 py-3 bg-amber-50 border-t border-amber-200 text-xs text-amber-800">
                <strong>⚠ Using built-in fallback for the impersonate subject.</strong>{' '}
                If <code className="px-1 bg-amber-100 rounded">{data.config.calendar.impersonateSubject}</code>{' '}
                leaves the company or loses Workspace access, calendar invites
                will break. To swap: set{' '}
                <code className="px-1 bg-amber-100 rounded">GOOGLE_IMPERSONATE_SUBJECT</code>{' '}
                in the Portainer stack env to a different Workspace user (with
                Editor access to the shared calendar) and redeploy.{' '}
                See <code className="px-1 bg-amber-100 rounded">docs/runbook-impersonate-swap.md</code>.
              </div>
            )}
          </Section>

          <Section title="Auth">
            <KV k="NEXTAUTH_URL" v={data.config.auth.nextauthUrl} />
            <KV k="NEXTAUTH_SECRET" v={<SetBadge set={data.config.auth.nextauthSecretSet} />} />
            <KV k="Reconcile worker secret" v={<SetBadge set={data.config.auth.calendarReconcileSecretSet} />} />
          </Section>

          <Section title="Email">
            <KV k="Provider" v={data.config.email.provider} />
            <KV k="SMTP host" v={data.config.email.smtpHost} />
            <KV k="SMTP user" v={<SetBadge set={data.config.email.smtpUserSet} />} />
            <KV k="SMTP pass" v={<SetBadge set={data.config.email.smtpPassSet} />} />
          </Section>
        </>
      )}

      {/* Danger Zone */}
      <DangerZone />
    </div>
  )
}

/* ---------- Danger Zone ---------- */

type PurgeCounts = { bookings: number; episodes: number; auditLogs: number; uploads: number; footageLogs: number }

function DangerZone() {
  const [counts, setCounts] = useState<PurgeCounts | null>(null)
  const [loadingCounts, setLoadingCounts] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [purging, setPurging] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  function loadCounts() {
    setLoadingCounts(true)
    fetch('/api/admin/purge-bookings')
      .then(r => r.json())
      .then(d => setCounts(d))
      .finally(() => setLoadingCounts(false))
  }

  async function handlePurge() {
    if (confirm !== 'DELETE ALL') return
    setPurging(true)
    setResult(null)
    try {
      const res = await fetch('/api/admin/purge-bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      })
      const d = await res.json()
      if (d.ok) {
        setResult({ ok: true, msg: `ลบแล้ว: ${d.deleted.bookingCount} bookings · ${d.deleted.episodeCount} episodes · ${d.deleted.auditCount} audit logs · ${d.deleted.uploadCount} uploads · ${d.deleted.footageCount} footage logs` })
        setCounts(null)
        setConfirm('')
      } else {
        setResult({ ok: false, msg: d.error || 'Unknown error' })
      }
    } catch (e) {
      setResult({ ok: false, msg: String(e) })
    } finally {
      setPurging(false)
    }
  }

  const ready = confirm === 'DELETE ALL'

  return (
    <div className="mt-6 border border-red-200 rounded-xl overflow-hidden">
      <div className="px-4 py-2 bg-red-50 border-b border-red-200 flex items-center gap-2">
        <Trash2 className="w-4 h-4 text-red-600" />
        <span className="text-sm font-semibold text-red-800">Danger Zone</span>
      </div>

      <div className="px-4 py-4 bg-white">
        <div className="text-sm font-medium text-gray-800 mb-1">Purge all bookings</div>
        <p className="text-xs text-gray-500 mb-4">
          ลบ Booking + Episode + Audit Log + Upload + Footage Log ทั้งหมดออกจาก DB ถาวร · ใช้สำหรับล้างข้อมูลทดสอบก่อนใช้งานจริง
        </p>

        {/* Step 1 — Export CSV first */}
        <div className="flex items-center gap-3 mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200 text-xs text-gray-600">
          <span className="font-mono bg-gray-200 text-gray-700 w-5 h-5 rounded-full flex items-center justify-center text-[10px] flex-shrink-0">1</span>
          <span>Export CSV ก่อนเป็น backup —</span>
          <Link href="/dashboard" className="text-brand-primary hover:underline font-medium">
            ไปหน้า Dashboard → Export Bookings
          </Link>
        </div>

        {/* Step 2 — Load counts */}
        <div className="flex items-start gap-3 mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200 text-xs text-gray-600">
          <span className="font-mono bg-gray-200 text-gray-700 w-5 h-5 rounded-full flex items-center justify-center text-[10px] flex-shrink-0 mt-0.5">2</span>
          <div className="flex-1">
            <div className="mb-2">ตรวจสอบจำนวน records ที่จะถูกลบ</div>
            {counts ? (
              <div className="flex flex-wrap gap-3 text-gray-700">
                <span><strong>{counts.bookings}</strong> bookings</span>
                <span><strong>{counts.episodes}</strong> episodes</span>
                <span><strong>{counts.auditLogs}</strong> audit logs</span>
                <span><strong>{counts.uploads}</strong> uploads</span>
                <span><strong>{counts.footageLogs}</strong> footage logs</span>
              </div>
            ) : (
              <button onClick={loadCounts} disabled={loadingCounts}
                className="ops-btn-secondary ops-btn-sm">
                {loadingCounts ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                Load counts
              </button>
            )}
          </div>
        </div>

        {/* Step 3 — Type to confirm */}
        <div className="flex items-start gap-3 mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200 text-xs text-gray-600">
          <span className="font-mono bg-gray-200 text-gray-700 w-5 h-5 rounded-full flex items-center justify-center text-[10px] flex-shrink-0 mt-0.5">3</span>
          <div className="flex-1">
            <div className="mb-2">พิมพ์ <code className="bg-red-100 text-red-700 px-1 rounded">DELETE ALL</code> เพื่อยืนยัน</div>
            <input
              type="text"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="DELETE ALL"
              className="ops-input text-xs w-48 font-mono"
            />
          </div>
        </div>

        {/* Result message */}
        {result && (
          <div className={`mb-3 px-3 py-2 rounded-lg text-xs flex items-start gap-2 ${result.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
            {result.ok
              ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
            {result.msg}
          </div>
        )}

        {/* Purge button */}
        <button
          onClick={handlePurge}
          disabled={!ready || purging}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            ready && !purging
              ? 'bg-red-600 text-white hover:bg-red-700'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
          }`}
        >
          {purging ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          {purging ? 'กำลังลบ…' : 'Purge All Bookings'}
        </button>
      </div>
    </div>
  )
}

/* ---------- presentational helpers ---------- */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ops-card overflow-hidden mb-3">
      <div className="px-4 py-2 border-b border-gray-100 bg-gray-50">
        <div className="ops-section-title">{title}</div>
      </div>
      <div className="divide-y divide-gray-100">{children}</div>
    </div>
  )
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-3 px-4 py-2 text-sm">
      <div className="text-xs text-gray-500 uppercase tracking-wide pt-0.5">{k}</div>
      <div className="text-gray-800 break-words">{v}</div>
    </div>
  )
}

function CheckRow({ name, result }: { name: string; result: CheckResult }) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3 px-4 py-2 text-sm">
      <div>
        <div className="flex items-center gap-2">
          {result.ok ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
          )}
          <span className="text-gray-800">{name}</span>
          <span className="text-xs text-gray-400 tabular-nums">{result.latencyMs}ms</span>
        </div>
        {result.ok && result.detail && (
          <div className="text-xs text-gray-500 ml-6 mt-0.5">{result.detail}</div>
        )}
        {!result.ok && (
          <div className="text-xs text-red-700 ml-6 mt-0.5 break-words">{result.error}</div>
        )}
      </div>
    </div>
  )
}

function SourceBadge({ source }: { source: 'env' | 'hardcoded-fallback' }) {
  if (source === 'env') {
    return <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">env</span>
  }
  return <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">hardcoded fallback</span>
}

function SetBadge({ set }: { set: boolean }) {
  return set
    ? <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">set</span>
    : <span className="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">missing</span>
}
