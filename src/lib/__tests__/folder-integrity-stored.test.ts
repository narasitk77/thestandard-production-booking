/**
 * maint 23 Nov 2026 — folder-integrity chose between a stored box/landing id and a NAME walk with isFolderAlive, which
 * reads 'unknown' (a 403 rateLimitExceeded, not retried) as dead. Prod logged `folderLiveness … indeterminate (status
 * 401 unauthorized_client)` 3× in a week; on such a run the worker walked names instead — rememberDriveLinks overwrote
 * the stored id with whatever the walk found, or a fresh box / landing drop folder was created beside the real one.
 * It now uses storedFolder (drive-links.ts, the same rule as video/sound-merge): only a folder Drive says is GONE
 * falls back; 'unknown' keeps the stored id and never rewrites a link or creates a box/landing.
 *
 * Runs the REAL drive-links.ts (storedFolder + rememberDriveLinks), with Drive and the db mocked.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const CODE = 'TSS-TSS-261123-01'
const BOX = 'BOXstored0000001'
const LANDING = 'LANDINGstored001'
const TWIN = 'BOXtwinFromNames'

let liveness: Record<string, 'alive' | 'dead' | 'unknown'> = {}
let row: any
const linkWrites: any[] = []
const calls: string[] = []

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findMany: async () => [row],
        findUnique: async () => ({ driveFolders: row.driveFolders }),
        update: async ({ data }: any) => { linkWrites.push(data); return {} },
      },
    },
  },
})
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../notify', { namedExports: { notifyChat: async () => true } })
mock.module('../google-drive', {
  namedExports: {
    hasDriveCredentials: () => true,
    folderLiveness: async (id: string) => liveness[id] ?? 'alive',
    isFolderAlive: async (id: string) => (liveness[id] ?? 'alive') === 'alive', // what the pre-fix code asked
    findEpisodeFolderUrls: async () => { calls.push('box name walk'); return { bookingFolderId: TWIN, viaBookingSubfolder: true, episodes: [] } },
    findChildFolderByCode: async () => { calls.push('landing name search'); return null },
    getFileName: async (id: string) => (id === LANDING ? `x (${CODE})` : `The Secret Sauce · x (${CODE})`),
    listChildFolders: async () => [{ id: 'cam', name: 'CAM-A' }],
    findFoldersByCode: async () => [],
    classifyFootageTreeFolder: async () => 'in-tree',
    listFilesRecursive: async () => [],
    getDriveParentFolderId: async () => 'parent',
    renameDriveItem: async () => { calls.push('rename') },
    ensureFolderPath: async () => { calls.push('ensureFolderPath'); return 'new' },
    ensureShootCameraFolders: async () => { calls.push('create box'); return { bookingFolderId: 'BOXnewlyCreated1' } },
    ensureFlatShootFolders: async () => { calls.push('create landing'); return { bookingFolderId: 'LANDnewCreated01' } },
  },
})

let fi: typeof import('../folder-integrity')
before(async () => { process.env.DRIVE_FOOTAGE_ROOT = 'ROOTfolder000001'; fi = await import('../folder-integrity') })
beforeEach(() => {
  liveness = {}; linkWrites.length = 0; calls.length = 0
  row = {
    id: 'b1', bookingCode: CODE, driveFolders: { box: BOX, landing: LANDING },
    shootDate: new Date(), shootEndDate: null, // today = inside the landing window
    projectId: null, projectName: 'x', category: null, cameraCount: 1, micCount: 0,
    outlet: { code: 'TSS' }, program: { name: 'The Secret Sauce' }, episodes: [],
  }
})

test("stored box + landing answering 'unknown' are TRUSTED: no name walk, no link rewritten, nothing created", async () => {
  liveness = { [BOX]: 'unknown', [LANDING]: 'unknown' }
  const r = await fi.runFolderIntegrity({ dryRun: false, onlyCode: CODE })
  assert.deepEqual(calls.filter(c => c !== 'ensureFolderPath'), [], `pre-fix: ${calls.join(', ')}`)
  assert.deepEqual(linkWrites, [], 'rememberDriveLinks wrote nothing (pre-fix: box → the twin the walk found)')
  assert.equal(r.fixed.linksHealed, 0)
  assert.equal(r.fixed.boxCreated, 0)
  assert.equal(r.fixed.landingRepaired, 0)
})

test('a stored box Drive says is GONE still falls back to the name walk and heals the link (unchanged)', async () => {
  liveness = { [BOX]: 'dead' }
  const r = await fi.runFolderIntegrity({ dryRun: false, onlyCode: CODE })
  assert.ok(calls.includes('box name walk'))
  assert.deepEqual(linkWrites.map(w => w.driveFolders.box), [TWIN])
  assert.equal(r.fixed.linksHealed, 1)
})
