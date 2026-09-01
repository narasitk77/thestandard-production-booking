// v1.212 — Postgres rows → Lark Base (Bitable) fields.
//
// Pure, so the awkward parts (type inference, truncation, the primary-field
// rule) are unit-testable without a Lark app. src/lib/lark-export.ts calls this
// and then hands the result to src/lib/lark-client.ts.
//
// DESIGN NOTE — why the Base is the CONVENIENCE and not the guarantee:
// a Bitable cell has a size limit, a table has a record limit, and a field has
// exactly one type. Every one of those can force a lossy write. The daily
// snapshot in Lark Drive is full-fidelity and is what the archive promise rests
// on; this mirror exists so a human can browse and filter without unzipping
// anything. Wherever the two disagree, the file is right — and every place this
// module loses something, it COUNTS it, so the run report can say so out loud
// instead of quietly looking complete.

import {
  LARK_FIELD_TEXT, LARK_FIELD_NUMBER, LARK_FIELD_DATETIME, LARK_FIELD_CHECKBOX,
} from './lark-client'

/** Bitable rejects an over-long cell outright; keep well inside the limit. */
export const MAX_CELL_CHARS = 8000

export type FieldDef = { field_name: string; type: number }

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function looksLikeIsoDate(v: unknown): v is string {
  return typeof v === 'string' && ISO_DATE_RE.test(v)
}

/**
 * Infer one column's Bitable type from the values actually present.
 *
 * Scans up to `sample` rows rather than trusting the first non-null: a column
 * that is null for the first 200 rows and a number afterwards would otherwise
 * be typed Text, and Lark would then refuse every numeric write for the rest of
 * the table's life (a field's type is fixed at creation).
 *
 * Mixed types collapse to Text. That is the safe direction — Text accepts
 * everything, a wrong specific type accepts nothing.
 */
export function inferFieldType(values: readonly unknown[], sample = 500): number {
  let seen: 'none' | 'number' | 'bool' | 'date' | 'text' = 'none'
  let checked = 0
  for (const v of values) {
    if (v === null || v === undefined) continue
    if (++checked > sample) break
    let kind: 'number' | 'bool' | 'date' | 'text'
    if (typeof v === 'number' && Number.isFinite(v)) kind = 'number'
    else if (typeof v === 'boolean') kind = 'bool'
    else if (looksLikeIsoDate(v)) kind = 'date'
    else kind = 'text'
    if (seen === 'none') seen = kind
    else if (seen !== kind) return LARK_FIELD_TEXT
  }
  switch (seen) {
    case 'number': return LARK_FIELD_NUMBER
    case 'bool': return LARK_FIELD_CHECKBOX
    case 'date': return LARK_FIELD_DATETIME
    default: return LARK_FIELD_TEXT
  }
}

/**
 * Field list for a table, primary key first.
 *
 * Bitable's FIRST field is the table's primary field: it cannot be empty, and
 * Lark restricts which types it may take. Putting the row's primary key there,
 * typed Text, sidesteps both — and makes the leftmost column of every mirrored
 * table the thing you would join on anyway.
 */
export function buildFieldDefs(
  rows: readonly Record<string, unknown>[],
  primaryKey: string,
): FieldDef[] {
  const columns = new Set<string>()
  for (const row of rows) for (const k of Object.keys(row)) columns.add(k)
  // A table with no rows yet still needs its key column, or the first write
  // after it fills up would have nowhere to land.
  columns.add(primaryKey)

  const ordered = [primaryKey, ...Array.from(columns).filter((c) => c !== primaryKey).sort()]
  return ordered.map((name) => ({
    field_name: name,
    type: name === primaryKey ? LARK_FIELD_TEXT : inferFieldType(rows.map((r) => r[name])),
  }))
}

export type CellResult = { value: unknown; truncated: boolean }

/** One value, shaped for the field type it is going into. */
export function toCell(value: unknown, type: number): CellResult {
  if (value === null || value === undefined) return { value: null, truncated: false }

  if (type === LARK_FIELD_NUMBER) {
    const n = typeof value === 'number' ? value : Number(value)
    return { value: Number.isFinite(n) ? n : null, truncated: false }
  }
  if (type === LARK_FIELD_CHECKBOX) {
    return { value: Boolean(value), truncated: false }
  }
  if (type === LARK_FIELD_DATETIME) {
    // Bitable takes epoch milliseconds, not an ISO string.
    const ms = typeof value === 'number' ? value : Date.parse(String(value))
    return { value: Number.isFinite(ms) ? ms : null, truncated: false }
  }

  // Text — everything else, including JSON columns (audit_logs.changes,
  // bookings.footageCache, switcher_jobs.links) which are exactly the fields
  // most likely to blow the cell limit.
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  if (s.length <= MAX_CELL_CHARS) return { value: s, truncated: false }
  return { value: `${s.slice(0, MAX_CELL_CHARS - 30)}…[ตัดที่ ${MAX_CELL_CHARS} ตัวอักษร]`, truncated: true }
}

export type MappedRecords = {
  records: Record<string, unknown>[]
  /** How many cells were shortened — reported, never swallowed. */
  truncatedCells: number
  /** Columns dropped because the existing Base table has no such field. */
  droppedColumns: string[]
}

/**
 * Map rows onto an EXISTING field set.
 *
 * Columns the Base table does not have are dropped and named in the result
 * rather than sent: Bitable rejects the whole batch for one unknown field, so
 * "send it and see" would turn a new DB column into a total mirror outage for
 * that table. The caller creates missing fields first and then re-maps.
 */
export function mapRecords(
  rows: readonly Record<string, unknown>[],
  fields: readonly { field_name: string; type: number }[],
): MappedRecords {
  const byName = new Map(fields.map((f) => [f.field_name, f.type]))
  const dropped = new Set<string>()
  let truncatedCells = 0

  const records = rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      const type = byName.get(k)
      if (type === undefined) { dropped.add(k); continue }
      const cell = toCell(v, type)
      if (cell.truncated) truncatedCells++
      // Bitable treats an absent key as "leave empty"; sending null for a
      // number/date field is an error on some field types, so omit instead.
      if (cell.value !== null) out[k] = cell.value
    }
    return out
  })

  return { records, truncatedCells, droppedColumns: Array.from(dropped).sort() }
}

/** Base table name for a Postgres table: `probook_bookings`. */
export function baseTableName(pgTable: string): string {
  return `probook_${pgTable}`
}

/** The append-only tombstone table — the one table that is never replaced. */
export const TOMBSTONE_TABLE_NAME = 'probook__deleted_rows'

export const TOMBSTONE_FIELDS: FieldDef[] = [
  { field_name: 'key', type: LARK_FIELD_TEXT },
  { field_name: 'table', type: LARK_FIELD_TEXT },
  { field_name: 'label', type: LARK_FIELD_TEXT },
  { field_name: 'vanishedAt', type: LARK_FIELD_DATETIME },
  { field_name: 'lastSeenIn', type: LARK_FIELD_TEXT },
]
