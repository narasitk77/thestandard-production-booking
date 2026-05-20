/**
 * Minimal CSV helpers used by the audit-log export endpoint.
 *
 * - Prepends a UTF-8 BOM so Excel opens Thai-language values without mojibake.
 * - Escapes quotes, newlines, and embedded commas per RFC 4180.
 * - `streamCSV` produces a ReadableStream so the export route can hand it
 *   straight to a NextResponse without buffering the full result set.
 */

export const UTF8_BOM = '﻿'

export function escapeCSVCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const raw =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  const needsQuoting = /[",\n\r]/.test(raw)
  const escaped = raw.replace(/"/g, '""')
  return needsQuoting ? `"${escaped}"` : escaped
}

export function rowToCSV(cells: unknown[]): string {
  return cells.map(escapeCSVCell).join(',')
}

export function buildCSVHeader(columns: string[]): string {
  return UTF8_BOM + rowToCSV(columns) + '\n'
}

/**
 * Async-iterable rows → ReadableStream of CSV bytes. Yields the BOM + header
 * line first, then one line per row. Caller controls page size by yielding
 * batches from `rowsAsync`.
 */
export function streamCSV<T>(
  columns: string[],
  rowsAsync: AsyncIterable<T>,
  toCells: (row: T) => unknown[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let iter: AsyncIterator<T> | null = null
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(buildCSVHeader(columns)))
      iter = rowsAsync[Symbol.asyncIterator]()
    },
    async pull(controller) {
      if (!iter) {
        controller.close()
        return
      }
      const { value, done } = await iter.next()
      if (done) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(rowToCSV(toCells(value)) + '\n'))
    },
    cancel() {
      iter?.return?.()
    },
  })
}

export function csvFilename(prefix: string, fromISO: string, toISO: string): string {
  const safe = (s: string) => s.replace(/[^0-9A-Za-z-]/g, '').slice(0, 10)
  return `${prefix}-${safe(fromISO)}-to-${safe(toISO)}.csv`
}
