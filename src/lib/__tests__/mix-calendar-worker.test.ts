// v1.247 — scripts/mix-calendar-worker.js: อะไรนับว่า "ล้ม" (ต้องดัง) และอะไรนับว่า "ไม่มีอะไรทำ" (เงียบ)
//
// worker ตัวนี้มีไว้ซ่อมปฏิทินที่ทั้งโดเมนดูอยู่ · worker ที่รายงานว่าสำเร็จทั้งที่ซิงก์ล้ม
// แย่กว่าไม่มี worker เพราะมันทำให้เลิกดู (bug class 11 "silence is not success") ·
// เทสยิงเซิร์ฟเวอร์ปลอมผ่าน httpRequest ตัวจริง แบบเดียวกับ worker-http.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { syncOnce } = require_('../../../scripts/mix-calendar-worker.js') as {
  syncOnce: (url: string, headers: Record<string, string>, timeoutMs?: number) =>
    Promise<{ failed: boolean; quiet?: boolean; line: string }>
}

/** เซิร์ฟเวอร์ที่ตอบ status + body ตายตัว (null = ไม่ตอบเลย) · คืน url + ตัวปิด + header ที่ได้รับ */
async function serve(status: number | null, body = '') {
  const seen: { url?: string; secret?: string } = {}
  const server = http.createServer((req, res) => {
    seen.url = req.url
    seen.secret = req.headers['x-reconcile-secret'] as string
    if (status === null) return // เงียบ — ให้ timeout ทำงาน
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/api/internal/mix-calendar/sync?dryRun=0`,
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

async function run(status: number | null, body: unknown, timeoutMs = 5_000) {
  const s = await serve(status, typeof body === 'string' ? body : JSON.stringify(body))
  try {
    return { r: await syncOnce(s.url, { 'x-reconcile-secret': 's3cr3t' }, timeoutMs), seen: s.seen }
  } finally {
    await s.close()
  }
}

// บรรทัดล้มต้องเข้า BAD_RE ของ scripts/hermes/probook-worker-check.py (ตัวเฝ้าจากนอกคอนเทนเนอร์)
const HERMES_BAD_RE = /run failed|no activity for|route error|\] [45]\d\d:/
const logged = (line: string) => `[mix-calendar] ${line}`

test('ซิงก์ครบ = สำเร็จ · ส่ง secret ไปที่ route จริง', async () => {
  const { r, seen } = await run(200, { ok: true, counts: { create: 1, update: 2, delete: 0, none: 0 }, failed: 0, results: [] })
  assert.equal(r.failed, false)
  assert.ok(!r.quiet)
  assert.match(r.line, /create=1 update=2 delete=0 failed=0/)
  assert.equal(seen.secret, 's3cr3t')
  assert.equal(seen.url, '/api/internal/mix-calendar/sync?dryRun=0')
})

test('off:true (ไม่ได้ตั้ง MIX_CALENDAR_ID) = เงียบ ไม่ใช่ล้ม', async () => {
  const { r } = await run(200, { ok: true, off: true, note: 'MIX_CALENDAR_ID ไม่ได้ตั้ง' })
  assert.equal(r.failed, false)
  assert.equal(r.quiet, true)
})

test('failed>0 = ล้ม และบอกว่างานไหน · แม้ HTTP 200', async () => {
  const { r } = await run(200, {
    ok: false, counts: { create: 1, update: 1, delete: 0, none: 0 }, failed: 1,
    results: [{ code: 'MIX-003', plan: 'create', action: 'create', ok: false, error: 'Rate Limit Exceeded' }],
  })
  assert.equal(r.failed, true)
  assert.match(r.line, /MIX-003 create: Rate Limit Exceeded/)
  assert.match(logged(r.line), HERMES_BAD_RE)

  // failed นับเองโดยไม่พึ่ง ok — สองช่องนี้ขัดกันเมื่อไหร่ ให้เชื่อฝั่งที่บอกว่าล้ม
  const { r: r2 } = await run(200, { ok: true, counts: {}, failed: 2, results: [] })
  assert.equal(r2.failed, true)
})

test('ok ไม่ใช่ true = ล้ม (body ที่ไม่มี ok ไม่ใช่หลักฐานว่าสำเร็จ)', async () => {
  for (const body of [{ counts: {}, failed: 0 }, { ok: false, error: 'x' }, { ok: 'true', failed: 0 }]) {
    const { r } = await run(200, body)
    assert.equal(r.failed, true, JSON.stringify(body))
    assert.match(logged(r.line), HERMES_BAD_RE)
  }
})

test('non-2xx = ล้ม ทุกตัว (401 secret ไม่ตรง · 400 ตั้งปฏิทินผิด · 502 preflight · 500 แครช)', async () => {
  for (const status of [401, 400, 502, 500]) {
    const { r } = await run(status, { ok: false, error: `e${status}` })
    assert.equal(r.failed, true, String(status))
    assert.match(r.line, new RegExp(`^${status}: `))
    assert.match(logged(r.line), HERMES_BAD_RE)
  }
})

test('timeout ไม่ใช่ความสำเร็จ', async () => {
  const { r } = await run(null, '', 300)
  assert.equal(r.failed, true)
  assert.match(r.line, /no activity for/)
  assert.match(logged(r.line), HERMES_BAD_RE)
})

test('ต่อไม่ติด / ตอบ 200 แต่ไม่ใช่ JSON = ล้ม ไม่ใช่ throw', async () => {
  const refused = await syncOnce('http://127.0.0.1:1/api/internal/mix-calendar/sync?dryRun=0', {}, 2_000)
  assert.equal(refused.failed, true)
  assert.match(logged(refused.line), HERMES_BAD_RE)

  const { r } = await run(200, '<html>502 Bad Gateway</html>')
  assert.equal(r.failed, true)
  assert.match(logged(r.line), HERMES_BAD_RE)
})

test('truncated ถูกพิมพ์ออกมา (ธงที่ไม่มีคนอ่าน = ไม่มีธง)', async () => {
  const { r } = await run(200, { ok: true, counts: { create: 0, update: 300, delete: 0, none: 0 }, failed: 0, truncated: true })
  assert.equal(r.failed, false)
  assert.match(r.line, /TRUNCATED/)
})
