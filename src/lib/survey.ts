/**
 * v1.278 — แบบสำรวจ "probook ช่วยประหยัดเวลาคุณได้แค่ไหน" (นัทสั่ง 3 พ.ย. 2569)
 *
 * ถามเฉพาะคนจองงาน + ทีมจัดคิว · ทีละคำถามบนมือถือ · ไม่ผูกชื่อกับคำตอบ
 * (ระบบจำแค่ว่าใครตอบแล้วใน survey_participants เพื่อไม่ชวนซ้ำ — ตารางคำตอบไม่มีอีเมล)
 *
 * ไฟล์นี้คือที่เดียวที่นิยามแบบสอบถาม: หน้า /survey, API ตรวจคำตอบ และหน้าผลใช้ชุดเดียวกัน
 * ตัวเลือกเก็บเป็น id ไม่ใช่ข้อความไทย — แก้คำบนจอได้โดยผลที่เก็บไปแล้วไม่เพี้ยน
 * ไม่ import อะไรฝั่ง server เพราะหน้า client ใช้ด้วย
 *
 * ตัวเลือก "ยังกินเวลา" มาจากข้อมูลจริง 30 ก.ค.–3 พ.ย.: 59 ข้อความขอแก้ใบหลังอนุมัติ,
 * 32/49 คำขอยกเลิกคือเลื่อนวัน, เลข QU, ห้องชน/กล้องเต็ม, เมลไม่ถึง, ล็อกอินหมดทุก 7 วัน
 */

export const SURVEY_KEY = 'time-2026-11'

export type Group = 'booker' | 'queue'
export type Kind = 'single' | 'multi' | 'text'
export type Option = { id: string; label: string }
export type Question = {
  id: string
  kind: Kind
  title: string
  help?: string
  options?: Option[]
  required: boolean
  /** แสดงเฉพาะกลุ่มนี้ (ไม่ใส่ = ทุกคน) */
  group?: Group
  /** multi เท่านั้น: มีช่อง "อื่น ๆ" ให้พิมพ์ — เก็บที่ `<id>_other` */
  other?: boolean
  /** multi เท่านั้น: ตัวเลือกนี้เลือกคู่กับตัวอื่นไม่ได้ (เช่น "ยังไม่มีเรื่องไหน") */
  exclusive?: string
}
export type Answers = Record<string, string | string[]>

const CHASE: Option[] = [
  { id: 'much_less', label: 'น้อยลงเยอะ 🙌' },
  { id: 'less', label: 'น้อยลงนิดหน่อย' },
  { id: 'same', label: 'เท่าเดิม' },
  { id: 'more', label: 'มากขึ้น 😵' },
  { id: 'na', label: 'ไม่ทันวิธีเดิม / เพิ่งเข้ามา' },
]

export const SURVEY = {
  key: SURVEY_KEY,
  title: 'probook ช่วยประหยัดเวลาคุณได้แค่ไหน? ⏱️',
  intro: 'สวัสดีครับ 👋 นัทจากทีม Production เองครับ อยากรู้จริง ๆ ว่าตั้งแต่มี probook งานของแต่ละคนเร็วขึ้นหรือยุ่งขึ้น ตรงไหนช่วยได้ ตรงไหนยังกินเวลา จะได้แก้ให้ถูกจุด',
  facts: ['⏱ ประมาณ 3 นาที', '🙈 ไม่ผูกชื่อกับคำตอบ', '🎯 ตอบกะ ๆ เอาได้เลย ไม่มีถูกผิด'],
  privacy: 'ระบบจำแค่ว่าคุณตอบแล้ว (จะได้ไม่ชวนซ้ำ) แต่ไม่เก็บว่าใครตอบอะไร',
  thanks: 'นัทจะสรุปผลให้ทุกคนดูภายใน 2 สัปดาห์ พร้อมบอกว่าจะแก้อะไรก่อน',
  questions: [
    { id: 'role', kind: 'single', required: true, title: 'คุณใช้ probook ในบทบาทไหน?', help: 'เลือกอันที่ใช่ที่สุดอันเดียวพอ',
      options: [
        { id: 'booker', label: '📝 คนจองงาน — Producer / Co-Producer / PM / Content Creator' },
        { id: 'queue', label: '🗂 ทีมจัดคิว — อนุมัติ / จัดทีม / ลงปฏิทิน' },
      ] },

    { id: 'b_now', kind: 'single', required: true, group: 'booker', title: 'จองคิวถ่าย 1 ใบใน probook ตอนนี้ใช้เวลาประมาณเท่าไร?', help: 'นับตั้งแต่เปิดฟอร์มจนกดส่ง',
      options: [{ id: 'lt5', label: 'ไม่ถึง 5 นาที' }, { id: '5_10', label: '5–10 นาที' }, { id: '10_20', label: '10–20 นาที' }, { id: 'gt20', label: 'มากกว่า 20 นาที' }] },
    { id: 'b_before', kind: 'single', required: true, group: 'booker', title: 'ก่อนมี probook ตกลงคิวถ่าย 1 งานใช้เวลารวมประมาณเท่าไร?', help: 'รวมทักไลน์ ตามคน รอยืนยันทีม',
      options: [{ id: 'lt10', label: 'ไม่ถึง 10 นาที' }, { id: '10_30', label: '10–30 นาที' }, { id: '30_60', label: '30–60 นาที' },
        { id: '1_2h', label: '1–2 ชั่วโมง' }, { id: 'gt2h', label: 'มากกว่า 2 ชั่วโมง' }, { id: 'na', label: 'ไม่ทันวิธีเดิม / เพิ่งเข้ามา' }] },
    { id: 'b_chase', kind: 'single', required: true, group: 'booker', title: 'เดี๋ยวนี้ต้องทักไลน์หรือโทรตามเรื่องคิวถ่ายน้อยลงไหม?', help: 'เช่น อนุมัติหรือยัง ใครไปบ้าง ขอแก้เวลา', options: CHASE },

    { id: 'q_now', kind: 'single', required: true, group: 'queue', title: 'จัดคิว 1 งานใน probook ตอนนี้ใช้เวลาประมาณเท่าไร?', help: 'ตั้งแต่เปิดใบที่ส่งเข้ามา จัดทีม จนกดอนุมัติ (ลงปฏิทิน + ส่งเมลให้ทีม)',
      options: [{ id: 'lt2', label: 'ไม่ถึง 2 นาที' }, { id: '2_5', label: '2–5 นาที' }, { id: '5_10', label: '5–10 นาที' }, { id: 'gt10', label: 'มากกว่า 10 นาที' }] },
    { id: 'q_before', kind: 'single', required: true, group: 'queue', title: 'ก่อนมี probook จัดคิว 1 งานใช้เวลารวมประมาณเท่าไร?', help: 'รวมรับเรื่องจากไลน์ เช็กคนว่าง ลงปฏิทินเอง แจ้งทีมทีละคน',
      options: [{ id: 'lt5', label: 'ไม่ถึง 5 นาที' }, { id: '5_15', label: '5–15 นาที' }, { id: '15_30', label: '15–30 นาที' },
        { id: '30_60', label: '30–60 นาที' }, { id: 'gt1h', label: 'มากกว่า 1 ชั่วโมง' }, { id: 'na', label: 'ไม่ทันวิธีเดิม / เพิ่งเข้ามา' }] },
    { id: 'q_chase', kind: 'single', required: true, group: 'queue', title: 'เดี๋ยวนี้มีคนทักมาถามหรือขอแก้เรื่องคิวถ่ายน้อยลงไหม?', help: 'เช่น อนุมัติหรือยัง ใครไปบ้าง ขอเลื่อนเวลา', options: CHASE },

    { id: 'hours', kind: 'single', required: true, title: 'โดยรวม probook ช่วยประหยัดเวลาคุณประมาณเท่าไรต่อสัปดาห์?', help: 'เทียบกับทำแบบเดิม (ไลน์ / โทร / ชีท) — กะคร่าว ๆ พอ',
      options: [{ id: 'worse', label: '⏳ ทำให้เสียเวลาเพิ่ม' }, { id: 'same', label: 'พอ ๆ เดิม' }, { id: 'lt30', label: 'ไม่ถึง 30 นาที' },
        { id: '30_60', label: '30 นาที – 1 ชั่วโมง' }, { id: '1_2', label: '1–2 ชั่วโมง' }, { id: '2_4', label: '2–4 ชั่วโมง' },
        { id: 'gt4', label: 'มากกว่า 4 ชั่วโมง' }, { id: 'unsure', label: 'ไม่แน่ใจ' }] },
    { id: 'faster', kind: 'multi', required: false, other: true, exclusive: 'none', title: 'เรื่องไหนที่ probook ทำให้เร็วขึ้นจริง ๆ?', help: 'เลือกเฉพาะที่รู้สึกชัด ๆ · เลือกได้หลายข้อ',
      options: [{ id: 'book', label: 'จองคิวถ่าย' }, { id: 'approve', label: 'อนุมัติ / จัดทีม / ลงปฏิทิน' },
        { id: 'calendar', label: 'ดูว่าใครถ่ายอะไรวันไหน (ปฏิทิน)' }, { id: 'notify', label: 'รู้ว่างานอนุมัติแล้ว ใครไปกอง (เมล + Calendar invite)' },
        { id: 'footage', label: 'รู้ว่าฟุตเทจขึ้น Drive ครบแล้ว (เมล "Footage พร้อม")' }, { id: 'folder', label: 'หาโฟลเดอร์ Drive ของงาน' },
        { id: 'edit', label: 'ขอแก้ / ขอยกเลิกงาน' }, { id: 'none', label: 'ยังไม่มีเรื่องไหนเร็วขึ้น' }] },
    { id: 'slower', kind: 'multi', required: false, other: true, title: 'แล้วเรื่องไหนที่ยัง "กินเวลา" อยู่?', help: 'เลือกได้หลายข้อ',
      options: [{ id: 'reschedule', label: 'เลื่อนวัน/เวลา ต้องยกเลิกแล้วจองใหม่' }, { id: 'edit_after', label: 'แก้ใบหลังอนุมัติ (ต้องส่งข้อความ / ต้องแก้ให้ทีละช่อง)' },
        { id: 'qu', label: 'เลข QU / Agency Ref' }, { id: 'long_form', label: 'ฟอร์มจองยาว กรอกหลายขั้น' },
        { id: 'status', label: 'ไม่รู้ว่างานอนุมัติแล้วหรือยัง' }, { id: 'clash', label: 'ห้องชน / กล้องหรือคนไม่พอ' },
        { id: 'footage', label: 'หาไฟล์ฟุตเทจไม่เจอ / โฟลเดอร์งง' }, { id: 'email', label: 'เมลเยอะเกิน หรือเมลไม่มา' },
        { id: 'login', label: 'ต้องล็อกอินใหม่บ่อย' }] },
    { id: 'feel', kind: 'single', required: true, title: 'โดยรวมแล้ว รู้สึกกับ probook ยังไง?',
      options: [{ id: '5', label: '😍 ชอบมาก ช่วยได้เยอะ' }, { id: '4', label: '🙂 ชอบ' }, { id: '3', label: '😐 เฉย ๆ' },
        { id: '2', label: '😕 ไม่ค่อยชอบ' }, { id: '1', label: '😫 ไม่ชอบเลย' }] },
    { id: 'wish', kind: 'text', required: false, title: 'ถ้าเสกได้ 1 อย่าง ให้ probook ช่วยประหยัดเวลาคุณได้อีก อยากให้ทำอะไร? ✨', help: 'ไม่บังคับ' },
    { id: 'note', kind: 'text', required: false, title: 'มีอะไรอยากบอกนัทอีกไหม?', help: 'ชม ติ บ่น ได้หมดเลย 😄 · ไม่บังคับ' },
  ] as Question[],
}

export const TEXT_MAX = 2000
export const OTHER_MAX = 200

/** คำถามที่คนกลุ่มนี้เห็น ตามลำดับ (ยังไม่เลือกกลุ่ม = เส้นทางคนจองงาน ใช้แค่นับความยาวคร่าว ๆ) */
export function questionsFor(group: Group | null): Question[] {
  return SURVEY.questions.filter(q => !q.group || q.group === (group ?? 'booker'))
}

/**
 * ตรวจคำตอบทั้งชุดก่อนบันทึก — คืนเฉพาะคำตอบของคำถามที่กลุ่มนั้นเห็นจริง (ตัดของกลุ่มอื่นทิ้ง)
 * ตัวเลือกต้องเป็น id ที่มีอยู่ · ข้อบังคับต้องตอบ · ข้อความยาวไม่เกินเพดาน
 */
export function validateAnswers(raw: unknown):
  { ok: true; group: Group; answers: Answers } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'คำตอบไม่ถูกรูปแบบ' }
  const a = raw as Record<string, unknown>
  const group = a.role
  if (group !== 'booker' && group !== 'queue') return { ok: false, error: 'ยังไม่ได้เลือกบทบาท' }
  const out: Answers = {}
  for (const q of questionsFor(group)) {
    const v = a[q.id]
    const ids = new Set((q.options || []).map(o => o.id))
    if (q.kind === 'text') {
      if (v === undefined || v === null || v === '') { if (q.required) return { ok: false, error: `ยังไม่ได้ตอบ: ${q.title}` }; continue }
      if (typeof v !== 'string') return { ok: false, error: `คำตอบไม่ถูกรูปแบบ: ${q.title}` }
      const t = v.trim()
      if (t.length > TEXT_MAX) return { ok: false, error: `ข้อความยาวเกิน ${TEXT_MAX} ตัวอักษร` }
      if (t) out[q.id] = t
      continue
    }
    if (q.kind === 'single') {
      if (v === undefined || v === null || v === '') { if (q.required) return { ok: false, error: `ยังไม่ได้ตอบ: ${q.title}` }; continue }
      if (typeof v !== 'string' || !ids.has(v)) return { ok: false, error: `ตัวเลือกไม่ถูกต้อง: ${q.title}` }
      out[q.id] = v
      continue
    }
    // multi
    const list = v === undefined || v === null ? [] : v
    if (!Array.isArray(list) || list.some(x => typeof x !== 'string' || !ids.has(x))) return { ok: false, error: `ตัวเลือกไม่ถูกต้อง: ${q.title}` }
    const uniq = [...new Set(list as string[])]
    if (q.exclusive && uniq.includes(q.exclusive) && uniq.length > 1) return { ok: false, error: `เลือกขัดกันเอง: ${q.title}` }
    const otherRaw = q.other ? a[`${q.id}_other`] : undefined
    if (otherRaw !== undefined && otherRaw !== null && typeof otherRaw !== 'string') return { ok: false, error: `คำตอบไม่ถูกรูปแบบ: ${q.title}` }
    const other = typeof otherRaw === 'string' ? otherRaw.trim() : ''
    if (other.length > OTHER_MAX) return { ok: false, error: `ช่อง "อื่น ๆ" ยาวเกิน ${OTHER_MAX} ตัวอักษร` }
    if (q.exclusive && uniq.includes(q.exclusive) && other) return { ok: false, error: `เลือกขัดกันเอง: ${q.title}` }
    if (q.required && uniq.length === 0 && !other) return { ok: false, error: `ยังไม่ได้ตอบ: ${q.title}` }
    if (uniq.length) out[q.id] = uniq
    if (other) out[`${q.id}_other`] = other
  }
  return { ok: true, group, answers: out }
}

// ponytail: แปลงช่วงเป็นค่ากลางเพื่อประมาณเวลา — เป็นค่าประมาณจากความรู้สึกคนตอบ ไม่ใช่การจับเวลา
// "มากกว่า X" ใช้ค่ากลาง ๆ ที่สมเหตุผล · "ทำให้เสียเวลาเพิ่ม" นับ −30 นาที/สัปดาห์ · ไม่แน่ใจ/ไม่ทันวิธีเดิม = ไม่นับ
export const MINUTES: Record<string, Record<string, number>> = {
  b_now: { lt5: 3, '5_10': 7.5, '10_20': 15, gt20: 25 },
  b_before: { lt10: 5, '10_30': 20, '30_60': 45, '1_2h': 90, gt2h: 150 },
  q_now: { lt2: 1, '2_5': 3.5, '5_10': 7.5, gt10: 15 },
  q_before: { lt5: 3, '5_15': 10, '15_30': 22.5, '30_60': 45, gt1h: 75 },
}
export const HOURS_PER_WEEK: Record<string, number> = { worse: -0.5, same: 0, lt30: 0.25, '30_60': 0.75, '1_2': 1.5, '2_4': 3, gt4: 5 }

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)

export type Summary = {
  total: number
  byGroup: Record<Group, number>
  /** questionId → optionId → จำนวนคน */
  counts: Record<string, Record<string, number>>
  /** ชั่วโมงที่ประหยัด/สัปดาห์/คน เฉลี่ย (ไม่นับ "ไม่แน่ใจ") */
  hoursPerWeek: { avg: number | null; n: number }
  /** นาทีต่อใบ: เฉลี่ยก่อน/ตอนนี้ เฉพาะคนที่ทันวิธีเดิม */
  perItem: Record<Group, { before: number | null; now: number | null; saved: number | null; n: number }>
  /** คะแนนความรู้สึก 1–5 เฉลี่ย + % ที่ตอบ ชอบ/ชอบมาก */
  feel: { avg: number | null; positivePct: number | null; n: number }
  texts: { wish: string[]; note: string[]; other: string[] }
}

export function summarize(rows: Array<{ group: string; answers: unknown }>): Summary {
  const s: Summary = {
    total: 0, byGroup: { booker: 0, queue: 0 }, counts: {},
    hoursPerWeek: { avg: null, n: 0 }, perItem: { booker: { before: null, now: null, saved: null, n: 0 }, queue: { before: null, now: null, saved: null, n: 0 } },
    feel: { avg: null, positivePct: null, n: 0 }, texts: { wish: [], note: [], other: [] },
  }
  const hours: number[] = [], feel: number[] = []
  const pairs: Record<Group, Array<[number, number]>> = { booker: [], queue: [] }
  for (const r of rows) {
    const g = r.group === 'queue' ? 'queue' : r.group === 'booker' ? 'booker' : null
    if (!g || !r.answers || typeof r.answers !== 'object') continue
    const a = r.answers as Answers
    s.total++; s.byGroup[g]++
    for (const q of questionsFor(g)) {
      const v = a[q.id]
      if (q.kind === 'text') { if (typeof v === 'string' && v) s.texts[q.id === 'wish' ? 'wish' : 'note'].push(v); continue }
      const c = (s.counts[q.id] ||= {})
      for (const id of Array.isArray(v) ? v : typeof v === 'string' ? [v] : []) c[id] = (c[id] || 0) + 1
      const o = a[`${q.id}_other`]
      if (typeof o === 'string' && o) s.texts.other.push(o)
    }
    const h = HOURS_PER_WEEK[a.hours as string]
    if (h !== undefined) hours.push(h)
    const f = Number(a.feel)
    if (f >= 1 && f <= 5) feel.push(f)
    const p = g === 'booker' ? 'b' : 'q'
    const before = MINUTES[`${p}_before`][a[`${p}_before`] as string]
    const now = MINUTES[`${p}_now`][a[`${p}_now`] as string]
    if (before !== undefined && now !== undefined) pairs[g].push([before, now])
  }
  s.hoursPerWeek = { avg: mean(hours), n: hours.length }
  s.feel = { avg: mean(feel), positivePct: feel.length ? (feel.filter(f => f >= 4).length / feel.length) * 100 : null, n: feel.length }
  for (const g of ['booker', 'queue'] as Group[]) {
    const before = mean(pairs[g].map(x => x[0])), now = mean(pairs[g].map(x => x[1]))
    s.perItem[g] = { before, now, saved: before !== null && now !== null ? before - now : null, n: pairs[g].length }
  }
  return s
}
