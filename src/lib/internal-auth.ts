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
 * sending NEXTAUTH_SECRET → silent hourly 401s ever since. All candidates live
 * in the same server env (one trust domain), so matching against the full set
 * of configured values is the intended behavior.
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
