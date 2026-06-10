/**
 * escapeCSVCell — RFC 4180 escaping plus spreadsheet formula-injection
 * neutralization (OWASP: prefix `=` `+` `-` `@` tab CR with an apostrophe).
 * Covers the bookings, OT, and audit-log CSV exports.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeCSVCell, rowToCSV } from '../csv'

test('plain values pass through unchanged', () => {
  assert.equal(escapeCSVCell('End Game'), 'End Game')
  assert.equal(escapeCSVCell('NWS-KYM-260616-L-01'), 'NWS-KYM-260616-L-01')
  assert.equal(escapeCSVCell(42), '42')
  assert.equal(escapeCSVCell(null), '')
  assert.equal(escapeCSVCell(undefined), '')
})

test('quotes, commas, and newlines are escaped per RFC 4180', () => {
  assert.equal(escapeCSVCell('a,b'), '"a,b"')
  assert.equal(escapeCSVCell('say "hi"'), '"say ""hi"""')
  assert.equal(escapeCSVCell('line1\nline2'), '"line1\nline2"')
})

test('formula-leading cells are neutralized with an apostrophe', () => {
  assert.equal(escapeCSVCell('=1+1'), "'=1+1")
  assert.equal(escapeCSVCell('+66 81 234 5678'), "'+66 81 234 5678")
  assert.equal(escapeCSVCell('-cmd'), "'-cmd")
  assert.equal(escapeCSVCell('@SUM(A1)'), "'@SUM(A1)")
  assert.equal(escapeCSVCell('\tpayload'), "'\tpayload")
  assert.equal(escapeCSVCell('\rpayload'), '"\'\rpayload"')
})

test('neutralized formula containing quotes/commas is still quoted correctly', () => {
  assert.equal(
    escapeCSVCell('=HYPERLINK("http://evil.test","click")'),
    '"\'=HYPERLINK(""http://evil.test"",""click"")"',
  )
  assert.equal(escapeCSVCell('=2+5,9'), '"\'=2+5,9"')
})

test('actual numbers keep their sign — no apostrophe', () => {
  assert.equal(escapeCSVCell(-5), '-5')
  assert.equal(escapeCSVCell(-1.5), '-1.5')
})

test('numeric-looking strings starting with - are still neutralized', () => {
  assert.equal(escapeCSVCell('-5'), "'-5")
})

test('rowToCSV applies neutralization per cell', () => {
  assert.equal(rowToCSV(['a', '=2+2', 'c,d']), 'a,\'=2+2,"c,d"')
})
