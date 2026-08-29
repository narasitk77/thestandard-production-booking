import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SWITCHER_PROGRAM_CODE,
  buildSwitcherProductionId,
  canEditSwitcherJob,
  followUpReason,
  formatDuration,
  guessPlatform,
  hhmmToMinutes,
  idFieldsLocked,
  isSwitcherProductionId,
  isValidHttpUrl,
  isValidISODate,
  isoDateToUTC,
  jobDurationMinutes,
  nextSwitcherSequence,
  normalizeLinks,
  readLinks,
  switcherIdPrefix,
  utcDateToISO,
  validateSwitcherPayload,
  yymmddFromISODate,
} from '../switcher-jobs'
import { parseEpisodeId, EPISODE_ID_RE_LOOSE } from '../episode-id'
import { OUTLETS, getProgram } from '../data'

const knownOutlet = (c: string) => OUTLETS.some(o => o.code === c)

// ── สายเลขต้องไม่ชนกับงานถ่าย ─────────────────────────────────────────────────

test('รหัส LIV ต้องไม่ซ้ำกับรหัสรายการจริงของ outlet ใดเลย', () => {
  // นี่คือสมมติฐานที่ทำให้เลขงานไลฟ์ชนเลขงานถ่ายไม่ได้ ถ้าวันหนึ่งมีคนเพิ่ม
  // รายการรหัส LIV ลง data.ts เทสต์นี้จะแดงก่อนที่ข้อมูลจะปนกันบน prod
  for (const outlet of OUTLETS) {
    assert.equal(
      getProgram(outlet.code, SWITCHER_PROGRAM_CODE),
      undefined,
      `${outlet.code} มีรายการรหัส ${SWITCHER_PROGRAM_CODE} แล้ว — สายเลขจะชนกัน`,
    )
  }
})

test('Production ID งานไลฟ์อ่านได้ด้วย parser ตัวเดียวกับงานถ่าย', () => {
  const id = buildSwitcherProductionId('NWS', '2026-08-29', 1)
  assert.equal(id, 'NWS-LIV-260829-01')
  const parsed = parseEpisodeId(id)
  assert.ok(parsed)
  assert.equal(parsed!.outletCode, 'NWS')
  assert.equal(parsed!.programCode, 'LIV')
  assert.equal(parsed!.dateStr, '260829')
  assert.equal(parsed!.sequence, 1)
  // และถูกจับได้ตอนฝังอยู่ในชื่อโฟลเดอร์/ไฟล์ด้วย (คนจะเอาไปแปะจริง)
  assert.ok(EPISODE_ID_RE_LOOSE.test(`[live] ${id} master.mp4`))
})

test('outlet 2 ตัวอักษร (PM) ก็ยังได้รูปที่ parse ออก', () => {
  const id = buildSwitcherProductionId('PM', '2026-12-31', 12)
  assert.equal(id, 'PM-LIV-261231-12')
  assert.equal(parseEpisodeId(id)?.sequence, 12)
})

test('isSwitcherProductionId แยกงานไลฟ์ออกจากงานถ่าย', () => {
  assert.equal(isSwitcherProductionId('NWS-LIV-260829-01'), true)
  assert.equal(isSwitcherProductionId('NWS-KYM-260616-01'), false)
  assert.equal(isSwitcherProductionId('AGN-260423-01'), false)
  assert.equal(isSwitcherProductionId(null), false)
})

test('ลำดับถัดไป = มากสุดที่เคยออก + 1 และไม่ใช้เลขซ้ำแม้แถวถูกลบ', () => {
  assert.equal(nextSwitcherSequence([]), 1)
  assert.equal(nextSwitcherSequence(['NWS-LIV-260829-01', 'NWS-LIV-260829-03']), 4)
  // เลขของแถวที่ soft-delete ไปแล้วก็ยังนับ — คนอาจก็อปไปแปะที่อื่นแล้ว
  assert.equal(nextSwitcherSequence(['NWS-LIV-260829-07', null, undefined]), 8)
  // ID ที่อ่านไม่ออกถูกข้าม ไม่ทำให้ทั้งก้อนกลายเป็น NaN
  assert.equal(nextSwitcherSequence(['ขยะ', 'NWS-LIV-260829-02']), 3)
})

test('prefix ของคนละ outlet / คนละวัน เป็นคนละสาย', () => {
  assert.equal(switcherIdPrefix('nws', '2026-08-29'), 'NWS-LIV-260829-')
  assert.notEqual(switcherIdPrefix('NWS', '2026-08-29'), switcherIdPrefix('WLT', '2026-08-29'))
  assert.notEqual(switcherIdPrefix('NWS', '2026-08-29'), switcherIdPrefix('NWS', '2026-08-30'))
})

// ── วันที่ ────────────────────────────────────────────────────────────────────

test('yymmdd ตัดจากสตริง ไม่ขึ้นกับโซนเวลาของเครื่อง', () => {
  assert.equal(yymmddFromISODate('2026-01-05'), '260105')
  assert.equal(yymmddFromISODate('2026-12-31'), '261231')
})

test('ปี พ.ศ. ถูกปฏิเสธ ไม่ใช่แปลงเงียบ ๆ', () => {
  assert.equal(isValidISODate('2569-08-29'), false)  // พ.ศ. หลุดเข้ามา
  assert.equal(isValidISODate('2026-08-29'), true)
})

test('วันที่ไม่มีจริง / รูปผิด ถูกปฏิเสธ', () => {
  assert.equal(isValidISODate('2026-02-30'), false)
  assert.equal(isValidISODate('2026-13-01'), false)
  assert.equal(isValidISODate('2026-8-9'), false)
  assert.equal(isValidISODate(''), false)
  assert.equal(isValidISODate(null), false)
})

test('แปลงไป-กลับ @db.Date ได้วันเดิม', () => {
  assert.equal(utcDateToISO(isoDateToUTC('2026-08-29')), '2026-08-29')
  assert.equal(isoDateToUTC('2026-08-29').toISOString(), '2026-08-29T00:00:00.000Z')
})

// ── เวลาทำงาน ─────────────────────────────────────────────────────────────────

test('ชั่วโมงทำงานปกติ', () => {
  assert.equal(jobDurationMinutes({ startTime: '09:00', endTime: '10:35', endDayOffset: 0 }), 95)
  assert.equal(formatDuration(95), '1 ชม. 35 นาที')
  assert.equal(formatDuration(45), '45 นาที')
  assert.equal(formatDuration(120), '2 ชม.')
  assert.equal(formatDuration(null), '—')
})

test('ไลฟ์ข้ามเที่ยงคืนคิดได้เมื่อบอกว่าจบวันถัดไป', () => {
  assert.equal(jobDurationMinutes({ startTime: '22:00', endTime: '01:30', endDayOffset: 1 }), 210)
  // ไม่ติ๊กข้ามคืน = เวลาถอยหลัง → ไม่รับ (ให้คนไปติ๊ก ไม่ใช่เดาให้)
  assert.equal(jobDurationMinutes({ startTime: '22:00', endTime: '01:30', endDayOffset: 0 }), null)
})

test('เวลาที่ยังไม่กรอก / กรอกผิดรูป คืน null ไม่ใช่ 0', () => {
  assert.equal(jobDurationMinutes({ startTime: null, endTime: '10:00', endDayOffset: 0 }), null)
  assert.equal(jobDurationMinutes({ startTime: '9:00', endTime: '10:00', endDayOffset: 0 }), null)
  assert.equal(jobDurationMinutes({ startTime: '09:00', endTime: '09:00', endDayOffset: 0 }), null)
  assert.equal(hhmmToMinutes('24:00'), null)
  assert.equal(hhmmToMinutes('09:60'), null)
  assert.equal(hhmmToMinutes('09:05'), 545)
})

// ── ลิงก์ ─────────────────────────────────────────────────────────────────────

test('รับเฉพาะ http/https — javascript: ต้องไม่รอด', () => {
  assert.equal(isValidHttpUrl('https://youtu.be/abc'), true)
  assert.equal(isValidHttpUrl('http://example.com'), true)
  assert.equal(isValidHttpUrl('javascript:alert(1)'), false)
  assert.equal(isValidHttpUrl('data:text/html,<script>'), false)
  assert.equal(isValidHttpUrl('youtube.com/watch'), false)
  assert.equal(isValidHttpUrl(''), false)
})

test('แถวลิงก์เปล่าถูกตัดทิ้ง แต่ลิงก์ที่กรอกแล้วผิดต้องฟ้อง', () => {
  const ok = normalizeLinks([{ platform: 'YOUTUBE', url: '  ' }, { platform: 'YOUTUBE', url: 'https://youtu.be/x' }])
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.ok && ok.links, [{ platform: 'YOUTUBE', url: 'https://youtu.be/x' }])

  const bad = normalizeLinks([{ platform: 'YOUTUBE', url: 'ไม่ใช่ลิงก์' }])
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /ลิงก์ไม่ถูกต้อง/)
})

test('เดาแพลตฟอร์มจาก host เมื่อไม่ได้เลือกช่อง', () => {
  assert.equal(guessPlatform('https://www.youtube.com/watch?v=x'), 'YOUTUBE')
  assert.equal(guessPlatform('https://youtu.be/x'), 'YOUTUBE')
  assert.equal(guessPlatform('https://fb.watch/x'), 'FACEBOOK')
  assert.equal(guessPlatform('https://www.tiktok.com/@a/video/1'), 'TIKTOK')
  assert.equal(guessPlatform('https://example.com/live'), 'OTHER')
  // platform ที่ client ส่งมามั่ว ๆ ถูกแทนด้วยค่าที่เดาได้ ไม่ใช่เก็บดิบ
  const r = normalizeLinks([{ platform: 'MYSPACE', url: 'https://youtu.be/x' }])
  assert.deepEqual(r.ok && r.links, [{ platform: 'YOUTUBE', url: 'https://youtu.be/x' }])
})

test('readLinks ทนข้อมูลพังใน Json column', () => {
  assert.deepEqual(readLinks(null), [])
  assert.deepEqual(readLinks('ไม่ใช่ array'), [])
  assert.deepEqual(readLinks([{ url: 'https://a.co' }]), [{ platform: 'OTHER', url: 'https://a.co' }])
})

test('จำกัดจำนวนลิงก์ต่อหนึ่งงาน', () => {
  const many = Array.from({ length: 11 }, () => ({ platform: 'OTHER', url: 'https://a.co' }))
  assert.equal(normalizeLinks(many).ok, false)
})

// ── การตามงาน ─────────────────────────────────────────────────────────────────

test('เหตุผลที่ต้องตาม แยกกันคนละเรื่อง ไม่ยุบเป็น boolean เดียว', () => {
  assert.equal(followUpReason({ status: 'DRAFT', jobName: 'x' } as any), 'UNCLAIMED')
  assert.equal(followUpReason({ status: 'LOGGED', startTime: null, endTime: null }), 'NO_TIME')
  assert.equal(followUpReason({ status: 'LOGGED', startTime: '09:00', endTime: '10:00', links: [] }), 'NO_LINK')
  assert.equal(
    followUpReason({ status: 'LOGGED', startTime: '09:00', endTime: '10:00', links: [{ platform: 'YOUTUBE', url: 'https://youtu.be/x' }] }),
    null,
  )
})

// ── สิทธิ์ ────────────────────────────────────────────────────────────────────

test('แก้ได้เฉพาะงานของตัวเอง · admin/manager แก้ได้ทุกแถว', () => {
  const mine = { switcherEmail: 'Dream@thestandard.co', status: 'LOGGED' }
  const theirs = { switcherEmail: 'ting@thestandard.co', status: 'LOGGED' }
  const me = { email: 'dream@thestandard.co', canEditAll: false }
  assert.equal(canEditSwitcherJob(me, mine), true)   // เทียบอีเมลแบบไม่สนตัวพิมพ์
  assert.equal(canEditSwitcherJob(me, theirs), false)
  assert.equal(canEditSwitcherJob({ ...me, canEditAll: true }, theirs), true)
})

test('แถว DRAFT ที่ยังไม่มีเจ้าของ ใครก็รับได้ — แต่แถวที่มีเจ้าของแล้วไม่ใช่', () => {
  const me = { email: 'dream@thestandard.co', canEditAll: false }
  assert.equal(canEditSwitcherJob(me, { switcherEmail: null, status: 'DRAFT' }), true)
  assert.equal(canEditSwitcherJob(me, { switcherEmail: null, status: 'LOGGED' }), false)
})

test('สังกัด/วันที่ล็อกทันทีที่มีเลข', () => {
  assert.equal(idFieldsLocked({ productionId: 'NWS-LIV-260829-01' }), true)
  assert.equal(idFieldsLocked({ productionId: null }), false)
})

// ── ตรวจ payload ──────────────────────────────────────────────────────────────

const goodPayload = {
  outletCode: 'nws',
  jobName: '  ไลฟ์แถลงข่าว  ',
  workDate: '2026-08-29',
  startTime: '09:00',
  endTime: '11:30',
  links: [{ platform: 'YOUTUBE', url: 'https://youtu.be/x' }],
  requestedBy: ' พี่ปุ๊ก ',
  notes: '',
}

test('payload ที่ถูกต้อง ถูก normalize (uppercase outlet, trim, notes ว่าง → null)', () => {
  const r = validateSwitcherPayload(goodPayload, knownOutlet)
  assert.ok(!('error' in r))
  const v = r as any
  assert.equal(v.outletCode, 'NWS')
  assert.equal(v.jobName, 'ไลฟ์แถลงข่าว')
  assert.equal(v.requestedBy, 'พี่ปุ๊ก')
  assert.equal(v.notes, null)
  assert.equal(v.endDayOffset, 0)
})

test('payload ที่ผิดถูกตีกลับพร้อมเหตุผลเป็นภาษาคน', () => {
  const cases: Array<[any, RegExp]> = [
    [{ ...goodPayload, outletCode: 'ZZZ' }, /ไม่รู้จักสังกัด/],
    [{ ...goodPayload, jobName: '   ' }, /ชื่อหมาย/],
    [{ ...goodPayload, jobName: 'ก'.repeat(201) }, /ยาวเกิน/],
    [{ ...goodPayload, workDate: '2569-08-29' }, /วันที่ไม่ถูกต้อง/],
    [{ ...goodPayload, startTime: '9:00' }, /HH:MM/],
    [{ ...goodPayload, startTime: '22:00', endTime: '01:00' }, /ข้ามเที่ยงคืน/],
    [{ ...goodPayload, links: [{ url: 'javascript:alert(1)' }] }, /ลิงก์ไม่ถูกต้อง/],
  ]
  for (const [payload, re] of cases) {
    const r = validateSwitcherPayload(payload, knownOutlet)
    assert.ok('error' in r, `ควรถูกปฏิเสธ: ${JSON.stringify(payload).slice(0, 80)}`)
    assert.match((r as any).error, re)
  }
})

test('งานข้ามคืนที่ติ๊กถูกต้องผ่านได้ และเก็บ endDayOffset=1', () => {
  const r = validateSwitcherPayload(
    { ...goodPayload, startTime: '22:00', endTime: '01:00', endDayOffset: 1 },
    knownOutlet,
  )
  assert.ok(!('error' in r))
  assert.equal((r as any).endDayOffset, 1)
})
