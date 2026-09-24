/**
 * v1.237 — คิวที่ปล่อยงานทีละชิ้น และเว้นจังหวะขั้นต่ำระหว่างชิ้น
 *
 * WHY THIS FILE EXISTS. `sheets.spreadsheets.values.append` ที่ยิง**พร้อมกัน**
 * คืน `updates.updatedRange` ที่ไม่ตรงกับแถวที่เขียนจริง (Google คิดตำแหน่งต่อท้าย
 * แยกกันต่อ request แล้วบอกหลายตัวว่าได้แถวเดียวกัน) ⇒ เราเก็บเลขแถวผิด
 *
 * ตรวจกับพรอด 2026-09-24 (อ่านคอลัมน์ A ทั้งแท็บ 700 แถวเทียบกับ DB): 39 ใบเก็บ
 * `sheetRowIndex` ผิด · ชีทเองสะอาด ทุกใบมีแถวครบไม่ซ้ำ ผิดแค่ตัวชี้ใน DB
 * **34 ใบเป็นของกลุ่มที่สร้าง 20 ใบใน 7 วินาที และ "แถวจริง" มากกว่า "ที่เก็บ"
 * เสมอ (ต่าง +1 ถึง +14)** ซึ่งเป็นลายเซ็นของ append ที่ยิงพร้อมกัน — คิวนี้ปิดเคสนั้น
 *
 * ⚠️ **คิวนี้ไม่ได้ปิดทุกทาง**: อีก 5 ใบที่เหลือเลขเคยถูกแล้วกลายเป็นผิดทีหลัง
 * (4 ใบต่าง +1 ที่แถวติดกัน 355–361 = มีคนแทรกแถว · 1 ใบต่าง −1 = มีคนลบแถว)
 * ตราบใดที่มีคนแทรก/ลบแถวในชีทเองได้ เลขที่เก็บไว้ก็จะเก่าอีก **ซึ่งไม่เป็นไร**
 * เพราะไม่มีโค้ดตรงไหน dereference มัน — `updateBookingRow` หาแถวจากคอลัมน์ A เสมอ
 * (ดูคอมเมนต์ในนั้น) ค่านี้ทำหน้าที่แค่ธง "ใบนี้มีแถวในชีทแล้ว" · ถ้าวันหนึ่งจะมีใคร
 * เอาเลขนี้ไปเขียนทับแถวตรง ๆ **ต้องเลิกคิดแบบนั้น** หรือเปลี่ยนคอลัมน์เป็น boolean ก่อน
 *
 * แยกออกมาเป็นไฟล์เพราะตรรกะ "ห้ามทับกัน + เว้นจังหวะ" เทสได้ยากมากถ้าฝังอยู่ใน
 * ฟังก์ชันที่ต้องต่อ Google API จริง — และเป็นตรรกะที่พังแบบเงียบถ้าเขียนผิด
 */
export interface SerialQueue {
  /** ต่อคิว — งานจะเริ่มก็ต่อเมื่องานก่อนหน้าจบและเว้นจังหวะครบแล้ว */
  run<T>(fn: () => Promise<T>): Promise<T>
}

export interface SerialQueueOptions {
  /**
   * งานชิ้นหนึ่งใช้เวลาได้นานสุดเท่าไรก่อนถูกตัดทิ้ง **บังคับต้องมี**
   *
   * WHY. การต่อคิวแลกมาด้วยความเสี่ยงใหม่ที่ไม่มีตอนยิงขนาน: งานที่ไม่ยอม settle
   * (socket ค้างครึ่งทาง, NAT ตัดเงียบ, API ค้าง) จะกันคิวไว้ **ตลอดอายุโปรเซส**
   * ของเดิมยิงขนานกัน ค้างหนึ่งตัวเสียหนึ่งงาน · ต่อคิวแล้วค้างหนึ่งตัวเสียทุกงานที่เหลือ
   * และเงียบสนิทเพราะผู้เรียก (create-booking) ปิดท้ายด้วย `.catch(() => {})`
   * ⇒ slot ต้องถูกปล่อยเสมอ ไม่ว่าจะด้วยผลลัพธ์หรือด้วยการหมดเวลา
   */
  jobTimeoutMs: number
  /** ชื่อไว้ใส่ใน log ตอนหมดเวลา — ต้องดังพอให้ log scan เจอ */
  label?: string
}

export function makeSerialQueue(
  minGapMs: number,
  opts: SerialQueueOptions,
  now: () => number = Date.now,
): SerialQueue {
  let chain: Promise<unknown> = Promise.resolve()
  let lastFinishedAt = 0

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const exec = async (): Promise<T> => {
        // clamp: `now()` เป็นนาฬิกาผนัง ถ้าเข็มถูกปรับถอยหลัง (NTP/DST) ค่าที่ได้
        // จะกลายเป็นการรอยาวเท่าที่ถอย — คิวหยุดนิ่งโดยไม่มีใครรู้
        const wait = Math.min(minGapMs, minGapMs - (now() - lastFinishedAt))
        if (wait > 0) await new Promise(r => setTimeout(r, wait))
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            fn(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                const msg = `serial-queue${opts.label ? ' [' + opts.label + ']' : ''}: งานค้างเกิน ${opts.jobTimeoutMs}ms — ตัดทิ้งเพื่อปล่อยคิว`
                console.error(msg)   // ต้องดัง ไม่งั้นคิวตันแบบไม่มีใครรู้
                reject(new Error(msg))
              }, opts.jobTimeoutMs)
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
          // นับจังหวะจาก "จบ" ไม่ใช่ "เริ่ม" — โควตาคิดตามจำนวน request ที่ถึงปลายทาง
          lastFinishedAt = now()
        }
      }
      // ต่อคิวจาก promise ที่กลืน error แล้ว ไม่งั้นงานที่ล้มหนึ่งชิ้นจะทำให้
      // คิวที่เหลือไม่ถูกเรียกเลย (unhandled rejection + งานค้างถาวร)
      const next = chain.then(exec, exec)
      chain = next.then(() => undefined, () => undefined)
      return next
    },
  }
}
