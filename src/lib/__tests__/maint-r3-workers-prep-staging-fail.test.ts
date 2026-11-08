// maint r3 2026-11-08 — a failed _SOUND-STAGING ensure was a console.error and nothing else: errors stayed 0, the
// booking's row did not mention staging, the worker printed `errors=0` — the sound team had no drop folder and no one
// knew. Now it counts in errors and shows on that booking's row as staging: 'FAILED: …'. Still non-fatal: the
// booking's video folders are prepped as before.
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'

let bookings: any[] = []
mock.module('../db', { namedExports: { prisma: { booking: { findMany: async () => bookings } } } })
mock.module('../google-drive', {
  namedExports: {
    hasDriveCredentials: () => true,
    findFoldersByCode: async () => [],
    isFootageTreeFolder: async () => true,
    listFilesRecursive: async () => [],
    listFilesInFolder: async () => [{ name: '_SHOOT.txt' }],
    ensureShootCameraFolders: async () => ({ bookingFolderId: 'box' }),
    ensurePhotoAlbumFolder: async () => ({ bookingFolderId: 'photo' }),
    ensureSoundStagingFolder: async () => { throw new Error('Drive 403 insufficientPermissions') },
    upsertTextFile: async () => {},
  },
})
mock.module('../shoot-marker', { namedExports: { CANONICAL_MARKER_NAME: '_SHOOT.txt', ensureShootMarkerExists: async () => 'skipped' } })
mock.module('../drive-links', { namedExports: { rememberDriveLinks: async () => {} } })
mock.module('../booking-info', { namedExports: { renderBookingInfo: () => '', bookingInfoInput: (b: any) => b } })

let prep: typeof import('../prep-folders')
before(async () => {
  process.env.DRIVE_FOOTAGE_ROOT = 'root'
  prep = await import('../prep-folders')
})

const row = (code: string, over: any = {}) => ({
  id: code, bookingCode: code, cameraCount: 2, micCount: 0, projectId: null, projectName: 'Job', category: null,
  crewRequired: [] as string[], outlet: { code: 'NWS', name: 'News' }, program: { code: 'KYM', name: 'Key Message' },
  episodes: [] as any[], ...over,
})

test('staging failure → errors counts it, the booking row says staging: FAILED, video prep still runs', async () => {
  bookings = [row('NWS-KYM-261108-01', { crewRequired: ['Sound'] }), row('NWS-KYM-261108-02')]
  const origErr = console.error
  console.error = () => {}
  let r: Awaited<ReturnType<typeof prep.prepTodayShootFolders>>
  try { r = await prep.prepTodayShootFolders() } finally { console.error = origErr }
  assert.equal(r.errors, 1, 'the worker line must read errors=1, not errors=0')
  const sound = r.results.find((x) => x.bookingCode === 'NWS-KYM-261108-01')!
  assert.match(sound.staging || '', /^FAILED: .*insufficientPermissions/)
  assert.deepEqual(sound.created, ['CAM-A', 'CAM-B'], 'video folders are still prepped (staging is non-fatal)')
  assert.equal(r.prepared, 2)
  assert.equal(r.results.find((x) => x.bookingCode === 'NWS-KYM-261108-02')!.staging, undefined)
})
