/**
 * maint 23 Nov 2026 — an EP folder whose name starts with the booking code ("TSS-TSG-261110-01 · TBC", named by its
 * episode id when EP sequences collide) is inside the box AND a findFoldersByCode root of its own, so every walk that
 * unions the box with the code-named folders listed its files twice:
 *  - footage-folders (team mail, cache): two rows for the same 8 files — fileCount 26 in TSS-TSG-261110-01's mail;
 *  - countDriveFilesByCode (NAS drain mail): 16 files / 34.7 GB for 8 / 17.4 GB;
 *  - verifyNasMirror: the Drive side of the NAS compare counted twice;
 *  - mediaproGate: "2 การ์ด" for one (covered in mediapro.test.ts).
 * Every union now counts a Drive FILE id once. findFoldersByCode itself is unchanged (episode-sync needs those folders).
 */
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'

const CODE = 'TSS-TSG-261110-01'
const BOX = 'BOXfolder0000001'
const EP = 'EPfolder00000001'
const CAMA = 'CAMAfolder000001'

// the card as walked FROM THE BOX (path starts at the EP folder) and FROM THE EP FOLDER (path starts at CAM-A): same ids
const names = ['MEDIAPRO.XML', 'FX3_B0001.MP4', 'FX3_B0001M01.XML', 'FX3_B0002.MP4']
const fromBox = names.map((name, i) => ({ id: `file${i}`, name, size: 1000 * (i + 1), md5: `m${i}`, mimeType: 'x', parents: [CAMA], webViewLink: null, createdTime: null, modifiedTime: null, folderPath: [`${CODE} · TBC`, 'CAM-A'], topFolderId: EP }))
const fromEp = fromBox.map(f => ({ ...f, folderPath: ['CAM-A'], topFolderId: CAMA }))

mock.module('../db', { namedExports: { prisma: {} } })
mock.module('../email', { namedExports: { sendEmail: async () => ({}), isEmailConfigured: () => false } })
mock.module('../notify', { namedExports: { notifyChat: async () => true } })
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../ops-alert', { namedExports: { alertOps: async () => ({ attempted: true }) } })
mock.module('../google-drive', {
  namedExports: {
    findFoldersByCode: async () => [{ id: BOX, name: `The Secret Sauce · x (${CODE})`, parents: ['PROG'] }, { id: EP, name: `${CODE} · TBC`, parents: [BOX] }],
    listFilesRecursive: async (id: string) => (id === BOX ? fromBox : id === EP ? fromEp : []),
    listChildFolders: async () => [], // no landing folder on the Production Team drive
    findChildFolder: async () => null,
    listSoundStagingTree: async () => ({ bookings: [], containerIds: [] }),
    SOUND_STAGING_DIR: '_SOUND-STAGING',
    isFolderAlive: async () => true,
    folderLiveness: async () => 'alive',
    findEpisodeFolderUrls: async () => { throw new Error('stored box is alive — no name walk') },
  },
})

let nas: typeof import('../nas-sync')
let ff: typeof import('../footage-folders')
before(async () => { process.env.DRIVE_FOOTAGE_ROOT = 'ROOTfolder000001'; nas = await import('../nas-sync'); ff = await import('../footage-folders') })

const BYTES = 1000 + 2000 + 3000 + 4000

test('countDriveFilesByCode: the code-named EP folder inside the box is not counted twice (NAS drain mail)', async () => {
  assert.deepEqual(await nas.countDriveFilesByCode(CODE), { files: 4, bytes: BYTES }, 'pre-fix: 8 files / double bytes')
})

test('verifyNasMirror: the Drive side counts each file once', async () => {
  const v = await nas.verifyNasMirror({ at: new Date().toISOString(), folders: [{ name: `Talk (${CODE})`, files: fromBox.map(f => ({ p: `CAM-A/${f.name}`, size: f.size })) }] })
  assert.equal(v.allMatch, true)
  assert.equal(v.folders[0].driveFiles, 4, 'pre-fix: 8')
})

test('resolveFootageFolders: one row per real folder, fileCount = real files (the TSS-TSG-261110-01 mail counted the same 8 files twice)', async () => {
  const r = await ff.resolveFootageFolders({
    driveFolders: { box: BOX }, bookingCode: CODE, projectId: null, projectName: 'x', category: null,
    outlet: { code: 'TSS' }, program: { name: 'The Secret Sauce' }, episodes: [],
  })
  assert.equal(r.fileCount, 4, 'pre-fix: 8')
  assert.deepEqual(r.folders.map(f => [f.label, f.fileCount, f.totalBytes]), [[`${CODE} · TBC`, 4, BYTES]], 'the box row keeps its label; no second row for the EP root')
})
