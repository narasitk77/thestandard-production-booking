import { NextResponse } from 'next/server'
import pkg from '../../../../package.json'

export const dynamic = 'force-dynamic'

/**
 * GET /api/version — what's actually deployed. Public, no secrets: app version
 * (package.json) + the build commit (APP_GIT_SHA, stamped by CI). Lets anyone
 * confirm the running container matches the intended release after a deploy.
 */
export function GET() {
  const sha = process.env.APP_GIT_SHA || ''
  return NextResponse.json({
    version: pkg.version,
    commit: sha || null,
    imageTag: sha ? `sha-${sha.slice(0, 7)}` : null,
  })
}
