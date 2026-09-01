import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  inferFieldType, buildFieldDefs, toCell, mapRecords, baseTableName,
  MAX_CELL_CHARS, TOMBSTONE_TABLE_NAME,
} from '../lark-base-mapping'
import {
  LARK_FIELD_TEXT, LARK_FIELD_NUMBER, LARK_FIELD_DATETIME, LARK_FIELD_CHECKBOX,
} from '../lark-client'

// v1.212 — a Bitable field's type is fixed at creation and a bad cell rejects
// the WHOLE batch. So the two things worth locking are: infer conservatively,
// and never lose something without counting it.

test('types are inferred from the values present', () => {
  assert.equal(inferFieldType([1, 2, 3]), LARK_FIELD_NUMBER)
  assert.equal(inferFieldType([true, false]), LARK_FIELD_CHECKBOX)
  assert.equal(inferFieldType(['2026-08-31T00:00:00.000Z']), LARK_FIELD_DATETIME)
  assert.equal(inferFieldType(['AGN-260630-01']), LARK_FIELD_TEXT)
})

test('an all-null column is Text, which accepts anything later', () => {
  assert.equal(inferFieldType([null, null, undefined]), LARK_FIELD_TEXT)
})

test('mixed types collapse to Text rather than picking a winner', () => {
  // The safe direction: Text accepts every value, a wrong specific type accepts
  // none — and the field cannot be retyped once the table exists.
  assert.equal(inferFieldType([1, 'n/a']), LARK_FIELD_TEXT)
  assert.equal(inferFieldType(['2026-08-31T00:00:00.000Z', 'ยังไม่ระบุ']), LARK_FIELD_TEXT)
})

test('inference looks past a long run of nulls', () => {
  // A column null for the first 200 rows and numeric after would otherwise be
  // typed Text forever, on the very first night.
  const values = [...Array(200).fill(null), 42, 43]
  assert.equal(inferFieldType(values), LARK_FIELD_NUMBER)
})

test('the primary key is the first field and is always Text', () => {
  // Bitable's first field is the primary field: it cannot be empty and Lark
  // restricts its type. The key column satisfies both by construction.
  const defs = buildFieldDefs([{ id: 'a', n: 1 }], 'id')
  assert.equal(defs[0].field_name, 'id')
  assert.equal(defs[0].type, LARK_FIELD_TEXT)
})

test('an empty table still declares its key column', () => {
  const defs = buildFieldDefs([], 'id')
  assert.deepEqual(defs, [{ field_name: 'id', type: LARK_FIELD_TEXT }])
})

test('fields cover the union of columns across rows, not just the first row', () => {
  const defs = buildFieldDefs([{ id: '1' }, { id: '2', extra: 'x' }], 'id')
  assert.deepEqual(defs.map((d) => d.field_name), ['id', 'extra'])
})

test('cells are shaped for their field type', () => {
  assert.deepEqual(toCell('7', LARK_FIELD_NUMBER), { value: 7, truncated: false })
  assert.deepEqual(toCell(0, LARK_FIELD_CHECKBOX), { value: false, truncated: false })
  assert.deepEqual(toCell('2026-08-31T00:00:00.000Z', LARK_FIELD_DATETIME), { value: 1788134400000, truncated: false })
  assert.deepEqual(toCell({ a: 1 }, LARK_FIELD_TEXT), { value: '{"a":1}', truncated: false })
  assert.deepEqual(toCell(null, LARK_FIELD_TEXT), { value: null, truncated: false })
})

test('an unparseable value for a typed field becomes null, not a rejected batch', () => {
  assert.deepEqual(toCell('ไม่ใช่ตัวเลข', LARK_FIELD_NUMBER), { value: null, truncated: false })
  assert.deepEqual(toCell('ไม่ใช่วันที่', LARK_FIELD_DATETIME), { value: null, truncated: false })
})

test('an oversized cell is truncated AND flagged', () => {
  const r = toCell('x'.repeat(MAX_CELL_CHARS + 500), LARK_FIELD_TEXT)
  assert.equal(r.truncated, true)
  assert.ok(String(r.value).length <= MAX_CELL_CHARS)
  assert.match(String(r.value), /ตัดที่/)
})

test('mapRecords counts truncations instead of swallowing them', () => {
  const rows = [{ id: '1', blob: 'y'.repeat(MAX_CELL_CHARS + 1) }]
  const out = mapRecords(rows, [
    { field_name: 'id', type: LARK_FIELD_TEXT },
    { field_name: 'blob', type: LARK_FIELD_TEXT },
  ])
  assert.equal(out.truncatedCells, 1)
})

test('columns the Base table lacks are dropped and NAMED, not sent', () => {
  // Bitable rejects the entire batch for one unknown field. Sending blind would
  // turn a newly added DB column into a total mirror outage for that table.
  const out = mapRecords([{ id: '1', brandNewColumn: 'v' }], [{ field_name: 'id', type: LARK_FIELD_TEXT }])
  assert.deepEqual(out.records, [{ id: '1' }])
  assert.deepEqual(out.droppedColumns, ['brandNewColumn'])
})

test('null values are omitted rather than sent as null', () => {
  const out = mapRecords([{ id: '1', n: null }], [
    { field_name: 'id', type: LARK_FIELD_TEXT },
    { field_name: 'n', type: LARK_FIELD_NUMBER },
  ])
  assert.deepEqual(out.records, [{ id: '1' }])
})

test('Base table names are namespaced so they cannot collide with a human table', () => {
  assert.equal(baseTableName('bookings'), 'probook_bookings')
  assert.equal(TOMBSTONE_TABLE_NAME, 'probook__deleted_rows')
})
