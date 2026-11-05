/**
 * แบบสำรวจการใช้งาน Production Booking — รอบ satisfaction-2026-11 (v1.279, 4 พ.ย. 2569)
 *
 * แทนรอบ "probook ช่วยประหยัดเวลาแค่ไหน" (time-2026-11, v1.278) ตามฟีดแบ็กที่นัทส่งมา:
 * ลดเหลือคำถามหลัก 4 ข้อ + ทีม · ทุกข้ออยู่หน้าเดียว · ถามเฉพาะคนจองคิว (Producer / PM ฯลฯ) ·
 * คำถามเป็นกลาง (สเกลสองขั้ว มีจุดกลาง) · ไม่มีข้อความสัญญาว่าจะสรุปผลให้ทุกคน
 * v1.279.2 (5 พ.ย.) นัทปรับคำ: ข้อ 2 เป็นข้อความให้ตอบเห็นด้วย–ไม่เห็นด้วย (ความรู้สึกคนใช้ ไม่ใช่ให้ตัดสินระบบ · ตัด "ตอบไม่ได้") ·
 * ข้อ 4 ถาม "จุดแข็งที่อยากให้รักษาไว้" และบังคับตอบ · ข้อ 5 คำอธิบายเชิงเปิดรับแทน "ไม่บังคับ"
 *
 * ไฟล์นี้คือที่เดียวที่นิยามแบบสอบถาม: หน้า /survey, API ตรวจคำตอบ และหน้าผลใช้ชุดเดียวกัน
 * ตัวเลือกเก็บเป็น id ไม่ใช่ข้อความไทย — แก้คำบนจอได้โดยผลที่เก็บไปแล้วไม่เพี้ยน
 * ไม่ import อะไรฝั่ง server เพราะหน้า client ใช้ด้วย
 */

export const SURVEY_KEY = 'satisfaction-2026-11'

export type Kind = 'select' | 'scale' | 'multi' | 'text'
export type Option = { id: string; label: string }
export type Question = {
  id: string
  kind: Kind
  title: string
  help?: string
  required: boolean
  /** select / multi */
  options?: Option[]
  /** scale: ป้าย 5 ระดับ (1 → 5) */
  scale?: string[]
  /** scale: ทางออกสำหรับคนที่ตอบไม่ได้ — เก็บเป็น 'na' ไม่นับในค่าเฉลี่ย */
  na?: string
  /** multi: มีช่อง "อื่น ๆ" — เก็บที่ `<id>_other` */
  other?: boolean
  /** multi: ตัวเลือกนี้เลือกคู่กับตัวอื่นไม่ได้ */
  exclusive?: string
}
export type Answers = Record<string, string | string[]>

/**
 * ทีม — รวมทีมเล็กให้แต่ละตัวเลือกมีคนจองคิวอย่างน้อย ~5 คน (นับจากใบที่ถ่ายใน 180 วัน ณ 4 พ.ย. 2569:
 * News 9 · Event 6 · Agency 5 · PM 5 · Wealth/Sport/KND 3 · TSS/Podcast 2 · POP/LIFE 1)
 * ตัวเลือกที่มีคนแค่ 1–2 คน = คำตอบผูกกับชื่อโดยปริยาย ขัดกับที่บอกคนตอบว่าไม่ผูกชื่อ
 * ทีมถูกเก็บในคอลัมน์ `group` ของ survey_responses (ไม่ซ้ำใน answers)
 */
// v1.279.1 — 1 outlet = 1 ตัวเลือก (นัทสั่ง: ไม่จับกลุ่ม) · ลำดับ/ชื่อตามตาราง outlets (sort) · id = code ตัวเล็ก
// ทีมที่คนตอบไม่ถึง TEAM_MIN ถูกรวมเป็นก้อนเดียวในหน้าผลอยู่แล้ว (summarize) — แยกละเอียดขึ้นไม่ทำให้ระบุตัวได้
export const TEAMS: Option[] = [
  { id: 'nws', label: 'News' },
  { id: 'wlt', label: 'Wealth' },
  { id: 'spt', label: 'Sport' },
  { id: 'pop', label: 'POP' },
  { id: 'pod', label: 'Podcast' },
  { id: 'knd', label: 'KND (คำนี้ดี)' },
  { id: 'lif', label: 'LIFE' },
  { id: 'tss', label: 'The Secret Sauce' },
  { id: 'agn', label: 'Content Agency' },
  { id: 'evt', label: 'Event' },
  { id: 'pm', label: 'PM (Project Management Office)' },
  { id: 'other', label: 'ทีมอื่น' },
  { id: 'na', label: 'ไม่ขอระบุ' },
]

/** ผลแยกทีมโชว์เฉพาะทีมที่มีคนตอบตั้งแต่เท่านี้ — ข้อความ privacy ที่คนตอบเห็นอ้างเลขนี้ */
export const TEAM_MIN = 3

export const SURVEY = {
  key: SURVEY_KEY,
  title: 'แบบสำรวจการใช้งาน Production Booking',
  intro: 'อยากฟังความเห็นจากคนที่จองคิวถ่ายผ่านระบบ ทั้งส่วนที่ใช้ได้ดีและส่วนที่ควรปรับ เพื่อนำไปปรับปรุงระบบต่อครับ',
  facts: ['⏱ ประมาณ 1–2 นาที', '🙈 ไม่ผูกชื่อกับคำตอบ'],
  privacy: `ระบบจำแค่ว่าคุณตอบแล้ว (จะได้ไม่ชวนซ้ำ) แต่ไม่เก็บว่าใครตอบอะไร · ผู้ดูแลระบบจะเห็นผลแยกรายทีมเฉพาะทีมที่มีคนตอบตั้งแต่ ${TEAM_MIN} คนขึ้นไป ทีมที่มีคนตอบน้อยกว่านั้นจะถูกรวมเป็นกลุ่มเดียวกัน`,
  questions: [
    { id: 'team', kind: 'select', required: true, title: 'คุณอยู่ทีม / แผนกไหน?',
      help: 'ถ้าดูแลหลายทีม เลือกทีมที่สังกัด · ไม่อยากระบุ เลือก "ไม่ขอระบุ" ได้', options: TEAMS },
    { id: 'efficiency', kind: 'scale', required: true,
      title: 'ระบบ Production Booking ช่วยให้คุณวางแผนการทำงานได้สะดวกและมีประสิทธิภาพมากขึ้น',
      scale: ['ไม่เห็นด้วยอย่างยิ่ง', 'ไม่เห็นด้วย', 'เฉย ๆ', 'เห็นด้วย', 'เห็นด้วยอย่างยิ่ง'] },
    { id: 'satisfaction', kind: 'scale', required: true,
      title: 'โดยรวม คุณพึงพอใจกับการใช้งานระบบในระดับใด?',
      scale: ['ไม่พึงพอใจมาก', 'ไม่พึงพอใจ', 'เฉย ๆ', 'พึงพอใจ', 'พึงพอใจมาก'] },
    { id: 'useful', kind: 'multi', required: true, exclusive: 'none',   // v1.279.3 ตัดช่อง "อื่น ๆ" (นัท 5 พ.ย.)
      title: 'ฟังก์ชันที่คุณคิดว่าเป็นจุดแข็งของระบบ Production Booking และอยากให้รักษาไว้ต่อไป', help: 'เลือกได้หลายข้อ',
      options: [
        { id: 'approved_mail', label: 'เมลและ Calendar invite เมื่อคิวได้รับอนุมัติ' },
        { id: 'footage_mail', label: 'เมล "Footage พร้อม" เมื่อฟุตเทจขึ้น Drive ครบ' },
        { id: 'capacity', label: 'คำเตือนตอนจองเมื่อช่วงเวลานั้นกล้องหรือทีมงานไม่พอ (อาจต้องเช่าอุปกรณ์ / จ้างฟรีแลนซ์)' },
        { id: 'status', label: 'หน้า My Bookings — ดูสถานะคิวของตัวเอง (อนุมัติหรือยัง / ใครไปกอง)' },
        { id: 'calendar', label: 'หน้า Calendar — ดูว่าวันไหนมีงานถ่ายอะไร' },
        { id: 'folder', label: 'โฟลเดอร์ Drive ของงานที่ระบบสร้างให้' },
        { id: 'none', label: 'ไม่มีข้อไหนเลย' },
      ] },
    { id: 'improve', kind: 'text', required: false, title: 'สิ่งที่อยากให้ปรับปรุงหรือพัฒนาเพิ่มเติม',
      help: 'พร้อมรับทุกความเห็นเพื่อพัฒนาการใช้งานกันต่อไปเสมอครับ · ข้อความจะแสดงตามที่พิมพ์ (ไม่มีชื่อกำกับ)' },
  ] as Question[],
}

export const TEXT_MAX = 2000
export const OTHER_MAX = 200
const SCALE_IDS = ['1', '2', '3', '4', '5']

export type SurveyDef = typeof SURVEY

/**
 * v1.279.3 — คำบนจอแก้ได้จาก /admin/survey โดยไม่ต้อง deploy (นัท 5 พ.ย.: "เปิดให้กูแก้ปรับคำถามเอง")
 * เก็บเฉพาะ "ส่วนที่ต่างจากโค้ด" ต่อ id — โครงคำถาม/ตัวเลือก (id, kind, exclusive, other) ยังมาจากโค้ด
 * เพื่อให้ผลที่เก็บไปแล้วอ่านออกเสมอ · ค่าว่าง = กลับไปใช้ของโค้ด
 */
export type QuestionOverride = { title?: string; help?: string; required?: boolean; scale?: string[]; options?: Record<string, string> }
export type Overrides = { intro?: string; questions?: Record<string, QuestionOverride> }
const OVERRIDE_TEXT_MAX = 500

/** รับ JSON จากฟอร์มแอดมิน → Overrides ที่สะอาด (ตัดช่องว่าง, ทิ้งช่องว่างเปล่า) หรือบอกว่าผิดตรงไหน */
export function validateOverrides(raw: unknown): { ok: true; value: Overrides | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'รูปแบบไม่ถูกต้อง' }
  const r = raw as Record<string, unknown>
  const str = (v: unknown, where: string): string | undefined | { error: string } => {
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string') return { error: `${where}: ต้องเป็นข้อความ` }
    const t = v.trim()
    if (t.length > OVERRIDE_TEXT_MAX) return { error: `${where}: ยาวเกิน ${OVERRIDE_TEXT_MAX} ตัวอักษร` }
    return t || undefined
  }
  const out: Overrides = {}
  const intro = str(r.intro, 'คำนำ')
  if (typeof intro === 'object') return { ok: false, error: intro.error }
  if (intro) out.intro = intro
  if (r.questions !== undefined && r.questions !== null) {
    if (typeof r.questions !== 'object' || Array.isArray(r.questions)) return { ok: false, error: 'questions ต้องเป็น object' }
    for (const [id, qv] of Object.entries(r.questions as Record<string, unknown>)) {
      const q = SURVEY.questions.find(x => x.id === id)
      if (!q) return { ok: false, error: `ไม่มีคำถาม id "${id}"` }
      if (!qv || typeof qv !== 'object' || Array.isArray(qv)) return { ok: false, error: `${q.id}: รูปแบบไม่ถูกต้อง` }
      const o = qv as Record<string, unknown>
      const qo: QuestionOverride = {}
      for (const k of ['title', 'help'] as const) {
        const v = str(o[k], `${q.id}.${k}`)
        if (typeof v === 'object') return { ok: false, error: v.error }
        if (v) qo[k] = v
      }
      if (o.required !== undefined && o.required !== null) {
        if (typeof o.required !== 'boolean') return { ok: false, error: `${q.id}: required ต้องเป็น true/false` }
        if (q.id === 'team' && !o.required) return { ok: false, error: 'ข้อทีมต้องบังคับตอบ (ผลแยกทีมใช้ค่านี้)' }
        if (o.required !== q.required) qo.required = o.required
      }
      if (o.scale !== undefined && o.scale !== null) {
        if (q.kind !== 'scale') return { ok: false, error: `${q.id}: ไม่ใช่ข้อสเกล` }
        if (!Array.isArray(o.scale) || o.scale.length !== 5) return { ok: false, error: `${q.id}: ป้ายสเกลต้องมี 5 ช่อง` }
        const labels: string[] = []
        for (const [i, v] of o.scale.entries()) {
          const t = str(v, `${q.id}.scale[${i + 1}]`)
          if (typeof t === 'object') return { ok: false, error: t.error }
          labels.push(t || q.scale![i])
        }
        if (labels.some((l, i) => l !== q.scale![i])) qo.scale = labels
      }
      if (o.options !== undefined && o.options !== null) {
        if (!q.options) return { ok: false, error: `${q.id}: ไม่มีตัวเลือกให้แก้` }
        if (typeof o.options !== 'object' || Array.isArray(o.options)) return { ok: false, error: `${q.id}: options ต้องเป็น object` }
        const opts: Record<string, string> = {}
        for (const [oid, v] of Object.entries(o.options as Record<string, unknown>)) {
          const opt = q.options.find(x => x.id === oid)
          if (!opt) return { ok: false, error: `${q.id}: ไม่มีตัวเลือก id "${oid}"` }
          const t = str(v, `${q.id}.${oid}`)
          if (typeof t === 'object') return { ok: false, error: t.error }
          if (t && t !== opt.label) opts[oid] = t
        }
        if (Object.keys(opts).length) qo.options = opts
      }
      if (Object.keys(qo).length) (out.questions ||= {})[id] = qo
    }
  }
  return { ok: true, value: Object.keys(out).length ? out : null }
}

/** ชุดคำถามที่หน้า /survey และ API ใช้จริง = โค้ด + ส่วนที่แอดมินแก้ (ไม่แก้ SURVEY ตัวจริง) */
export function applyOverrides(ov: Overrides | null | undefined): SurveyDef {
  if (!ov) return SURVEY
  return {
    ...SURVEY,
    intro: ov.intro ?? SURVEY.intro,
    questions: SURVEY.questions.map(q => {
      const o = ov.questions?.[q.id]
      if (!o) return q
      return {
        ...q,
        title: o.title ?? q.title,
        help: o.help ?? q.help,
        required: o.required ?? q.required,
        scale: o.scale ?? q.scale,
        options: q.options && o.options ? q.options.map(x => ({ ...x, label: o.options![x.id] ?? x.label })) : q.options,
      }
    }),
  }
}

/**
 * ตรวจคำตอบทั้งชุดก่อนบันทึก — คืนทีมแยกออกมา (ลงคอลัมน์ group) + คำตอบที่เหลือ
 * ตัวเลือกต้องเป็น id ที่มีอยู่ · ข้อบังคับต้องตอบ · ข้อความยาวไม่เกินเพดาน · คีย์แปลกถูกตัดทิ้ง
 */
export function validateAnswers(raw: unknown, survey: SurveyDef = SURVEY):
  { ok: true; group: string; answers: Answers } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'คำตอบไม่ถูกรูปแบบ' }
  const a = raw as Record<string, unknown>
  const out: Answers = {}
  let group = ''
  for (const q of survey.questions) {
    const v = a[q.id]
    const empty = v === undefined || v === null || v === ''
    if (q.kind === 'text') {
      if (empty) { if (q.required) return { ok: false, error: `ยังไม่ได้ตอบ: ${q.title}` }; continue }
      if (typeof v !== 'string') return { ok: false, error: `คำตอบไม่ถูกรูปแบบ: ${q.title}` }
      const t = v.trim()
      if (t.length > TEXT_MAX) return { ok: false, error: `ข้อความยาวเกิน ${TEXT_MAX} ตัวอักษร` }
      if (t) out[q.id] = t
      continue
    }
    if (q.kind === 'select' || q.kind === 'scale') {
      if (empty) { if (q.required) return { ok: false, error: `ยังไม่ได้ตอบ: ${q.title}` }; continue }
      const allowed = q.kind === 'select' ? (q.options || []).map(o => o.id) : [...SCALE_IDS, ...(q.na ? ['na'] : [])]
      if (typeof v !== 'string' || !allowed.includes(v)) return { ok: false, error: `ตัวเลือกไม่ถูกต้อง: ${q.title}` }
      if (q.id === 'team') group = v
      else out[q.id] = v
      continue
    }
    // multi
    const ids = new Set((q.options || []).map(o => o.id))
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
  if (!group) return { ok: false, error: 'ยังไม่ได้เลือกทีม' }
  return { ok: true, group, answers: out }
}

export type ScaleStat = {
  /** คนที่ให้คะแนน 1–5 (ไม่นับ "ตอบไม่ได้") */
  n: number
  avg: number | null
  dist: Record<string, number>
  na: number
  /** % ที่ตอบ 4–5 และ 1–2 ของคนที่ให้คะแนน */
  topPct: number | null
  bottomPct: number | null
}
export type Summary = {
  total: number
  scales: Record<string, ScaleStat>
  /**
   * แยกทีม — เฉพาะทีมที่มีคนตอบ ≥ teamMin · ทีมที่เหลือรวมไว้ใน `smallTeams` (ไม่บอกว่ามีทีมไหนบ้าง)
   * ถ้าก้อนที่เหลือมี 1–2 คน ทีมที่เล็กสุดในตารางถูกพับรวมเข้าไปด้วย — ไม่งั้น "ภาพรวม − ทีมที่โชว์" = คะแนนรายคน
   */
  teams: Array<{ id: string; label: string; n: number; scales: Record<string, ScaleStat> }>
  smallTeams: number
  /** questionId → optionId → จำนวนคน (เฉพาะ multi) */
  counts: Record<string, Record<string, number>>
  /** questionId → จำนวนคนที่ตอบข้อ multi นั้นจริง (ข้อไม่บังคับ — ตัวหารไม่ใช่ total) */
  answered: Record<string, number>
  texts: { improve: string[]; other: string[] }
}

const SCALE_QS = SURVEY.questions.filter(q => q.kind === 'scale').map(q => q.id)

function scaleStat(values: string[]): ScaleStat {
  const dist: Record<string, number> = Object.fromEntries(SCALE_IDS.map(id => [id, 0]))
  let na = 0
  const nums: number[] = []
  for (const v of values) {
    if (v === 'na') { na++; continue }
    if (!SCALE_IDS.includes(v)) continue
    dist[v]++
    nums.push(Number(v))
  }
  const n = nums.length
  return {
    n, dist, na,
    avg: n ? nums.reduce((s, x) => s + x, 0) / n : null,
    topPct: n ? (nums.filter(x => x >= 4).length / n) * 100 : null,
    bottomPct: n ? (nums.filter(x => x <= 2).length / n) * 100 : null,
  }
}

export function summarize(rows: Array<{ group: string; answers: unknown }>, teamMin = TEAM_MIN): Summary {
  const valid = rows.filter(r => TEAMS.some(t => t.id === r.group) && r.answers && typeof r.answers === 'object') as
    Array<{ group: string; answers: Answers }>
  const scalesOf = (rs: typeof valid) =>
    Object.fromEntries(SCALE_QS.map(id => [id, scaleStat(rs.map(r => r.answers[id]).filter((v): v is string => typeof v === 'string'))]))

  const counts: Summary['counts'] = {}
  const answered: Summary['answered'] = {}
  const texts: Summary['texts'] = { improve: [], other: [] }
  for (const r of valid) {
    for (const q of SURVEY.questions) {
      const v = r.answers[q.id]
      if (q.kind === 'multi') {
        const c = (counts[q.id] ||= {})
        for (const id of Array.isArray(v) ? v : []) c[id] = (c[id] || 0) + 1
        const o = r.answers[`${q.id}_other`]
        if (typeof o === 'string' && o) texts.other.push(o)
        if ((Array.isArray(v) && v.length) || (typeof o === 'string' && o)) answered[q.id] = (answered[q.id] || 0) + 1
      } else if (q.kind === 'text' && typeof v === 'string' && v) texts.improve.push(v)
    }
  }

  const teams: Summary['teams'] = []
  let smallTeams = 0
  for (const t of TEAMS) {
    const rs = valid.filter(r => r.group === t.id)
    if (!rs.length) continue
    if (rs.length < teamMin) { smallTeams += rs.length; continue }
    teams.push({ id: t.id, label: t.label, n: rs.length, scales: scalesOf(rs) })
  }
  // ก้อนที่เหลือ 1–2 คน: ภาพรวมลบทีมที่โชว์ = คะแนนของคนกลุ่มนั้นตรงตัว → พับทีมเล็กสุดเข้าไปด้วย
  // (ทีมที่โชว์มี ≥ teamMin เสมอ พับทีมเดียวก็พ้นเพดาน)
  if (smallTeams > 0 && smallTeams < teamMin && teams.length) {
    const i = teams.reduce((m, t, j) => (t.n < teams[m].n ? j : m), 0)
    smallTeams += teams.splice(i, 1)[0].n
  }
  return { total: valid.length, scales: scalesOf(valid), teams, smallTeams, counts, answered, texts }
}
