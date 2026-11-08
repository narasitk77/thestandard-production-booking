/**
 * maint 2026-11-08 (batch B1a-merge) — prep-folders dryRun must walk the real run's path (bug class 5).
 *
 * The read-only "footage already delivered" check ran only in the real run, so the preview said wouldCreate
 * CAM-A.. for a booking the real run skips; and the _SOUND-STAGING folder the real run creates was never named
 * in the preview. Now the only difference between the two is the writes.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let bookings: any[] = []
const writes: string[] = []
const delivered = new Set<string>() // booking codes whose footage is already in a VIDEO-tree folder

mock.module('../db', { namedExports: { prisma: { booking: { findMany: async () => bookings } } } })
mock.module('../google-drive', {
  namedExports: {
    hasDriveCredentials: () => true,
    findFoldersByCode: async (code: string) => [{ id: `box-of-${code}` }],
    isFootageTreeFolder: async () => true,
    listFilesRecursive: async (id: string) => delivered.has(id.replace('box-of-', '')) ? [{ name: 'A001C001.MXF' }] : [{ name: '_SHOOT.txt' }],
    listFilesInFolder: async () => [{ name: '_SHOOT.txt' }],
    ensureShootCameraFolders: async () => { writes.push('cameras'); return { bookingFolderId: 'box' } },
    ensurePhotoAlbumFolder: async () => { writes.push('photo'); return { bookingFolderId: 'photo' } },
    ensureSoundStagingFolder: async () => { writes.push('staging'); return { stagingFolderId: 'stg' } },
    upsertTextFile: async () => { writes.push('marker-file') },
  },
})
mock.module('../shoot-marker', {
  namedExports: {
    CANONICAL_MARKER_NAME: '_SHOOT.txt',
    ensureShootMarkerExists: async () => { writes.push('marker'); return 'skipped' },
  },
})
mock.module('../drive-links', { namedExports: { rememberDriveLinks: async () => { writes.push('links') } } })
mock.module('../booking-info', { namedExports: { renderBookingInfo: () => '', bookingInfoInput: (b: any) => b } })

let prep: typeof import('../prep-folders')
before(async () => {
  process.env.DRIVE_FOOTAGE_ROOT = 'root'
  prep = await import('../prep-folders')
})
beforeEach(() => { writes.length = 0; delivered.clear() })

const row = (code: string, over: any = {}) => ({
  id: code, bookingCode: code, cameraCount: 2, micCount: 0, projectId: null, projectName: 'Job', category: null,
  crewRequired: [] as string[], outlet: { code: 'NWS', name: 'News' }, program: { code: 'KYM', name: 'Key Message' },
  episodes: [] as any[], ...over,
})

test('dryRun reports exactly what the real run does: delivered → skip, sound → staging named, the rest → cameras', async () => {
  bookings = [row('NWS-KYM-261108-01'), row('NWS-KYM-261108-02', { crewRequired: ['Sound'] }), row('NWS-KYM-261108-03')]
  delivered.add('NWS-KYM-261108-01')

  const dry = await prep.prepTodayShootFolders({ dryRun: true })
  assert.equal(writes.length, 0, `a preview writes nothing (wrote: ${writes.join(', ')})`)
  const real = await prep.prepTodayShootFolders()

  const view = (r: typeof dry) => r.results.map(x => ({ code: x.bookingCode, skipped: x.skipped, cams: x.wouldCreate ?? x.created, staging: x.staging }))
  assert.deepEqual(view(dry), [
    { code: 'NWS-KYM-261108-01', skipped: 'footage already delivered — skip empty re-prep', cams: undefined, staging: undefined },
    { code: 'NWS-KYM-261108-02', skipped: undefined, cams: ['CAM-A', 'CAM-B'], staging: 'Job (NWS-KYM-261108-02)' },
    { code: 'NWS-KYM-261108-03', skipped: undefined, cams: ['CAM-A', 'CAM-B'], staging: undefined },
  ], 'pre-fix: the delivered booking previewed as wouldCreate CAM-A/B, and no staging was named')
  assert.deepEqual(view(real), view(dry))
  assert.equal(dry.prepared, real.prepared)
  assert.ok(writes.includes('staging') && writes.includes('marker'), 'the real run still writes (staging, delivered-marker repair)')
})
