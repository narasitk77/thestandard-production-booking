import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'

// maint 2026-11-08 (B1b) — folder-integrity สั่ง rename กล่องสลับไปมา: ใบหลายรายการที่ทุก EP sequence=1 (class 17)
// orderBy { sequence } อย่างเดียว = Postgres คืนลำดับไม่คงที่ → jobName (episodes[0].title) / ชื่อรายการสลับทุกรอบ
// (WLT-OTH-261113-01 rename 8 ครั้งใน 16 วัน) · ล็อกว่า query ของ EP เป็นลำดับรวม (total order) เสมอ

let lastArgs: any = null
mock.module('../db', {
  namedExports: {
    prisma: { booking: { findMany: async (args: any) => { lastArgs = args; return [] } } },
  },
})
const noop = async () => null
mock.module('../google-drive', {
  namedExports: {
    hasDriveCredentials: () => true, findEpisodeFolderUrls: noop, listChildFolders: async () => [], getFileName: noop, renameDriveItem: noop,
    ensureFolderPath: noop, ensureShootCameraFolders: noop, ensureFlatShootFolders: noop, findChildFolderByCode: noop,
    findFoldersByCode: async () => [], isFolderAlive: async () => false, classifyFootageTreeFolder: async () => 'in-tree',
    listFilesRecursive: async () => [], getDriveParentFolderId: noop,
  },
})
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../notify', { namedExports: { notifyChat: async () => true } })

let fi: typeof import('../folder-integrity')
before(async () => { process.env.DRIVE_FOOTAGE_ROOT = 'ROOT'; fi = await import('../folder-integrity') })

test('maint: EP ของใบจองเรียงแบบไม่มีเสมอ (sequence → episodeId → id) — ชื่อกล่องไม่สลับทุกรอบ', async () => {
  await fi.runFolderIntegrity({ dryRun: true })
  const order = lastArgs?.select?.episodes?.orderBy
  assert.deepEqual(order, [{ sequence: 'asc' }, { episodeId: 'asc' }, { id: 'asc' }])
})
