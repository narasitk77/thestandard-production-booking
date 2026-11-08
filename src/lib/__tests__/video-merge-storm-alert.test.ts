/**
 * v1.266.2 — เตือน sync-storm เฉพาะตอนชุดชื่อเปลี่ยน (ชุดเดิม = สัปดาห์ละครั้ง)
 *
 * เคสจริง: POP-PIV-261007-02 ซาก "(1)" 123 ชื่อชุดเดิม เตือนซ้ำ 8 ครั้งใน 2 วัน (9–11 ต.ค. 2569) ทุก 6 ชม.
 * ทั้งที่ต้นฉบับอยู่ในกล่องครบแล้ว — การเตือนซ้ำไม่ทำให้ใครถอดตัวอัปเร็วขึ้น มีแต่ทำให้เลิกอ่าน
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const HOUR = 3_600_000
let rows: Record<string, { key: string; at: Date; note: string | null }> = {}
let readFails = false
let now = Date.parse('2026-10-11T12:32:00Z')
const sent: Array<{ key: string; everyMs: number; text: string }> = []

mock.module('../db', {
  namedExports: {
    prisma: {
      systemHeartbeat: {
        findUnique: async ({ where }: any) => { if (readFails) throw new Error('db down'); return rows[where.key] ?? null },
        upsert: async ({ where, create, update }: any) => { rows[where.key] = { ...(rows[where.key] ?? create), ...update } },
        updateMany: async ({ where, data }: any) => {
          const r = rows[where.key]
          if (!r || r.note === where.NOT?.note) return { count: 0 }
          rows[where.key] = { ...r, ...data }; return { count: 1 }
        },
      },
    },
  },
})
// alertOps' own throttle, faithfully: send unless the last attempt for this key is younger than everyMs
mock.module('../ops-alert', {
  namedExports: {
    OPS_ALERT_EVERY_MS: 6 * HOUR,
    alertOps: async (key: string, _subject: string, text: string, everyMs: number) => {
      const last = rows[`alert:${key}`]?.at
      if (last && now - last.getTime() < everyMs) return { attempted: false, delivered: false, discord: false, lark: false, email: false }
      rows[`alert:${key}`] = { key: `alert:${key}`, at: new Date(now), note: 'email=true' }
      sent.push({ key, everyMs, text })
      return { attempted: true, delivered: true, discord: false, lark: false, email: true }
    },
  },
})
mock.module('../google-drive', { namedExports: {} })

let vm: typeof import('../video-merge')
before(async () => { vm = await import('../video-merge') })
// Date is mocked too: the card-hold chat stamps (cardHoldsChatDue / rememberCardHoldsPosted) read the real clock
beforeEach(() => {
  rows = {}; readFails = false; sent.length = 0; now = Date.parse('2026-10-11T12:32:00Z')
  mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now })
})

const names = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `C${String(i + from).padStart(4, '0')} (1).MXF`)
const at = (h: number) => { now = Date.parse('2026-10-11T12:32:00Z') + h * HOUR; mock.timers.setTime(now) }

test('ชุดเดิม (เคส POP-PIV-261007-02) → เตือนครั้งเดียว แล้วเงียบจนครบ 7 วัน ไม่ใช่ทุก 6 ชม.', async () => {
  const set = names(123)
  await vm.reportConflicts('POP-PIV-261007-02', set)
  for (const h of [6.5, 13, 19.5, 26, 48, 100, 167]) { at(h); await vm.reportConflicts('POP-PIV-261007-02', [...set].reverse()) }
  assert.equal(sent.length, 1, 'ลำดับชื่อต่างกันไม่ใช่ชุดใหม่')
  at(168.5)
  await vm.reportConflicts('POP-PIV-261007-02', set)
  assert.equal(sent.length, 2, 'ครบสัปดาห์ = เตือนซ้ำหนึ่งครั้ง (ไม่เงียบถาวร)')
  assert.match(sent[0].text, /ชุดเดิมเตือนซ้ำสัปดาห์ละครั้ง/)
})

test('ชุดเปลี่ยน (ซิงก์ยังเขียนอยู่) = ข่าวใหม่ → เตือนที่ 6 ชม. ตามเดิม · ไม่ถี่กว่านั้น', async () => {
  await vm.reportConflicts('X-1', names(10))
  at(1); await vm.reportConflicts('X-1', names(12))
  assert.equal(sent.length, 1, 'ยังอยู่ในหน้าต่าง 6 ชม. ของรหัสนี้')
  at(6.5); await vm.reportConflicts('X-1', names(12))
  assert.equal(sent.length, 2, 'ชุดที่ยังไม่เคยเตือน → เตือนเมื่อพ้น 6 ชม.')
  at(13); await vm.reportConflicts('X-1', names(12))
  assert.equal(sent.length, 2, 'ชุดนั้นเตือนแล้ว → รอสัปดาห์')
})

test('อ่านชุดเดิมไม่ได้ → ถือเป็นชุดใหม่ (เตือนซ้ำดีกว่าเงียบ)', async () => {
  await vm.reportConflicts('X-2', names(5))
  readFails = true
  at(6.5); await vm.reportConflicts('X-2', names(5))
  assert.equal(sent.length, 2)
  assert.equal(sent[1].everyMs, 6 * HOUR)
})

test('ไม่มีซาก = ไม่ทำอะไร · ลายนิ้วมือไม่ขึ้นกับลำดับ แต่ขึ้นกับชื่อ', async () => {
  await vm.reportConflicts('X-3', [])
  assert.equal(sent.length, 0)
  assert.equal(vm.conflictSetKey(['b (1)', 'a (1)']), vm.conflictSetKey(['a (1)', 'b (1)']))
  assert.notEqual(vm.conflictSetKey(['a (1)']), vm.conflictSetKey(['a (1)', 'b (1)']))
})

// ── v1.280 — card holds: ops (reportCardHolds) repeats every 6 h; the team chat gets a held SET once ──
// maint 2026-11-08 — the chat side is its own state: cardHoldsChatDue reads it, and only the route — after notifyChat
// delivered — writes it (rememberCardHoldsPosted). reportCardHolds used to stamp it whenever ops' alert was attempted,
// before any chat post, so the admin button (no ?notify=1) or a failed post meant the team never heard of the set.
const holds = (...codes: string[]) => codes.map(c => `${c}: EP01 · x/CAM-A`)
/** what a whole-landing ?notify=1 run does when its chat post goes through: ops, the chat gate, the stamp */
const hourlyRunPosts = async (h: string[]) => {
  await vm.reportCardHolds(h)
  const due = await vm.cardHoldsChatDue(h)
  if (due) await vm.rememberCardHoldsPosted(h)
  return due
}

test('การ์ดค้างชุดเดิมรอบสอง → แชตเงียบ แต่ ops ยังเตือนซ้ำที่ 6 ชม. · ชุดใหม่ → แชต', async () => {
  assert.equal(await hourlyRunPosts(holds('AGN-261104-01')), true, 'ชุดแรก = ข่าว → แชต')
  at(6.5)
  assert.equal(await hourlyRunPosts(holds('AGN-261104-01')), false, 'ชุดเดิม = ไม่โพสต์แชตซ้ำ')
  assert.equal(sent.length, 2, 'ops ยังได้เตือนซ้ำตาม throttle 6 ชม. ของ alertOps')
  assert.equal(sent[1].everyMs, 6 * HOUR)
  at(7)
  assert.equal(await hourlyRunPosts(holds('AGN-261104-01', 'NWS-KYM-261105-01')), true, 'ชุดเปลี่ยน = ข่าวใหม่ → แชต')
  assert.match(sent[2].text, /MEDIAPRO ไม่มีคลิปร่วมกับการ์ดในกล่อง/)
})

test('การ์ดค้าง: ชุดที่แชตเพิ่งได้ไป (< 6 ชม.) วนกลับมา → ไม่โพสต์ซ้ำ · อ่านชุดเดิมไม่ได้ → ถือเป็นชุดใหม่ · ไม่มี → false', async () => {
  assert.equal(await hourlyRunPosts(holds('X-1')), true)
  at(1)
  assert.equal(await hourlyRunPosts(holds('X-1', 'X-2')), true, 'ชุดใหม่ = ส่งทันที')
  at(2)
  assert.equal(await hourlyRunPosts(holds('X-1')), false, 'ต่างจากชุดล่าสุด แต่แชตเพิ่งได้ชุดนี้ไป 2 ชม. → ไม่โพสต์')
  at(13)
  readFails = true
  assert.equal(await vm.cardHoldsChatDue(holds('X-1')), true, 'เตือนซ้ำดีกว่าเงียบ')
  assert.equal(await vm.cardHoldsChatDue([]), false)
})

test('การ์ดค้าง: ปุ่มรวมไฟล์รายใบเตือน ops อย่างเดียว — ไม่แตะชุดของแชต และไม่กินโควตาแชตของรอบรายชั่วโมง', async () => {
  assert.equal(await hourlyRunPosts(holds('A-1', 'B-1')), true)
  at(7)
  await vm.reportCardHolds(holds('A-1')) // the booking button on A-1
  at(14)
  assert.equal(await hourlyRunPosts(holds('A-1', 'B-1')), false, 'ชุดรอบรายชั่วโมงยังเป็นชุดเดิม')
  // the button's ops alert on a set the team has not seen used to eat the throttle the chat gate rode on (up to 6 h late)
  at(15)
  await vm.reportCardHolds(holds('C-1'))
  assert.equal(sent[sent.length - 1].key, `card-hold:${vm.conflictSetKey(holds('C-1'))}`, 'ปุ่มยิง ops ของชุดนี้ไปแล้ว')
  at(15.5)
  assert.equal(await hourlyRunPosts(holds('C-1')), true, 'ทีมยังไม่เคยได้ชุดนี้ → โพสต์ทันที ไม่ต้องรอ throttle ของ ops')
})

test('การ์ดค้าง: รอบที่ไม่มีการ์ดค้างล้างชุดที่แชตได้ไป → การ์ดใหม่ที่ path เดิมเป็นข่าวอีกครั้ง', async () => {
  assert.equal(await hourlyRunPosts(holds('AGN-261104-01')), true, 'ชุดแรก = ข่าว')
  at(1)
  assert.equal(await vm.cardHoldsChatDue([]), false, 'รอบเต็มที่ไม่มีการ์ดค้าง')
  assert.equal(rows['card-hold-set'].note, '', 'ล้างชุดแล้ว')
  at(7) // พ้น 6 ชม. นับจากที่แชตได้ชุดนี้
  assert.equal(await hourlyRunPosts(holds('AGN-261104-01')), true, 'การ์ดใหม่ที่ path เดิมหลังแก้ใบแรก = ข่าวใหม่ → แชต')
})

test('maint 2026-11-08 — รอบที่ไม่ได้โพสต์แชต (ปุ่มทั้งระบบไม่มี ?notify=1 · แชตส่งไม่ถึง) ไม่ประทับชุด → รอบ worker ถัดไปยังโพสต์', async () => {
  // the admin "🎬 รวมไฟล์วิดีโอ (ทั้งระบบ)" run: ops goes out, the route posts nothing and so remembers nothing
  await vm.reportCardHolds(holds('AGN-261104-01'))
  assert.equal(await vm.cardHoldsChatDue(holds('AGN-261104-01')), true)
  at(1) // the worker's ?notify=1 run: ops is inside its 6 h window, the chat must still get the set
  await vm.reportCardHolds(holds('AGN-261104-01'))
  assert.equal(sent.length, 1, 'ops ไม่ซ้ำภายใน 6 ชม.')
  assert.equal(await vm.cardHoldsChatDue(holds('AGN-261104-01')), true, 'ทีมยังไม่ได้ชุดนี้ → ต้องโพสต์ (เดิม = false ถาวร)')
  at(2) // that post failed (notifyChat → false): nothing remembered, so the next run is still due
  assert.equal(await vm.cardHoldsChatDue(holds('AGN-261104-01')), true, 'แชตล้ม = ยังค้างโพสต์')
  await vm.rememberCardHoldsPosted(holds('AGN-261104-01'))
  assert.equal(await vm.cardHoldsChatDue(holds('AGN-261104-01')), false, 'โพสต์ถึงแล้ว = เงียบ')
})
