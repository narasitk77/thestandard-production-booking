// v1.212 — WHAT MAY LEAVE FOR LARK, and in what shape.
//
// Kept as a pure module (no prisma, no fetch) for one reason: this file is the
// privacy boundary of the export, and a boundary you cannot unit-test is a
// boundary you are only hoping about. Everything here is a plain function over
// plain data; src/lib/lark-export.ts does the I/O.
//
// ─── WHY AN EXPORT AT ALL ────────────────────────────────────────────────────
// The nightly pg_dump (v1.77, src/lib/backup.ts) already protects the database
// against loss — but it prunes itself at BACKUP_RETENTION_DAYS (30), and a
// .sql.gz is a recovery artefact, not something anyone can look back through.
// Meanwhile the app really does delete rows on a schedule:
//
//   • audit_logs   — everything older than 90 days, on EVERY container boot
//                    (start.sh) and from /api/audit/purge
//   • ot_records   — everything older than the 10-day archive window, lazily on
//                    every GET /api/ot (src/lib/ot-cleanup.ts)
//   • ot_records   — deleteMany + recreate on each booking edit (ot-sync.ts)
//   • bookings     — an admin delete takes that booking's audit_logs,
//                    footage_log and ot_records with it (api/admin/[id]/delete)
//
// A 30-day-pruned dump means a row deleted 31 days ago is gone from every copy
// we hold. This export is the durable side: one immutable snapshot per day that
// nothing in this codebase ever prunes.
//
// ─── THE THREE TIERS ─────────────────────────────────────────────────────────
// Lark visibility is a SHARING SETTING, not our code. Anything that reaches a
// Lark Base or a Lark Drive folder is readable by whoever that folder is shared
// with, forever, and we cannot revoke what someone has already seen. So the
// classification is deliberately conservative and lives in one place.

/**
 * Tier 1 — NEVER. Not env-overridable on purpose: turning these on has to be a
 * code change somebody makes on purpose, in a diff a reviewer can see.
 *
 *   shoot_reviews         The anonymous cross-team ratings. src/lib/review-access.ts
 *                         restricts these to three named readers and the form
 *                         TELLS staff so. Copying them into a Lark Base would
 *                         move that promise from enforced code to a sharing
 *                         checkbox — i.e. break it — and the people who were
 *                         promised would never know.
 *   shoot_review_invites  Carries `token`, the bearer credential in the emailed
 *                         review link. Anyone holding it can submit as that
 *                         person. Credentials do not go in archives.
 */
export const NEVER_EXPORT: readonly string[] = [
  'shoot_reviews',
  'shoot_review_invites',
] as const

/**
 * Tier 2 — OFF BY DEFAULT, opt back in with LARK_EXPORT_INCLUDE.
 *
 *   users              86 rows of the staff directory + roles.
 *   ot_records         Compensation data. Ironically the table with the most
 *                      aggressive delete policy in the system — so if these are
 *                      ever wanted in the archive, that is a real argument. It
 *                      stays a deliberate opt-in rather than a default.
 *   page_events        Who opened which page and when. Individual browsing
 *                      behaviour; near-zero archival value (nothing deletes it)
 *                      and a meaningful downside if the Base is shared widely.
 *   feedback_tickets   Named colleagues complaining about the system, written
 *   feedback_messages  to an admin console — not to a room.
 *
 * Operator decision 2026-08-31 (Narasit): none of these go to Lark. The pg_dump
 * on Google Drive keeps covering them.
 */
export const SENSITIVE_DEFAULT_OFF: readonly string[] = [
  'users',
  'ot_records',
  'page_events',
  'feedback_tickets',
  'feedback_messages',
] as const

/** Postgres bookkeeping that is not our data. */
export const INFRASTRUCTURE_TABLES: readonly string[] = [
  '_prisma_migrations',
  'lark_export_runs', // our own bookkeeping — exporting it would be a hall of mirrors
] as const

/**
 * Field-level safety net, applied to EVERY exported table.
 *
 * Tier 1 already removes the one table that holds a credential today; this
 * exists so a column added next year called `webhookSecret` does not silently
 * ride along into a shared folder. Matches whole segments only, so `driveFileId`
 * / `boxFolderId` / `externalKey` (identifiers we WANT) are untouched.
 *
 * `account` / `iban` / `swift` were added 2026-09-01 after a review found a real
 * leak waiting to happen: `Vendor.bankAccount` (prisma/schema.prisma, model
 * Vendor) holds supplier bank account numbers, and `vendors` is in NEITHER
 * Tier 1 nor Tier 2 — so classifyTables() returns
 * `{ included: true, reason: 'exported' }` for it. Without this line, the FIRST
 * night anyone sets LARK_EXPORT_ENABLED=1 publishes every supplier's bank
 * account into a Lark folder/Base whose audience is a SHARING CHECKBOX, not
 * code — and you cannot un-see what has already been shared.
 *
 * The fix is at field level rather than dropping the whole `vendors` table,
 * because vendor names/contacts are exactly the sort of thing the archive is
 * for; it is the one column that must not travel.
 */
// 2026-09-01 — TWO patterns, because the words behave differently.
//
// The earlier single pattern was anchored to the END of the name (`…s?$`), with
// a note saying not to loosen it or `driveFileId` / `externalKey` would be
// caught. Half of that is wrong and half is right, so this splits the rule:
//
//   • WRONG: the anchor is not what protects `driveFileId` / `externalKey` —
//     the WORD LIST is. Neither name contains token/secret/account/… as a
//     segment at all, at either end. Checked against all 303 columns currently
//     in the exported tables.
//   • RIGHT: `account` genuinely is ambiguous. `accountManager` means a person,
//     not a bank account, and a blanket loosening would silently start dropping
//     it (and `accountName`, `accountOwner`) from the archive.
//
// So the unambiguous secrets match as ANY segment — a future `passwordHash`,
// `secretKey`, `tokenValue` or `swiftCode` is caught, which the old anchor
// missed — while `account` matches only where it really means bank details:
// as the final segment (`bankAccount`) or followed by a number word
// (`accountNumber`, `bankAccountNumber`).
//
// Net effect on today's data: identical. Both the old pattern and this one drop
// exactly one real column, `vendors.bankAccount`. This only widens the net for
// columns that do not exist yet — which is the entire job of a safety net.
const SECRET_FIELD_RE = /(^|_)(token|secret|password|passwd|apikey|api_key|credential|iban|swift)s?(_|$)/i
const BANK_ACCOUNT_RE = /(^|_)accounts?(_(number|numbers|no|num|id))?$/i

export function isSecretFieldName(name: string): boolean {
  // camelCase → snake so `webhookSecret` and `webhook_secret` behave the same.
  const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  return SECRET_FIELD_RE.test(snake) || BANK_ACCOUNT_RE.test(snake)
}

export type TableDecision = {
  table: string
  included: boolean
  /** Why, in one phrase — surfaced by /api/internal/lark-export/preflight. */
  reason: 'exported' | 'never' | 'sensitive-default-off' | 'infrastructure' | 'opted-in' | 'not-in-allowlist'
}

function parseList(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Decide, for every table present in the database, whether it is exported.
 *
 * @param allTables   table names as enumerated from information_schema
 * @param env         LARK_EXPORT_INCLUDE / LARK_EXPORT_EXCLUDE
 *
 * Precedence, most binding first:
 *   1. NEVER_EXPORT           — nothing can turn these on
 *   2. LARK_EXPORT_EXCLUDE    — the operator's kill switch, always obeyed
 *   3. infrastructure         — never interesting
 *   4. LARK_EXPORT_INCLUDE    — opts a tier-2 table back in
 *   5. SENSITIVE_DEFAULT_OFF  — off unless opted in above
 *   6. everything else        — exported
 */
export function classifyTables(
  allTables: readonly string[],
  env: { include?: string; exclude?: string } = {},
): TableDecision[] {
  const include = new Set(parseList(env.include))
  const exclude = new Set(parseList(env.exclude))
  const never = new Set(NEVER_EXPORT)
  const infra = new Set(INFRASTRUCTURE_TABLES)
  const sensitive = new Set(SENSITIVE_DEFAULT_OFF)

  return [...allTables]
    .map((t) => t.toLowerCase())
    .sort()
    .map((table): TableDecision => {
      if (never.has(table)) return { table, included: false, reason: 'never' }
      if (exclude.has(table)) return { table, included: false, reason: 'not-in-allowlist' }
      if (infra.has(table)) return { table, included: false, reason: 'infrastructure' }
      if (sensitive.has(table)) {
        return include.has(table)
          ? { table, included: true, reason: 'opted-in' }
          : { table, included: false, reason: 'sensitive-default-off' }
      }
      return { table, included: true, reason: 'exported' }
    })
}

/** Strip credential-shaped columns from one row. Returns a new object. */
export function redactRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (isSecretFieldName(k)) continue
    out[k] = v
  }
  return out
}

/* ─────────────────────── serialisation for the archive ─────────────────────── */

/**
 * JSON-safe view of one raw-query value.
 *
 * `$queryRaw` hands back real Date objects, BigInt for int8 columns, Buffer for
 * bytea and Prisma.Decimal for numeric. `JSON.stringify` throws on BigInt and
 * flattens the rest into something you cannot read back, so normalise here —
 * the archive has to survive being opened years from now by something that is
 * not this codebase.
 */
export function toJsonValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'bigint') return v.toString()
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return `base64:${v.toString('base64')}`
  if (Array.isArray(v)) return v.map(toJsonValue)
  if (typeof v === 'object') {
    // Prisma.Decimal and anything else with a sane toString
    const proto = Object.getPrototypeOf(v)
    if (proto && proto.constructor && proto.constructor.name === 'Decimal') return String(v)
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = toJsonValue(val)
    return out
  }
  return v
}

export function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  return toJsonValue(redactRow(row)) as Record<string, unknown>
}

/* ──────────────────────── keys, labels and tombstones ──────────────────────── */

/**
 * A short human phrase identifying a row, so a tombstone reads
 * "AGN-260630-01 · รายการ X" instead of a bare cuid nobody can act on.
 *
 * Deliberately generic (first hit wins) rather than per-table: a per-table map
 * would need editing every time a model is added, and the day it falls out of
 * date is the day a tombstone becomes unreadable.
 */
const LABEL_FIELDS = [
  'bookingCode', 'booking_code', 'productionId', 'production_id',
  'episodeCode', 'episode_code', 'code', 'name', 'title', 'jobName', 'job_name',
  'subject', 'fileName', 'file_name', 'action', 'label', 'email', 'key',
]

export function rowLabel(row: Record<string, unknown>): string {
  const parts: string[] = []
  for (const f of LABEL_FIELDS) {
    const v = row[f]
    if (typeof v === 'string' && v.trim()) {
      parts.push(v.trim())
      if (parts.length === 2) break
    }
  }
  return parts.join(' · ').slice(0, 200)
}

export type KeyIndex = Record<string, Record<string, string>>

/**
 * Stable identity string for a row.
 *
 * Takes an ARRAY of key columns rather than one: this export is driven by
 * information_schema, not by the Prisma models, so it has to keep working if a
 * composite primary key ever appears. `␟` (␟, unit separator) cannot occur
 * in a cuid, an email or a Production ID, so joining on it cannot collide.
 */
export function rowKey(row: Record<string, unknown>, keyColumns: readonly string[]): string | null {
  if (keyColumns.length === 0) return null
  const parts: string[] = []
  for (const c of keyColumns) {
    const v = row[c]
    if (v === null || v === undefined) return null
    parts.push(String(v))
  }
  return parts.join('␟')
}

/** Build { table: { primaryKey: label } } — the diff basis for the next run. */
export function buildKeyIndex(
  tables: Record<string, Record<string, unknown>[]>,
  pkOf: (table: string) => readonly string[],
): KeyIndex {
  const idx: KeyIndex = {}
  for (const [table, rows] of Object.entries(tables)) {
    const cols = pkOf(table)
    const m: Record<string, string> = {}
    for (const row of rows) {
      const key = rowKey(row, cols)
      if (key === null) continue
      m[key] = rowLabel(row)
    }
    idx[table] = m
  }
  return idx
}

export type Tombstone = {
  table: string
  key: string
  label: string
  /** Snapshot file that still holds the full row. */
  lastSeenIn: string
  /** ISO timestamp of the run that noticed it gone. */
  vanishedAt: string
}

/**
 * Rows present in the previous run and absent from this one.
 *
 * This — not the Base mirror — is the answer to "what got deleted". The mirror
 * is current state by construction: a row deleted yesterday simply is not in
 * it, and its absence is invisible. A tombstone is the row's absence made into
 * a record, pointing at the archive file that still has the full contents.
 *
 * A table that vanishes entirely (dropped, renamed, or excluded by a config
 * change) is NOT tombstoned row-by-row — that would file thousands of false
 * deletions the first time someone edits LARK_EXPORT_EXCLUDE. Those surface as
 * `droppedTables` instead, which is a config event, not a data event.
 */
export function diffTombstones(
  previous: KeyIndex | null,
  current: KeyIndex,
  opts: { lastSeenIn: string; vanishedAt: string; maxPerTable?: number },
): { tombstones: Tombstone[]; droppedTables: string[]; truncated: Record<string, number> } {
  if (!previous) return { tombstones: [], droppedTables: [], truncated: {} }
  const max = opts.maxPerTable ?? 500
  const tombstones: Tombstone[] = []
  const droppedTables: string[] = []
  const truncated: Record<string, number> = {}

  for (const [table, prevRows] of Object.entries(previous)) {
    const curr = current[table]
    if (!curr) {
      droppedTables.push(table)
      continue
    }
    const gone = Object.keys(prevRows).filter((k) => !(k in curr))
    if (gone.length === 0) continue
    if (gone.length > max) truncated[table] = gone.length - max
    for (const key of gone.slice(0, max)) {
      tombstones.push({
        table,
        key,
        label: prevRows[key] || '',
        lastSeenIn: opts.lastSeenIn,
        vanishedAt: opts.vanishedAt,
      })
    }
  }
  return { tombstones, droppedTables, truncated }
}

/* ───────────────────────────── snapshot naming ─────────────────────────────── */

/** `probook-2026-08-31.json.gz` — one per Bangkok day, sorts chronologically. */
export function snapshotFileName(bangkokDate: string): string {
  return `probook-${bangkokDate}.json.gz`
}
