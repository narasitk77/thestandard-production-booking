// v1.212 — the daily export to Lark. Orchestration only; the decisions live in
// lark-export-policy.ts, the API in lark-client.ts, the field shapes in
// lark-base-mapping.ts.
//
// ONE RUN, IN ORDER:
//   1. enumerate every table from information_schema (NOT from the Prisma
//      models — a column added by a `db push` we forgot about still gets
//      archived, which is the whole point of an archive)
//   2. classify: what may leave for Lark at all
//   3. read the rows, redact credential-shaped columns, serialise
//   4. ARCHIVE  → one gzipped JSON per Bangkok day into a Lark Drive folder.
//                 Immutable. Nothing in this codebase ever prunes it.
//   5. TOMBSTONE → diff this run's keys against the previous run's; every row
//                 that disappeared becomes an append-only record in the Base,
//                 pointing at the snapshot file that still holds it
//   6. MIRROR   → replace-in-place copies of each table in a Lark Base, so
//                 people can browse and filter without unzipping anything
//
// Steps 4 and 6 are reported SEPARATELY and never collapsed into one boolean.
// The archive is the promise; the mirror is a convenience. A run where the file
// landed and the Base write failed is a good night with a broken nicety — and a
// run that says "ok" when the file did NOT land is the failure mode this
// codebase has been bitten by repeatedly (v1.186 · footage-ready). So:
// `archiveOk` and `mirrorOk`, always both.

import { gzipSync, gunzipSync } from 'zlib'
import { prisma } from './db'
import { todayBangkokStr } from './bangkok-day'
import {
  classifyTables, serializeRow, buildKeyIndex, diffTombstones, snapshotFileName,
  type KeyIndex, type TableDecision, type Tombstone,
} from './lark-export-policy'
import {
  larkAppConfigured, larkUploadFile, larkListTables, larkCreateTable, larkListFields,
  larkCreateField, larkListRecordIds, larkDeleteRecords, larkCreateRecords,
  larkTenantToken, larkBaseUrl, LarkError, resetLarkTokenCache,
} from './lark-client'
import {
  buildFieldDefs, mapRecords, baseTableName, TOMBSTONE_TABLE_NAME, TOMBSTONE_FIELDS,
} from './lark-base-mapping'

/* ─────────────────────────────── configuration ─────────────────────────────── */

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}
function envOn(v: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes(String(v || '').trim().toLowerCase())
}
function envOffOnly(v: string | undefined): boolean {
  return !['0', 'false', 'no'].includes(String(v || '').trim().toLowerCase())
}

export function larkExportEnabled(): boolean {
  return envOn(process.env.LARK_EXPORT_ENABLED)
}

/** Cap per mirrored Base table. The archive is never capped — only the mirror. */
function maxRowsPerBaseTable(): number {
  return envInt('LARK_BASE_MAX_ROWS_PER_TABLE', 5000)
}

/* ───────────────────────── reading the database generically ────────────────── */

export type TableMeta = { table: string; keyColumns: string[] }

/**
 * Every base table in the `public` schema, with its primary-key columns.
 *
 * Driven by the catalogue rather than the Prisma client on purpose: this is a
 * backup, and a backup that only knows about the models someone remembered to
 * add is not one.
 */
export async function listTableMeta(): Promise<TableMeta[]> {
  const rows = await prisma.$queryRaw<{ table_name: string; pk_column: string | null; ord: number | null }[]>`
    SELECT t.table_name::text                       AS table_name,
           a.attname::text                          AS pk_column,
           array_position(i.indkey::int2[], a.attnum) AS ord
    FROM information_schema.tables t
    LEFT JOIN pg_class      c ON c.relname = t.table_name
    LEFT JOIN pg_namespace  n ON n.oid = c.relnamespace AND n.nspname = 'public'
    LEFT JOIN pg_index      i ON i.indrelid = c.oid AND i.indisprimary
    LEFT JOIN pg_attribute  a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name, ord
  `
  const byTable = new Map<string, string[]>()
  for (const r of rows) {
    const list = byTable.get(r.table_name) ?? []
    if (r.pk_column && !list.includes(r.pk_column)) list.push(r.pk_column)
    byTable.set(r.table_name, list)
  }
  return Array.from(byTable.entries())
    .map(([table, keyColumns]) => ({ table, keyColumns }))
    .sort((a, b) => a.table.localeCompare(b.table))
}

/**
 * Read one whole table.
 *
 * `$queryRawUnsafe` with an interpolated identifier is normally where injection
 * lives; here the name can only ever be one that information_schema just handed
 * us, and it is re-checked against that list by the caller before we get here.
 * The extra regex is belt-and-braces so a future caller cannot pass a literal.
 */
async function readTable(table: string): Promise<Record<string, unknown>[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`refusing to read suspicious table name: ${table}`)
  return prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${table}"`)
}

/* ─────────────────────────────── previous run ──────────────────────────────── */

async function loadPreviousKeys(): Promise<{ keys: KeyIndex | null; fileName: string | null }> {
  const prev = await prisma.larkExportRun.findFirst({
    where: { ok: true, keysGz: { not: null } },
    orderBy: { at: 'desc' },
    select: { keysGz: true, fileName: true },
  })
  if (!prev?.keysGz) return { keys: null, fileName: null }
  try {
    return { keys: JSON.parse(gunzipSync(prev.keysGz).toString('utf8')) as KeyIndex, fileName: prev.fileName }
  } catch (e: any) {
    // A corrupt basis must not stop tonight's archive — it only costs us this
    // one night's tombstones, and saying so is better than failing the run.
    console.warn('[lark-export] previous key index unreadable, skipping tombstone diff:', e?.message || e)
    return { keys: null, fileName: null }
  }
}

/* ─────────────────────────────── the Base mirror ───────────────────────────── */

type MirrorTableResult = {
  written: number
  deleted: number
  truncatedCells: number
  /** Rows past LARK_BASE_MAX_ROWS_PER_TABLE. Reported, never silent. */
  skippedRows: number
  createdFields: string[]
  error?: string
}

/**
 * Replace one table's contents in the Base.
 *
 * REPLACE, not append: the mirror is a picture of current state, and a mirror
 * that only ever grows would double every day and hit Lark's per-table record
 * ceiling within a fortnight. What preserves deleted rows is the archive file
 * plus the tombstone table — not this.
 */
async function mirrorTable(
  appToken: string,
  pgTable: string,
  rows: Record<string, unknown>[],
  keyColumns: string[],
  existing: Map<string, string>,
): Promise<MirrorTableResult> {
  const result: MirrorTableResult = { written: 0, deleted: 0, truncatedCells: 0, skippedRows: 0, createdFields: [] }
  const cap = maxRowsPerBaseTable()
  let use = rows
  if (rows.length > cap) {
    // Keep the NEWEST rows when we have to choose — an operator looking things
    // up in the Base is almost always looking at recent work.
    const dateCol = ['createdAt', 'at', 'updatedAt', 'created_at'].find((c) => rows[0] && c in rows[0])
    use = dateCol
      ? [...rows].sort((a, b) => String(b[dateCol] ?? '').localeCompare(String(a[dateCol] ?? ''))).slice(0, cap)
      : rows.slice(0, cap)
    result.skippedRows = rows.length - cap
  }

  const name = baseTableName(pgTable)
  const primary = keyColumns[0] || 'id'
  let tableId = existing.get(name)

  if (!tableId) {
    tableId = await larkCreateTable(appToken, name, buildFieldDefs(use, primary))
    existing.set(name, tableId)
  }

  // Reconcile fields BEFORE mapping: Bitable rejects an entire batch for one
  // unknown field name, so a column added since the table was created would
  // otherwise take the whole table's mirror down rather than just itself.
  let fields = await larkListFields(appToken, tableId)
  const have = new Set(fields.map((f) => f.field_name))
  const wanted = buildFieldDefs(use, primary)
  for (const f of wanted) {
    if (have.has(f.field_name)) continue
    await larkCreateField(appToken, tableId, f)
    result.createdFields.push(f.field_name)
  }
  if (result.createdFields.length) fields = await larkListFields(appToken, tableId)

  const mapped = mapRecords(use, fields)
  result.truncatedCells = mapped.truncatedCells

  const oldIds = await larkListRecordIds(appToken, tableId)
  // Write first, then delete. If the run dies between the two the table holds
  // yesterday's rows AND today's — visibly odd, and recoverable next run. The
  // other order leaves an empty table, which reads as "there is no data".
  result.written = await larkCreateRecords(appToken, tableId, mapped.records)
  result.deleted = await larkDeleteRecords(appToken, tableId, oldIds)
  return result
}

async function appendTombstones(appToken: string, tombstones: Tombstone[], existing: Map<string, string>): Promise<number> {
  if (tombstones.length === 0) return 0
  let tableId = existing.get(TOMBSTONE_TABLE_NAME)
  if (!tableId) {
    tableId = await larkCreateTable(appToken, TOMBSTONE_TABLE_NAME, TOMBSTONE_FIELDS)
    existing.set(TOMBSTONE_TABLE_NAME, tableId)
  }
  const records = tombstones.map((t) => ({
    key: t.key,
    table: t.table,
    label: t.label,
    vanishedAt: Date.parse(t.vanishedAt),
    lastSeenIn: t.lastSeenIn,
  }))
  return larkCreateRecords(appToken, tableId, records)
}

/* ──────────────────────────────────── run ──────────────────────────────────── */

export type LarkExportResult = {
  ok: boolean
  day: string
  /** The archive — the promise. */
  archiveOk: boolean
  fileName: string | null
  fileToken: string | null
  sizeBytes: number
  /** The Base mirror — the convenience. Null when no Base is configured. */
  mirrorOk: boolean | null
  tables: TableDecision[]
  counts: Record<string, number>
  mirrored: Record<string, MirrorTableResult>
  vanished: number
  tombstones: Tombstone[]
  droppedTables: string[]
  tombstoneTruncated: Record<string, number>
  errors: string[]
  dryRun: boolean
}

export async function runLarkExport(opts: { dryRun?: boolean } = {}): Promise<LarkExportResult> {
  const dryRun = Boolean(opts.dryRun)
  const day = todayBangkokStr()
  const fileName = snapshotFileName(day)
  const errors: string[] = []

  const meta = await listTableMeta()
  const decisions = classifyTables(meta.map((m) => m.table), {
    include: process.env.LARK_EXPORT_INCLUDE,
    exclude: process.env.LARK_EXPORT_EXCLUDE,
  })
  const included = decisions.filter((d) => d.included).map((d) => d.table)
  const metaByTable = new Map(meta.map((m) => [m.table, m]))

  // ── 3. read + serialise ───────────────────────────────────────────────────
  const tables: Record<string, Record<string, unknown>[]> = {}
  const counts: Record<string, number> = {}
  for (const t of included) {
    try {
      const rows = await readTable(t)
      tables[t] = rows.map(serializeRow)
      counts[t] = rows.length
    } catch (e: any) {
      errors.push(`read ${t}: ${e?.message || e}`)
    }
  }

  const keys = buildKeyIndex(tables, (t) => metaByTable.get(t)?.keyColumns ?? ['id'])

  const snapshot = {
    meta: {
      source: 'thestandard-production-booking',
      generatedAt: new Date().toISOString(),
      bangkokDay: day,
      appVersion: process.env.npm_package_version || null,
      // Written into the file so a reader years later knows what is NOT here
      // and does not mistake the archive for the whole database.
      excludedTables: decisions.filter((d) => !d.included).map((d) => ({ table: d.table, reason: d.reason })),
      note: 'Rows are verbatim table dumps with credential-shaped columns removed. Excluded tables are listed above with the reason.',
    },
    counts,
    tables,
  }
  const gz = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'), { level: 9 })

  const result: LarkExportResult = {
    ok: false, day, archiveOk: false, fileName, fileToken: null, sizeBytes: gz.length,
    mirrorOk: null, tables: decisions, counts, mirrored: {}, vanished: 0,
    tombstones: [], droppedTables: [], tombstoneTruncated: {}, errors, dryRun,
  }

  // ── 5. tombstones (computed even on a dry run — it is read-only) ──────────
  const prev = await loadPreviousKeys()
  const diff = diffTombstones(prev.keys, keys, {
    lastSeenIn: prev.fileName || 'ไม่ทราบไฟล์',
    vanishedAt: new Date().toISOString(),
    maxPerTable: envInt('LARK_TOMBSTONE_MAX_PER_TABLE', 500),
  })
  result.tombstones = diff.tombstones
  result.droppedTables = diff.droppedTables
  result.tombstoneTruncated = diff.truncated
  result.vanished = diff.tombstones.length

  if (dryRun) {
    result.ok = errors.length === 0
    return result
  }

  // ── 4. archive → Lark Drive ───────────────────────────────────────────────
  const folderToken = process.env.LARK_DRIVE_FOLDER_TOKEN?.trim()
  if (!larkAppConfigured()) {
    errors.push('LARK_APP_ID / LARK_APP_SECRET not set — no Lark app, nothing can be written')
  } else if (!folderToken) {
    errors.push('LARK_DRIVE_FOLDER_TOKEN not set — the archive has nowhere to land')
  } else {
    try {
      const up = await larkUploadFile({ folderToken, fileName, content: gz })
      result.fileToken = up.fileToken
      result.archiveOk = true
    } catch (e: any) {
      errors.push(`archive upload: ${e?.message || e}`)
    }
  }

  // ── 6. mirror → Lark Base ─────────────────────────────────────────────────
  const appToken = process.env.LARK_BASE_APP_TOKEN?.trim()
  if (appToken && larkAppConfigured() && envOffOnly(process.env.LARK_MIRROR_ENABLED)) {
    result.mirrorOk = true
    try {
      const existing = new Map((await larkListTables(appToken)).map((t) => [t.name, t.table_id]))
      // Tombstones first: they are small, append-only, and the thing that is
      // actually irreplaceable if this run runs out of time.
      try {
        await appendTombstones(appToken, diff.tombstones, existing)
      } catch (e: any) {
        result.mirrorOk = false
        errors.push(`tombstones: ${e?.message || e}`)
      }
      for (const t of included) {
        if (!tables[t]) continue
        try {
          result.mirrored[t] = await mirrorTable(appToken, t, tables[t], metaByTable.get(t)?.keyColumns ?? ['id'], existing)
        } catch (e: any) {
          result.mirrorOk = false
          const msg = e instanceof LarkError ? `${e.message} [${e.endpoint}]` : String(e?.message || e)
          result.mirrored[t] = { written: 0, deleted: 0, truncatedCells: 0, skippedRows: 0, createdFields: [], error: msg }
          errors.push(`mirror ${t}: ${msg}`)
        }
      }
    } catch (e: any) {
      result.mirrorOk = false
      errors.push(`mirror setup: ${e?.message || e}`)
    }
  }

  // The run is OK when the ARCHIVE landed. A failed mirror is reported and
  // visible, but it does not make the night a loss — the file is the promise.
  result.ok = result.archiveOk

  // ── bookkeeping ───────────────────────────────────────────────────────────
  try {
    await prisma.larkExportRun.create({
      data: {
        at: new Date(), ok: result.ok, day, fileName,
        fileToken: result.fileToken, sizeBytes: gz.length,
        counts: counts as any, mirrored: result.mirrored as any,
        vanished: result.vanished,
        // Only store the diff basis when the archive landed: if the file is not
        // in Lark, next run's tombstones would point at a snapshot that does
        // not exist, and a tombstone you cannot follow is worse than none.
        keysGz: result.archiveOk ? gzipSync(Buffer.from(JSON.stringify(keys), 'utf8'), { level: 9 }) : null,
        error: errors.length ? errors.join(' | ').slice(0, 2000) : null,
      },
    })
    const keep = envInt('LARK_EXPORT_RUNS_KEPT', 60)
    const old = await prisma.larkExportRun.findMany({
      orderBy: { at: 'desc' }, skip: keep, select: { id: true },
    })
    if (old.length) await prisma.larkExportRun.deleteMany({ where: { id: { in: old.map((o) => o.id) } } })
  } catch (e: any) {
    errors.push(`bookkeeping: ${e?.message || e}`)
  }

  return result
}

/**
 * One-line summary for the heartbeat note. The ROUTE records the tick (house
 * convention, and the guard in heartbeat-specs.test.ts enforces it) — and it
 * ticks whether or not the archive landed, on purpose:
 *
 *   liveness = "the nightly pass ran"        → heartbeat / health-summary
 *   outcome  = "the file is actually in Lark" → larkExportStats().alerts
 *
 * Collapsing the two is the folder-integrity mistake in reverse: gate the tick
 * on success and a stack with a misconfigured Lark app pages someone about a
 * dead worker every six hours when the worker is fine and the config is not.
 */
export function heartbeatNote(r: LarkExportResult): string {
  return [
    `${r.fileName}`,
    `${Math.round(r.sizeBytes / 1024)}KB`,
    `archive=${r.archiveOk ? 'ok' : 'FAILED'}`,
    `mirror=${r.mirrorOk === null ? 'off' : r.mirrorOk ? 'ok' : 'FAILED'}`,
    `vanished=${r.vanished}`,
  ].join(' ')
}

/* ─────────────────────────────── stats + preflight ─────────────────────────── */

export type LarkExportStats = {
  enabled: boolean
  configured: { app: boolean; driveFolder: boolean; base: boolean }
  last: {
    at: string; day: string | null; ok: boolean; fileName: string | null
    fileToken: string | null; sizeBytes: number | null; vanished: number
    ageHours: number; error: string | null
  } | null
  runs7d: number
  failures7d: number
  vanished7d: number
  alerts: string[]
}

/**
 * Read-only health of the export, in the shape the nightly check consumes.
 *
 * Computes its OWN Thai alerts rather than handing over numbers for a reader to
 * interpret — the reader is a language model at midnight, and the lesson from
 * footage-ready is that whoever transforms the number is where the wrong
 * conclusion gets made.
 */
export async function larkExportStats(): Promise<LarkExportStats> {
  const enabled = larkExportEnabled()
  const configured = {
    app: larkAppConfigured(),
    driveFolder: Boolean(process.env.LARK_DRIVE_FOLDER_TOKEN?.trim()),
    base: Boolean(process.env.LARK_BASE_APP_TOKEN?.trim()),
  }
  const since = new Date(Date.now() - 7 * 86_400_000)
  const [lastRow, recent] = await Promise.all([
    prisma.larkExportRun.findFirst({ orderBy: { at: 'desc' } }),
    prisma.larkExportRun.findMany({ where: { at: { gte: since } }, select: { ok: true, vanished: true } }),
  ])

  const alerts: string[] = []
  const last = lastRow
    ? {
        at: lastRow.at.toISOString(), day: lastRow.day, ok: lastRow.ok, fileName: lastRow.fileName,
        fileToken: lastRow.fileToken, sizeBytes: lastRow.sizeBytes, vanished: lastRow.vanished,
        ageHours: Math.round(((Date.now() - lastRow.at.getTime()) / 3_600_000) * 10) / 10,
        error: lastRow.error,
      }
    : null

  if (!enabled) {
    alerts.push('⚪ LARK_EXPORT_ENABLED ยังปิดอยู่ — ไม่มีการส่งออกไป Lark เลย')
  } else {
    if (!configured.app) alerts.push('🔴 เปิด LARK_EXPORT_ENABLED แล้วแต่ไม่มี LARK_APP_ID/LARK_APP_SECRET — ทุกคืนจะล้มเงียบ')
    if (!configured.driveFolder) alerts.push('🔴 ไม่มี LARK_DRIVE_FOLDER_TOKEN — ไฟล์ archive ไม่มีที่ลง')
    if (!configured.base) alerts.push('🟠 ไม่มี LARK_BASE_APP_TOKEN — ได้แค่ไฟล์ ไม่มีตารางให้เปิดดูและไม่มีบันทึก "ของที่หายไป"')
    if (!last) {
      alerts.push('🟠 ยังไม่เคยรันสำเร็จสักครั้ง')
    } else {
      if (!last.ok) alerts.push(`🔴 รอบล่าสุด (${last.at}) ล้มเหลว: ${last.error || 'ไม่ระบุสาเหตุ'}`)
      if (last.ageHours > 26) alerts.push(`🔴 ไม่มี snapshot ใหม่มา ${last.ageHours} ชม. (ควรทุก 24 ชม.)`)
      if (last.ok && !last.fileToken) alerts.push('🔴 รอบล่าสุดบอกว่าสำเร็จแต่ไม่มี file_token — ไฟล์อาจไม่ได้ลงจริง')
      if (last.vanished > 200) alerts.push(`🟠 รอบล่าสุดพบแถวหายไป ${last.vanished} แถว — ผิดปกติ ตรวจว่ามีใครลบอะไรไหม`)
    }
  }

  return {
    enabled, configured, last,
    runs7d: recent.length,
    failures7d: recent.filter((r) => !r.ok).length,
    vanished7d: recent.reduce((s, r) => s + r.vanished, 0),
    alerts,
  }
}

export type LarkPreflight = {
  baseUrl: string
  configured: { app: boolean; driveFolder: boolean; base: boolean }
  tokenOk: boolean
  baseReadable: boolean | null
  baseTables: string[]
  archiveWriteOk: boolean | null
  estimatedSnapshotBytes: number | null
  tables: TableDecision[]
  problems: string[]
}

/**
 * Day-one verification. Nothing about this integration can be trusted from
 * reading code — the app, its scopes and the folder share all live in someone's
 * Lark console. `?write=1` uploads a tiny probe file, which is the only way to
 * learn whether the folder is actually shared with the app.
 */
export async function larkPreflight(opts: { write?: boolean } = {}): Promise<LarkPreflight> {
  resetLarkTokenCache()
  const problems: string[] = []
  const configured = {
    app: larkAppConfigured(),
    driveFolder: Boolean(process.env.LARK_DRIVE_FOLDER_TOKEN?.trim()),
    base: Boolean(process.env.LARK_BASE_APP_TOKEN?.trim()),
  }
  const out: LarkPreflight = {
    baseUrl: larkBaseUrl(), configured, tokenOk: false, baseReadable: null,
    baseTables: [], archiveWriteOk: null, estimatedSnapshotBytes: null,
    tables: [], problems,
  }

  try {
    const meta = await listTableMeta()
    out.tables = classifyTables(meta.map((m) => m.table), {
      include: process.env.LARK_EXPORT_INCLUDE,
      exclude: process.env.LARK_EXPORT_EXCLUDE,
    })
  } catch (e: any) {
    problems.push(`อ่านรายชื่อตารางไม่ได้: ${e?.message || e}`)
  }

  if (!configured.app) {
    problems.push('ยังไม่มี LARK_APP_ID / LARK_APP_SECRET — ต้องสร้าง self-built app ใน Lark Developer Console ก่อน (webhook ของบอทใช้แทนไม่ได้)')
    return out
  }
  try {
    await larkTenantToken()
    out.tokenOk = true
  } catch (e: any) {
    problems.push(`ขอ tenant_access_token ไม่ผ่าน: ${e?.message || e}`)
    return out
  }

  const appToken = process.env.LARK_BASE_APP_TOKEN?.trim()
  if (appToken) {
    try {
      out.baseTables = (await larkListTables(appToken)).map((t) => t.name)
      out.baseReadable = true
    } catch (e: any) {
      out.baseReadable = false
      problems.push(`เปิด Base ไม่ได้ (${e?.message || e}) — เช็คว่าแชร์ Base ให้แอปเป็น editor แล้ว และเพิ่ม scope bitable:app`)
    }
  }

  const folderToken = process.env.LARK_DRIVE_FOLDER_TOKEN?.trim()
  if (opts.write && folderToken) {
    try {
      const probe = gzipSync(Buffer.from(JSON.stringify({ probe: true, at: new Date().toISOString() })))
      await larkUploadFile({ folderToken, fileName: `probook-preflight-${Date.now()}.json.gz`, content: probe })
      out.archiveWriteOk = true
    } catch (e: any) {
      out.archiveWriteOk = false
      problems.push(`อัปโหลดไฟล์ทดสอบไม่ผ่าน (${e?.message || e}) — เช็คว่าแชร์โฟลเดอร์ให้แอปแก้ไขได้ และเพิ่ม scope drive:drive`)
    }
  }
  return out
}
