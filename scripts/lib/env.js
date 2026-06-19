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

module.exports = { parsePositiveInt }
