/**
 * v1.286 — /api/internal/episode-sync/run: who may call it, and that a write needs an explicit `apply: true`.
 * The logic itself is in episode-sync.test.ts; here the library is a recorder so the route's own promises are pinned:
 *  - no secret / wrong secret / non-admin session = 401 (a rename changes production identifiers)
 *  - dry run is the DEFAULT; only the boolean `true` writes — a non-boolean `apply` ("true", 1, "yes", null) is a 400,
 *    never a quiet preview that reads like a write
 *  - business refusals come back as HTTP 200 + ok:false (the operator's busybox wget drops non-2xx bodies)
 *  - malformed bodies are 400, a thrown library error is 500 with ok:false (never a 200 "ok")
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let session: any = null
let calls: Array<{ fn: string; args: any }> = []
let reportResult: any = { ok: true, dashboardEpisodes: 2, bookingRows: 5, drift: [] }
let renameResult: any = { ok: true }
let autoResult: any = { ok: true }
let boom = false

mock.module('../session', { namedExports: { getSession: async () => session } })
mock.module('../episode-sync', {
  namedExports: {
    driftReport: async () => { if (boom) throw new Error('kaboom'); calls.push({ fn: 'report', args: null }); return reportResult },
    renameEpisodeCode: async (a: any) => { if (boom) throw new Error('kaboom'); calls.push({ fn: 'rename', args: a }); return renameResult },
    autoApplyDrift: async (a: any) => { if (boom) throw new Error('kaboom'); calls.push({ fn: 'auto', args: a }); return autoResult },
  },
})

let GET: (r: any) => Promise<Response>
let POST: (r: any) => Promise<Response>
before(async () => {
  process.env.PREP_FOLDERS_SECRET = 'es-secret'
  ;({ GET, POST } = await import('../../app/api/internal/episode-sync/run/route'))
})
beforeEach(() => {
  session = null; calls = []; boom = false
  reportResult = { ok: true, dashboardEpisodes: 2, bookingRows: 5, drift: [] }
  renameResult = { ok: true }; autoResult = { ok: true }
})

const URL_ = 'https://probook.test/api/internal/episode-sync/run'
const get = (headers: Record<string, string> = {}) => new Request(URL_, { method: 'GET', headers }) as any
const post = (body: unknown, headers: Record<string, string> = { 'x-episode-sync-secret': 'es-secret' }) =>
  new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) as any

test('401 without a valid secret or an ADMIN session — GET and POST, nothing runs', async () => {
  assert.equal((await GET(get())).status, 401)
  assert.equal((await GET(get({ 'x-episode-sync-secret': 'wrong' }))).status, 401)
  assert.equal((await POST(post({ from: 'a', to: 'b' }, { 'x-episode-sync-secret': 'wrong' }))).status, 401)
  session = { role: 'PRODUCER', email: 'p@x' }
  assert.equal((await POST(post({ from: 'a', to: 'b' }, {}))).status, 401)
  assert.deepEqual(calls, [])
})

test('the NAS manifest secret is NOT accepted (the DSM box has no business renaming episodes)', async () => {
  process.env.NAS_MANIFEST_SECRET = 'nas-secret'
  try {
    assert.equal((await GET(get({ 'x-episode-sync-secret': 'nas-secret' }))).status, 401)
  } finally { delete process.env.NAS_MANIFEST_SECRET }
})

test('GET with a secret returns the report; an ADMIN session works too (actor = their email)', async () => {
  const res = await GET(get({ 'x-episode-sync-secret': 'es-secret' }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), reportResult)
  session = { role: 'ADMIN', email: 'nat@x' }
  renameResult = { ok: true, dryRun: true }
  await POST(post({ from: 'PP-26-056-H01', to: 'PP-26-056-S01' }, {}))
  assert.equal(calls.at(-1)!.args.actor, 'nat@x')
})

test('an unreadable Dashboard is HTTP 200 + ok:false with the reason (not a 5xx the operator tool would swallow)', async () => {
  reportResult = { ok: false, error: 'อ่าน Dashboard ไม่ได้: x' }
  const res = await GET(get({ 'x-episode-sync-secret': 'es-secret' }))
  assert.equal(res.status, 200)
  const b: any = await res.json()
  assert.equal(b.ok, false)
  assert.match(b.error, /อ่าน Dashboard ไม่ได้/)
})

test('POST rename is a DRY RUN by default; only the boolean true applies; apply:false stays a dry run', async () => {
  const body = { from: ' PP-26-056-H01 ', to: 'PP-26-056-S01' }
  await POST(post(body))
  assert.equal(calls.at(-1)!.args.dryRun, true)
  await POST(post({ ...body, apply: false }))
  assert.equal(calls.at(-1)!.args.dryRun, true)
  await POST(post({ ...body, apply: true }))
  assert.equal(calls.at(-1)!.args.dryRun, false)
  assert.equal(calls.at(-1)!.args.actor, 'episode-sync')
})

test('a NON-boolean apply is a 400 and calls nothing — never a preview that looks like a write', async () => {
  for (const apply of ['true', 1, 'yes', null, 0, [], {}]) {
    for (const extra of [{ from: 'PP-26-056-H01', to: 'PP-26-056-S01' }, { auto: true }]) {
      const res = await POST(post({ ...extra, apply }))
      assert.equal(res.status, 400, `apply=${JSON.stringify(apply)}`)
      assert.match(((await res.json()) as any).error, /boolean/)
    }
  }
  assert.deepEqual(calls, [])
})

test('a refused rename comes back as 200 + ok:false + the blockers', async () => {
  renameResult = { ok: false, blockers: ['รหัสใหม่ S01 มีอยู่แล้ว'] }
  const res = await POST(post({ from: 'PP-26-056-H01', to: 'PP-26-056-S01', apply: true }))
  assert.equal(res.status, 200)
  const b: any = await res.json()
  assert.equal(b.ok, false)
  assert.deepEqual(b.blockers, ['รหัสใหม่ S01 มีอยู่แล้ว'])
})

test('POST auto: apply defaults to false and is passed through only as a real boolean', async () => {
  await POST(post({ auto: true }))
  assert.deepEqual(calls.at(-1), { fn: 'auto', args: { apply: false, actor: 'episode-sync' } })
  await POST(post({ auto: true, apply: true }))
  assert.equal(calls.at(-1)!.args.apply, true)
})

test('an auto run where a pair failed comes back as 200 with the library\'s ok:false and the per-pair results (not rewritten to ok:true)', async () => {
  autoResult = { ok: false, failed: 1, applied: true, results: [{ ok: false, error: 'เขียนชีทไม่สำเร็จ' }] }
  const res = await POST(post({ auto: true, apply: true }))
  assert.equal(res.status, 200)
  const b: any = await res.json()
  assert.equal(b.ok, false)
  assert.equal(b.failed, 1)
  assert.equal(b.results[0].error, 'เขียนชีทไม่สำเร็จ')
})

test('the secret may also come as Authorization: Bearer', async () => {
  const res = await GET(get({ authorization: 'Bearer es-secret' }))
  assert.equal(res.status, 200)
  assert.equal((await GET(get({ authorization: 'Bearer nope' }))).status, 401)
})

test('malformed bodies are 400 and call nothing', async () => {
  for (const b of ['not json', '[]', {}, { from: 'a' }, { from: '  ', to: 'b' }, { from: 1, to: 2 }, { auto: 'true' }]) {
    const res = await POST(post(b as any))
    assert.equal(res.status, 400, JSON.stringify(b))
  }
  assert.deepEqual(calls, [])
})

test('a library crash is 500 with ok:false — never a 200', async () => {
  boom = true
  const g = await GET(get({ 'x-episode-sync-secret': 'es-secret' }))
  assert.equal(g.status, 500)
  assert.equal(((await g.json()) as any).ok, false)
  const p = await POST(post({ from: 'PP-26-056-H01', to: 'PP-26-056-S01', apply: true }))
  assert.equal(p.status, 500)
  assert.equal(((await p.json()) as any).ok, false)
  const a = await POST(post({ auto: true, apply: true }))
  assert.equal(a.status, 500)
  assert.equal(((await a.json()) as any).ok, false)
})

test('GET is read-only, always: it calls the report and nothing else', async () => {
  await GET(get({ 'x-episode-sync-secret': 'es-secret' }))
  assert.deepEqual(calls.map(c => c.fn), ['report'])
})

test('the secret the real caller sends ($NEXTAUTH_SECRET in the container) and AUTH_SECRET are accepted', async () => {
  process.env.NEXTAUTH_SECRET = 'na-secret'; process.env.AUTH_SECRET = 'au-secret'
  try {
    assert.equal((await GET(get({ 'x-episode-sync-secret': 'na-secret' }))).status, 200)
    assert.equal((await GET(get({ 'x-episode-sync-secret': 'au-secret' }))).status, 200)
  } finally { delete process.env.NEXTAUTH_SECRET; delete process.env.AUTH_SECRET }
})

test('a body with BOTH { auto: true } and from/to is ambiguous → 400, nothing runs', async () => {
  const res = await POST(post({ auto: true, from: 'PP-26-056-H01', to: 'PP-26-056-S01', apply: true }))
  assert.equal(res.status, 400)
  assert.deepEqual(calls, [])
})
