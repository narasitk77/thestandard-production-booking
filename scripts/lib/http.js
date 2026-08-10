// Shared HTTP client for the supervised worker scripts (CommonJS — run by start.sh).
//
// WHY THIS EXISTS — v1.172
//
// Node's global `fetch()` is undici, and undici's `headersTimeout` defaults to
// 300 seconds: if the server hasn't produced response *headers* within five
// minutes the request is destroyed and you get an opaque `TypeError: fetch
// failed`. Several of the endpoints these workers poke legitimately run longer
// than that — they walk every booking's Drive tree in one pass.
//
// On 2026-08-10 that produced a two-day run of `[sound-merge] run failed: fetch
// failed`, 48 out of 48 hourly runs. It was never a real failure. The worker
// banner logged at 10:20:12, the first run fires at load+120s, and the failure
// landed at 10:27:13 — exactly +301s; every later hourly failure landed at
// :25:1x, exactly +300s after the :20:1x timer tick. Meanwhile
// /api/health-summary showed the sound-merge heartbeat written ~46 seconds
// AFTER the "failure", i.e. the run finished in ~5m46s and did its job.
//
// The cost of that isn't the noise, it's the blindness: when every run reports
// the same failure, a real failure is unreportable.
//
// node:http / node:https have no headers cap. `timeoutMs` below is a socket
// INACTIVITY timeout, which is the semantic we actually want — an endpoint that
// is still working is fine, a connection that has gone silent is not. undici
// cannot express this, and `undici` is not a dependency of this repo (checked:
// not in package.json, not resolvable), so we use the stdlib directly rather
// than adding one for a scheduler that makes one request per hour.
//
// AbortSignal is not an escape hatch here: a signal can only make a request
// give up EARLIER than undici's 300s, never later.

const http = require('node:http')
const https = require('node:https')

// 30 minutes. The worst pass observed in production is ~6 minutes, so this is
// ~5x headroom while still catching a genuinely wedged request well before the
// next hourly tick. Override with WORKER_HTTP_TIMEOUT_MS when an endpoint
// legitimately needs longer.
const DEFAULT_TIMEOUT_MS = 30 * 60_000

function resolveTimeoutMs(explicit) {
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const fromEnv = Number(process.env.WORKER_HTTP_TIMEOUT_MS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return DEFAULT_TIMEOUT_MS
}

/**
 * GET/POST a worker endpoint and read the whole body as text.
 *
 * Deliberately mirrors the shape the workers already used, so a call site
 * changes from
 *     const res = await fetch(url, { headers }); const text = await res.text()
 * to
 *     const res = await httpRequest(url, { headers }); const text = res.text
 * and nothing else about the worker moves.
 *
 * @returns {Promise<{ ok: boolean, status: number, text: string }>}
 *   Resolves for ANY status code — `ok` is status 2xx, exactly like fetch.
 *   Rejects only on transport failure (connection refused, DNS, inactivity
 *   timeout), also like fetch.
 */
function httpRequest(url, { method = 'GET', headers = {}, timeoutMs } = {}) {
  const timeout = resolveTimeoutMs(timeoutMs)
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error(`invalid worker URL: ${url}`))
      return
    }
    const mod = target.protocol === 'https:' ? https : http
    const req = mod.request(target, { method, headers }, (res) => {
      res.setEncoding('utf8')
      let body = ''
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        const status = res.statusCode || 0
        resolve({ ok: status >= 200 && status < 300, status, text: body })
      })
      // A socket that dies mid-body must reject rather than resolve with a
      // truncated body that JSON.parse would then blame on the endpoint.
      res.on('error', reject)
    })
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`no activity for ${Math.round(timeout / 1000)}s — giving up`))
    })
    req.on('error', reject)
    req.end()
  })
}

module.exports = { httpRequest, DEFAULT_TIMEOUT_MS }
