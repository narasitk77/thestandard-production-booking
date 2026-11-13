import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// v1.288 — the route must carry the agent's MEDIAPRO cards through to ingest (dropping them = the short-card check
// goes silently dead), capped so a runaway agent cannot stuff the row.

let ingested: any = null
mock.module('../internal-auth', { namedExports: { internalSecretAllowed: () => true } })
mock.module('../session', { namedExports: { getSession: async () => null } })
mock.module('../nas-sync', { namedExports: { ingestNasManifest: async (m: any) => { ingested = m; return { sendingCount: 0, sentCount: 0, folders: m.folders } } } })

let POST: any
before(async () => { ({ POST } = await import('../../app/api/internal/nas-manifest/route')) })
beforeEach(() => { ingested = null })
const req = (body: any) => new Request('http://x/api/internal/nas-manifest', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) as any

test('cards ไปถึง ingest (dir + origs + error) · ไม่มี cards = ไม่มี key · ตัดเพดาน', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ dir: `C${i}`, origs: ['Clip/A.MXF'] }))
  const res = await POST(req({ at: 'x', folders: [
    { name: 'A (NWS-KYM-261110-01)', files: [{ p: 'EP01/CAM-A/XDROOT/Clip/A.MXF', size: 5 }],
      cards: [{ dir: 'EP01/CAM-A/XDROOT', origs: ['Clip/A.MXF', 7] }, { dir: 'EP01/CAM-B/XDROOT', error: 'ParseError: x'.repeat(100) }] },
    { name: 'B (NWS-KYM-261110-02)', files: [] },
    { name: 'C (NWS-KYM-261110-03)', files: [], cards: many },
  ] }))
  assert.equal(res.status, 200)
  const [a, b, c] = ingested.folders
  assert.deepEqual(a.cards[0], { dir: 'EP01/CAM-A/XDROOT', origs: ['Clip/A.MXF', '7'] })
  assert.equal(a.cards[1].dir, 'EP01/CAM-B/XDROOT')
  assert.ok(a.cards[1].error.length <= 300)
  assert.equal('cards' in b, false)
  assert.equal(c.cards.length, 50)
})
