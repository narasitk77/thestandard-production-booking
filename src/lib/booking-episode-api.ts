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
  // Hard timeout so a slow/hanging Apps Script Web App can't keep the booking
  // POST open long enough for the upstream proxy to time out and return an HTML
  // 504 page (which would surface to the client as "Unexpected token '<'").
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
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
    // Apps Script can answer 200 with an HTML error/login page. Guard the parse
    // so that surfaces as a clean error string, not an unhandled throw.
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
      return { ok: false, error: 'Web App timed out after 15s' }
    }
    return { ok: false, error: (e && e.message) || String(e) }
  } finally {
    clearTimeout(timer)
  }
}
