/**
 * Maintenance 2026-11-08 — Lark export (dormant: LARK_EXPORT_ENABLED=0 on prod).
 *  1. A table that failed to read left the run ok:true: the file shipped without it,
 *     meta did not say so, no alert fired (alerts only on !ok), and its key index —
 *     missing that table — became the next night's diff basis.
 *  2. audit_logs is exported in full, and `feedback.submitted` rows carry the
 *     reporter's email + 500 chars of the complaint — feedback that the 2026-08-31
 *     decision keeps out of Lark.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync, gzipSync } from 'zlib'

let tableRows: Record<string, any[] | Error> = {}
let uploaded: Buffer | null = null
let runRows: any[] = []

mock.module('../db', {
  namedExports: {
    prisma: {
      $queryRaw: async () => Object.keys(tableRows).map(t => ({ table_name: t, pk_column: 'id', ord: 1 })),
      $queryRawUnsafe: async (sql: string) => {
        const t = /FROM "([a-z_]+)"/.exec(sql)![1]
        const v = tableRows[t]
        if (v instanceof Error) throw v
        return v
      },
      larkExportRun: {
        findFirst: async (args: any) => {
          const rows = [...runRows].sort((a, b) => b.at - a.at)
          return (args?.where?.ok ? rows.filter(r => r.ok && r.keysGz) : rows)[0] ?? null
        },
        create: async ({ data }: any) => { runRows.push(data); return data },
        findMany: async () => runRows.map(r => ({ id: 'x', ok: r.ok, vanished: r.vanished })).slice(60),
        deleteMany: async () => ({ count: 0 }),
      },
    },
  },
})
mock.module('../lark-client', {
  namedExports: {
    larkAppConfigured: () => true,
    larkUploadFile: async ({ content }: any) => { uploaded = content; return { fileToken: 'ftok' } },
    larkListTables: async () => [], larkCreateTable: async () => 't', larkListFields: async () => [],
    larkCreateField: async () => {}, larkListRecordIds: async () => [], larkDeleteRecords: async () => 0,
    larkCreateRecords: async () => 0, larkTenantToken: async () => 'tok', larkBaseUrl: () => 'https://lark.test',
    resetLarkTokenCache: () => {},
    LarkError: class extends Error { endpoint = '' },
  },
})

let mod: typeof import('../lark-export')
let policy: typeof import('../lark-export-policy')
before(async () => {
  process.env.LARK_DRIVE_FOLDER_TOKEN = 'folder'
  process.env.LARK_EXPORT_ENABLED = '1'
  delete process.env.LARK_BASE_APP_TOKEN
  mod = await import('../lark-export')
  policy = await import('../lark-export-policy')
})
beforeEach(() => { uploaded = null; runRows = [] })

const snapshot = () => JSON.parse(gunzipSync(uploaded!).toString('utf8'))

test('a table that cannot be read makes the run NOT ok, is named in the file, and is not the next diff basis', async () => {
  tableRows = {
    bookings: new Error('canceling statement due to statement timeout'),
    episodes: [{ id: 'e1', episodeId: 'EP-1' }],
  }
  const r = await mod.runLarkExport()
  assert.equal(r.archiveOk, true, 'the file still went up — the rest is worth keeping')
  assert.equal(r.ok, false)
  assert.deepEqual(r.failedTables, ['bookings'])
  assert.deepEqual(snapshot().meta.failedTables, ['bookings'])
  assert.equal(runRows[0].ok, false)
  assert.equal(runRows[0].keysGz, null, 'a partial key index must not become tomorrow\'s basis')
  assert.match(mod.heartbeatNote(r), /unreadTables=bookings/)

  const dry = await mod.runLarkExport({ dryRun: true })
  assert.equal(dry.ok, false, 'dry run judges a read failure the same way')
})

test('a complete run is ok and stores its key index (unchanged)', async () => {
  tableRows = { episodes: [{ id: 'e1', episodeId: 'EP-1' }] }
  const r = await mod.runLarkExport()
  assert.equal(r.ok, true)
  assert.ok(runRows[0].keysGz)
})

test('feedback audit rows do not ride out through audit_logs; ordinary audit rows do', async () => {
  tableRows = {
    audit_logs: [
      { id: 'a1', action: 'feedback.submitted', entityType: 'Feedback', actorEmail: 'staff@thestandard.co', changes: { message: 'ระบบช้ามาก หัวหน้า…' } },
      { id: 'a2', action: 'booking.approve', entityType: 'Booking', actorEmail: 'boss@thestandard.co', changes: {} },
    ],
  }
  const r = await mod.runLarkExport()
  const ids = snapshot().tables.audit_logs.map((x: any) => x.id)
  assert.deepEqual(ids, ['a2'])
  assert.equal(r.withheldAuditRows, 1)
  assert.equal(snapshot().meta.withheldAuditRows, 1)
})

test('policy: an audit row follows its table — opting the table in brings its audit rows along', () => {
  const row = { action: 'feedback.reply', entityType: 'FeedbackTicket' }
  assert.equal(policy.auditRowWithheld(row, new Set(['audit_logs'])), true)
  assert.equal(policy.auditRowWithheld(row, new Set(['audit_logs', 'feedback_tickets'])), false)
  assert.equal(policy.auditRowWithheld({ action: 'feedback.whatever', entityType: 'X' }, new Set()), true, 'action prefix is a second net')
  assert.equal(policy.auditRowWithheld({ action: 'ot.resync', entityType: 'OTRecord' }, new Set()), true)
  assert.equal(policy.auditRowWithheld({ action: 'booking.approve', entityType: 'Booking' }, new Set()), false)
})

test('stats: a run that landed but logged errors (e.g. the mirror) raises an alert instead of nothing', async () => {
  runRows = [{ at: new Date(), ok: true, day: '2026-11-08', fileName: 'f', fileToken: 'ftok', sizeBytes: 1, vanished: 0, error: 'mirror bookings: 1254043 FieldNameNotFound' }]
  const s = await mod.larkExportStats()
  assert.ok(s.alerts.some(a => a.includes('mirror bookings')), JSON.stringify(s.alerts))
})

test('first run after deploy: audit rows that are now withheld (still in the DB) are NOT tombstoned; a really deleted row is', async () => {
  // The previous night's index was built before withholding existed → it holds a1.
  const prevIndex = { audit_logs: { a1: 'feedback.submitted', a2: 'booking.approve', a3: 'booking.cancel' } }
  runRows = [{ at: new Date(0), ok: true, fileName: 'probook-2026-11-07.json.gz', keysGz: gzipSync(Buffer.from(JSON.stringify(prevIndex))) }]
  tableRows = {
    audit_logs: [
      { id: 'a1', action: 'feedback.submitted', entityType: 'Feedback', actorEmail: 'staff@thestandard.co', changes: {} },
      { id: 'a2', action: 'booking.approve', entityType: 'Booking', actorEmail: 'boss@thestandard.co', changes: {} },
      // a3 was deleted from the DB for real
    ],
  }
  const r = await mod.runLarkExport({ dryRun: true })
  assert.deepEqual(r.tombstones.map(t => t.key), ['a3'], 'withheld a1 still exists — it must not be recorded as deleted')
  assert.equal(r.vanished, 1)
  assert.equal(r.withheldAuditRows, 1)

  const real = await mod.runLarkExport()
  assert.deepEqual(real.tombstones.map(t => t.key), ['a3'])
  const stored = JSON.parse(gunzipSync(runRows[runRows.length - 1].keysGz).toString('utf8'))
  assert.deepEqual(Object.keys(stored.audit_logs), ['a2'], 'the stored basis holds only what left for Lark')
})
