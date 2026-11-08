import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// maint 2026-11-08 (auth-documents-arbitrary-drive-delete) — any console tier could
// attach ANY Drive id (e.g. a footage box from GET /api/bookings/:id) to their own
// DRAFT purchase via the JSON path, then DELETE it → files.delete as the impersonated
// admin, permanent. Now: JSON path takes no driveFileId, DELETE trashes (recoverable)
// and refuses folders, and a Drive error keeps the ref instead of orphaning the file.
let docRow: any = null
let deleted: string[] = []
let created: any[] = []
let audits: any[] = []
let driveState: any = null
let driveStateErr: Error | null = null
let trashed: string[] = []
let hardDeleted: string[] = []

mock.module('../db', {
  namedExports: {
    prisma: {
      documentRef: {
        findUnique: async () => docRow,
        delete: async ({ where }: any) => { deleted.push(where.id); return {} },
        create: async ({ data }: any) => { created.push(data); return { id: 'doc-new', ...data } },
      },
      purchase: { findUnique: async () => ({ batch: { ownerEmail: 'coord@thestandard.co', status: 'DRAFT' } }) },
    },
  },
})
mock.module('../session', {
  namedExports: { requireConsole: async () => ({ email: 'coord@thestandard.co', role: 'COORDINATOR' }) },
})
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { audits.push(a) } } })
mock.module('../google-drive', {
  namedExports: {
    ensureFolderPath: async () => 'folder',
    uploadFileToFolder: async () => ({ id: 'up', webViewLink: null }),
    getDriveItemState: async () => { if (driveStateErr) throw driveStateErr; return driveState },
    trashDriveItem: async (id: string) => { trashed.push(id) },
    deleteDriveFile: async (id: string) => { hardDeleted.push(id) },
  },
})
mock.module('../purchase-drive', { namedExports: { ensurePurchaseItemFolder: async () => 'folder' } })

let DELETE: (r: any) => Promise<Response>
let POST: (r: any) => Promise<Response>
before(async () => {
  ;({ DELETE, POST } = await import('../../app/api/admin/documents/route'))
})
beforeEach(() => {
  docRow = null; deleted = []; created = []; audits = []
  driveState = null; driveStateErr = null; trashed = []; hardDeleted = []
})

const del = (id = 'doc1') => new Request(`https://probook.test/api/admin/documents?id=${id}`, { method: 'DELETE' }) as any
const FILE = { id: 'f1', name: 'receipt.pdf', mimeType: 'application/pdf', trashed: false, trashedTime: null, driveId: 'd' }

test('POST JSON with a driveFileId is refused — only uploads may own a Drive file', async () => {
  const res = await POST(new Request('https://probook.test/api/admin/documents', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownerType: 'purchase', ownerId: 'p1', fileName: 'x', driveFileId: 'BOX_FOLDER_ID' }),
  }) as any)
  assert.equal(res.status, 400)
  assert.equal(created.length, 0)
})

test('POST JSON link-only still works, and stores no driveFileId', async () => {
  const res = await POST(new Request('https://probook.test/api/admin/documents', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownerType: 'purchase', ownerId: 'p1', fileName: 'x', driveUrl: 'https://drive.google.com/x' }),
  }) as any)
  assert.equal(res.status, 201)
  assert.equal(created[0].driveFileId, undefined)
  assert.equal(created[0].driveUrl, 'https://drive.google.com/x')
})

test('DELETE trashes the file (recoverable), never files.delete, and audits the id', async () => {
  docRow = { fileName: 'receipt.pdf', driveFileId: 'f1', purchaseId: 'p1' }
  driveState = FILE
  const res = await DELETE(del())
  assert.equal(res.status, 200)
  assert.deepEqual(trashed, ['f1'])
  assert.deepEqual(hardDeleted, [])
  assert.deepEqual(deleted, ['doc1'])
  const a = audits.find(x => x.action === 'document.detach')
  assert.equal(a.changes.driveFileId, 'f1')
  assert.equal(a.changes.drive, 'trashed')
})

test('DELETE refuses a ref that points at a FOLDER — nothing trashed, ref kept', async () => {
  docRow = { fileName: 'x', driveFileId: 'BOX_FOLDER_ID', purchaseId: 'p1' }
  driveState = { ...FILE, id: 'BOX_FOLDER_ID', mimeType: 'application/vnd.google-apps.folder' }
  const res = await DELETE(del())
  assert.equal(res.status, 409)
  assert.deepEqual(trashed, [])
  assert.deepEqual(deleted, [])
})

test('DELETE: Drive read error fails loudly and keeps the ref (no orphaned file)', async () => {
  docRow = { fileName: 'x', driveFileId: 'f1', purchaseId: 'p1' }
  driveStateErr = Object.assign(new Error('unauthorized_client'), { status: 401 })
  const res = await DELETE(del())
  assert.equal(res.status, 502)
  assert.deepEqual(deleted, [])
})

test('DELETE: file already gone / already trashed still detaches', async () => {
  docRow = { fileName: 'x', driveFileId: 'f1', purchaseId: 'p1' }
  driveState = null
  assert.equal((await DELETE(del())).status, 200)
  driveState = { ...FILE, trashed: true }
  assert.equal((await DELETE(del())).status, 200)
  assert.deepEqual(trashed, [])
  assert.deepEqual(deleted, ['doc1', 'doc1'])
})
