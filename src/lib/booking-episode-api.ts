/**
 * Booking → Episode ID  ·  Web App client
 * ---------------------------------------
 * Calls the Apps Script Web App on the Producer Dashboard sheet to request
 * Episode IDs for a project-linked booking. The Web App is the SINGLE owner
 * of the EP_SEQ_<project>_<type> counter, so booking-created and hand-typed
 * episodes share one continuous sequence — no collisions possible.
 *
 * Configure via env (set in Portainer stack environment):
 *   BOOKING_EPISODE_WEBAPP_URL    — full URL of the deployed Web App
 *                                  (ends in /exec for Apps Script)
 *   BOOKING_EPISODE_WEBAPP_SECRET — matches BOOKING_API_SECRET in the script
 *
 * If either var is missing, requestEpisodeIds returns an error result; the
 * booking POST then refuses to create a project-linked booking with a clear
 * message, so the misconfiguration is obvious instead of silently falling
 * back to a locally-generated ID that wouldn't match the sheet.
 */

export type EpisodeType = 'L' | 'S' | 'A' | 'T'
export const EPISODE_TYPES: ReadonlyArray<EpisodeType> = ['L', 'S', 'A', 'T']

export type RequestEpisodeIdsInput = {
  projectId: string
  type: EpisodeType
  count: number
  titles?: string[]
}

export type RequestEpisodeIdsResult =
  | { ok: true; episodeIds: string[] }
  | { ok: false; error: string }

export function isWebAppConfigured(): boolean {
  return Boolean(
    process.env.BOOKING_EPISODE_WEBAPP_URL &&
      process.env.BOOKING_EPISODE_WEBAPP_SECRET,
  )
}

export async function requestEpisodeIds(
  input: RequestEpisodeIdsInput,
): Promise<RequestEpisodeIdsResult> {
  const url = process.env.BOOKING_EPISODE_WEBAPP_URL
  const secret = process.env.BOOKING_EPISODE_WEBAPP_SECRET
  if (!url || !secret) {
    return { ok: false, error: 'BOOKING_EPISODE_WEBAPP_URL / SECRET not configured' }
  }
  // Bulletproof timeout. AbortController alone is NOT enough: a socket wedged
  // in DNS resolution or TCP connect (this host has documented IPv6-egress
  // issues with Google hosts) may never honour the abort, so the await would
  // hang indefinitely → the booking POST never responds → NPM returns an HTML
  // 502. We therefore Promise.race the request against a hard timer that ALWAYS
  // resolves: even if the underlying fetch stays wedged forever, this function
  // returns within TIMEOUT_MS and the caller falls back to local Episode IDs.
  const TIMEOUT_MS = 12_000
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let guardTimer: ReturnType<typeof setTimeout> | undefined

  const doRequest = async (): Promise<RequestEpisodeIdsResult> => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Apps Script Web Apps redirect to script.googleusercontent.com on POST.
        // Node fetch follows redirects by default; explicit here for clarity.
        redirect: 'follow',
        signal: controller.signal,
        body: JSON.stringify({
          secret,
          projectId: input.projectId,
          type: input.type,
          count: input.count,
          titles: input.titles || [],
        }),
      })
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}` }
      }
      // Apps Script can answer 200 with an HTML error/login page. Guard the
      // parse so that surfaces as a clean error string, not an unhandled throw.
      const text = await res.text()
      let data: any
      try {
        data = JSON.parse(text)
      } catch {
        return { ok: false, error: `non-JSON response from Web App: ${text.slice(0, 80)}` }
      }
      if (!data || data.ok !== true || !Array.isArray(data.episodeIds)) {
        return { ok: false, error: (data && data.error) || 'malformed response' }
      }
      return { ok: true, episodeIds: data.episodeIds as string[] }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        return { ok: false, error: `Web App aborted after ${TIMEOUT_MS}ms` }
      }
      return { ok: false, error: (e && e.message) || String(e) }
    }
  }

  // Hard backstop: resolves the race even if doRequest's fetch never settles.
  const guard = new Promise<RequestEpisodeIdsResult>(resolve => {
    guardTimer = setTimeout(
      () => resolve({ ok: false, error: `Web App timed out (hard) after ${TIMEOUT_MS}ms` }),
      TIMEOUT_MS,
    )
  })

  try {
    return await Promise.race([doRequest(), guard])
  } finally {
    clearTimeout(abortTimer)
    if (guardTimer) clearTimeout(guardTimer)
  }
}
