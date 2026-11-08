import type { NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'

/**
 * v1.123 — internal-worker auth that accepts ANY configured secret, not just the
 * first-set env var.
 *
 * The old per-route pattern (`A || B || C` then a single equality) broke the
 * moment prod defined a higher-precedence var the worker didn't know about:
 * v1.113.4 inserted NAS_MANIFEST_SECRET into sound-merge's chain, so the route
 * started expecting the NAS secret while scripts/sound-merge-worker.js kept
 * sending NEXTAUTH_SECRET → silent hourly 401s ever since. Matching against
 * the full set of configured values is the intended behavior.
 *
 * ⚠️ NOT one trust domain (corrected 2026-11-08): NAS_MANIFEST_SECRET also
 * lives on the IT-managed DSM box (nas_manifest_agent.py, since 21 Oct 2026),
 * so every route that lists it grants that box what the route does. Only list
 * it where the NAS agent itself needs to call.
 */
export function internalSecretAllowed(
  request: NextRequest,
  headerName: string,
  envKeys: string[],
): boolean {
  const provided = [
    request.headers.get(headerName)?.trim(),
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim(),
  ].filter((v): v is string => Boolean(v))
  if (provided.length === 0) return false
  const valid = envKeys
    .map((k) => process.env[k]?.trim())
    .filter((v): v is string => Boolean(v))
  // v1.146 review fix — constant-time compare, same as /api/mcp: a plain
  // Set.has/=== leaks how many leading bytes matched via timing.
  return provided.some((p) => {
    const pb = Buffer.from(p)
    return valid.some((v) => {
      const vb = Buffer.from(v)
      return pb.length === vb.length && timingSafeEqual(pb, vb)
    })
  })
}

/**
 * maint 2026-11-08 — CSRF: a request ANOTHER site made the browser send.
 *
 * The session cookie is SameSite=Lax (next-auth default), so any page on a
 * sibling *.thestandard.co host is "same-site" and gets the cookie attached to
 * an `<img src=…/api/internal/video-merge/run>` or an auto-submitted form —
 * one page view by an admin = a real MOVE. getSession() asks this before it
 * hands out a session, so every route behind getSession/requireAdmin/
 * requireConsole is covered without touching the routes.
 *
 * Refused: cross-site/same-site requests that are NOT a top-level GET
 * navigation (subresources, fetch, and form POSTs — a POST navigation carries
 * `Origin`, a GET navigation never does). Still allowed: links clicked in
 * chat/mail/Google Docs (GET navigation — pages need that), same-origin calls
 * from the app itself, and non-browser callers (curl/workers send no
 * Sec-Fetch-* headers; they authenticate with a secret anyway).
 * ponytail: a link that GETs a state-changing API still works with an admin
 * session — closing that needs POST-only/dryRun-default on those routes.
 */
export function isCrossSiteRequest(h: { get(name: string): string | null }): boolean {
  const site = h.get('sec-fetch-site')
  if (site !== 'cross-site' && site !== 'same-site') return false
  return h.get('sec-fetch-mode') !== 'navigate' || !!h.get('origin')
}
