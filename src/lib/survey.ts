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

/** ผลแยกทีมโชว์เฉพาะทีมที่มีคนตอบตั้งแต่เท่านี้ (ตั้งแต่ v1.280.3 ไม่ได้ประกาศเลขนี้บนหน้าคนตอบแล้ว) */
export const TEAM_MIN = 3

/**
 * v1.285.1 — "กล่อง" ของคนตอบ (ใส่ฝั่ง server ตอนบันทึก เก็บในคำตอบเป็น `seg`): booker = จองคิวเอง (สร้าง/Producer/Co-Producer ของใบที่ถ่ายใน 180 วัน)
 * other = ล็อกอินเข้ามาตอบแต่ไม่ได้จองเอง (ไม่เคยใช้ / ใช้ทางอ้อม / ทีมจัดคิว) — ไว้วัดว่าคนที่ไม่ได้ใช้เองรู้สึกต่างจากคนใช้ไหม
 */
export type Segment = 'booker' | 'other'
export const SEGMENTS: Array<{ id: Segment; label: string }> = [
  { id: 'booker', label: 'คนจองคิวเอง' },
  { id: 'other', label: 'ไม่ได้จองเอง / ไม่เคยใช้' },
]

export const SURVEY = {
  key: SURVEY_KEY,
  title: 'แบบสำรวจการใช้งาน Production Booking',
  intro: 'อยากฟังความเห็นจากทุกคนที่เกี่ยวข้องกับการจองคิวถ่ายผ่านระบบ ทั้งส่วนที่ใช้ได้ดีและส่วนที่ควรปรับ เพื่อนำไปปรับปรุงระบบต่อครับ',
  facts: ['⏱ ประมาณ 1–2 นาที', '🙈 ไม่ผูกชื่อกับคำตอบ'],
  // v1.280.3 — นัทสั่งเอาประโยค "ผู้ดูแลระบบจะเห็นผลแยกรายทีม…" ออกจากจอ · กฎ TEAM_MIN ใน summarize ยังทำงานเหมือนเดิม (แค่ไม่ประกาศ)
  privacy: 'ระบบจำแค่ว่าคุณตอบแล้ว (จะได้ไม่ชวนซ้ำ) แต่ไม่เก็บว่าใครตอบอะไร',
  questions: [
    { id: 'team', kind: 'select', required: true, title: 'คุณอยู่ทีม / แผนกไหน?',
      help: 'ถ้าดูแลหลายทีม เลือกทีมที่สังกัด · ไม่อยากระบุ เลือก "ไม่ขอระบุ" ได้', options: TEAMS },
    { id: 'satisfaction', kind: 'scale', required: true,
      title: 'โดยรวม คุณพึงพอใจกับการใช้ Production Booking แค่ไหน?',
      scale: ['ไม่พึงพอใจมาก', 'ไม่พึงพอใจ', 'เฉย ๆ', 'พึงพอใจ', 'พึงพอใจมาก'] },
    { id: 'efficiency', kind: 'scale', required: true,
      title: 'ระบบ Production Booking ช่วยให้คุณวางแผนการทำงานได้สะดวกและมีประสิทธิภาพมากขึ้น',
      scale: ['ไม่เห็นด้วยอย่างยิ่ง', 'ไม่เห็นด้วย', 'เฉย ๆ', 'เห็นด้วย', 'เห็นด้วยอย่างยิ่ง'] },
    // v1.284.2 — ข้อ 4/5 เป็นพิมพ์ข้อความ (นัท 11 พ.ย.) · id ใหม่ keep/change เพราะ useful/fix เดิมเก็บเป็นรายการตัวเลือก — id เดียวไม่ควรเปลี่ยนรูปข้อมูลกลางทาง
    { id: 'keep', kind: 'text', required: true, title: 'ส่วนไหนของระบบที่คุณพึงพอใจ และอยากให้รักษาไว้ต่อไป' },
    { id: 'change', kind: 'text', required: true, title: 'ส่วนไหนของระบบที่คุณอยากให้ปรับปรุงก่อน' },
    // ข้อความเปิดถามเหตุการณ์จริงล่าสุด (เจาะจงกว่า "มีอะไรอยากบอกไหม" ได้คำตอบที่เอาไปทำต่อได้) · ไม่บังคับ
    // ไม่มีคำอธิบายใต้ข้อ (นัทสั่งเอาออก v1.280.2 · ช่องว่างในหน้าแก้คำ = ใช้คำในโค้ด จึงลบจากหน้าแก้คำไม่ได้)
    { id: 'improve', kind: 'text', required: false, title: 'ครั้งล่าสุดที่จองคิว มีตรงไหนที่ติด หรือต้องถามคนอื่นต่อบ้าง? มีอะไรอยากให้ระบบทำเพิ่มก็บอกได้เลย' },
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
export function validateOverrides(raw: unknown, survey: SurveyDef = SURVEY): { ok: true; value: Overrides | null } | { ok: false; error: string } {
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
      const q = survey.questions.find(x => x.id === id)
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
      // ฟอร์มแอดมินส่ง scale: [] / options: {} มากับทุกข้อ — ว่าง = ไม่แก้ (บั๊ก v1.279.3: ปฏิเสธ "team: ไม่ใช่ข้อสเกล" ทั้งที่ไม่ได้แก้อะไร)
      if (o.scale !== undefined && o.scale !== null && !(Array.isArray(o.scale) && o.scale.length === 0)) {
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
      if (o.options !== undefined && o.options !== null && !(typeof o.options === 'object' && !Array.isArray(o.options) && Object.keys(o.options).length === 0)) {
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
export function applyOverrides(ov: Overrides | null | undefined, survey: SurveyDef = SURVEY): SurveyDef {
  if (!ov) return survey
  return {
    ...survey,
    intro: ov.intro ?? survey.intro,
    questions: survey.questions.map(q => {
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
      // ช่องว่างล้วนไม่ใช่คำตอบ — หน้าจอเช็กด้วย trim อยู่แล้ว แต่ด่านนี้ต้องไม่ผ่านถ้ามีคนยิง API ตรง ๆ (ข้อบังคับพิมพ์ข้อความเริ่มใช้ v1.284.2)
      if (!t) { if (q.required) return { ok: false, error: `ยังไม่ได้ตอบ: ${q.title}` }; continue }
      out[q.id] = t
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
  /**
   * v1.285.1 — แยกตามกล่อง (คนจองคิวเอง vs ไม่ได้จองเอง) · โชว์เมื่อ "ทั้งสองกล่อง" มีคนตอบ ≥ teamMin เท่านั้น
   * ไม่งั้น null: กล่องเล็ก 1–2 คน = ภาพรวมลบอีกกล่องได้คะแนนรายคน · คำตอบเก่าที่ไม่มี seg ไม่นับเข้ากล่องไหน (นับในภาพรวมตามปกติ)
   */
  segments: Array<{ id: Segment; label: string; n: number; scales: Record<string, ScaleStat> }> | null
  /** questionId → optionId → จำนวนคน (เฉพาะ multi) */
  counts: Record<string, Record<string, number>>
  /** questionId → จำนวนคนที่ตอบข้อ multi นั้นจริง (ข้อไม่บังคับ — ตัวหารไม่ใช่ total) */
  answered: Record<string, number>
  /** ข้อความที่พิมพ์ แยกตาม id ของข้อ (keep / change / improve) · other = ช่อง "อื่น ๆ" ของข้อเลือกตัวเลือก */
  texts: Record<string, string[]>
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

export function summarize(rows: Array<{ group: string; answers: unknown }>, teamMin = TEAM_MIN, survey: SurveyDef = SURVEY): Summary {
  const valid = rows.filter(r => TEAMS.some(t => t.id === r.group) && r.answers && typeof r.answers === 'object') as
    Array<{ group: string; answers: Answers }>
  const scalesOf = (rs: typeof valid) =>
    Object.fromEntries(SCALE_QS.map(id => [id, scaleStat(rs.map(r => r.answers[id]).filter((v): v is string => typeof v === 'string'))]))

  const counts: Summary['counts'] = {}
  const answered: Summary['answered'] = {}
  const texts: Summary['texts'] = { other: [], ...Object.fromEntries(survey.questions.filter(q => q.kind === 'text').map(q => [q.id, [] as string[]])) }
  for (const r of valid) {
    for (const q of survey.questions) {
      const v = r.answers[q.id]
      if (q.kind === 'multi') {
        const c = (counts[q.id] ||= {})
        for (const id of Array.isArray(v) ? v : []) c[id] = (c[id] || 0) + 1
        const o = r.answers[`${q.id}_other`]
        if (typeof o === 'string' && o) texts.other.push(o)
        if ((Array.isArray(v) && v.length) || (typeof o === 'string' && o)) answered[q.id] = (answered[q.id] || 0) + 1
      } else if (q.kind === 'text' && typeof v === 'string' && v) texts[q.id].push(v)
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
  const segRows = SEGMENTS.map(s => ({ ...s, rs: valid.filter(r => r.answers.seg === s.id) }))
  // ต้องไม่มีคำตอบ "ไม่มีกล่อง" ค้าง: ถ้ามี (ข้อมูลก่อน v1.285.1) ภาพรวมลบสองกล่อง = คะแนนของคนกลุ่มนั้นที่ไม่ถึงเพดาน
  const unboxed = valid.length - segRows.reduce((s, x) => s + x.rs.length, 0)
  const segments = segRows.every(x => x.rs.length >= teamMin) && (unboxed === 0 || unboxed >= teamMin)
    ? segRows.map(x => ({ id: x.id, label: x.label, n: x.rs.length, scales: scalesOf(x.rs) }))
    : null
  return { total: valid.length, scales: scalesOf(valid), teams, smallTeams, segments, counts, answered, texts }
}
