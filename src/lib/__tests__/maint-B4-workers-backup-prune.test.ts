// 2026-11-08 maintenance — DB backup retention prune.
//
// Read ONE page of 1000 (no nextPageToken), counted a failed delete as pruned
// (`.catch(() => {})` then `removed++`), and used files.delete (permanent).
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'

const OLD = new Date(Date.now() - 400 * 86_400_000).toISOString()
const NEW = new Date().toISOString()
const pages: Record<string, { files: any[]; nextPageToken?: string }> = {
  first: { files: [{ id: 'a', name: 'backup-a', createdTime: OLD }, { id: 'n', name: 'backup-new', createdTime: NEW }], nextPageToken: 'p2' },
  p2: { files: [{ id: 'b', name: 'backup-b', createdTime: OLD }, { id: 'bad', name: 'backup-bad', createdTime: OLD }] },
}
const trashed: string[] = []
const deleted: string[] = []

mock.module('googleapis', {
  namedExports: {
    google: {
      drive: () => ({
        files: {
          list: async (args: any) => ({ data: pages[args.pageToken || 'first'] }),
          delete: async (args: any) => { deleted.push(args.fileId) },
        },
      }),
    },
  },
})
mock.module('../google-drive', {
  namedExports: {
    getDriveWriteAuth: () => ({}),
    uploadFileToFolder: async () => ({ id: 'up' }),
    deleteDriveFile: async (id: string) => { deleted.push(id) },
    trashDriveItem: async (id: string) => {
      if (id === 'bad') throw new Error('insufficientFilePermissions')
      trashed.push(id)
    },
  },
})

let backup: typeof import('../backup')
before(async () => { backup = await import('../backup') })

test('prune walks every page, trashes (never deletes), and counts only real successes', async () => {
  const errs: string[] = []
  const e = console.error
  console.error = (...a: any[]) => { errs.push(a.map(String).join(' ')) }
  let r: { removed: number; failed: number }
  try {
    r = await backup.pruneBackups('FOLDER', 365)
  } finally {
    console.error = e
  }
  assert.deepEqual(trashed.sort(), ['a', 'b'], 'page 2 must be reached; the fresh backup kept')
  assert.deepEqual(deleted, [], 'no permanent delete')
  assert.deepEqual(r!, { removed: 2, failed: 1 })
  assert.ok(errs.some((l) => l.includes('[backup] prune run failed')), 'a failed trash must be loud')
})
