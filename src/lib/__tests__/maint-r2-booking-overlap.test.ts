// maint 2026-11-08 R2 (booking) — computeSlotLoad hands the calendar days to
// resource-load, so a multi-day candidate takes the peak PER DAY instead of
// stacking a Monday job and a Wednesday job as if they ran at the same time.
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'

let rows: any[] = []
mock.module('../db', {
  namedExports: {
    prisma: {
      booking: { findMany: async () => rows },
      teamMember: { count: async () => 0 },
    },
  },
})

let computeSlotLoad: typeof import('../booking-overlap').computeSlotLoad
before(async () => { ({ computeSlotLoad } = await import('../booking-overlap')) })

const job = (day: string, cams: number) => ({
  shootDate: new Date(`${day}T00:00:00Z`), shootEndDate: null, callTime: '09:00', estimatedWrap: '18:00',
  shootType: 'STUDIO', cameraCount: cams, videographerCount: 0, switcherCount: 0, crewRequired: [],
})

test('multi-day candidate: jobs on different days do not stack', async () => {
  rows = [job('2026-11-09', 4), job('2026-11-11', 4)]
  const { summary } = await computeSlotLoad({
    shootDate: '2026-11-09', shootEndDate: '2026-11-11', callTime: '09:00', estimatedWrap: '18:00', cameraCount: 3,
  })
  const cams = summary.lines.find(l => l.key === 'cameras')!
  assert.equal(cams.others, 4, 'max of one day, not 4 + 4')
  assert.equal(cams.over, false)
})

test('same day still sums concurrent jobs', async () => {
  rows = [job('2026-11-10', 4), job('2026-11-10', 4)]
  const { summary } = await computeSlotLoad({
    shootDate: '2026-11-09', shootEndDate: '2026-11-11', callTime: '09:00', estimatedWrap: '18:00', cameraCount: 3,
  })
  const cams = summary.lines.find(l => l.key === 'cameras')!
  assert.equal(cams.others, 8)
  assert.equal(cams.over, true)
})
