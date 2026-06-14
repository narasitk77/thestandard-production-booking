// v1.55.0 — Workspace column registry.
//
// Single source of truth for the admin Workspace table + its CSV export, so
// the columns a user sees on screen and the columns they export never drift.
// Each column has a stable `key`, a display `label`, a `group` (for the
// column-picker UI), and a pure `value(booking)` accessor that returns the
// CSV / cell string. Special on-screen rendering (status pill, links) lives
// in the page; everything funnels through `value()` for text + export.

import { normalizeFreelancers } from './freelancers'
import { statusLabel, shootTypeLabel, categoryLabel } from './utils'

// Loosely typed: the same accessor runs over a Prisma row (Date objects,
// server export) and the JSON the client fetched (ISO strings). Date helpers
// coerce both.
export interface WorkspaceBooking {
  id: string
  bookingCode?: string | null
  shootDate?: string | Date | null
  shootEndDate?: string | Date | null
  callTime?: string | null
  estimatedWrap?: string | null
  status?: string | null
  category?: string | null
  videoType?: string | null
  shootType?: string | null
  locationName?: string | null
  producer?: string | null
  producerEmail?: string | null
  producerPhone?: string | null
  director?: string | null
  directorEmail?: string | null
  creative?: string[] | null
  crewRequired?: string[] | null
  videographerCount?: number | null
  cameraCount?: number | null
  micCount?: number | null
  needsVan?: boolean | null
  freelancers?: unknown
  assignedEmails?: string[] | null
  mainVideographerEmail?: string | null
  agencyRef?: string | null
  projectId?: string | null
  projectName?: string | null
  notes?: string | null
  adminNotes?: string | null
  calendarSyncStatus?: string | null
  calendarEventId?: string | null
  isRoutine?: boolean | null
  createdByEmail?: string | null
  createdAt?: string | Date | null
  approvedAt?: string | Date | null
  outlet?: { code?: string; name?: string } | null
  program?: { code?: string; name?: string } | null
  episodes?: Array<{ episodeId?: string; title?: string | null }> | null
}

function dateOnly(v: unknown): string {
  if (!v) return ''
  try {
    const d = new Date(v as string)
    if (isNaN(d.getTime())) return ''
    return d.toISOString().slice(0, 10)
  } catch {
    return ''
  }
}

function dateTimeBkk(v: unknown): string {
  if (!v) return ''
  try {
    const d = new Date(v as string)
    if (isNaN(d.getTime())) return ''
    // yyyy-mm-dd HH:mm in Bangkok — stable, sortable, Excel-friendly
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d)
    const get = (t: string) => parts.find(p => p.type === t)?.value || ''
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
  } catch {
    return ''
  }
}

function freelancerList(b: WorkspaceBooking): ReturnType<typeof normalizeFreelancers> {
  return normalizeFreelancers(b.freelancers)
}

export type ColumnGroup = 'Core' | 'Show' | 'People' | 'Crew & Gear' | 'Meta'

export interface WorkspaceColumn {
  key: string
  label: string
  group: ColumnGroup
  /** Plain-text value for cell display + CSV. */
  value: (b: WorkspaceBooking) => string
  /** Numeric sort hint — when set, the table sorts on this instead of `value`. */
  num?: (b: WorkspaceBooking) => number
  /** Default-visible in the on-screen table. */
  defaultVisible?: boolean
  /** Right-align (numbers). */
  align?: 'right'
}

export const WORKSPACE_COLUMNS: WorkspaceColumn[] = [
  // ── Core ──────────────────────────────────────────────────────────
  { key: 'code', label: 'Production ID', group: 'Core', defaultVisible: true,
    value: b => b.bookingCode || b.id },
  { key: 'status', label: 'Status', group: 'Core', defaultVisible: true,
    value: b => statusLabel(b.status || '') },
  { key: 'isRoutine', label: 'Routine', group: 'Core',
    value: b => b.isRoutine ? 'Routine' : '' },
  { key: 'shootDate', label: 'Shoot Date', group: 'Core', defaultVisible: true,
    value: b => dateOnly(b.shootDate),
    num: b => { const d = new Date(b.shootDate as string); return isNaN(d.getTime()) ? 0 : d.getTime() } },
  { key: 'shootEndDate', label: 'Shoot End', group: 'Core',
    value: b => dateOnly(b.shootEndDate) },
  { key: 'callTime', label: 'Call Time', group: 'Core', defaultVisible: true,
    value: b => b.callTime || '' },
  { key: 'estimatedWrap', label: 'Wrap', group: 'Core',
    value: b => b.estimatedWrap || '' },

  // ── Show ──────────────────────────────────────────────────────────
  { key: 'outlet', label: 'Outlet', group: 'Show', defaultVisible: true,
    value: b => b.outlet?.code ? `${b.outlet.code} · ${b.outlet?.name || ''}`.trim() : (b.outlet?.name || '') },
  { key: 'program', label: 'Program', group: 'Show', defaultVisible: true,
    value: b => b.program?.name || '' },
  { key: 'videoType', label: 'Video Type', group: 'Show',
    value: b => b.videoType || '' },
  { key: 'shootType', label: 'Shoot Type', group: 'Show',
    value: b => shootTypeLabel(b.shootType || '') },
  { key: 'category', label: 'Category', group: 'Show',
    value: b => categoryLabel(b.category || '') },
  { key: 'projectId', label: 'Project ID', group: 'Show',
    value: b => b.projectId || '' },
  { key: 'projectName', label: 'Project Name', group: 'Show',
    value: b => b.projectName || '' },
  { key: 'episodes', label: 'Episode IDs', group: 'Show',
    value: b => (b.episodes || []).map(e => e.episodeId).filter(Boolean).join(', ') },

  // ── People ────────────────────────────────────────────────────────
  { key: 'producer', label: 'Producer', group: 'People', defaultVisible: true,
    value: b => b.producer || '' },
  { key: 'producerEmail', label: 'Producer Email', group: 'People',
    value: b => b.producerEmail || '' },
  { key: 'producerPhone', label: 'Producer Phone', group: 'People',
    value: b => b.producerPhone || '' },
  { key: 'director', label: 'Director', group: 'People',
    value: b => b.director || '' },
  { key: 'directorEmail', label: 'Director Email', group: 'People',
    value: b => b.directorEmail || '' },
  { key: 'creative', label: 'Creative / Host', group: 'People',
    value: b => (b.creative || []).join(', ') },
  { key: 'assignedEmails', label: 'Assigned Crew', group: 'People', defaultVisible: true,
    value: b => (b.assignedEmails || []).join(', ') },
  { key: 'mainVideographerEmail', label: 'Lead Camera', group: 'People',
    value: b => b.mainVideographerEmail || '' },

  // ── Crew & Gear ───────────────────────────────────────────────────
  { key: 'crewRequired', label: 'Crew Required', group: 'Crew & Gear', defaultVisible: true,
    value: b => (b.crewRequired || []).join(', ') },
  { key: 'videographerCount', label: 'Videographers', group: 'Crew & Gear', align: 'right',
    value: b => String(b.videographerCount ?? ''), num: b => b.videographerCount ?? 0 },
  { key: 'cameraCount', label: 'Cameras', group: 'Crew & Gear', align: 'right',
    value: b => b.cameraCount == null ? '' : String(b.cameraCount), num: b => b.cameraCount ?? 0 },
  { key: 'micCount', label: 'Mics', group: 'Crew & Gear', align: 'right',
    value: b => b.micCount == null ? '' : String(b.micCount), num: b => b.micCount ?? 0 },
  { key: 'needsVan', label: 'Van', group: 'Crew & Gear',
    value: b => b.needsVan ? 'Yes' : 'No' },
  { key: 'freelancerCount', label: 'Freelancers', group: 'Crew & Gear', defaultVisible: true, align: 'right',
    value: b => { const n = freelancerList(b).length; return n ? String(n) : '' },
    num: b => freelancerList(b).length },
  { key: 'freelancers', label: 'Freelancer Detail', group: 'Crew & Gear',
    value: b => freelancerList(b)
      .map(f => `${f.name}${f.contract ? ` (${f.contract})` : ''}${f.email ? ` <${f.email}>` : ''}`)
      .join(' | ') },

  // ── Meta ──────────────────────────────────────────────────────────
  { key: 'locationName', label: 'Location', group: 'Meta',
    value: b => b.locationName || '' },
  { key: 'agencyRef', label: 'Agency Ref', group: 'Meta',
    value: b => b.agencyRef || '' },
  { key: 'notes', label: 'Notes', group: 'Meta',
    value: b => b.notes || '' },
  { key: 'adminNotes', label: 'Admin Notes', group: 'Meta',
    value: b => b.adminNotes || '' },
  { key: 'calendarSyncStatus', label: 'Calendar Sync', group: 'Meta',
    value: b => b.calendarSyncStatus || '' },
  { key: 'calendarEventId', label: 'Calendar Event ID', group: 'Meta',
    value: b => b.calendarEventId || '' },
  { key: 'createdByEmail', label: 'Created By', group: 'Meta',
    value: b => b.createdByEmail || '' },
  { key: 'createdAt', label: 'Created At', group: 'Meta',
    value: b => dateTimeBkk(b.createdAt) },
  { key: 'approvedAt', label: 'Approved At', group: 'Meta',
    value: b => dateTimeBkk(b.approvedAt) },
]

export const WORKSPACE_COLUMN_MAP: Record<string, WorkspaceColumn> =
  Object.fromEntries(WORKSPACE_COLUMNS.map(c => [c.key, c]))

export const COLUMN_GROUP_ORDER: ColumnGroup[] = ['Core', 'Show', 'People', 'Crew & Gear', 'Meta']

export function hasFreelancers(b: WorkspaceBooking): boolean {
  return freelancerList(b).length > 0
}
