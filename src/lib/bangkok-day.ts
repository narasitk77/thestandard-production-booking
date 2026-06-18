// One source of truth for "today" in the business timezone (Asia/Bangkok).
// The server runs UTC; comparing @db.Date fields against a UTC-midnight boundary
// drifts by one day for the ~7h each morning that is "yesterday" in UTC but
// "today" in Bangkok. Use these so the dashboard, the loans list, and the
// reminder engine all agree on which loans/rentals are overdue.

const BKK = 'Asia/Bangkok'

/** YYYY-MM-DD for "now" in Bangkok (lexicographically comparable to date strings). */
export function todayBangkokStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BKK }).format(new Date())
}

/**
 * Start of today in Bangkok, expressed as a UTC-midnight Date. Prisma stores
 * `@db.Date` as UTC midnight, so comparing `{ lt: startOfTodayBangkok() }` flags
 * everything dated strictly before today (Bangkok) — correct year-round.
 */
export function startOfTodayBangkok(): Date {
  const [y, m, d] = todayBangkokStr().split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
