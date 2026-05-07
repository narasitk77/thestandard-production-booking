import type { JWT } from 'next-auth/jwt'

/**
 * Refresh-aware access-token resolver for API routes.
 *
 * NextAuth's `jwt` callback only runs on sign-in / session reads, so a JWT
 * cookie can hold an expired Google access token while the API route reads it
 * via `getToken()`. Calling Gmail with that stale token yields 401.
 *
 * This helper checks expiry and, if needed, exchanges the stored refresh
 * token for a fresh access token directly against Google's OAuth endpoint.
 * The refreshed token is NOT written back to the cookie — it's returned for
 * one-shot use. The cookie will catch up the next time NextAuth runs its
 * `jwt` callback (e.g. on the next page load).
 */
export async function getValidGoogleAccessToken(
  token: JWT | null | undefined
): Promise<string | null> {
  if (!token) return null

  const accessToken = typeof (token as any).accessToken === 'string' ? (token as any).accessToken : null
  const refreshToken = typeof (token as any).refreshToken === 'string' ? (token as any).refreshToken : null
  const expiresAt = typeof (token as any).accessTokenExpires === 'number' ? (token as any).accessTokenExpires : 0

  // Still valid for at least 60s — use as-is.
  if (accessToken && expiresAt && Date.now() < expiresAt - 60_000) {
    return accessToken
  }

  // Need a refresh — but no refresh token means we're stuck.
  if (!refreshToken) {
    return accessToken // best-effort; caller will see the 401 and surface a hint
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      console.error('Google token refresh failed:', data)
      return accessToken
    }
    return typeof data.access_token === 'string' ? data.access_token : accessToken
  } catch (err) {
    console.error('Google token refresh threw:', err)
    return accessToken
  }
}
