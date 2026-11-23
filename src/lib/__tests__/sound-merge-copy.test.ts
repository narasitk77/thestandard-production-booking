/**
 * maint 23 Nov 2026 — sound-merge poured every staging subfolder into ONE box AUDIO folder:
 *  - POP-7TG-260826-01: REC-001.WAV / REC-002.WAV each sat twice in staging with the SAME md5 → two copies in the box;
 *  - WLT-EXI-260701-01: a graded WAV at the staging root and the raw WAV in RAW/Audio Files share name AND size but not
 *    content → both landed side by side under one name, and the editor could not tell them apart.
 * Now (both paths — the hourly runSoundMerge and the booking button's mergeBookingSound share copyStagedAudio):
 * the same md5 is copied once (md5 only — a name|size dedupe would silently DROP the WLT-EXI raw take), and a name that
 * still appears more than once keeps its staging sub-path under AUDIO. Nothing in the box is touched or deleted.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let staging: any[] = []
let box: any[] = []                     // files already in the box AUDIO
const copies: Array<{ id: string; to: string; name: string }> = []
const made: string[] = []

mock.module('../db', { namedExports: { prisma: { booking: { findMany: async () => rows } } } })
let rows: any[] = []
mock.module('../drive-links', {
  namedExports: {
    getDriveLink: (df: any, k: string) => df?.[k] ?? null,
    rememberDriveLinks: async () => {},
    storedFolder: async (link: string | null) => link,
  },
})
mock.module('../google-drive', {
  namedExports: {
    hasDriveCredentials: () => true,
    SOUND_STAGING_DIR: '_SOUND-STAGING',
    findChildFolder: async () => 'STAGINGROOT',
    listSoundStagingBookingFolders: async () => [],
    findEpisodeFolderUrls: async () => ({}),
    // box → EP01 (with AUDIO + CAM-A)
    listChildFolders: async (id: string) => (id === 'BOX' ? [{ id: 'EP1', name: 'EP01' }] : id === 'EP1' ? [{ id: 'AUD', name: 'AUDIO' }, { id: 'CAMA', name: 'CAM-A' }] : []),
    listFilesRecursive: async (id: string) => (id === 'STAGING' ? staging : id === 'AUD' ? box : []),
    ensureFolderPath: async (root: string, segs: string[]) => { const p = `${root}/${segs.join('/')}`; made.push(p); return p },
    copyFileToFolder: async (id: string, to: string, name: string) => { copies.push({ id, to, name }) },
  },
})

let sm: typeof import('../sound-merge')
before(async () => { process.env.DRIVE_FOOTAGE_ROOT = 'ROOT'; sm = await import('../sound-merge') })
beforeEach(() => { staging = []; box = []; copies.length = 0; made.length = 0; rows = [] })

const wav = (id: string, folderPath: string[], name: string, size: number, md5: string | null) =>
  ({ id, name, size, md5, folderPath, mimeType: 'audio/wav', parents: [], webViewLink: null, createdTime: null, modifiedTime: null, topFolderId: null })
const BOOKING = {
  id: 'b1', bookingCode: 'WLT-EXI-260701-01', driveFolders: { staging: 'STAGING', box: 'BOX' },
  projectId: null, projectName: 'x', category: null, crewRequired: ['Sound'],
  outlet: { code: 'WLT' }, program: { name: 'p' }, episodes: [],
}

test('same name, different content (WLT-EXI-260701-01): BOTH copied, each under its own staging sub-path', async () => {
  staging = [wav('graded', [], 'ZOOM0001.WAV', 313_263_978, '08ef650b'), wav('raw', ['RAW', 'Audio Files'], 'ZOOM0001.WAV', 313_263_978, 'b0b4ab63'),
    wav('solo', ['RAW'], 'ZOOM0002.WAV', 10, 'cccc')]
  const r = await sm.mergeBookingSound(BOOKING)
  assert.equal(r.copied, 3)
  assert.deepEqual(copies.map(c => [c.id, c.to]).sort(), [
    ['graded', 'AUD'],                          // its staging path is the root → AUDIO itself
    ['raw', 'AUD/RAW/Audio Files'],             // pre-fix: also 'AUD', beside the graded one, same name
    ['solo', 'AUD'],                            // a unique name stays flat, as before
  ])
})

test('the same md5 twice in staging (POP-7TG-260826-01) is copied ONCE — and a name|size twin with another md5 is never dropped', async () => {
  staging = [wav('a1', ['GDH', 'ZZ'], 'REC-001.WAV', 50, 'aaaa'), wav('a2', ['ไม่ใช้'], 'REC-001.WAV', 50, 'aaaa'), wav('b1', [], 'REC-002.WAV', 60, 'bbbb')]
  const dry = await sm.mergeBookingSound(BOOKING, { dryRun: true })
  assert.equal(dry.copied, 2, 'the dry run plans the same copies')
  assert.equal(copies.length, 0)
  const r = await sm.mergeBookingSound(BOOKING)
  assert.equal(r.copied, 2, 'pre-fix: 3 (REC-001 twice)')
  assert.deepEqual(copies.map(c => [c.name, c.to]).sort(), [['REC-001.WAV', 'AUD'], ['REC-002.WAV', 'AUD']], 'one copy left = flat, as before')
})

test('the hourly run uses the same plan; files already in the box AUDIO (name+size) are not copied again', async () => {
  rows = [{ ...BOOKING }]
  box = [wav('x', [], 'ZOOM0002.WAV', 10, 'cccc')]
  staging = [wav('graded', [], 'ZOOM0001.WAV', 313_263_978, '08ef650b'), wav('raw', ['RAW', 'Audio Files'], 'ZOOM0001.WAV', 313_263_978, 'b0b4ab63'),
    wav('solo', ['RAW'], 'ZOOM0002.WAV', 10, 'cccc'), wav('solo2', ['RAW', 'dup'], 'ZOOM0002.WAV', 10, 'cccc')]
  const r = await sm.runSoundMerge()
  assert.equal(r.merged, 2)
  assert.deepEqual(copies.map(c => [c.id, c.to]).sort(), [['graded', 'AUD'], ['raw', 'AUD/RAW/Audio Files']])
})

test('the WLT-EXI pair reaching staging in TWO runs: the later take is copied (md5 decides), beside nothing of its name', async () => {
  // run 1 copied the raw take flat; run 2 sees the graded take at the staging root — same name AND size, other md5
  box = [wav('raw-copy', [], 'ZOOM0001.WAV', 313_263_978, 'b0b4ab63')]
  staging = [wav('graded', [], 'ZOOM0001.WAV', 313_263_978, '08ef650b'), wav('raw', ['RAW', 'Audio Files'], 'ZOOM0001.WAV', 313_263_978, 'b0b4ab63')]
  const dry = await sm.mergeBookingSound(BOOKING, { dryRun: true })
  assert.equal(dry.copied, 1, 'the dry run plans the same copy')
  const r = await sm.mergeBookingSound(BOOKING)
  assert.equal(r.copied, 1, 'pre-fix: 0 — name|size matched the raw copy and the graded take was dropped with no log line')
  assert.deepEqual(copies.map(c => [c.id, c.to]), [['graded', `AUD/${sm.ROOT_CLASH_DIR}`]], 'not AUDIO itself, where its namesake sits')

  // the other order: graded first (flat), raw later → its own staging sub-path
  copies.length = 0
  box = [wav('graded-copy', [], 'ZOOM0001.WAV', 313_263_978, '08ef650b')]
  staging = [wav('raw', ['RAW', 'Audio Files'], 'ZOOM0001.WAV', 313_263_978, 'b0b4ab63')]
  await sm.mergeBookingSound(BOOKING)
  assert.deepEqual(copies.map(c => [c.id, c.to]), [['raw', 'AUD/RAW/Audio Files']])

  // content already in the box under another name (an editor renamed it) is not copied again
  copies.length = 0
  box = [wav('renamed', [], 'Interview A.WAV', 313_263_978, 'b0b4ab63')]
  staging = [wav('raw', ['RAW', 'Audio Files'], 'ZOOM0001.WAV', 313_263_978, 'b0b4ab63')]
  assert.equal((await sm.mergeBookingSound(BOOKING)).copied, 0)
})
