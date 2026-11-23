// Maintenance 23 Nov 2026 — a Bookings-tab append that failed at create time was a console line and
// nothing else: no alert, no retry (3 rows lost in the 60 days to 13 Nov, found by hand). Now
// (1) the create path alerts ops when sheets are configured, (2) sheet-row-repair, on the calendar
// reconciler's tick, appends the missing row — after checking col A, so a row that did land is
// claimed, never duplicated — and alerts when it can't.
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let candidates: any[] = []
let findManyArgs: any[] = []
let updateManys: any[] = []
let updates: any[] = []
let colA: string[][] | Error = []
let colAReads = 0
let appendResult: (b: any) => number | null = () => 42
let appended: string[] = []
let configured = true
let audits: any[] = []
let alerts: any[][] = []

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findMany: async (a: any) => { findManyArgs.push(a); return candidates },
        updateMany: async (a: any) => { updateManys.push(a); return { count: 1 } },
        update: async (a: any) => { updates.push(a); return {} },
      },
    },
  },
})
mock.module('../google-sheets', {
  namedExports: {
    appendBookingRow: async (b: any) => { appended.push(b.bookingCode); return appendResult(b) },
    getSheetsReadAuth: () => ({}),
    sheetsWriteConfigured: () => configured,
  },
})
mock.module('googleapis', {
  namedExports: {
    google: {
      sheets: () => ({ spreadsheets: { values: { get: async () => {
        colAReads++
        if (colA instanceof Error) throw colA
        return { data: { values: colA } }
      } } } }),
      auth: { JWT: class {} },
    },
  },
})
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { audits.push(a) } } })
mock.module('../ops-alert', {
  namedExports: { alertOps: async (...a: any[]) => { alerts.push(a); return { attempted: true, delivered: true } } },
})

let repair: typeof import('../sheet-row-repair')
let createBooking: typeof import('../create-booking')
before(async () => {
  repair = await import('../sheet-row-repair')
  createBooking = await import('../create-booking')
})
beforeEach(() => {
  candidates = []; findManyArgs = []; updateManys = []; updates = []; colA = []; colAReads = 0
  appendResult = () => 42; appended = []; configured = true; audits = []; alerts = []
})

const bk = (code: string) => ({
  id: `id-${code}`, bookingCode: code, createdAt: new Date('2026-11-20T03:00:00Z'), shootDate: new Date('2026-11-25T00:00:00Z'),
  outlet: { code: 'NWS', name: 'News' }, program: { name: 'P' }, episodes: [],
})
const quiet = async <T>(fn: () => Promise<T>) => {
  const [e, l] = [console.error, console.log]
  console.error = () => {}; console.log = () => {}
  try { return await fn() } finally { console.error = e; console.log = l }
}

test('query: live, no sheetRowIndex, older than 5 minutes, oldest first, bounded', async () => {
  const t0 = Date.now()
  await repair.repairMissingSheetRows()
  const w = findManyArgs[0].where
  assert.equal(w.deletedAt, null)
  assert.deepEqual(w.status, { notIn: ['CANCELLED'] })
  assert.equal(w.sheetRowIndex, null)
  assert.ok(Math.abs(t0 - repair.SHEET_REPAIR_GRACE_MS - w.createdAt.lt.getTime()) < 2_000)
  assert.deepEqual(findManyArgs[0].orderBy, { createdAt: 'asc' })
  assert.equal(findManyArgs[0].take, repair.SHEET_REPAIR_LIMIT + 1)
  assert.equal(colAReads, 0, 'nothing to repair = no Sheets call')
})

test('no row in col A → appended, index saved on a null CAS, audit sheet.row_appended, no alert', async () => {
  candidates = [bk('NWS-TSN-261117-01')]
  colA = [['OTHER-01']]
  const r = await quiet(() => repair.repairMissingSheetRows({ actorEmail: 'calendar-reconcile-worker' }))
  assert.deepEqual(appended, ['NWS-TSN-261117-01'])
  assert.deepEqual(r.append, [{ code: 'NWS-TSN-261117-01', rowIndex: 42 }])
  assert.deepEqual(updateManys, [{ where: { id: 'id-NWS-TSN-261117-01', sheetRowIndex: null }, data: { sheetRowIndex: 42 } }])
  const a = audits.find(x => x.action === 'sheet.row_appended')
  assert.equal(a.bookingCode, 'NWS-TSN-261117-01')
  assert.equal(a.changes.rowIndex, 42)
  assert.equal(a.actorEmail, 'calendar-reconcile-worker')
  assert.equal(alerts.length, 0)
})

test('code already in col A → claimed, NEVER appended again (no duplicate row)', async () => {
  candidates = [bk('AGN-261110-01')]
  colA = [['X'], ['AGN-261110-01'], ['AGN-261110-01']]   // rows 2, 3, 4 — first row wins
  const r = await quiet(() => repair.repairMissingSheetRows())
  assert.deepEqual(appended, [])
  assert.deepEqual(r.claim, [{ code: 'AGN-261110-01', rowIndex: 3 }])
  assert.deepEqual(updateManys[0].data, { sheetRowIndex: 3 })
  assert.equal(audits[0].action, 'sheet.rowindex_repaired')
  assert.equal(alerts.length, 0)
})

test('append fails → named in failed[] and ops alerted; the rest of the batch still runs', async () => {
  candidates = [bk('A-01'), bk('B-01')]
  appendResult = b => (b.bookingCode === 'A-01' ? null : 7)
  const r = await quiet(() => repair.repairMissingSheetRows())
  assert.deepEqual(appended, ['A-01', 'B-01'])
  assert.deepEqual(r.failed.map(f => f.code), ['A-01'])
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0][0], 'sheet-row-repair')
  assert.match(alerts[0][2], /A-01/)
  assert.ok(!updateManys.some(u => u.where.id === 'id-A-01'), 'a failed append saves no index')
})

test('col A unreadable → append nothing (cannot tell "no row" from "could not see"), alert', async () => {
  candidates = [bk('A-01')]
  colA = new Error('Quota exceeded')
  const r = await quiet(() => repair.repairMissingSheetRows())
  assert.deepEqual(appended, [])
  assert.equal(r.failed.length, 1)
  assert.match(r.failed[0].error, /Quota exceeded/)
  assert.equal(alerts[0][0], 'sheet-row-repair')
})

test('dry run = the same plan as the real run, but no append, no DB write, no audit, no alert', async () => {
  candidates = [bk('A-01'), bk('B-01')]
  colA = [['B-01']]
  const r = await repair.repairMissingSheetRows({ dryRun: true })
  assert.deepEqual(r.append, [{ code: 'A-01' }])
  assert.deepEqual(r.claim, [{ code: 'B-01', rowIndex: 2 }])
  assert.equal(appended.length + updateManys.length + audits.length + alerts.length, 0)
})

test('sheets off in this process (dev / staging) → skipped, Sheets not touched', async () => {
  candidates = [bk('A-01')]
  configured = false
  const r = await repair.repairMissingSheetRows()
  assert.equal(r.skipped, 'sheets-off')
  assert.equal(colAReads + appended.length + alerts.length, 0)
})

test('more candidates than the cap → more:true and the alert says so', async () => {
  candidates = Array.from({ length: repair.SHEET_REPAIR_LIMIT + 1 }, (_, i) => bk(`C-${i}`))
  appendResult = () => null
  const r = await quiet(() => repair.repairMissingSheetRows())
  assert.equal(r.more, true)
  assert.equal(appended.length, repair.SHEET_REPAIR_LIMIT)
  assert.match(alerts[0][2], /รอคิวซ่อมอีก/)
})

test('create path: a failed append alerts ops (sheets configured) and is silent to ops when sheets are off', async () => {
  const b = bk('NWS-KYM-261117-01') as any
  appendResult = () => null
  await quiet(() => createBooking.appendNewBookingRow(b))
  assert.deepEqual(alerts.map(a => a[0]), ['sheet-append'])
  assert.match(alerts[0][1], /NWS-KYM-261117-01/)
  assert.equal(updates.length, 0)

  alerts = []; configured = false
  await quiet(() => createBooking.appendNewBookingRow(b))
  assert.equal(alerts.length, 0)
})

test('create path: a landed append saves sheetRowIndex and does not alert', async () => {
  appendResult = () => 99
  await createBooking.appendNewBookingRow(bk('A-01') as any)
  assert.deepEqual(updates, [{ where: { id: 'id-A-01' }, data: { sheetRowIndex: 99 } }])
  assert.equal(alerts.length, 0)
})
