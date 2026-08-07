// Shared helpers for the supervised worker scripts (CommonJS — run by start.sh).

// Parse a numeric env var safely. `Number('abc')` is NaN, and `setInterval(fn,
// NaN)` is silently clamped to ~1ms — i.e. a busy loop that hammers the API and
// the DB. Guard against that by falling back to the default whenever the value
// isn't a finite, positive number.
function parsePositiveInt(envValue, fallback) {
  if (envValue == null || envValue === '') return fallback
  const n = Number(envValue)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// v1.168 — where the worker should send its request.
//
// Every supervised worker is a THIN SCHEDULER: it sleeps until its hour, then
// calls one `/api/internal/...` endpoint on the app. Nothing here touches
// Postgres or Drive. That is what makes the workers relocatable — point them at
// a different app and they keep working unchanged.
//
// Resolution order, most specific first:
//   1. the worker's own URL var (VIDEO_MERGE_URL, LANDING_MANAGE_URL, …) —
//      still honoured so a single worker can be pointed somewhere special
//   2. WORKER_APP_URL — set once when the workers run in their OWN container,
//      e.g. http://app:3000 inside the compose network
//   3. 127.0.0.1:3000 — the historical default, i.e. "same container as the app"
//
// Prefer the in-network service name over the public URL: the reverse proxy
// times out long Drive-mutating endpoints at ~60s (the recurring 504), while a
// direct container-to-container call has no such limit.
function appBaseUrl(specificEnvValue) {
  const pick = (specificEnvValue || '').trim()
    || (process.env.WORKER_APP_URL || '').trim()
    || 'http://127.0.0.1:3000'
  return pick.replace(/\/+$/, '')
}

module.exports = { parsePositiveInt, appBaseUrl }
