/**
 * v1.175 — Week Plan → plain text.
 *
 * The operator fills อุปกรณ์ / เช่า for a week and then has to tell people what
 * was arranged. Screenshotting the page loses the text and cannot be searched;
 * this renders the same week as something paste-able into LINE/mail.
 *
 * Pure and formatted here (not in the component) so the shape is pinned by tests
 * — the output is read by humans in a chat window, where a stray blank line or a
 * missing "—" is the difference between scannable and noise.
 */

export type ExportRow = {
  /** "08:00 → 11:00" — already resolved, including the estimated-wrap marker. */
  time: string
  /** "WLT · New Gen Investor" */
  title: string
  cameraCount?: number | null
  equipment?: string | null
  rental?: string | null
}

export type ExportDay = {
  /** "อ. 18 Aug" */
  label: string
  rows: ExportRow[]
}

const DASH = '—'

/** Blank, whitespace-only and null all mean "not filled in yet". */
function has(v: string | null | undefined): boolean {
  return !!(v && v.trim())
}

export function countFilled(rows: ExportRow[]): number {
  return rows.filter(r => has(r.equipment) || has(r.rental)).length
}

/**
 * Multi-line body for one shoot. Equipment and rental always BOTH appear, even
 * when empty: a missing line reads as "nothing needed", while "—" reads as
 * "nobody has filled this in" — which is the thing the operator is chasing.
 */
function renderRow(r: ExportRow): string[] {
  const cams = typeof r.cameraCount === 'number' && r.cameraCount > 0 ? `  🎥${r.cameraCount}` : ''
  return [
    `• ${r.time}  ${r.title}${cams}`,
    `    อุปกรณ์: ${has(r.equipment) ? r.equipment!.trim().replace(/\s*\n\s*/g, ' / ') : DASH}`,
    `    เช่า: ${has(r.rental) ? r.rental!.trim().replace(/\s*\n\s*/g, ' / ') : DASH}`,
  ]
}

export function buildWeekPlanText(input: {
  weekLabel: string
  days: ExportDay[]
  /** Only shoots that already have อุปกรณ์ or เช่า filled in. */
  filledOnly?: boolean
}): string {
  const { weekLabel, days, filledOnly = false } = input
  const out: string[] = [`📅 Week Plan · อุปกรณ์ / เช่า`, weekLabel, '']

  let shown = 0
  for (const day of days) {
    const rows = filledOnly ? day.rows.filter(r => has(r.equipment) || has(r.rental)) : day.rows
    // A day with no shoots at all is skipped — an empty heading is just noise in
    // a chat message. In filledOnly mode a day nobody has touched is skipped too.
    if (rows.length === 0) continue
    shown += rows.length
    const filled = countFilled(day.rows)
    out.push(`━━ ${day.label} · ${day.rows.length} งาน · ใส่แล้ว ${filled}/${day.rows.length}`)
    for (const r of rows) out.push(...renderRow(r))
    out.push('')
  }

  if (shown === 0) out.push(filledOnly ? '(ยังไม่มีงานที่กรอกอุปกรณ์/เช่า)' : '(ไม่มีงานในสัปดาห์นี้)')
  // One trailing newline at most — chat clients turn a run of blanks into a gap.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
