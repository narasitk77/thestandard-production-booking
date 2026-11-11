/**
 * v1.286 — episode codes follow the Producer Dashboard (src/lib/episode-sync.ts).
 *
 * The case that started it (11 Nov 2026): the Dashboard renamed PP-26-056-H01 → S01 on 4 Nov; two bookings kept H01
 * and PMDC logged "Unresolved Episode" every night. L01 of the same project sits on THREE bookings, so a rename has
 * to follow the code across bookings, never one booking at a time.
 *
 * What this file pins (two independent review rounds + mutation testing shaped it):
 *  - AUTOMATIC pairing only on strong evidence: one code vanished, one unclaimed, and the Dashboard row has a label
 *    of its own (not "", "-" or the project name every unlabelled episode shares) that is unique in the project and
 *    equals every stored title. The real incident (labels = project name) is `weak-label`: SUGGESTED, not applied
 *  - a code already held by ANOTHER booking is the normal multi-shoot case, not a conflict; only one booking holding
 *    both codes is refused
 *  - ORDER of effects: reads (Dashboard, Drive) → sheet cell(s) → _SHOOT.txt → ONE transaction that also writes the
 *    audit rows. Any error before the commit leaves the DB untouched; nothing runs after it; no Calendar patch at all
 *  - guards: new code on the Dashboard, old one not, no Drive folder named for the old code, no uploads, not the
 *    sandbox sheet, `from` with no rows is a typo unless the audit shows it was renamed
 *  - concurrency: a retry joins the run in flight; real writes are serialised so two renames on one booking cannot
 *    each write the sheet from a stale snapshot
 *  - nothing fails quietly: refusals, sheet 'not-found'/'skipped', a tripwire, an auto run where one pair failed
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

type Ep = { id: string; episodeId: string; bookingId: string; sequence: number; title: string; uploads: number }
type Bk = { id: string; bookingCode: string | null; status: string; deletedAt: Date | null; calendarEventId: string | null }

const T = 'LINE Executive Networking 2026'   // project name — the fallback label every unlabelled episode shares
const HL = 'Highlight reel'                    // a label of its own
let eps: Ep[] = []
let bks: Bk[] = []
let mix: Array<{ episodeRowId: string | null; episodeCode: string }> = []
let order: string[] = []
let audits: any[] = []
let sheetWrites: Array<{ code: string; fields: any }> = []
let sheetResult: Record<string, string> = {}
let markerResult: Record<string, string> = {}
let markerThrows = false
let markerSeen: any[] = []
let racing: (() => void) | null = null      // fires inside the transaction BEFORE its first check
let midTx: (() => void) | null = null       // fires inside the transaction between the checks and the write
let auditFails = false
let bkFindCalls = 0
let bkFindThrowOn = 0
let drive: Record<string, Array<{ id: string; name: string }>> = {}
let driveThrows = false
let dashboard: any = { ok: true, episodes: [] }
let sheetGate: Promise<void> | null = null
let dashGate: Promise<void> | null = null
const gate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r }); return { p, open } }

const epWhere = (w: any) => (e: Ep) => {
  if (w.id?.in && !w.id.in.includes(e.id)) return false
  if (w.bookingId?.in && !w.bookingId.in.includes(e.bookingId)) return false
  if (typeof w.episodeId === 'string' && e.episodeId !== w.episodeId) return false
  // a plain string has .startsWith too (String.prototype) — only the { startsWith } object form is a prefix filter
  if (typeof w.episodeId === 'object' && !e.episodeId.startsWith(w.episodeId.startsWith)) return false
  if (w.uploads?.none && e.uploads > 0) return false
  return true
}
const tick = () => new Promise(r => setImmediate(r))   // let concurrent runs interleave like real I/O does
const shape = (b: Bk) => ({
  ...b, outlet: { code: 'AGN', name: 'Content Agency' }, program: { code: 'P', name: 'P' }, shootDate: new Date('2026-11-26'),
  episodes: eps.filter(e => e.bookingId === b.id).sort((x, y) => x.sequence - y.sequence || x.episodeId.localeCompare(y.episodeId))
    .map(e => ({ ...e, program: { code: 'P', name: 'P' } })),
})
const prisma: any = {
  episode: {
    findMany: async ({ where }: any) => { await tick(); return eps.filter(epWhere(where)).map(e => {
      const b = bks.find(x => x.id === e.bookingId)!
      return { id: e.id, episodeId: e.episodeId, title: e.title, bookingId: e.bookingId, booking: { bookingCode: b.bookingCode, status: b.status, deletedAt: b.deletedAt }, _count: { uploads: e.uploads } }
    }) },
    count: async ({ where }: any) => eps.filter(epWhere(where)).length,
    updateMany: async ({ where, data }: any) => {
      midTx?.()
      const hit = eps.filter(epWhere(where)); hit.forEach(e => Object.assign(e, data)); return { count: hit.length }
    },
  },
  booking: {
    findMany: async ({ where }: any) => {
      await tick()
      if (bkFindThrowOn && ++bkFindCalls === bkFindThrowOn) throw new Error('db blip on real run')
      return bks.filter(b => where.id.in.includes(b.id)).map(shape)
    },
  },
  mixJob: {
    updateMany: async ({ where, data }: any) => { mix.filter(m => where.episodeRowId.in.includes(m.episodeRowId)).forEach(m => Object.assign(m, data)); return { count: 0 } },
  },
  auditLog: {
    createMany: async ({ data }: any) => { order.push('audit'); if (auditFails) throw new Error('audit table down'); audits.push(...data); return { count: data.length } },
    findFirst: async ({ where }: any) => {
      const conds = where.AND.map((c: any) => [c.changes.path[0], c.changes.equals])
      return audits.find(a => a.action === where.action && conds.every(([k, v]: [string, string]) => a.changes[k] === v)) ? { at: new Date() } : null
    },
  },
  $transaction: async (cb: any) => {
    order.push('tx')
    racing?.()                                              // someone else touches the rows between plan and commit
    const snap = JSON.parse(JSON.stringify({ eps, mix, audits }))   // a throwing callback must roll EVERYTHING back
    try { return await cb(prisma) } catch (e) { eps = snap.eps; mix = snap.mix; audits = snap.audits; throw e }
  },
}

mock.module('../db', { namedExports: { prisma } })
mock.module('../google-sheets', {
  namedExports: {
    updateBookingRow: async (code: string, fields: any) => { await tick(); if (sheetGate) await sheetGate; order.push(`sheet:${code}`); sheetWrites.push({ code, fields }); return sheetResult[code] ?? 'updated' },
  },
})
mock.module('../shoot-marker', {
  namedExports: {
    refreshShootMarker: async (b: any) => {
      order.push(`marker:${b.bookingCode}`); markerSeen.push(b)
      if (markerThrows) throw new Error('drive 500')
      return markerResult[b.bookingCode] ?? 'updated'
    },
  },
})
mock.module('../google-drive', {
  namedExports: {
    findFoldersByCode: async (code: string) => { order.push('drive-check'); if (driveThrows) throw new Error('drive 403'); return drive[code] ?? [] },
  },
})
mock.module('../dashboard-episodes', { namedExports: { listAllDashboardEpisodes: async () => { order.push('dash-read'); if (dashGate) await dashGate; return dashboard } } })

let sync: typeof import('../episode-sync')
before(async () => { sync = await import('../episode-sync') })

const L = 'PP-26-056-L01', H = 'PP-26-056-H01', S = 'PP-26-056-S01'
const ep = (id: string, episodeId: string, bookingId: string, sequence: number, uploads = 0, title = T): Ep => ({ id, episodeId, bookingId, sequence, title, uploads })
type Row = import('../episode-sync').EpRow
const row = (episodeId: string, bookingId: string, o: Partial<Row> = {}): Row =>
  ({ id: `r-${bookingId}-${episodeId}`, episodeId, title: T, bookingId, bookingCode: bookingId.toUpperCase(), status: 'CONFIRMED', deleted: false, uploadCount: 0, ...o })
/** Dashboard rows for planDrift: `own` = codes that carry a label of their own (label = HL unless given) */
const D = (codes: string[], own: Record<string, string> = {}) =>
  codes.map(episodeId => ({ episodeId, label: own[episodeId] ?? T, ownLabel: episodeId in own }))
const dashEps = (...rows: Array<[string, string]>) => rows.map(([episodeId, ep]) => ({ episodeId, ep, projectName: T }))
const holding = (code: string) => eps.filter(e => e.episodeId === code).map(e => e.id)

beforeEach(() => {
  order = []; audits = []; sheetWrites = []; sheetResult = {}; markerResult = {}; markerThrows = false; markerSeen = []
  racing = null; midTx = null; auditFails = false; bkFindCalls = 0; bkFindThrowOn = 0; drive = {}; driveThrows = false
  sheetGate = null; dashGate = null
  delete process.env.EPISODE_SYNC_AUTOAPPLY
  delete process.env.PRODUCER_DASHBOARD_SHEET_ID
  bks = [
    { id: 'b1', bookingCode: 'AGN-261026-01', status: 'COMPLETED', deletedAt: null, calendarEventId: 'ev1' },
    { id: 'b2', bookingCode: 'AGN-261126-02', status: 'CONFIRMED', deletedAt: null, calendarEventId: 'ev2' },
    { id: 'b3', bookingCode: 'AGN-261126-01', status: 'CONFIRMED', deletedAt: null, calendarEventId: 'ev3' },   // holds only L01
  ]
  // default fixture: H01 has a label of its own (HL) — the strong case the automatic path may act on
  eps = [ep('e1', L, 'b1', 1), ep('e2', H, 'b1', 2, 0, HL), ep('e3', L, 'b2', 1), ep('e4', H, 'b2', 2, 0, HL), ep('e5', L, 'b3', 1)]
  mix = [{ episodeRowId: 'e2', episodeCode: H }, { episodeRowId: 'e1', episodeCode: L }]
  dashboard = { ok: true, episodes: dashEps([L, ''], [S, HL]) }
})

// ── labels (pure) ───────────────────────────────────────────────────────────────

test("dashLabel / hasOwnLabel: '' and '-' and the project name are NOT a label of its own (create-booking's fallback rule)", () => {
  assert.equal(sync.dashLabel({ ep: '-', projectName: T }), T)
  assert.equal(sync.dashLabel({ ep: '', projectName: T }), T)
  assert.equal(sync.dashLabel({ ep: 'Ep 3', projectName: T }), 'Ep 3')
  assert.equal(sync.hasOwnLabel({ ep: '-', projectName: T }), false)
  assert.equal(sync.hasOwnLabel({ ep: '', projectName: T }), false)
  assert.equal(sync.hasOwnLabel({ ep: ` ${T} `, projectName: T }), false, 'an EP cell that repeats the project name says nothing')
  assert.equal(sync.hasOwnLabel({ ep: 'Ep 3', projectName: T }), true)
})

// ── planDrift (pure) ────────────────────────────────────────────────────────────

test('planDrift: one vanished + one unclaimed + an own, unique, matching label = rename-candidate across ALL bookings holding it', () => {
  const rows = [row(L, 'b1'), row(H, 'b1', { title: HL }), row(L, 'b2'), row(H, 'b2', { title: HL }), row(L, 'b3')]
  const d = sync.planDrift(rows, D([L, S], { [S]: HL }))
  assert.deepEqual(d, [{ project: 'PP-26-056', kind: 'rename-candidate', orphans: [H], unclaimed: [S], bookings: ['B1', 'B2'], candidate: { from: H, to: S } }])
})

test('planDrift: THE REAL INCIDENT — both sides carry only the project name → weak-label: the pair is SUGGESTED for a human, never auto', () => {
  const d = sync.planDrift([row(L, 'b1'), row(H, 'b1'), row(L, 'b2'), row(H, 'b2')], D([L, S]))
  assert.equal(d[0].kind, 'ambiguous')
  assert.equal(d[0].reason, 'weak-label')
  assert.equal(d[0].candidate, undefined)
  assert.deepEqual(d[0].suggested, { from: H, to: S })
  assert.deepEqual(d[0].dashboardCodes, [L, S])
})

test('planDrift: an own label that another episode of the project also carries ("Short" ×2) is weak too', () => {
  const d = sync.planDrift([row(L, 'b1'), row(H, 'b1', { title: 'Short' }), row('PP-26-056-S03', 'b1', { title: 'Short' })],
    D([L, S, 'PP-26-056-S03'], { [S]: 'Short', 'PP-26-056-S03': 'Short' }))
  assert.equal(d[0].reason, 'weak-label')
  assert.equal(d[0].candidate, undefined)
})

test('planDrift: a DIFFERENT label (deleted episode + unrelated new one) → label-mismatch, suggested but never a candidate', () => {
  const d = sync.planDrift([row(L, 'b1'), row(H, 'b1', { title: HL })], D([L, S], { [S]: 'Something else entirely' }))
  assert.equal(d[0].kind, 'ambiguous')
  assert.equal(d[0].reason, 'label-mismatch')
  assert.deepEqual(d[0].suggested, { from: H, to: S })
})

test('planDrift: EVERY row holding the vanished code must carry the label — one booking with another stored title = label-mismatch', () => {
  const d = sync.planDrift([row(L, 'b1'), row(H, 'b1', { title: HL }), row(H, 'b2', { title: 'Something else' })], D([L, S], { [S]: HL }))
  assert.equal(d[0].reason, 'label-mismatch')
})

test('planDrift: label comparison ignores whitespace noise but nothing else', () => {
  const d = sync.planDrift([row(L, 'b1'), row(H, 'b1', { title: HL })], D([L, S], { [S]: `  Highlight\t reel ` }))
  assert.equal(d[0].kind, 'rename-candidate')
})

test('planDrift: spare unbooked episodes make the pairing a guess → ambiguous (several), nothing suggested', () => {
  const d = sync.planDrift([row(L, 'b1'), row(H, 'b1', { title: HL })], D([L, S, 'PP-26-056-S02'], { [S]: HL }))
  assert.equal(d[0].reason, 'several')
  assert.equal(d[0].suggested, undefined)
  assert.deepEqual(d[0].unclaimed, [S, 'PP-26-056-S02'])
})

test('planDrift: the new code already booked elsewhere → orphan-only no-unclaimed, and the report LISTS the Dashboard codes (no false "nothing new")', () => {
  const d = sync.planDrift([row(L, 'b1'), row(H, 'b1'), row(S, 'b9')], D([L, S]))
  assert.equal(d[0].kind, 'orphan-only')
  assert.equal(d[0].reason, 'no-unclaimed')
  assert.deepEqual(d[0].dashboardCodes, [L, S])
})

test('planDrift: two vanished = not a candidate · a whole project missing from the Dashboard is orphan-only', () => {
  const two = sync.planDrift([row(L, 'b1'), row(H, 'b1'), row('PP-26-056-A01', 'b1')], D([L, S]))
  assert.equal(two[0].kind, 'ambiguous')
  assert.deepEqual(two[0].orphans, ['PP-26-056-A01', H])
  const gone = sync.planDrift([row('PP-26-077-L01', 'b9')], D([L, S]))
  assert.equal(gone[0].project, 'PP-26-077')
  assert.equal(gone[0].kind, 'orphan-only')
})

test('planDrift: soft-deleted bookings COUNT — their sheet rows stay and PMDC reads CANCELLED rows too', () => {
  const onlyDeleted = sync.planDrift([row(L, 'b3'), row(H, 'b1', { deleted: true, title: HL })], D([L, S], { [S]: HL }))
  assert.equal(onlyDeleted[0].kind, 'rename-candidate')
  assert.deepEqual(onlyDeleted[0].bookings, ['B1'])
  const claimed = sync.planDrift([row(L, 'b3'), row(H, 'b1'), row(S, 'b9', { deleted: true })], D([L, S]))
  assert.equal(claimed[0].kind, 'orphan-only', 'a code a soft-deleted booking holds is not unclaimed')
})

test('planDrift: ignores non-Dashboard codes and projects with no drift · refuses an empty Dashboard list', () => {
  assert.deepEqual(sync.planDrift([row('NWS-TSN-261109-01', 'b2'), row(L, 'b3')], D([L, S])), [])
  assert.throws(() => sync.planDrift([row(H, 'b1')], []), /empty Dashboard/)
})

// ── planRename (pure) ───────────────────────────────────────────────────────────

test('planRename: refusals — same code, bad format, other project, ONE booking holding both codes, uploads, duplicate, = booking code', () => {
  const h = [row(H, 'b1'), row(H, 'b2')]
  assert.match(sync.planRename(H, H, h, []).blockers[0], /เหมือนกัน/)
  assert.match(sync.planRename(H, 'AGN-261026-01', h, []).blockers[0], /รูปแบบ/)
  assert.match(sync.planRename(H, 'PP-26-057-S01', h, []).blockers[0], /คนละโปรเจกต์/)
  assert.match(sync.planRename(H, S, h, [row(S, 'b2')]).blockers.join(), /AGN|B2.*มีทั้ง/)
  assert.match(sync.planRename(H, S, [row(H, 'b1', { uploadCount: 2 })], []).blockers.join(), /ไฟล์อัปโหลด/)
  assert.match(sync.planRename(H, S, [row(H, 'b1'), { ...row(H, 'b1'), id: 'other' }], []).blockers.join(), /ซ้ำหลายตอน/)
  assert.match(sync.planRename(H, S, [row(H, 'b1', { bookingCode: H })], []).blockers.join(), /regenerate-id/)
})

test('planRename: the new code held by ANOTHER booking is the normal multi-shoot case — not a blocker', () => {
  assert.deepEqual(sync.planRename(H, S, [row(H, 'b1'), row(H, 'b2')], [row(S, 'b9')]), { blockers: [], nothingToDo: false })
})

test('planRename: no row holds the old code — `to` in use = nothing-to-do (the audit decides repeat vs typo) · neither = typo blocker', () => {
  assert.deepEqual(sync.planRename(H, S, [], [row(S, 'b1')]), { blockers: [], nothingToDo: true })
  assert.match(sync.planRename(H, S, [], []).blockers.join(), /ไม่พบตอน/)
})

// ── renameEpisodeCode ───────────────────────────────────────────────────────────

test('dry run walks the SAME reads as the real run, shows the sheet text and what it will NOT touch, and writes NOTHING', async () => {
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.deepEqual(r.bookings.map(b => [b.bookingCode, b.sheetEpisodeIds]), [['AGN-261026-01', `${L}, ${S}`], ['AGN-261126-02', `${L}, ${S}`]])
  assert.match(r.notes.join('\n'), /ปฏิทิน/)
  assert.deepEqual(order, ['dash-read', 'drive-check'], 'only the guard reads — no sheet / marker / tx / audit')
  assert.deepEqual(holding(H), ['e2', 'e4'])
})

test('apply: reads → sheet FIRST → _SHOOT.txt → ONE transaction (audit inside) → nothing after; no calendar patch at all', async () => {
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'episode-sync', dryRun: false })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.committed, true)
  assert.deepEqual(order, ['dash-read', 'drive-check', 'sheet:AGN-261026-01', 'sheet:AGN-261126-02', 'marker:AGN-261026-01', 'marker:AGN-261126-02', 'tx', 'audit'])
  assert.deepEqual(sheetWrites.map(w => w.fields), [{ episodeIds: `${L}, ${S}` }, { episodeIds: `${L}, ${S}` }], 'only col Q, in episode order')
  assert.deepEqual(eps.map(e => [e.id, e.episodeId]), [['e1', L], ['e2', S], ['e3', L], ['e4', S], ['e5', L]])
  assert.deepEqual(mix.map(m => m.episodeCode), [S, L], 'the mix-job snapshot of the renamed episode follows; others do not')
  assert.deepEqual(r.effects.map(e => [e.sheet, e.marker]), [['updated', 'updated'], ['updated', 'updated']])
  assert.deepEqual(audits.map(a => [a.action, a.entityType, a.entityId, a.bookingCode, a.changes.from, a.changes.to, a.actorEmail]),
    [['booking.episode_renamed', 'Booking', 'b1', 'AGN-261026-01', H, S, 'episode-sync'], ['booking.episode_renamed', 'Booking', 'b2', 'AGN-261126-02', H, S, 'episode-sync']])
  assert.deepEqual(r.warnings, [])
})

test('the _SHOOT.txt written is the RENAMED booking (the crawler must read the new code), for each live booking', async () => {
  await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.deepEqual(markerSeen.map(b => [b.bookingCode, b.episodes.map((e: any) => e.episodeId)]),
    [['AGN-261026-01', [L, S]], ['AGN-261126-02', [L, S]]])
})

test('a sheet ERROR aborts before the marker and the DB commit: DB untouched, no audit, the reason says so', async () => {
  sheetResult['AGN-261126-02'] = 'error'
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, false)
  assert.match(r.error!, /DB ยังไม่ถูกแตะ/)
  assert.ok(!order.includes('tx') && !order.some(o => o.startsWith('marker:')))
  assert.deepEqual(holding(H), ['e2', 'e4'])
  assert.deepEqual(audits, [])
})

test('a _SHOOT.txt write that THROWS aborts before the commit too (the crawler contract must not go stale silently) · not-found is fine', async () => {
  markerThrows = true
  let r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, false)
  assert.match(r.error!, /_SHOOT\.txt.*DB ยังไม่ถูกแตะ/)
  assert.ok(!order.includes('tx'))
  assert.deepEqual(holding(H), ['e2', 'e4'])
  markerThrows = false; markerResult['AGN-261026-01'] = 'not-found'
  r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, true)
  assert.equal(r.effects[0].marker, 'not-found')
})

test('re-running after a sheet error converges: the retry rewrites the sheet and commits', async () => {
  sheetResult['AGN-261126-02'] = 'error'
  await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  sheetResult = {}
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, true)
  assert.deepEqual(holding(S), ['e2', 'e4'])
})

test('sheet row not found / sheet skipped (no credential) still rename, but SAY so', async () => {
  sheetResult['AGN-261026-01'] = 'not-found'
  sheetResult['AGN-261126-02'] = 'skipped'
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, true)
  const w = r.warnings.join('\n')
  assert.match(w, /AGN-261026-01.*ไม่พบแถวในชีท/)
  assert.match(w, /AGN-261126-02.*ข้ามการเขียนชีท/)
})

test('rows changed between plan and commit (a file got uploaded): rolled back, no audit, honest error', async () => {
  racing = () => { eps.find(e => e.id === 'e4')!.uploads = 1 }
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, false)
  assert.match(r.error!, /เปลี่ยนไประหว่างรัน/)
  assert.deepEqual(holding(H), ['e2', 'e4'], 'rolled back')
  assert.deepEqual(audits, [])
})

test('a file linked BETWEEN the in-transaction check and the write is caught by the write itself (uploads re-asserted + row count)', async () => {
  midTx = () => { eps.find(e => e.id === 'e4')!.uploads = 1 }
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, false)
  assert.match(r.error!, /เปลี่ยนไประหว่างรัน/)
  assert.deepEqual(holding(H), ['e2', 'e4'], 'the half-done update was rolled back')
})

test('the SAME booking getting the new code mid-flight is refused inside the transaction', async () => {
  racing = () => { eps.push(ep('e9', S, 'b2', 3)) }
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, false)
  assert.match(r.error!, /ใบเดียวกันเพิ่งได้รหัส/)
  assert.deepEqual(holding(H), ['e2', 'e4'])
})

test('the new code already held by ANOTHER booking: renamed anyway (one episode, many shoots) and the result says who else holds it', async () => {
  bks.push({ id: 'b9', bookingCode: 'AGN-261203-01', status: 'CONFIRMED', deletedAt: null, calendarEventId: null })
  eps.push(ep('e9', S, 'b9', 1, 0, HL))
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, true, JSON.stringify(r.blockers))
  assert.deepEqual(r.alsoHeldBy, ['AGN-261203-01'])
  assert.deepEqual(holding(S), ['e2', 'e4', 'e9'])
})

test('the audit rows commit WITH the rename: if the audit write fails the rename is rolled back (no audit, no rename)', async () => {
  auditFails = true
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, false)
  assert.match(r.error!, /DB ล้ม.*audit table down/)
  assert.equal(r.committed, undefined)
  assert.deepEqual(holding(H), ['e2', 'e4'])
  assert.deepEqual(mix.map(m => m.episodeCode), [H, L])
})

test('repeat run after success = nothing to do, alreadyRenamed (the audit proves it), zero writes', async () => {
  await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  order = []
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, true)
  assert.equal(r.nothingToDo, true)
  assert.equal(r.alreadyRenamed, true)
  assert.deepEqual(order, [])
})

test('a TYPO in `from` while `to` is in use (no audit of that rename) is refused — not reported as "already renamed"', async () => {
  const r = await sync.renameEpisodeCode({ from: 'PP-26-056-H09', to: L, actor: 'x', dryRun: false })
  assert.equal(r.ok, false)
  assert.equal(r.alreadyRenamed, false)
  assert.match(r.blockers.join(), /ไม่พบประวัติ/)
})

test('a code that exists nowhere (typo in `from`, `to` unused) is refused', async () => {
  const r = await sync.renameEpisodeCode({ from: 'PP-26-056-H09', to: 'PP-26-056-S09', actor: 'x', dryRun: false })
  assert.equal(r.ok, false)
  assert.match(r.blockers.join(), /ไม่พบตอน/)
  assert.deepEqual(order, [])
})

test('refused plans (one booking holding both codes / uploads) return ok:false with the blockers and write nothing', async () => {
  eps.push(ep('e9', S, 'b2', 3))
  let r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, false)
  assert.match(r.blockers.join(), /AGN-261126-02 มีทั้ง/)
  eps.pop(); eps.find(e => e.id === 'e2')!.uploads = 3
  r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, false)
  assert.match(r.blockers.join(), /ไฟล์อัปโหลด/)
  assert.ok(!order.some(o => o.startsWith('sheet:') || o === 'tx'))
})

test('the Dashboard is the source: a `to` it does not list, a `from` it still lists, or an unreadable Dashboard are all REFUSED (dry run too)', async () => {
  for (const dryRun of [true, false]) {
    order = []
    const typo = await sync.renameEpisodeCode({ from: H, to: 'PP-26-056-S10', actor: 'x', dryRun })
    assert.equal(typo.ok, false)
    assert.match(typo.blockers.join(), /Dashboard ไม่มีรหัส PP-26-056-S10/)
    assert.ok(!order.some(o => o.startsWith('sheet:') || o === 'tx'))
  }
  dashboard = { ok: true, episodes: dashEps([L, ''], [H, ''], [S, HL]) }
  let r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.match(r.blockers.join(), /Dashboard ยังมีรหัส PP-26-056-H01/)
  dashboard = { ok: false, error: 'unauthorized_client' }
  r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.match(r.blockers.join(), /อ่าน Dashboard ไม่ได้.*unauthorized_client/)
  assert.deepEqual(holding(H), ['e2', 'e4'])
})

test('a Drive folder still named for the old code (AGN episode folders lead with it) or an unreadable Drive REFUSES the rename', async () => {
  drive[H] = [{ id: 'f1', name: `${H} · ${HL}` }]
  let r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.match(r.blockers.join(), /พบโฟลเดอร์ใน Drive.*PP-26-056-H01 · Highlight/)
  drive = {}; driveThrows = true
  r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.match(r.blockers.join(), /ตรวจโฟลเดอร์ใน Drive ไม่ได้.*drive 403/)
  assert.ok(!order.some(o => o.startsWith('sheet:') || o === 'tx'))
  assert.deepEqual(holding(H), ['e2', 'e4'])
})

test('pointed at a SANDBOX Dashboard sheet: rename refused and the drift report refuses too (never compare prod bookings to a test sheet)', async () => {
  process.env.PRODUCER_DASHBOARD_SHEET_ID = 'some-throwaway-sheet'
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, false)
  assert.match(r.blockers.join(), /ชีททดสอบ/)
  const rep: any = await sync.driftReport()
  assert.equal(rep.ok, false)
  assert.match(rep.error, /ชีททดสอบ/)
  assert.deepEqual(order, [])
})

test('a soft-deleted booking: DB renamed AND its sheet row written (PMDC reads CANCELLED rows) — but no _SHOOT.txt', async () => {
  bks.push({ id: 'b4', bookingCode: 'AGN-260901-01', status: 'CONFIRMED', deletedAt: new Date(), calendarEventId: 'ev4' })
  eps.push(ep('e6', H, 'b4', 1, 0, HL))
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, true)
  assert.equal(eps.find(e => e.id === 'e6')!.episodeId, S)
  assert.ok(order.includes('sheet:AGN-260901-01'))
  assert.ok(!order.includes('marker:AGN-260901-01'))
  assert.deepEqual(audits.find(a => a.bookingCode === 'AGN-260901-01')!.changes, { from: H, to: S, deletedBooking: true })
})

test('a booking with a null bookingCode is skipped for sheet and marker (effect skipped), never written as "null"', async () => {
  bks.push({ id: 'b6', bookingCode: null, status: 'CONFIRMED', deletedAt: null, calendarEventId: null })
  eps.push(ep('e8', H, 'b6', 1, 0, HL))
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, true)
  assert.ok(!order.includes('sheet:null') && !order.includes('marker:null'))
  assert.equal(r.effects.find(e => e.bookingCode === null)!.sheet, 'skipped')
})

test('padded codes are trimmed — and a padded and an unpadded copy of the same request JOIN one run', async () => {
  const [a, b] = await Promise.all([
    sync.renameEpisodeCode({ from: ` ${H} `, to: `${S}\n`, actor: 'x', dryRun: false }),
    sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false }),
  ])
  assert.equal(a, b)
  assert.equal(a.ok, true)
  assert.equal(sheetWrites.length, 2, '2 bookings written once each — not 4')
  assert.deepEqual(holding(S), ['e2', 'e4'])
})

test('a REAL apply must not JOIN an in-flight DRY RUN of the same pair', async () => {
  const [d, r] = await Promise.all([
    sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: true }),
    sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false }),
  ])
  assert.equal(d.dryRun, true)
  assert.equal(r.dryRun, false)
  assert.equal(r.committed, true)
})

test('two DIFFERENT renames on one booking at the same moment are serialised: the sheet ends with BOTH new codes', async () => {
  const X = 'PP-26-056-X01', Y = 'PP-26-056-Y01'
  eps.push(ep('e7', X, 'b1', 3, 0, 'Teaser'))
  dashboard = { ok: true, episodes: dashEps([L, ''], [S, HL], [Y, 'Teaser']) }
  const [a, b] = await Promise.all([
    sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false }),
    sync.renameEpisodeCode({ from: X, to: Y, actor: 'x', dryRun: false }),
  ])
  assert.equal(a.ok && b.ok, true)
  const lastB1 = sheetWrites.filter(w => w.code === 'AGN-261026-01').at(-1)!.fields.episodeIds
  assert.equal(lastB1, `${L}, ${S}, ${Y}`, 'the second rename must see the first one, not overwrite it from a stale snapshot')
})

// ── drift report + automatic path ────────────────────────────────────────────────

test('driftReport: an unreadable or EMPTY Dashboard is an error, never "no drift"', async () => {
  dashboard = { ok: false, error: 'unauthorized_client' }
  let rep = await sync.driftReport()
  assert.equal(rep.ok, false)
  assert.match((rep as any).error, /อ่าน Dashboard ไม่ได้/)
  dashboard = { ok: true, episodes: [] }
  rep = await sync.driftReport()
  assert.equal(rep.ok, false)
  assert.match((rep as any).error, /ไม่มีตอนเลย/)
})

test('driftReport on THE REAL INCIDENT (no EP labels): weak-label with the pair suggested — the automatic path will not touch it', async () => {
  eps.forEach(e => { e.title = T })
  dashboard = { ok: true, episodes: dashEps([L, ''], [S, '']) }
  const rep: any = await sync.driftReport()
  assert.equal(rep.ok, true)
  assert.equal(rep.drift[0].reason, 'weak-label')
  assert.deepEqual(rep.drift[0].suggested, { from: H, to: S })
  assert.deepEqual(rep.drift[0].bookings, ['AGN-261026-01', 'AGN-261126-02'])
  process.env.EPISODE_SYNC_AUTOAPPLY = '1'
  const auto = await sync.autoApplyDrift({ apply: true, actor: 'x' })
  assert.deepEqual(auto.results, [])
  assert.deepEqual(holding(H), ['e2', 'e4'])
})

test('autoApplyDrift: kill switch OFF (default) = dry run only; says autoApplyEnabled:false and carries a note', async () => {
  const r = await sync.autoApplyDrift({ apply: true, actor: 'episode-sync' })
  assert.equal(r.ok, true)
  assert.equal(r.autoApplyEnabled, false)
  assert.equal(r.applied, false)
  assert.match(r.note!, /EPISODE_SYNC_AUTOAPPLY/)
  assert.equal(r.results![0].dryRun, true)
  assert.ok(!order.some(o => o.startsWith('sheet:') || o === 'tx'))
})

test('autoApplyDrift: switch ON but apply:false is still a dry run (no note) · ON + apply:true renames, reading the Dashboard ONCE', async () => {
  process.env.EPISODE_SYNC_AUTOAPPLY = '1'
  let r = await sync.autoApplyDrift({ apply: false, actor: 'episode-sync' })
  assert.equal(r.applied, false)
  assert.equal(r.note, undefined)
  assert.ok(!order.includes('tx'))
  order = []
  r = await sync.autoApplyDrift({ apply: true, actor: 'episode-sync' })
  assert.equal(r.applied, true)
  assert.equal(r.ok, true)
  assert.equal(r.failed, 0)
  assert.equal(r.results![0].committed, true)
  assert.equal(order.filter(o => o === 'dash-read').length, 1, 'the pairing snapshot is reused by the renames')
  assert.deepEqual(holding(S), ['e2', 'e4'])
})

test('autoApplyDrift: ONE failed rename makes the whole answer ok:false (never ok:true over a failure) and is counted', async () => {
  process.env.EPISODE_SYNC_AUTOAPPLY = '1'
  sheetResult['AGN-261126-02'] = 'error'
  const r = await sync.autoApplyDrift({ apply: true, actor: 'episode-sync' })
  assert.equal(r.applied, true)
  assert.equal(r.ok, false)
  assert.equal(r.failed, 1)
  assert.deepEqual(holding(H), ['e2', 'e4'])
})

test('autoApplyDrift: a pair the dry run REFUSES is reported WITH the dry-run answer, makes ok false, and is never attempted for real', async () => {
  process.env.EPISODE_SYNC_AUTOAPPLY = '1'
  eps.find(e => e.id === 'e2')!.uploads = 2
  const r = await sync.autoApplyDrift({ apply: true, actor: 'episode-sync' })
  assert.equal(r.ok, false)
  assert.equal(r.results![0].dryRun, true)
  assert.match(r.results![0].blockers.join(), /ไฟล์อัปโหลด/)
  assert.ok(!order.some(o => o.startsWith('sheet:') || o === 'tx'))
})

test('autoApplyDrift: ambiguous and label-mismatch projects are reported but never renamed', async () => {
  process.env.EPISODE_SYNC_AUTOAPPLY = '1'
  dashboard = { ok: true, episodes: dashEps([L, ''], [S, HL], ['PP-26-056-S02', 'Other']) }
  let r = await sync.autoApplyDrift({ apply: true, actor: 'episode-sync' })
  assert.equal(r.drift![0].reason, 'several')
  assert.deepEqual(r.results, [])
  dashboard = { ok: true, episodes: dashEps([L, ''], [S, 'Totally different']) }
  r = await sync.autoApplyDrift({ apply: true, actor: 'episode-sync' })
  assert.equal(r.drift![0].reason, 'label-mismatch')
  assert.deepEqual(r.results, [])
  assert.deepEqual(holding(H), ['e2', 'e4'])
})

const addProject = (n: number, uploads = 0) => {
  bks.push({ id: `bx${n}`, bookingCode: `AGN-27010${n}-01`, status: 'CONFIRMED', deletedAt: null, calendarEventId: null })
  eps.push(ep(`ex${n}`, `PP-26-10${n}-H01`, `bx${n}`, 1, uploads, `Clip ${n}`))
  dashboard.episodes.push({ episodeId: `PP-26-10${n}-S01`, ep: `Clip ${n}`, projectName: `Project ${n}` })
}

test('autoApplyDrift: TRIPWIRES — more candidates than the cap, or more orphans than the orphan cap, refuse the whole run (bad read / bulk edit), nothing written', async () => {
  process.env.EPISODE_SYNC_AUTOAPPLY = '1'
  for (let i = 1; i <= sync.MAX_AUTO_RENAMES; i++) addProject(i)          // + the base pair = MAX + 1 candidates
  let r = await sync.autoApplyDrift({ apply: true, actor: 'episode-sync' })
  assert.equal(r.ok, false)
  assert.match(r.error!, /ไม่ใช่ drift ปกติ/)
  assert.ok(r.drift, 'the drift list still comes back so the operator can act')
  assert.ok(!order.some(o => o.startsWith('sheet:') || o === 'tx'))
  // orphan tripwire: one real candidate, but a pile of vanished codes around it (a tab that did not parse)
  bks = bks.slice(0, 3); eps = eps.filter(e => !e.id.startsWith('ex')); dashboard = { ok: true, episodes: dashEps([L, ''], [S, HL]) }
  for (let i = 0; i <= sync.MAX_ORPHANS_FOR_AUTO; i++) {
    bks.push({ id: `bo${i}`, bookingCode: `AGN-2702${String(i).padStart(2, '0')}-01`, status: 'CONFIRMED', deletedAt: null, calendarEventId: null })
    eps.push(ep(`eo${i}`, `PP-26-3${String(i).padStart(2, '0')}-L01`, `bo${i}`, 1))
  }
  r = await sync.autoApplyDrift({ apply: true, actor: 'episode-sync' })
  assert.equal(r.ok, false)
  assert.match(r.error!, /ไม่ใช่ drift ปกติ/)
  assert.deepEqual(holding(H), ['e2', 'e4'])
})

test('autoApplyDrift: a pair that THROWS in its real run is reported for that pair; the pair that committed before it stays visible', async () => {
  process.env.EPISODE_SYNC_AUTOAPPLY = '1'
  addProject(1)                    // two candidates: PP-26-056 (first), PP-26-101
  bkFindThrowOn = 4                // booking.findMany: dry(056)=1 real(056)=2 dry(101)=3 real(101)=4 → throws
  const r = await sync.autoApplyDrift({ apply: true, actor: 'episode-sync' })
  assert.equal(r.ok, false)
  assert.equal(r.failed, 1)
  assert.equal(r.results![0].committed, true, 'pair 1 committed and must stay visible')
  assert.match(r.results![1].error!, /db blip on real run/)
  assert.equal(eps.find(e => e.id === 'ex1')!.episodeId, 'PP-26-101-H01')
})

test('autoApplyDrift: two concurrent calls with the SAME apply join (one Dashboard read, one set of writes); a different apply does NOT join', async () => {
  process.env.EPISODE_SYNC_AUTOAPPLY = '1'
  const [a, b] = await Promise.all([sync.autoApplyDrift({ apply: true, actor: 'x' }), sync.autoApplyDrift({ apply: true, actor: 'x' })])
  assert.equal(a, b)
  assert.equal(order.filter(o => o === 'dash-read').length, 1)
  assert.equal(sheetWrites.length, 2)
  // reset and race a preview against a write: the write must not get the preview's answer
  eps.forEach(e => { if (e.episodeId === S) e.episodeId = H }); audits = []
  const [p, w] = await Promise.all([sync.autoApplyDrift({ apply: false, actor: 'x' }), sync.autoApplyDrift({ apply: true, actor: 'x' })])
  assert.equal(p.applied, false)
  assert.equal(w.applied, true)
  assert.deepEqual(holding(S), ['e2', 'e4'])
})

test('autoApplyDrift: Dashboard unreadable = error out, no writes', async () => {
  process.env.EPISODE_SYNC_AUTOAPPLY = '1'
  dashboard = { ok: false, error: 'boom' }
  const r = await sync.autoApplyDrift({ apply: true, actor: 'episode-sync' })
  assert.equal(r.ok, false)
  assert.ok(!order.some(o => o.startsWith('sheet:') || o === 'tx'))
})

// ── round 3 ──────────────────────────────────────────────────────────────────────

test('planDrift: a Dashboard row whose only label is the project name stays WEAK even when it is the only episode left (unique ≠ own)', () => {
  const d = sync.planDrift([row(H, 'b1')], D([S]))
  assert.equal(d[0].reason, 'weak-label')
  assert.equal(d[0].candidate, undefined)
})

test('planDrift: "Highlight day 1" deleted + "Highlight day 2" left over (a different NUMBER) is renumbered — suggested, never automatic', () => {
  const H2 = 'PP-26-056-H02'
  const d = sync.planDrift([row(L, 'b1'), row(H, 'b2', { title: 'Highlight' })], D([L, H2], { [H2]: 'Highlight' }))
  assert.equal(d[0].kind, 'ambiguous')
  assert.equal(d[0].reason, 'renumbered')
  assert.deepEqual(d[0].suggested, { from: H, to: H2 })
})

test('alreadyRenamed needs the audit row for THIS from→to (a row for the reverse pair does not count)', async () => {
  audits.push({ action: 'booking.episode_renamed', changes: { from: S, to: H } })   // the opposite direction
  eps.forEach(e => { if (e.episodeId === H) e.episodeId = S })                      // nothing holds H01, S01 in use
  const r = await sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  assert.equal(r.ok, false)
  assert.match(r.blockers.join(), /ไม่พบประวัติ/)
})

test('a run older than the TTL is NOT joined: a retry after a stuck dry run starts a fresh one', async () => {
  const g = gate(); dashGate = g.p
  const realNow = Date.now()
  const first = sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: true })
  const clock = mock.method(Date, 'now', () => realNow + 16 * 60_000)
  try {
    const second = sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: true })
    assert.notEqual(second, first, 'a 16-minute-old run must not be joined')
    g.open()
    await Promise.all([first, second])
  } finally { clock.mock.restore() }
})

test('a HUNG real write makes later real writes fail LOUD after the TTL (instead of queueing behind it forever)', async () => {
  const g = gate(); sheetGate = g.p
  const realNow = Date.now()
  const stuck = sync.renameEpisodeCode({ from: H, to: S, actor: 'x', dryRun: false })
  await new Promise(r => setTimeout(r, 20))                                        // let it reach the hung sheet call
  const clock = mock.method(Date, 'now', () => realNow + 16 * 60_000)
  try {
    const X = 'PP-26-056-X01'
    eps.push(ep('e7', X, 'b3', 2, 0, 'Teaser'))
    dashboard = { ok: true, episodes: dashEps([L, ''], [S, HL], ['PP-26-056-Y01', 'Teaser']) }
    // race a real timer: queueing behind the hung run would never answer — that must FAIL here, not hang the suite
    const later = await Promise.race([
      sync.renameEpisodeCode({ from: X, to: 'PP-26-056-Y01', actor: 'x', dryRun: false }),
      new Promise<'hung'>(r => setTimeout(() => r('hung'), 2000)),
    ])
    assert.notEqual(later, 'hung', 'the later write must answer at once, not queue behind the hung one')
    if (later === 'hung') return
    assert.equal(later.ok, false)
    assert.match(later.error!, /คิวการแก้รหัสติดอยู่: PP-26-056-H01 → PP-26-056-S01/)
  } finally {
    clock.mock.restore()
    sheetGate = null; g.open()
    await stuck
  }
})

test('autoApplyDrift: a run older than the TTL is not joined either', async () => {
  const g = gate(); dashGate = g.p
  const realNow = Date.now()
  const first = sync.autoApplyDrift({ apply: false, actor: 'x' })
  const clock = mock.method(Date, 'now', () => realNow + 16 * 60_000)
  try {
    const second = sync.autoApplyDrift({ apply: false, actor: 'x' })
    assert.notEqual(second, first)
    g.open()
    await Promise.all([first, second])
  } finally { clock.mock.restore() }
})

test('autoApplyDrift: EXACTLY at the caps is allowed (the tripwires fire only above them)', async () => {
  process.env.EPISODE_SYNC_AUTOAPPLY = '1'
  for (let i = 1; i < sync.MAX_AUTO_RENAMES; i++) addProject(i)          // + the base pair = exactly MAX candidates
  const r = await sync.autoApplyDrift({ apply: true, actor: 'episode-sync' })
  assert.equal(r.error, undefined)
  assert.equal(r.results!.filter(x => x.committed).length, sync.MAX_AUTO_RENAMES)
})

test('autoApplyDrift: exactly MAX_ORPHANS_FOR_AUTO orphans is allowed', async () => {
  process.env.EPISODE_SYNC_AUTOAPPLY = '1'
  for (let i = 1; i < sync.MAX_ORPHANS_FOR_AUTO; i++) {                    // + the base orphan H01 = exactly MAX
    bks.push({ id: `bo${i}`, bookingCode: `AGN-2702${String(i).padStart(2, '0')}-01`, status: 'CONFIRMED', deletedAt: null, calendarEventId: null })
    eps.push(ep(`eo${i}`, `PP-26-3${String(i).padStart(2, '0')}-L01`, `bo${i}`, 1))
  }
  const r = await sync.autoApplyDrift({ apply: true, actor: 'episode-sync' })
  assert.equal(r.error, undefined, r.error)
  assert.equal(r.results![0].committed, true)
})
