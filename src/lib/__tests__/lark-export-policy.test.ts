import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTables, NEVER_EXPORT, SENSITIVE_DEFAULT_OFF, isSecretFieldName, redactRow,
  toJsonValue, serializeRow, rowKey, buildKeyIndex, diffTombstones, rowLabel,
  snapshotFileName, type KeyIndex,
} from '../lark-export-policy'

// v1.212 — this file is the privacy boundary of the Lark export. Everything
// here is about one question: does a row leave the building, and does it leave
// intact? A regression in classifyTables is not a bug report, it is 19 people
// finding their anonymous ratings in a shared Base.

const ALL_TABLES = [
  'bookings', 'episodes', 'audit_logs', 'footage_log', 'users', 'ot_records',
  'shoot_reviews', 'shoot_review_invites', 'page_events', 'feedback_tickets',
  'feedback_messages', '_prisma_migrations', 'lark_export_runs', 'switcher_jobs',
]

function decisionFor(table: string, env: { include?: string; exclude?: string } = {}) {
  return classifyTables(ALL_TABLES, env).find((d) => d.table === table)!
}

/* ─────────────────────────────── tier 1: NEVER ─────────────────────────────── */

test('shoot_reviews and its invites are never exported', () => {
  for (const t of NEVER_EXPORT) {
    const d = decisionFor(t)
    assert.equal(d.included, false, `${t} must never be included`)
    assert.equal(d.reason, 'never')
  }
})

test('LARK_EXPORT_INCLUDE cannot turn the NEVER tier back on', () => {
  // The promise made to staff in the review form is enforced in code, not in a
  // Lark sharing checkbox. Overriding it has to be a reviewed code change.
  const env = { include: 'shoot_reviews,shoot_review_invites,users' }
  assert.equal(decisionFor('shoot_reviews', env).included, false)
  assert.equal(decisionFor('shoot_review_invites', env).included, false)
  // ...while a tier-2 table in the same list DOES come back on, proving the
  // list was read and shoot_reviews was refused specifically.
  assert.equal(decisionFor('users', env).included, true)
  assert.equal(decisionFor('users', env).reason, 'opted-in')
})

/* ───────────────────────── tier 2: sensitive, default off ──────────────────── */

test('the sensitive tier is off unless opted in', () => {
  for (const t of SENSITIVE_DEFAULT_OFF) {
    const d = decisionFor(t)
    assert.equal(d.included, false, `${t} should default to off`)
    assert.equal(d.reason, 'sensitive-default-off')
  }
})

test('ordinary operational tables are exported', () => {
  for (const t of ['bookings', 'episodes', 'audit_logs', 'footage_log', 'switcher_jobs']) {
    assert.equal(decisionFor(t).included, true, `${t} should be exported`)
  }
})

test('infrastructure tables stay out', () => {
  assert.equal(decisionFor('_prisma_migrations').included, false)
  // Exporting our own bookkeeping would put a gzipped copy of every previous
  // run's key index inside every snapshot — the file would grow with its history.
  assert.equal(decisionFor('lark_export_runs').included, false)
})

test('EXCLUDE beats INCLUDE — the kill switch always wins', () => {
  const env = { include: 'ot_records', exclude: 'ot_records,bookings' }
  assert.equal(decisionFor('ot_records', env).included, false)
  assert.equal(decisionFor('bookings', env).included, false)
})

test('classification is case- and whitespace-tolerant', () => {
  const env = { include: ' Users , OT_RECORDS ' }
  assert.equal(decisionFor('users', env).included, true)
  assert.equal(decisionFor('ot_records', env).included, true)
})

test('a table nobody has classified is exported, not silently dropped', () => {
  // The catalogue drives this export, so a model added next year appears here
  // with no code change. Defaulting to "skip" would mean new tables are
  // quietly missing from the archive — the failure you find years later.
  const d = classifyTables(['some_new_table_2027']).find((x) => x.table === 'some_new_table_2027')!
  assert.equal(d.included, true)
  assert.equal(d.reason, 'exported')
})

/* ──────────────────────────── field-level redaction ────────────────────────── */

test('credential-shaped column names are recognised', () => {
  for (const n of ['token', 'secret', 'apiKey', 'api_key', 'password', 'webhookSecret', 'refresh_token', 'credentials']) {
    assert.equal(isSecretFieldName(n), true, `${n} should be treated as a secret`)
  }
})

test('identifiers that merely look secret-ish are kept', () => {
  // These are the columns the id-first Drive work depends on (v1.114) — losing
  // them would make the archive useless for reconstructing folder links.
  for (const n of ['driveFileId', 'boxFolderId', 'externalKey', 'bookingCode', 'tokenized_name']) {
    assert.equal(isSecretFieldName(n), false, `${n} should be kept`)
  }
})

test('bank details never travel — Vendor.bankAccount is the live case', () => {
  // vendors is in NEITHER Tier 1 nor Tier 2, so classifyTables() exports it.
  // The field-level net is therefore the ONLY thing standing between supplier
  // bank account numbers and a Lark folder shared by checkbox. Regression guard
  // added 2026-09-01 after a review found this one live.
  const decision = classifyTables(['vendors'])[0]
  assert.equal(decision.included, true, 'vendors is exported — that is the premise of this test')

  for (const n of ['bankAccount', 'bank_account', 'iban', 'swift', 'accounts']) {
    assert.equal(isSecretFieldName(n), true, `${n} must never reach Lark`)
  }

  // 2026-09-01 — the end-anchor was replaced by two patterns (see
  // SECRET_FIELD_RE / BANK_ACCOUNT_RE). These names were NOT caught before and
  // are now: the shapes a future migration is most likely to introduce.
  for (const n of ['swiftCode', 'accountNumber', 'bankAccountNumber', 'passwordHash', 'secretKey', 'tokenValue']) {
    assert.equal(isSecretFieldName(n), true, `${n} must never reach Lark`)
  }

  // ...without taking the rest of the vendor row with it. `accountManager` is
  // the reason `account` is matched more narrowly than the other words: here it
  // names a PERSON, not bank details, and a blanket loosening would have
  // silently dropped it (this assertion is what caught that).
  for (const n of ['accountManager', 'accountName', 'accountOwner', 'name', 'contact', 'service']) {
    assert.equal(isSecretFieldName(n), false, `${n} should be kept`)
  }

  // The identifiers the archive exists to preserve. The old comment claimed the
  // end-anchor was what protected these; it never was — they contain none of
  // the listed words at either end. Pinned so the claim stays checked.
  for (const n of ['driveFileId', 'boxFolderId', 'externalKey', 'producerEmail', 'bookingCode']) {
    assert.equal(isSecretFieldName(n), false, `${n} is an identifier, not a secret`)
  }
  assert.deepEqual(
    redactRow({ id: 'v1', name: 'เช่าดี', contact: '08x', bankAccount: '123-4-56789-0' }),
    { id: 'v1', name: 'เช่าดี', contact: '08x' },
  )
})

test('redactRow drops secrets and keeps everything else', () => {
  const out = redactRow({ id: 'a', token: 'bearer-xyz', bookingCode: 'AGN-260630-01', driveFileId: '1AbC' })
  assert.deepEqual(out, { id: 'a', bookingCode: 'AGN-260630-01', driveFileId: '1AbC' })
})

/* ───────────────────────────── serialisation ───────────────────────────────── */

test('toJsonValue survives the types $queryRaw actually returns', () => {
  assert.equal(toJsonValue(new Date('2026-08-31T12:00:00.000Z')), '2026-08-31T12:00:00.000Z')
  assert.equal(toJsonValue(BigInt('9007199254740993')), '9007199254740993')
  assert.equal(toJsonValue(Buffer.from('hi')), 'base64:aGk=')
  assert.deepEqual(toJsonValue({ a: [new Date(0), null] }), { a: ['1970-01-01T00:00:00.000Z', null] })
  assert.equal(toJsonValue(undefined), null)
})

test('a BigInt column does not throw the whole snapshot away', () => {
  // JSON.stringify(BigInt) throws. One int8 column would take out the archive
  // for every table, on a night nobody is watching.
  const row = serializeRow({ id: 'x', size: BigInt(12345), token: 'nope' })
  assert.doesNotThrow(() => JSON.stringify(row))
  assert.deepEqual(row, { id: 'x', size: '12345' })
})

/* ──────────────────────────── keys, labels, tombstones ─────────────────────── */

test('rowKey handles single and composite keys, and refuses null parts', () => {
  assert.equal(rowKey({ id: 'abc' }, ['id']), 'abc')
  assert.equal(rowKey({ a: 1, b: 2 }, ['a', 'b']), '1␟2')
  assert.equal(rowKey({ a: null }, ['a']), null)
  assert.equal(rowKey({ a: 1 }, []), null)
})

test('rowLabel prefers the identifiers a human can act on', () => {
  assert.equal(rowLabel({ id: 'cuid', bookingCode: 'AGN-260630-01', name: 'ถ่ายรายการ X' }), 'AGN-260630-01 · ถ่ายรายการ X')
  assert.equal(rowLabel({ id: 'cuid' }), '', 'no human-readable field → empty, never the cuid twice')
})

test('buildKeyIndex maps every row to its key and label', () => {
  const idx = buildKeyIndex(
    { bookings: [{ id: '1', bookingCode: 'A-1' }, { id: '2', bookingCode: 'A-2' }] },
    () => ['id'],
  )
  assert.deepEqual(idx, { bookings: { '1': 'A-1', '2': 'A-2' } })
})

test('the first run has no previous index and files no tombstones', () => {
  const d = diffTombstones(null, { bookings: { '1': 'A-1' } }, { lastSeenIn: 'f', vanishedAt: 'now' })
  assert.deepEqual(d.tombstones, [])
})

test('a row present yesterday and gone today becomes a tombstone', () => {
  const prev: KeyIndex = { bookings: { '1': 'A-1', '2': 'A-2' }, audit_logs: { x: 'booking.approve' } }
  const curr: KeyIndex = { bookings: { '1': 'A-1' }, audit_logs: { x: 'booking.approve' } }
  const d = diffTombstones(prev, curr, { lastSeenIn: 'probook-2026-08-30.json.gz', vanishedAt: '2026-08-31T16:00:00.000Z' })
  assert.equal(d.tombstones.length, 1)
  assert.deepEqual(d.tombstones[0], {
    table: 'bookings', key: '2', label: 'A-2',
    lastSeenIn: 'probook-2026-08-30.json.gz', vanishedAt: '2026-08-31T16:00:00.000Z',
  })
})

test('an added row is not a tombstone', () => {
  const d = diffTombstones({ bookings: { '1': 'A-1' } }, { bookings: { '1': 'A-1', '2': 'A-2' } }, { lastSeenIn: 'f', vanishedAt: 'now' })
  assert.equal(d.tombstones.length, 0)
})

test('a whole table disappearing is a config event, not thousands of deletions', () => {
  // Someone edits LARK_EXPORT_EXCLUDE and audit_logs stops being exported. If
  // that filed 4,129 tombstones, the one table that records real deletions
  // would be unreadable from that day on.
  const prev: KeyIndex = { audit_logs: Object.fromEntries([...Array(50)].map((_, i) => [String(i), 'x'])) }
  const d = diffTombstones(prev, {}, { lastSeenIn: 'f', vanishedAt: 'now' })
  assert.deepEqual(d.tombstones, [])
  assert.deepEqual(d.droppedTables, ['audit_logs'])
})

test('a mass deletion is capped, and the overflow is REPORTED not hidden', () => {
  const prev: KeyIndex = { audit_logs: Object.fromEntries([...Array(120)].map((_, i) => [String(i), `row-${i}`])) }
  const d = diffTombstones(prev, { audit_logs: {} }, { lastSeenIn: 'f', vanishedAt: 'now', maxPerTable: 100 })
  assert.equal(d.tombstones.length, 100)
  assert.equal(d.truncated.audit_logs, 20, 'the 20 we did not file must be counted')
})

test('snapshot names are one per Bangkok day and sort chronologically', () => {
  assert.equal(snapshotFileName('2026-08-31'), 'probook-2026-08-31.json.gz')
  const names = ['2026-09-01', '2026-08-31', '2026-12-01'].map(snapshotFileName)
  assert.deepEqual([...names].sort(), ['probook-2026-08-31.json.gz', 'probook-2026-09-01.json.gz', 'probook-2026-12-01.json.gz'])
})
