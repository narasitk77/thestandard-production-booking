/**
 * v1.280 — ensureBoxDayFolders: กล่องก่อน หรือไม่ทำเลย (box first or nothing)
 *
 * The REAL google-drive code against a fake googleapis client (folders only): when any EP is missing from the box
 * it creates NOTHING anywhere — no camera slot, no day folder under the EPs that do exist — and names the missing
 * EP, so the caller skips the landing half and says so. A half-built box day layer would let video-merge move one
 * EP's landing CAM-X whole (with its still-empty D2/D3) while another EP merges day by day.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

type Folder = { id: string; name: string; parent: string; createdTime: string }
let folders: Folder[] = []
let created: Folder[] = []
let seq = 0
const add = (name: string, parent: string): string => {
  const f = { id: `f${++seq}`, name, parent, createdTime: new Date(seq * 1000).toISOString() }
  folders.push(f)
  return f.id
}
// just enough of drive.files for listChildFolders + ensureChildFolder: `'<id>' in parents` [+ `and name = '<n>'`]
const client = {
  files: {
    list: async ({ q }: { q: string }) => {
      const parent = /'([^']+)' in parents/.exec(q)![1]
      const name = /\bname = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\'/g, "'")
      return { data: { files: folders.filter(f => f.parent === parent && (name === undefined || f.name === name)).map(({ id, name, createdTime }) => ({ id, name, createdTime })) } }
    },
    create: async ({ requestBody }: { requestBody: { name: string; parents: string[] } }) => {
      const id = add(requestBody.name, requestBody.parents[0])
      created.push(folders.find(f => f.id === id)!)
      return { data: { id } }
    },
  },
}
mock.module('googleapis', { namedExports: { google: { drive: () => client, auth: { JWT: class {} } } } })

let gd: typeof import('../google-drive')
before(async () => { gd = await import('../google-drive') })
beforeEach(() => { folders = []; created = []; seq = 0 })

const DAYS = ['D1-261104', 'D2-261105']
const pathOf = (f: Folder): string => {
  const p = folders.find(x => x.id === f.parent)
  return p ? `${pathOf(p)}/${f.name}` : f.name
}

test('an EP missing from the box → nothing is created anywhere, and the missing EP is named', async () => {
  const box = add('box', 'root')
  add('EP01 · Morning', box) // EP02 was never made in the box
  const r = await gd.ensureBoxDayFolders({ boxFolderId: box, episodeFolderNames: ['EP01 · Morning', 'EP02 · Evening'], cameras: ['CAM-A', 'AUDIO'], dayFolders: DAYS })
  assert.deepEqual(r.missingEpisodes, ['EP02 · Evening'])
  assert.deepEqual(created, []) // not even EP01's camera slots or day folders
})

test('every EP present → box/<EP>/<slot>/<day>, matched by the EP lead like ensureEpisodeFolder (a retitled EP is reused)', async () => {
  const box = add('box', 'root')
  add('EP01 · Morning (old title)', box)
  add('EP02 · Evening', box)
  const r = await gd.ensureBoxDayFolders({ boxFolderId: box, episodeFolderNames: ['EP01 · Morning', 'EP02 · Evening'], cameras: ['CAM-A'], dayFolders: DAYS })
  assert.deepEqual(r.missingEpisodes, [])
  assert.deepEqual(created.map(pathOf).sort(), [
    'box/EP01 · Morning (old title)/CAM-A', 'box/EP01 · Morning (old title)/CAM-A/D1-261104', 'box/EP01 · Morning (old title)/CAM-A/D2-261105',
    'box/EP02 · Evening/CAM-A', 'box/EP02 · Evening/CAM-A/D1-261104', 'box/EP02 · Evening/CAM-A/D2-261105',
  ])
  // find-or-create: a second run makes nothing new
  created = []
  await gd.ensureBoxDayFolders({ boxFolderId: box, episodeFolderNames: ['EP01 · Morning', 'EP02 · Evening'], cameras: ['CAM-A'], dayFolders: DAYS })
  assert.deepEqual(created, [])
})

test('findEpisodeFolders is find-only: it reports a missing EP and creates nothing', async () => {
  const box = add('box', 'root')
  const ep1 = add('EP01 · Morning', box)
  const r = await gd.findEpisodeFolders(box, ['EP01 · Morning', 'EP02 · Evening'])
  assert.deepEqual(r, { ids: [ep1], missing: ['EP02 · Evening'] })
  assert.deepEqual(created, [])
})
