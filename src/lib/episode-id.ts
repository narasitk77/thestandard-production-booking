/**
 * Episode ID format: [OUT]-[YYMMDD]-[PROG]-[EE]
 * e.g., TSS-260423-EXE-01
 *
 * Rules:
 * - Immutable once created
 * - Folder-only policy (ID on folder name, not individual files)
 * - Sequence resets per shoot date per program
 */

export function generateEpisodeId(
  outletCode: string,
  shootDate: Date,
  programCode: string,
  epSeq: number
): string {
  const yy = String(shootDate.getFullYear()).slice(-2)
  const mm = String(shootDate.getMonth() + 1).padStart(2, '0')
  const dd = String(shootDate.getDate()).padStart(2, '0')
  const seq = String(epSeq).padStart(2, '0')
  return `${outletCode}-${yy}${mm}${dd}-${programCode}-${seq}`
}

export function generateEpisodeIds(
  outletCode: string,
  shootDate: Date,
  programCode: string,
  count: number,
  startSeq = 1
): string[] {
  return Array.from({ length: count }, (_, i) =>
    generateEpisodeId(outletCode, shootDate, programCode, startSeq + i)
  )
}

export function parseEpisodeId(episodeId: string): {
  outletCode: string
  dateStr: string
  programCode: string
  sequence: number
  shootDate: Date
} | null {
  const match = episodeId.match(/^([A-Z]{2,4})-(\d{6})-([A-Z0-9]{2,4})-(\d{2})$/)
  if (!match) return null

  const [, outletCode, dateStr, programCode, seqStr] = match
  const yy = parseInt(dateStr.slice(0, 2)) + 2000
  const mm = parseInt(dateStr.slice(2, 4)) - 1
  const dd = parseInt(dateStr.slice(4, 6))

  return {
    outletCode,
    dateStr,
    programCode,
    sequence: parseInt(seqStr),
    shootDate: new Date(yy, mm, dd),
  }
}

export function formatShootDateForId(date: Date): string {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}
