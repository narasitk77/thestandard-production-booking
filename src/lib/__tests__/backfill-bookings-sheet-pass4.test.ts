// backfill-bookings-sheet pass 4 now covers AJ–AR (Agency Ref was blank on 97 rows created
// before v1.203). Bug class 5: the dry run the owner reads before { apply: true } must list
// exactly the cells and values apply writes — same plan object, not a second code path.
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'

const TAB = 'Bookings'
let readRanges: string[] = []
let writes: Array<{ range: string; values: string[][] }> = []

// row 2: pre-v1.203 row, AJ–AR blank (trailing blanks dropped like values.get does)
// row 3: Agency Ref hand-filled in the sheet → must not be overwritten
const row2 = ['AGN-260713-01']
const row3 = Array(42).fill('')
row3[0] = 'TSS-TSS-260805-01'
row3[41] = 'QU-4081'
const sheetRows = [row2, row3]

const fakeSheets = {
  spreadsheets: {
    values: {
      get: async ({ range }: any) => { readRanges.push(range); return { data: { values: sheetRows } } },
      batchUpdate: async ({ requestBody }: any) => { writes.push(...requestBody.data); return {} },
    },
  },
}
mock.module('googleapis', { namedExports: { google: { sheets: () => fakeSheets, auth: { JWT: class { constructor(_: any) {} } } } } })

const old = new Date('2026-07-01T00:00:00Z')
const base = {
  deletedAt: null, status: 'COMPLETED', calendarEventId: null, createdAt: old, outlet: { code: 'AGN' }, program: {},
  episodes: [], driveFolders: null, deliveredAt: null, deliveredBy: null, cancelReason: null,
  equipmentNote: null, rentalGearNote: null, micCount: null, vanCount: null, specialEquipment: [], isBlockShot: false, itinerary: null,
}
const bookings = [
  { ...base, id: 'a', bookingCode: 'AGN-260713-01', sheetRowIndex: 2, agencyRef: 'QU-4480', cameraCount: 2, vanCount: 0 },
  { ...base, id: 'b', bookingCode: 'TSS-TSS-260805-01', sheetRowIndex: 3, agencyRef: 'QU-4081', cameraCount: null },
]
mock.module('../db', { namedExports: { prisma: { booking: { findMany: async () => bookings, update: async () => ({}) } } } })
mock.module('../session', { namedExports: { requireAdmin: async () => ({ email: 'admin@x.co', role: 'ADMIN' }) } })
mock.module('../audit', { namedExports: { logAudit: async () => {} } })

let POST: any
before(async () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@x.iam', private_key: 'k' })
  delete process.env.PRODUCER_DASHBOARD_SHEET_ID
  ;({ POST } = await import('../../app/api/admin/backfill-bookings-sheet/route'))
})

const req = (body: any) => new Request('https://probook.test/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) as any

test('dry run lists the AJ–AR cells; apply writes exactly those cells and values', async () => {
  const dry = await (await POST(req({}))).json()
  assert.equal(dry.dryRun, true)
  assert.deepEqual(readRanges, [`${TAB}!A2:AR`], 'reads through AR')
  assert.equal(writes.length, 0, 'dry run writes nothing')
  assert.deepEqual(dry.patchExtras, [
    { code: 'AGN-260713-01', fields: ['cameraCount', 'vanCount', 'agencyRef'], values: { cameraCount: '2', vanCount: '0', agencyRef: 'QU-4480' } },
  ], 'TSS row: Agency Ref already in the sheet, Camera Count null in the DB → nothing to fill')

  const applied = await (await POST(req({ apply: true }))).json()
  assert.equal(applied.errors.length, 0)
  assert.deepEqual(writes, [
    { range: `${TAB}!AL2`, values: [['2']] },
    { range: `${TAB}!AN2`, values: [['0']] },
    { range: `${TAB}!AP2`, values: [['QU-4480']] },
  ])
  // the same plan, cell for cell
  const planned = dry.patchExtras.flatMap((e: any) => Object.values(e.values))
  assert.deepEqual(writes.map(w => w.values[0][0]), planned)
  assert.equal(applied.patchExtras[0].patched, true)
})
