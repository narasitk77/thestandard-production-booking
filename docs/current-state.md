# สถานะปัจจุบัน — 2026-09-23 · v1.233.1

> หน้านี้คือ "ตอนนี้อะไรกำลังค้างอยู่" สำหรับคน (หรือ AI) ที่เพิ่งมารับงานต่อ
> เป้าหมายคือ **ไม่ต้องขุด** — อ่านหน้านี้จบแล้วรู้ว่าของเพิ่ง ship อะไรไป, อะไรยังพังอยู่
> โดยตั้งใจไม่แก้, อะไรรอคนตัดสินใจ, และงานตั้งเวลาตัวไหนเป็นของใคร
>
> **หน้านี้จะเก่า** — วันที่ด้านบนคือวันที่ตรวจจริงกับพรอด ถ้าห่างจากวันนี้เกินสองสัปดาห์
> ให้เชื่อ `git log` + heartbeat จริงมากกว่าเชื่อหน้านี้

## 0. อ่านอะไรก่อน

| อยากรู้ | อ่านที่ |
|---|---|
| ระบบทำงานยังไง (mental model, lifecycle, code map) | `docs/architecture.md` — **ค้างที่ยุค v1.177.1** โครงยังถูก แต่รายละเอียดหลัง v1.178 ไม่มีในนั้น |
| เกิดอะไรขึ้นวันไหน ทำไมโค้ดถึงเป็นแบบนี้ | `docs/ops-log.md` (3,366 บรรทัด ใหม่อยู่บนสุด) — เป็น incident journal ตัวจริง |
| ของที่ ship ถึง v1.222 | `CHANGELOG.md` |
| ของที่ ship **หลัง** v1.222 | `git log` เท่านั้น — ดูข้อ 1 |
| วิธี deploy / ถอยกลับ | `docs/runbook-deploy-rollback.md` (เขียน 2026-09-23 พร้อม v1.233.1) |
| นโยบายโฟลเดอร์ landing | `docs/landing-folder-policy.md` |
| ค่า secret / โฮสต์ / token | `CLAUDE.local.md` (ไม่ commit — repo นี้เป็น public) |

**🔴 repo นี้เป็น public บน GitHub** — อย่าเขียน secret, token, ปลายทางของบอทแจ้งเตือน
(ชื่อ/ไอดีห้องแชท), หรือเบอร์/ที่อยู่ส่วนตัวลงไฟล์ใด ๆ ในนี้ ค่าพวกนี้อยู่ที่ `CLAUDE.local.md`

---

## 1. ของที่เพิ่ง ship (v1.228 → v1.233.1)

**หนี้เอกสารข้อแรก: `CHANGELOG.md` หยุดอยู่ที่ v1.222** (commit ล่าสุดที่แตะมันคือ 2026-09-16)
ตั้งแต่ v1.223 เป็นต้นมา **ข้อความ commit คือบันทึกฉบับเดียวที่มี** — และมันละเอียดพอจะใช้แทนได้จริง
(`git log -1 <sha>` อ่านเหตุผลเต็ม) แต่ใครกลับมาแตะ CHANGELOG ควรไล่เก็บช่วงนี้ก่อน

ก่อนหน้านี้ v1.222–v1.227 เป็นก้อน **"ระบบจองห้อง"** ทั้งชุด (เตือนห้องชนตอนกรอกฟอร์ม,
รู้จักห้องที่คนของงานจองมือไว้เอง, ป้าย "ต้องจองห้องเอง") — บริบทอยู่ที่
`docs/room-booking-integration-plan.md`

| version | commit | ทำอะไร และทำไม |
|---|---|---|
| **1.228.0** | `2508558` | ใส่ `/mix` เข้า `TRACKED_PATHS` — คิวมิกซ์ 0 แถวมา 18 วันแล้วเราตอบไม่ได้ว่าเพราะไม่มีคนเข้าหรือเข้าแล้วไม่กด เพราะหน้านั้น **ไม่เคยถูกติดเครื่องวัด** `page_events` 0 แถวจึงแปลได้สองอย่างที่แก้คนละทาง · **กฎที่ตกผลึก: ออกหน้าใหม่ = เติม `TRACKED_PATHS` ด้วยเสมอ** |
| **1.229.0** | `77dea5b` | ปุ่ม "อนุมัติทั้งชุด" ที่ `/admin/routine` — งาน routine รายเดือน 60+ ใบ เดิมต้องกดอนุมัติทีละใบ · วนเรียก endpoint ใบเดียวตัวเดิม **ไม่เขียน endpoint กลุ่มใหม่** เพราะ approve มีของที่ต้องถูก 400 บรรทัด |
| **1.229.1** | `366c149` | 6 ข้อจากรีวิว: อ่านรายการใหม่ทุกครั้ง (ไม่งั้นปลุกงาน `COMPLETED` ขึ้นมาใหม่) · 409 = "ข้าม" ไม่ใช่ "ล้ม" · หน่วง 1500→3000 ms (approve = 4 request/ใบ ที่ 1500 ms ชนโควตา Sheets) · โชว์ `bookingCode` ไม่ใช่ cuid 8 ตัว · เลิกพูดว่า "อนุมัติครบ" ทั้งที่ Drive/ปฏิทิน/ชีทยังวิ่งเป็น background · ล้มรวด 5 ใบแรก = หยุด |
| **1.230.0** | `2f76ad0` | กางดูใบในชุด (วันถ่าย/รหัส/สถานะ/ปฏิทิน/ทีมงาน) + เพิ่มทีมงานทั้งชุด · **merge ไม่ใช่ทับ** (assign endpoint เขียนทับ `assignedEmails` ทั้งก้อน ส่งตรง ๆ = ล้างคนที่จัดรายวันทิ้ง) · `sendEmail:false` เสมอ (คนเดียวถูกใส่ 67 ใบ = เมล 67 ฉบับใน 2 นาที) · รวม loop ทั้งสองปุ่มเป็น `runBulk()` ตัวเดียว |
| **1.231.0** | `0ab035f` | ผู้กำกับคนที่ 2 และ 3 (ไม่บังคับ) · **เพิ่มคอลัมน์ใหม่ ไม่แปลงของเดิมเป็น array** เพราะ container รัน `prisma db push --accept-data-loss` ทุก boot = เปลี่ยนชนิดคอลัมน์ที่มีข้อมูล คือ DROP จริงบนพรอด · ต้องเติม 9 จุด (attendees 1 + ผู้เรียก 4 + ผู้ประกอบ `CalendarEventInput` 5) |
| **1.232.0** | `82cd623` | แยก "รายการ" กับ "Episode Type" ที่ `/admin/routine` · dropdown ช่องเดียวส่งค่าเดียวไปทั้ง `booking.programCode` และ `episode.programCode` แต่ `create-booking` ใส่ชื่อรายการลง Production ID **ก็ต่อเมื่อสองค่าต่างกัน** → เลือก MNW ได้ `WLT-260923-01` ไม่มี MNW · เจอตอนสร้างจริง 135 ใบ |
| **1.232.1** | `717a8e1` | 4 ข้อจากรีวิว — ที่สำคัญคือ **เลิก "รองรับ" payload รุ่นเก่า ตอบ 400 ไปเลย** เพราะใบที่เกิดจากบั๊กนี้ **ซ่อมไม่ได้** (`reprogram-booking` เห็น `code == bookingProgCode` แล้วตอบ "ไม่มีอะไรเปลี่ยน") · และย้ายกฎสร้าง Production ID ไปอยู่ `episode-id.ts` **ที่เดียว** (เคยมีสำเนา 3 ชุด แล้วรอบนี้เกือบทำเป็นชุดที่ 4) |
| **1.233.0** | `cf65ea9` | 3 worker ที่เงียบหายมานาน + รู reconciler — **2 ใน 3 กัดอยู่แล้ววันนั้น ไม่ใช่รอเกิด** ดูรายละเอียดข้างล่าง |
| **1.233.1** | `425873f` | `scripts/ops/deploy.py` + `rollback.py` + `docs/runbook-deploy-rollback.md` — นัทสั่ง "ก่อน deploy ใหม่ ต้องถอยกลับได้" · backup worker มีอยู่แล้วและใช้ได้จริง แต่ **ไม่มีที่จดว่าเวอร์ชันดีล่าสุดคือเลขอะไร** และไม่มีทาง restore เลย |

### v1.233.0 ขยายความ (สามอันนี้เป็น bug class ที่จะเจอซ้ำ)

1. **`folder-integrity`: cursor แช่แข็ง** — `scanCursor = (start + checked + deferred) % N`
   ทุกแถวหลังชน limit จะ `deferred++` ดังนั้น `checked + deferred ≈ N` → cursor อยู่ที่เดิมตลอดกาล
   พรอด: audit 29 รอบใน 24 ชม. ขึ้น `checked=60` เท่ากันทุกรอบ = 44 ใบท้ายไม่เคยถูกตรวจซ่อมเลย
2. **`footage-integrity`: สแกนแต่งานที่ยังไม่ถ่าย** — `shootDate: { gte: since }` มีแต่ขอบล่าง
   + `orderBy desc` + `take 60` = หยิบงานที่ **ไกลไปในอนาคตที่สุด** worker ที่มีไว้ตรวจว่าฟุตเทจมาถึงไหม
   ไม่เคยดูงานที่ถ่ายจบสักใบ (187 ใบใน 30 วันหลุดหมด)
3. **cap คงที่ + ลำดับคงที่ = แถวท้ายไม่มีวันถูกแตะ** — เคสเดียวกับ v1.185.2 ที่กลับมาใหม่
   (65 ใบเข้าเงื่อนไข cap 50 → 15 ใบไม่มีวันถูกตรวจ) **เจอ `take`/`cap` ที่ไหน ให้ถามทันทีว่าลำดับหมุนไหม**

---

## 2. ของที่ยังพัง / ยังจำกัด — และ **ยังไม่ได้แก้**

ทุกข้อในนี้ตรวจกับพรอดวันที่ 2026-09-23 แล้ว ไม่ใช่การคาดเดา

### 2.1 🔴 `footage-sheet-sync` ปิดอยู่มา 83 วัน

```
heartbeat 'footage'  last tick = 2026-07-01 18:08 UTC   (83 วัน 15 ชม.)
prod env             FOOTAGE_WORKER_ENABLED=0
```

worker ตัวนี้เดิน Shared Drive ใต้ `DRIVE_FOOTAGE_ROOT` แล้ว append แถวลง footage log sheet
**dead-man switch ไม่เตือน — และมันถูกแล้ว**: `evaluateWorkers()` คิด `stale` เฉพาะ worker ที่
`enabled` เป็น true (heartbeat.ts:132) ตัวที่ปิดจึงเงียบโดยดีไซน์

ประเด็นคือ **ไม่มีใครตัดสินใจว่าจะเปิดคืนหรือลบทิ้ง** มันแค่ค้างอยู่แบบนั้น
ใครมาต่อต้องถามก่อนว่าชีท footage log ยังมีคนอ่านอยู่ไหม — ดู `prodbooking-delivery-tick`
ในบันทึกความจำ: ปุ่ม "ส่งงาน" ที่ควรจะ tick ชีทนี้ **ไม่เคยถูกกดเลย 0/282 ใบ**

### 2.2 🔴 ชีทหลุดแล้วหลุดเลย — `google-sheets.ts` ไม่มี 429 retry และไม่มีใครเขียนคืน

```
grep -n "429|retry|backoff" src/lib/google-sheets.ts   →  ไม่เจอเลย
```

ทุก `updateBookingRow()` ถูกเรียกแบบ fire-and-forget (`.catch(e => console.error(...))`)
ในเกือบทุก call site — approve, assign, deliver, producer-edit, routine cancel
**ถ้าชีทตอบ 429 หรือ 5xx แถวนั้นก็ผิดจากนั้นไปตลอด** โดยมีแค่บรรทัดใน container log

โควตาที่ชนจริง: **60 อ่าน + 60 เขียน/นาที ต่อ service account ตัวเดียวที่ worker ทุกตัวใช้ร่วมกัน**
· approve หนึ่งใบ = 4 request (`values.get` คอลัมน์ A + `batchUpdate` × 2 รอบ)
· ชีทตอบ 429 จริงเมื่อ 2026-09-22 ตอนทดสอบปุ่มอนุมัติทั้งชุด — นี่คือที่มาของหน่วง 3000 ms

**ทางซ่อม มีแค่บางคอลัมน์:** `POST /api/admin/backfill-bookings-sheet` เติมคืนได้เฉพาะ
Calendar Event ID (pass 3) และคอลัมน์ AE–AI (Delivered At/By, Cancel Reason, Episode Titles,
Drive Box ID — pass 4) · **`Status` (col V) และ `Approved At` (col AA) ไม่มี pass ไหนซ่อม**
· `calendar-reconcile.ts:28` เขียนคืนแค่ `calendarEventId` ตัวเดียว

> ทางแก้ที่ควรทำ (ยังไม่ทำ): retry+backoff ใน `google-sheets.ts` ที่เดียว (แทนที่จะไปไล่ใส่ทุก
> call site) + ขยาย backfill ให้ครอบ status/approvedAt

### 2.3 🟡 จังหวะยิงของ room-booking reconciler เร็วกว่าโควตาที่ใช้ร่วมทั้งบริษัท

```
โควตาของระบบจองห้องกลาง  20 req / 5 นาที   (= 4 req/นาที ทั้งบริษัทใช้ร่วมกัน)
reconciler                1200 ms ต่อใบ × 2 request/ใบ  ≈ 100 req/นาที
prod: ROOM_BOOKING_RECONCILE_MAX=5 · interval 1 ชม. · days=45
```

ที่มันยังไม่ระเบิดเพราะ **cap เล็กกับ cadence ห่าง** ไม่ใช่เพราะจังหวะถูก: หนึ่งรอบเต็มที่ max=5
คือ ~10 request ใน ~6 วินาที = ครึ่งหนึ่งของโควตา 5 นาที หมดไปใน 6 วินาที
`reconcileRoomBookings` clamp max ไว้ที่ 20 ⇒ **ถ้าใครขยับ `ROOM_BOOKING_RECONCILE_MAX` ขึ้น
รอบเดียวจะกินเกินโควตาทันที** และของที่พังคือการจองห้องจริงของทั้งบริษัท ไม่ใช่แค่ probook

`src/lib/room-availability.ts:12,82` เขียนเตือนเรื่องโควตานี้ไว้แล้ว — แต่ไม่มี rate limiter จริง
มีแค่ `setTimeout(1200)` ที่ `room-booking-reconcile.ts:369`

### 2.4 🟡 `/switcher` มี 0 แถว — และปลายทางที่ตั้งใจไว้ยังไม่ได้ทำ

`switcher_jobs` = **0 แถว** (deploy v1.211 เมื่อ 2026-08-29 · ตาราง 19 คอลัมน์ ถูกสร้างครบ)
คนที่ได้แท็บนี้บนพรอดมี 2 คน (ติง, ดรีม) และ **ยังไม่เคยแจ้งใครในทีม**

หมายไลฟ์ถูกสั่งกันในแชทกลุ่ม ไม่เคยผ่าน booking flow — `/switcher` มีไว้ให้สวิตเชอร์มาลงเองหลังงานจบ
แต่ปลายทางที่วางไว้คือ **ตัวอ่านข้อความจากแชทกลุ่มมา prefill** ซึ่งยังไม่มี
ฝั่งรับทำเสร็จและ curl ทดสอบได้แล้ว: `POST /api/internal/switcher/prefill`
(ตั้งแถว `DRAFT` ไม่มีเลข, กันซ้ำด้วย `externalKey`) — ที่ขาดคือตัวป้อน

**อย่าเพิ่งไปแก้ UI:** คิวที่ให้คนกรอกโดยไม่ได้อะไรกลับ จะว่างต่อไปไม่ว่าปุ่มจะสวยแค่ไหน

### 2.5 🟡 `/mix` มี 0 แถว — ตัดเรื่องเทคนิคออกหมดแล้ว

`mix_jobs` = **0 แถว** ตั้งแต่ deploy v1.219 เมื่อ 2026-09-03
ตรวจแล้วและ **ตัดออกทั้งหมด**: `/mix` อยู่ใน `ALWAYS` ของ tiers.ts · Nav มีทางเข้า ·
`MixRequests` mount บน `/dashboard/[id]` ไม่มี role gate · env เมลถึง container ครบ ·
`audit_logs` 0 แถวที่เกี่ยวกับ mix = **ไม่มีใครไปถึงขั้นกดเลย** ไม่ใช่กดแล้วพัง

สาเหตุจริงอยู่ฝั่ง supply: ทีมเสียง 3 ใน 4 คน `last_action = NULL` — ไม่เคยแตะระบบเลยตั้งแต่มีบัญชี
coordinator มี 2 action ใน 18 วัน · สาเหตุรอง: คนที่จะขอ (= ทุกคนที่ไม่ใช่ทีมเสียง) เจอทางเข้า
ใน dropdown "More" เท่านั้น (`Nav.tsx:101` — คอมเมนต์เหนือบรรทัดนั้นทำนายปัญหานี้ไว้เอง แล้ววางไว้ใน More อยู่ดี)

**ลำดับที่ตกลงกันไว้ ห้ามสลับ:** (1) ถามทีมเสียงก่อน (2) เติม `TRACKED_PATHS` — ทำแล้ว v1.228
(3) ค่อยย้ายปุ่มออกจาก More · ห้ามทำ (3) ก่อน (1) เพราะ **คำขอที่ไม่มีคนตอบ แย่กว่าคิวว่าง**

หมายเหตุ: หลังเติมเครื่องวัดแล้ว `page_events` ของ `/mix` **ยังเป็น 0** (ตรวจ 2026-09-23 หลัง deploy 1 วัน)
ตัวเลขที่มีอยู่จริงตอนนี้: `/admin` 174 · `/my-bookings` 171 · `/new` 140 · `/upload` 31 · `/ot` 3 · `/ot/admin` 1

### 2.6 🔴 `/api/admin/nas-sync-report` โชว์ข้อมูลอายุ 2 เดือนเหมือนเป็นของสด

launchd agent `co.thestandard.probook-nas-agent` (บน Mac ของนัท ทุก 10 นาที) **ตายมา 71 วัน** —
manifest ล่าสุด 2026-07-14 · `/Volumes/production team` ไม่ได้ mount · สคริปต์ `exit 0` เมื่อไม่ mount
→ launchd เห็นว่าสำเร็จ ไม่มีใครรู้ว่าเงียบ

แต่ที่แย่กว่าคือฝั่งรายงาน: `/api/admin/nas-sync-report` ตอบ `ok:true` + ตารางสวยงาม
โดยสร้างจาก manifest ของ 14 ก.ค. (`nasAt: 2026-07-14`, `comparedAt` = วันนี้)
`grep -iE "stale|ageHours|olderThan" src/lib/nas-sync.ts` → **ไม่เจอเลย**

> ตรงกับ bug class ประจำของโปรเจกต์นี้: **a record is not delivery**
> ทางแก้: `nasAt` เก่ากว่า ~1 ชม. ให้ตอบ `ok:false` แทนที่จะเรนเดอร์เฉย ๆ

เรื่องที่เกี่ยวกัน (**ไม่ใช่บั๊ก**): `NWS-TSN` ไม่เคยมีฟุตเทจในกล่องเลยสักใบ (0 ทุกใบ ย้อนถึง ก.ค.)
เพราะเป็นรายการไลฟ์รายวัน ฟุตเทจไม่ได้ลงกล่องตั้งแต่ต้น — เทียบกับ `NWS-GLF` outlet เดียวกัน = 45 ไฟล์ / 30 GB
**อย่าเห็นกล่องว่างของ TSN แล้วตกใจ ต้องเทียบกับประวัติของรายการนั้นก่อนเสมอ**

### 2.7 🟡 รอบเที่ยงกับรอบ 19:00 ตัดสินโฟลเดอร์ว่างไม่เหมือนกัน

`prune=today` (เที่ยง) **เก็บ** โฟลเดอร์ที่ยังไม่มีฟุตเทจไว้ (`keptNoFootage` — guard ที่ได้มาจากเคส 7 THINGS
ที่ระบบทิ้ง drop ของงานที่ฟุตเทจยังไม่ขึ้น) แต่ worker 19:00 (`LANDING_KEEP_PAST_DAYS=1`)
**ทิ้ง** past-empty โดยไม่ดู guard นั้น ⇒ ของที่รอบเที่ยงตั้งใจเก็บ หายไปเองตอนค่ำ

ยังไม่ได้แก้ · ตอนนี้ยังไม่ทำให้ใครเสียหาย (เคสที่เจอคือ TSN ซึ่งกล่องว่างอยู่แล้วโดยธรรมชาติ)
แต่ logic สองที่ขัดกันจริง และมันจะกัดวันที่มีงานที่ฟุตเทจมาช้าข้ามคืน

### 2.8 ของที่ปิดอยู่โดยตั้งใจ (อย่าเห็นแล้วนึกว่าพัง)

| ของ | flag บนพรอด | สถานะ |
|---|---|---|
| Lark export (คลังรายวัน) | `LARK_EXPORT_ENABLED=0` | dormant — ยังไม่เคย tick เลย (ไม่มีแถวใน `system_heartbeats`) ต้องเป็น self-built app ไม่ใช่ webhook และต้องแชร์โฟลเดอร์ให้แอปด้วย ดู `docs/runbook-lark-export.md` |
| footage-sheet-sync | `FOOTAGE_WORKER_ENABLED=0` | ดูข้อ 2.1 |
| reconciler (รวม ~10 Drive sweep เป็น pass เดียว) | — | design + lease + guards + DriveView ลงแล้ว แต่ `reconciler/phases/` ว่าง **ยังไม่มีอะไรเรียก** (`docs/reconciler-design.md`) |

### 2.9 กับดักที่ยังอยู่ (รู้แล้ว แต่แก้ไม่คุ้ม/ยังไม่แก้)

- **`prisma db push --accept-data-loss` รันทุก boot** (`start.sh`) — เปลี่ยนชนิดคอลัมน์ที่มีข้อมูล
  = DROP บนพรอด · และ **ถอยอิมเมจไปเวอร์ชันที่ schema เก่ากว่า = ลบคอลัมน์ใหม่ทิ้งพร้อมข้อมูล**
  (เช่นถอยข้าม v1.231 = ผู้กำกับคนที่ 2–3 ของทุกใบหาย) — `rollback.py` หยุดถามก่อนในเคสนี้
- **OT ที่อนุมัติแล้วยังถูก hard-delete** วันที่ 11 ของเดือนถัดไป · `/api/internal/ot/resync` กู้ร่างคืนได้ (v1.193)
- **Outlets/Programs seed จาก `src/lib/data.ts` ทุก boot** — เพิ่มรายการ = แก้โค้ด + redeploy
- **endpoint ที่แตะ Drive นาน ๆ 504 ที่ proxy** — อย่ายิงซ้ำ (races → dupes) ให้ไปเช็คผลจาก audit/อีเมลสรุปแทน

---

## 3. การตัดสินใจที่รอคน (ไม่ใช่รอโค้ด)

| เรื่อง | สถานะ | ต้องรู้อะไรก่อนตัดสิน |
|---|---|---|
| **ต่ออายุชุด routine** | ยังไม่มีปุ่ม | ชุด Now (`now-news-2026-*`) มีถึง **2026-12-31** แล้วหมด · ต่อไม่ได้นอกจากสร้างชุดใหม่ทั้งเดือน |
| **แก้ทั้งชุด (bulk edit)** | ยังไม่ทำ **โดยตั้งใจ** | อันตรายกว่า approve/assign มาก เพราะต้องขยับปฏิทิน + ห้องทั้งชุดตามไปด้วย · approve/assign ปลอดภัยเพราะวนเรียก endpoint ใบเดียวตัวเดิม การแก้ไม่มีคุณสมบัตินั้น |
| **2 ชุด Morning Wealth ที่ soft-delete ไว้** | ยังค้างในตาราง | `5a021de2…` (67 ใบ) และ `72de8346…` (67 ใบ) + `cce3af06…` (1 ใบ) = 135 ใบ `deletedAt` ครบทุกแถว ช่วง 2026-09-23 → 12-30 รหัสเป็น `WLT-2609xx-xx` **ไม่มี MNW** (ผลจากบั๊ก v1.232) · ซ่อมรหัสไม่ได้ (ดู v1.232.1) ⇒ ทางเลือกมีแค่ *ลบถาวร* หรือ *ปล่อยไว้* · **ปล่อยไว้ปลอดภัยกว่า** เพราะ `folder-integrity` และ `shoot-marker` กรอง `status IN ('CONFIRMED','COMPLETED')` แถว soft-deleted จึงไม่ถูกแตะ — แต่ต้องรู้ว่ามันอยู่ตรงนั้นตอนอ่านตัวเลขในหน้า `/admin/routine` |
| **เปิด footage-sheet-sync คืน หรือลบทิ้ง** | ปิดมา 83 วัน | ดูข้อ 2.1 — ถ้าชีทนั้นไม่มีคนอ่านแล้ว การลบ worker + spec + flag ออกคือคำตอบที่ถูก |
| **`/mix`: ย้ายปุ่มออกจาก More** | รอ (1) ถามทีมเสียงก่อน | ข้อ 2.5 — ห้ามข้ามลำดับ |
| **`/switcher`: ตัวป้อนจากแชทกลุ่ม** | รอเลือกวิธี | webhook / Hermes / คนก๊อปวาง — ฝั่งรับพร้อมแล้ว |
| **ลบ SKILL.md 3 ตัวที่ซ้ำกับ Hermes** | รอนัทสั่ง (เป็นการ *ลบ*) | ดูข้อ 4.5 — ตอนนี้กำลังยิงซ้ำกันจริง |
| **รู reconciler ของใบ routine** | **แก้แล้ว v1.233.0** | บันทึกไว้เพราะถ้าเจอบันทึกเก่าที่ยังเขียนว่า "รอนัทตัดสิน" อันนั้น stale แล้ว — ทางแก้ที่คิดไว้ตอนแรก (เพิ่ม OR ใน where) **ใช้ไม่ได้** เพราะ `processBooking:237` return ก่อนถึงทางสร้าง event · ของจริงคือเปลี่ยนไปตัดสินด้วย `calendarAttendees.length === 0` |

---

## 4. งานตั้งเวลา — ใครเป็นเจ้าของอะไร

**ทำไมต้องมีหน้านี้: งานเดียวกันรันสองที่ = ความล้มเหลวจริงในโปรเจกต์นี้ ไม่ใช่ทฤษฎี**
(landing cleanup ยิงผิดเวลาเคยลบโฟลเดอร์ของวันพรุ่งนี้ทิ้งมาแล้ว)

มี **4 ระบบ** ที่ตั้งเวลางานได้ และไม่มีใครรู้จักกัน

### 4.1 Worker ในคอนเทนเนอร์ (start.sh supervise) — เจ้าของหลัก

15 สคริปต์ใน `scripts/*-worker.js` · 16 heartbeat key (landing เขียน 2 key) · spec อยู่ที่
`src/lib/workerSpecs()` ใน `src/lib/heartbeat.ts` — **spec ที่ไม่ตรงกับสคริปต์ แย่กว่าไม่มี spec**
เพราะมันจะรายงานว่า healthy-because-disabled ทั้งที่ตัวจริงตายไปแล้ว

ค่าที่อ่านจาก container จริง 2026-09-23 (เวลาเป็น BKK):

| key | สคริปต์ | จังหวะ | flag บนพรอด | tick ล่าสุด |
|---|---|---|---|---|
| `calendar-reconcile` | calendar-reconcile-worker.js | ทุก 10 นาที | **เปิดเสมอ** (ไม่มี flag) | 5 นาทีก่อน |
| `folder-integrity` | folder-integrity-worker.js | ทุก 1 ชม. | `=1` (APPLY+RENAME) | 10 นาทีก่อน |
| `video-merge` | video-merge-worker.js | ทุก 1 ชม. (fallback 6 ชม.) | `=1` | 10 นาทีก่อน |
| `sound-merge` | sound-merge-worker.js | ทุก 1 ชม. | `=1` | 7 นาทีก่อน |
| `prep-folders` | prep-folders-worker.js | ทุก 1 ชม. | `=1` | 14 นาทีก่อน |
| `footage-ready` | footage-ready-worker.js | ทุก 30 นาที (max 12/รอบ) | `=1` | 14 นาทีก่อน |
| `room-booking-reconcile` | room-booking-worker.js | ทุก 1 ชม. (days=45, max=5) | `=1` | 15 นาทีก่อน |
| `reminders` | reminders-worker.js | ทุก 24 ชม. | `=1` | 15 นาทีก่อน |
| `backup` | backup-worker.js | ทุก 24 ชม. + ทุก boot (retention 365 วัน) | `=1` | 15 นาทีก่อน (1,109 KB) |
| `footage-integrity` | footage-integrity-worker.js | 13:00 | `=1` (days=30) | 13:00 วันนี้ |
| `shoot-review` | shoot-review-worker.js | 10:00 | `=1` | 10:00 วันนี้ |
| `landing-prune` | landing-worker.js (รอบเที่ยง) | 12:00 | `=1` | 12:02 วันนี้ |
| `landing` | landing-worker.js (รอบเย็น) | 19:00 (`CREATE_DAYS=3`, `KEEP_PAST_DAYS=1`) | `=1` | 19:18 เมื่อวาน |
| `shoot-marker` | shoot-marker-worker.js | 03:00 | `=1` | 03:17 เมื่อวาน |
| `footage` | footage-sheet-sync-worker.js | ทุก 10 นาที | **`=0`** | **2026-07-01** ← ข้อ 2.1 |
| `lark-export` | lark-export-worker.js | 23:00 | **`=0`** | ไม่เคย |

> **อ่านค่าจาก stack/container เสมอ ห้ามอ่านจาก `${VAR:-0}` ใน compose** —
> ค่า default ใน compose **ไม่ใช่** ค่าบนพรอด กับดักนี้กัดมาแล้วสองครั้งในวันเดียว
> และค่าที่ตั้งบน stack แต่ compose ไม่อ้างถึง = **ไม่มีอยู่จริง** (ต้นตอของ `AUTH_SECRET` 401)

Dead-man: `maybeAlertStaleWorkers()` ถูกเรียกจาก reconcile worker ทุกรอบ · stale = enabled + เคย tick +
เกิน interval + 2 ชม. · alert throttle 6 ชม. · ไปทางอีเมล admin (worker health ไม่ใช่ข่าวฟุตเทจ)
· ตัวที่ไม่เคย tick = `neverTicked` ไม่นับเป็น stale (กัน false alarm หลัง deploy)

### 4.2 Claude Code scheduled tasks — `~/.claude/scheduled-tasks/`

| task | cron | สถานะควรเป็น | สถานะจริง 2026-09-23 |
|---|---|---|---|
| `probook-nightly-check` | `0 0 * * *` | **เปิด** — ตัวเดียวที่ต้องใช้ LLM จริง (วินิจฉัย test/tsc ที่ล้ม, แก้, commit, push) | เปิด · รันเมื่อคืน ✓ |
| `probook-worker-check` | `0 9,21 * * *` | **ปิด** (ย้ายไป Hermes 2026-08-18) | 🔴 **เปิดเอง + ยิงจริงวันนี้** |
| `probook-landing-cleanup` | `0 12 * * *` | **ปิด** (ย้ายไป Hermes) | 🔴 **เปิดเอง + ยิงจริงวันนี้** |
| `idfirst-fallback-monitor` | `30 9 * * *` | **ปิด** (ย้ายไป Hermes) | 🔴 **เปิดเอง + ยิงจริงวันนี้** |
| `line-war-room-announce` | one-time 2026-09-19 | หมดอายุแล้ว | ปิด ✓ |

### 4.3 Hermes cron — `~/.hermes`

3 งาน เขียนเป็นสคริปต์ Python stdlib **ล้วน ไม่มี LLM** (`--no-agent`) เพราะสิ่งที่พรอมต์เดิมตัดสิน
คือเลขกับ threshold ไม่ใช่การใช้วิจารณญาณ · stdout ว่าง = ไม่ส่งข้อความ ⇒ "เงียบเมื่อปกติ"
เป็นคุณสมบัติของสคริปต์ ไม่ใช่คำสั่งที่โมเดลจะ drift ได้

| job | cron (BKK) | สคริปต์ |
|---|---|---|
| `probook-worker-check` | `0 9,21 * * *` | `probook-worker-check.py` (มี STEP 5 อ่าน footage-ready stats) |
| `idfirst-fallback-monitor` | `30 9 * * *` | `probook-idfirst-monitor.py` |
| `probook-landing-cleanup` | `0 12 * * *` | `probook-landing-cleanup.py` |

สำเนาที่ version-control ไว้: `scripts/hermes/` (มี README ที่มีคำสั่ง re-register ตรง ๆ) —
`~/.hermes` เองไม่เคยถูก backup

### 4.4 launchd บนเครื่อง Mac ของนัท

`co.thestandard.probook-nas-agent` — `~/.probook/nas-manifest-agent.sh` ทุก 10 นาที
**ตายมา 71 วัน และไม่มีใครเฝ้ามัน** (ดูข้อ 2.6)

### 4.5 🔴 ปัญหาที่กำลังเกิดอยู่ตอนนี้: ยิงซ้ำสองระบบ

"disabled, not deleted" **ไม่อยู่ยาว** — Claude Code copies ทั้งสามกลับมาเป็น `enabled: true` เอง
(น่าจะตอนอัปเดต/ย้ายเครื่องรีเซ็ต state ของ scheduled-tasks) แล้วยิงจริงทับ Hermes:

- `probook-worker-check` Claude Code ~21:10 ทับ Hermes 21:00
- `probook-landing-cleanup` Claude Code ~12:05 ชนเที่ยงของ Hermes
  → **อาการที่มองเห็น:** Hermes รอบเที่ยงได้ 409 "มีรอบอื่นทำงานอยู่" วันที่ 19 และ 22 ก.ย. = รอบเที่ยงถูกข้าม

⇒ **สถานะ `disabled` ของ scheduled-tasks ไม่ใช่ของถาวร** ต้องเช็กทุกคืน ไม่ใช่เช็กครั้งเดียวตอนย้าย
(`probook-nightly-check` step 4c ทำหน้าที่นี้อยู่) · ถ้าจะให้หายขาดคือ **ลบ** SKILL.md สามตัวทิ้ง
(rollback มีที่ `scripts/hermes/` แล้ว) — แต่เป็นการลบ ต้องรอนัทสั่ง

### 4.6 วิธีพิสูจน์ว่างานตั้งเวลา "ถูก register จริง"

ความล้มเหลวที่เคยเสียไปห้าวัน: SKILL.md บนดิสก์ดูปกติ แต่การลงทะเบียนหายไปเงียบ ๆ

```bash
# Claude Code
mcp__scheduled-tasks__list_scheduled_tasks

# Hermes
cd ~/.hermes/hermes-agent && ./venv/bin/python -m hermes_cli.main cron list
#   cron status  = ticker heartbeat · cron runs <id> = รอบจริง
#   source=builtin คือ scheduler ยิง · source=direct คือคนยิงเอง

# in-container workers — เชื่อ heartbeat ไม่ใช่เชื่อ compose
SELECT key, at, note, now() - at AS age FROM system_heartbeats ORDER BY at;
```

`~/.hermes/state/probook/{worker-check,idfirst-state}.json` ก็ต้องมี timestamp สด
· รอบที่ log ว่า `**Status:** silent (empty output)` **คือรอบที่สุขภาพดี** — รอบที่ *หายไป* ต่างหากคือสัญญาณเตือน

---

## 5. ของค้างในเวิร์กกิ้งทรี

```
M src/app/switcher/page.tsx    # default outlet 'TSS' → 'NWS' บรรทัดเดียว ยังไม่ commit
```

`main` ตรงกับ `origin/main` (0 commits ahead) · prod `/api/version` = **1.233.1** ตรงกับ `package.json`

---

## 6. กฎที่ได้มาด้วยราคาแพง — อ่านก่อนแตะอะไรก็ตาม

ทั้งหมดนี้มาจากเหตุการณ์จริง ไม่ใช่ความชอบส่วนตัว

1. **a record is not delivery** — audit บอกว่าส่งแล้ว 85/85 ครั้ง ทั้งที่ไม่มีใครได้เมลเลยสักฉบับ
   · `nas-sync-report` ตอบ `ok:true` จากข้อมูลอายุ 2 เดือน · **วัดผลลัพธ์ ไม่ใช่วัดว่า worker เต้น**
2. **an affordance is not a sighting / a permission is not an affordance** — producer 59 ใบมองไม่เห็นงานตัวเอง
   เพราะ `scope=mine` ไม่นับ `producerEmail` · 14 ใบไม่มีปุ่มแก้เพราะกฎ "ใครแก้ได้แค่ไหน" ซ้ำอยู่ 3 ที่
3. **dry-run ต้องตรงกับของจริง** — `if (dryRun) { push; continue }` = preview ที่โกหก **เกิดซ้ำมาแล้ว 3 ครั้ง**
   คนอ่าน preview เพื่อ *ตัดสินใจ*
4. **error ≠ ความว่างเปล่า** — `r.ok ? r.json() : []` ทำให้งานที่มี 15 ตอนขึ้นว่าไม่มี episode
5. **โฟลเดอร์ว่าง ≠ ส่งงานแล้ว** — เคส 7 THINGS: NAS ปิด ฟุตเทจไม่เคยขึ้น Drive แล้วระบบทิ้ง drop ทิ้ง
6. **ค่า default ใน compose ≠ ค่าบน stack** และ **ค่าบน stack ที่ compose ไม่อ้างถึง = ไม่มีอยู่จริง**
7. **กฎเดียว ต้องอยู่ที่เดียว** — `progSegmentForId()` เคยมี 4 สำเนา · ลิสต์แขกปฏิทินเคยประกอบเอง 4 ที่
   แก้ที่เดียวแล้วอีกสามที่จะลืมข้อใดข้อหนึ่งเสมอ
8. **`take` / `cap` ที่มาคู่กับลำดับคงที่ = แถวท้ายไม่มีวันถูกแตะ** — เจอมาแล้วที่ reconciler (take:50),
   folder-integrity (cursor แช่แข็ง), footage-integrity (หยิบงานอนาคต)
9. **หน้าที่ไม่มีทางเข้าใน nav = ยังไม่ได้ ship**
10. **`npm run build` คือด่าน** (ไม่ใช่ test+tsc) · deploy ผ่าน `scripts/ops/deploy.py <sha>` เท่านั้น
    · ยืนยันครบสาม: stack env == container image == tag **และ** แอปตอบ 200

---

## 7. ถ้าคุณคือ AI session ที่เพิ่งมารับงานต่อ

ลำดับที่ประหยัดเวลาที่สุด:

1. `docs/architecture.md` (โครง — ข้ามส่วนตัวเลขเวอร์ชัน มันเก่า) → หน้านี้ → `docs/ops-log.md` 200 บรรทัดแรก
2. `git log --oneline -40` แล้ว `git log -1 <sha>` ตัวที่สนใจ — **ข้อความ commit ในรีโปนี้คือเอกสารจริง**
   มันอธิบายว่าเหตุการณ์อะไรทำให้โค้ดเป็นแบบนี้ ไม่ใช่แค่ diff
3. คอมเมนต์ใน `src/lib/*.ts` เป็นชั้นเดียวกัน — หลายอันบันทึกเคสจริงที่ทำให้บรรทัดนั้นมีอยู่
   ก่อนจะ "ทำความสะอาด" คอมเมนต์ยาว ๆ ให้อ่านก่อนว่ามันกันอะไรอยู่
4. ก่อนสรุปสถานะอะไรก็ตาม **ถาม DB/container จริง** — `system_heartbeats`, `docker inspect` env,
   `/api/version` · บทเรียนจาก v1.185/v1.186: เชื่อ DB ไม่เชื่อสรุปที่ตัวเองแปลงมาอีกทอด
5. ทดสอบเรื่องสิทธิ์ให้ทำแบบเป็นคนอื่น (`SEED_ADMIN_EMAIL` + `AUTH_DISABLED` = ได้ role จริงจาก DB)
   — บั๊กสิทธิ์ที่เจ็บที่สุดมองไม่เห็นจากตาแอดมิน

**ข้อห้ามที่ไม่มีข้อยกเว้น:** repo นี้ public — ห้ามเขียน secret / token / ปลายทางของบอทแจ้งเตือน
(ชื่อหรือไอดีห้องแชท) / เนื้อหาจาก `CLAUDE.local.md` / เบอร์โทรหรือที่อยู่ส่วนตัว ลงไฟล์ใด ๆ ในรีโป
ถ้าต้องอ้างถึงค่าพวกนี้ ให้เขียนว่า "ดูไฟล์ `CLAUDE.local.md` (ไม่ commit)"
