# แผนเชื่อมต่อ probook ↔ ระบบจองห้องประชุม (service.thestandard.co/booking)

> สถานะ: **แผน (ยังไม่ implement)** · ผู้ตรวจ: narasit.k · สำรวจเมื่อ 2026-07-09
> เป้าหมาย: เมื่อ booking ในโปรบุ๊คถูก **อนุมัติ (CONFIRMED)** และเลือก location เป็นห้อง/สตูดิโอของ TSD → ระบบจองห้องในเว็บกลางให้อัตโนมัติ โปรดิวเซอร์จะได้ไม่ต้องจอง 2 ที่

---

## 1. บทสรุปผู้บริหาร (อ่านอันเดียวพอ)

- **ระบบปลายทางเป็นแอปที่ IT ของ THE STANDARD เขียนเอง** (ไม่ใช่ของ vendor, ไม่ใช่ Google resource calendar ตรง ๆ) — เป็น SPA (Vite + React) หลัง Cloudflare, ล็อกอินด้วย Google, มี **API ภายในของตัวเองใต้ `/api/liff/*`** และ **ฐานข้อมูลของตัวเอง** (booking เป็นเลข `BK-####`, ห้องเป็น `roomId` ตัวเลข)
- ห้องทั้ง 15 ห้อง **ผูกกับ Google Calendar ปฏิทินเดียวร่วมกัน** (`3b43062e…@group.calendar.google.com`) — ปฏิทินนี้เป็น "กระจกเงา" ให้คนไป subscribe ดูได้ ไม่ใช่แหล่งความจริงของ availability (แหล่งจริงคือ DB ของแอป ผ่าน `check-conflict`)
- รายชื่อห้องของโปรบุ๊ค (`src/lib/locations.ts`) แมปกับห้องในระบบจอง **เกือบ 1:1 (14/15)** — เหลือ 2 จุดไม่ตรง (ดูตาราง §4)
- **คำแนะนำ:** ทำ **Option A — เรียก API ของระบบจองโดยตรง** (`POST /api/liff/booking` + `check-conflict` ก่อนจอง) เพราะเป็นการจองที่ "ของจริง" ในระบบเขา บล็อกห้องได้จริง ทำงานถูกไม่ว่าเบื้องหลังจะใช้ DB หรือ Calendar เป็นแหล่งความจริง
- **ติดที่เดียว:** ต้องให้ **ทีม IT ออก service credential** ให้โปรบุ๊คเรียก API ได้แบบ server-to-server (ตอนนี้ auth เป็น `portal_token` ต่อผู้ใช้ ไม่มี API key เอกสารทางการ) → นี่คือ dependency หลักที่ต้องคุยก่อน
- ถ้า IT ยังไม่พร้อมออก credential → ทำ **Option C (deep link)** ไปพลางก่อนได้ทันที (ไม่ต้องพึ่งใคร) แล้วค่อยอัปเกรดเป็น A

---

## 2. ระบบปลายทางคืออะไร (ผลการสำรวจจริง)

| ประเด็น | สิ่งที่พบ |
|---|---|
| ชนิดระบบ | แอปภายในที่ **IT ของ THE STANDARD เขียนเอง** ("© 2026 THE STANDARD · IT Department") เป็นส่วนหนึ่งของ "Service Portal" |
| Frontend | SPA `Vite + React` (bundle `Booking-*.js`, `vendor-react-*.js`) เสิร์ฟผ่าน **Cloudflare** |
| Auth | **Google Identity Services** (`accounts.google.com/gsi/client`) → พอร์ทัลออก **`portal_token` (JWT)** เก็บใน `localStorage` (มี `portal_token`, `portal_user`); เรียก API แนบ `Authorization: Bearer <portal_token>` |
| API | **ภายใน ไม่มีเอกสาร** ใต้ `/api/liff/*` (เดิมเป็น LINE LIFF app จึงชื่อ liff) |
| แหล่งข้อมูล | **DB ของแอปเอง** — booking = `BK-####`, ห้อง = `roomId` (int). Google Calendar เป็นปลายทาง mirror เท่านั้น |
| ปฏิทิน Google | ห้องทุกห้องชี้ **ปฏิทินร่วมเดียว** `3b43062eca…@group.calendar.google.com` (คนละใบกับปฏิทินแอปโปรบุ๊ค `72bf6ae3…@group.calendar.google.com`) |

**นัยสำคัญ:** เพราะแหล่งความจริงคือ DB ของเขา ไม่ใช่ปฏิทิน Google — การ "เขียน event ลงปฏิทินห้องตรง ๆ" **ไม่การันตี** ว่าจะบล็อกห้องในระบบจองจริง (จะเห็นเฉพาะคนที่ subscribe ปฏิทิน แต่ availability/`check-conflict` ของแอปอาจไม่รับรู้). ดังนั้นทางที่ถูกคือเรียก API ของแอป (Option A) — ยกเว้น IT ยืนยันว่าแอปอ่าน availability จากปฏิทินนั้นจริง (ดู §11 คำถาม Q1)

---

## 3. API surface ที่ค้นพบ (read-only, ยังไม่ได้สร้าง booking จริง)

ทุก endpoint อยู่ใต้ `https://service.thestandard.co/api/liff/`

| Method | Endpoint | หน้าที่ | ใช้ในแผน |
|---|---|---|---|
| GET | `/rooms` | รายชื่อห้อง `{id, name, calendarId}` (เปิดอ่านได้ ไม่ต้อง auth) | สร้าง/ตรวจตารางแมปห้อง |
| GET | `/me` | ข้อมูลผู้ใช้ปัจจุบัน | — |
| GET | `/my-bookings` | booking ของผู้ใช้ | — |
| GET | `/bookings-calendar?year=&month=` | booking รายเดือน (มุมมองปฏิทิน) | ตรวจ/แสดงผลข้ามระบบ (option) |
| GET | `/room-slots?roomId=&date=` | ช่องเวลาว่างของห้องในวันนั้น | ตรวจว่างก่อนจอง |
| GET/POST | `/check-conflict` | **ตรวจชนเวลา** ก่อนจอง | **ใช้ก่อน POST ทุกครั้ง** (กันจองชน) |
| **POST** | **`/booking`** | **สร้างการจอง** | **จุดจองจริง** |
| PATCH | `/bookings/:id/cancel` | ยกเลิกการจอง | ใช้ตอนโปรบุ๊คยกเลิก/เลื่อน |
| POST | `/register-email` | ผูกอีเมลกับพอร์ทัล (ครั้งแรก) | อาจต้องทำครั้งเดียวให้ service user |

**Payload ของ `POST /booking`** (ได้จากฟอร์มจริง + bundle): `name`, `email`, `roomId`, `startDate`, `startTime`, `endDate`, `endTime`, `title`, `note`, `department`, `allDay`
**ข้อจำกัดเวลา:** ช่องเวลาให้เลือก **08:00–21:00 ราย 30 นาที** — ถ่ายกลางคืน/ข้ามวัน/เลิกดึกของโปรบุ๊คจะแทนในระบบนี้ไม่ได้ (ดู §8 edge case)

---

## 4. ตารางแมปห้อง (probook `locations.ts` ↔ ระบบจอง)

แมป **ด้วย id ตายตัว ห้ามแมปด้วยชื่อ** (ชื่อคนละแบบ เช่น B-1 ↔ "1", Hall ↔ "Hall A", Meeting Room 1 ↔ "Meeting 1")

| probook `location.id` | probook name | → `roomId` | ชื่อในระบบจอง |
|---|---|:--:|---|
| `tsd-studio-1` | Studio 1 | **15** | Studio 1 |
| `tsd-studio-2` | Studio 2 (1/F) | **1** | Studio 2 (1/F) |
| `tsd-a-hall-1f` | Hall (1/F) | **6** | Hall A (1/F) |
| `tsd-a-lounge-2f` | Lounge (2/F) | **—** | ❌ ไม่มีในระบบจอง |
| `tsd-a-mr1-5f` | Meeting Room 1 (5/F) | **9** | Meeting 1 (5/F) |
| `tsd-a-mr2-4f` | Meeting Room 2 (4/F) | **8** | Meeting 2 (4/F) |
| `tsd-a-mr3-3f` | Meeting Room 3 (3/F) | **7** | Meeting 3 (3/F) |
| `tsd-a-pod1-5f` | Pod 1 (5/F) | **12** | Pod 1 (5/F) |
| `tsd-a-pod2-5f` | Pod 2 (5/F) | **13** | Pod 2 (5/F) |
| `tsd-a-pod3-5f` | Pod 3 (5/F) | **14** | Pod 3 (5/F) |
| `tsd-a-war-4f` | War Room (4/F) | **2** | War Room (4/F) |
| `tsd-b-1-5f` | B-1 (5/F) | **17** | 1 (5/F) |
| `tsd-b-2-5f` | B-2 (5/F) | **18** | 2 (5/F) |
| `tsd-b-3-5f` | B-3 (5/F) | **19** | 3 (5/F) |
| `tsd-b-hall-5f` | B-Hall (5/F) | **20** | Hall B (5/F) |
| *(ไม่มี)* | — | **11** | 5A (5/F) ← มีเฉพาะในระบบจอง |
| `external-*` | On Location / Remote / Event / Other | **—** | ไม่ใช่ห้อง — **ข้าม ไม่จอง** |

**สรุป:** ตรง 14/15 · ต่าง 2 จุด → (ก) โปรบุ๊คมี **Lounge (2/F)** แต่ระบบจองไม่มี; (ข) ระบบจองมี **5A (5/F)** แต่โปรบุ๊คไม่มี · กลุ่ม `EXTERNAL` ต้องกรองออกด้วย field `group` ใน `locations.ts` (เชื่อมเฉพาะ `STUDIO`/`A`/`B`)

---

## 5. ตัวเลือกการเชื่อมต่อ (จัดอันดับ)

### ⭐ Option A — เรียก API ของระบบจองโดยตรง *(แนะนำ)*
ตอน approve: โปรบุ๊คยิง `check-conflict` → ถ้าว่าง `POST /api/liff/booking` ด้วยข้อมูล booking, เก็บ `roomBookingId` กลับมา
- ✅ เป็นการจอง "ของจริง" ในระบบเขา บล็อกห้องได้จริง โชว์ใน `my-bookings`/ปฏิทินของทุกคน
- ✅ ถูกต้องไม่ว่าเบื้องหลังจะเป็น DB หรือ Calendar
- ✅ มี `check-conflict` ให้กันชนอยู่แล้ว · ยกเลิก/เลื่อนได้ผ่าน PATCH cancel
- ⚠️ ต้องให้ IT ออก **service credential** (API key / service token / หรือรับ Google service-account ID token) — API ไม่มีเอกสาร อาจเปลี่ยนโดยไม่แจ้ง → ควรมี contract เบา ๆ กับ IT
- **ความเสี่ยง:** ผูกกับ API ภายในที่ไม่การันตี backward-compat → กันด้วย feature flag + reconciler + fallback deep link

### Option B — เขียน event เข้าปฏิทินห้องตรง ๆ (reuse ของเดิม)
ใช้ service account + DWD ที่โปรบุ๊คมีอยู่แล้ว (`src/lib/google-calendar.ts`) เขียน event ลง `3b43062e…@group.calendar.google.com`
- ✅ **ไม่ต้องพึ่ง IT ออก credential ใหม่** ถ้าปฏิทินนั้นแชร์สิทธิ์เขียนให้ `narasit.k` หรือ service account
- ✅ reuse machinery เดิมทั้งดุ้น (auth, computeEventTimes, reconciler)
- ❌ **จองไม่ "ของจริง"** ถ้าแอปอ่าน availability จาก DB ไม่ใช่ปฏิทิน → ห้องไม่ถูกบล็อก, `check-conflict` มองไม่เห็น, ไม่โชว์ใน `my-bookings` → เสี่ยงจองชน/เข้าใจผิด
- ❌ ต้องได้สิทธิ์เขียนปฏิทินนั้นก่อน (ตอนนี้ไม่รู้ว่ามีไหม — Q2)
- **ใช้ได้ก็ต่อเมื่อ** IT ยืนยันว่าปฏิทินนั้นคือแหล่งความจริง (Q1 = ใช่)

### Option C — Deep link (fallback / เฟส 0)
> **ทดสอบแล้ว 2026-07-09:** ฟอร์ม `/booking` **ไม่อ่าน query string เลย** (ในโค้ดไม่มี `URLSearchParams`/`location.search`/`useSearchParams`; โหลด `/booking?roomId=15&startDate=…&title=…` แล้ว **ไม่มีช่องไหนถูกเติม** — ห้องเด้งเป็น default, วันเป็นวันนี้, เวลายังว่าง). จุดบวกเดียว: ล็อกอิน Google แล้วฟอร์ม **auto-fill ชื่อ+อีเมลให้เอง** จาก session. → **prefill แบบเต็มยังทำไม่ได้จนกว่า IT จะเพิ่มการอ่าน query param**

เหลือ 2 แบบ:
- **C1 ลิงก์เปล่า + guided (ทำได้วันนี้ ไม่พึ่งใคร):** ปุ่ม "จองห้องในระบบกลาง" เปิด `/booking`; โปรบุ๊คแสดง/ก๊อปค่าที่ต้องกรอก (ห้อง, วัน, เวลา) ให้ข้าง ๆ. โปรดิวเซอร์เลือกเอง ~5 ช่อง (ชื่อ/อีเมลระบบเติมให้)
  - ✅ ไม่ต้องพึ่ง IT, ไม่มี auth server-to-server, ไม่มีอะไรพัง
  - ❌ ยังไม่คลิกเดียวจบ (ลดงานได้ระดับหนึ่งเท่านั้น)
- **C2 ขอ IT เพิ่ม prefill ผ่าน query param (งานเล็กมากฝั่งเขา):** อ่าน `URLSearchParams` ตอน mount → deep link เติมครบใช้ได้ทันที เป็นทางที่คุ้มสุดถ้ายังไม่ทำ Option A
- ⚠️ ทั้ง C1/C2 ยัง **ไม่บรรลุ "ไม่ต้องจอง 2 ที่" เต็มตัว** (ยังต้องกดยืนยันเอง) — แต่ปลอดภัยที่สุดและเป็น fallback ที่พึ่งได้เสมอ

### ❌ ไม่พิจารณา — Google resource-calendar (เชิญห้องเป็น attendee)
ปกติจองห้อง Workspace = ใส่ resource email เป็น attendee. **ใช้ไม่ได้ที่นี่** เพราะห้องพวกนี้ไม่ใช่ Workspace resource — เป็นแค่ secondary calendar ใบเดียวที่แอป custom คุมเอง

---

## 6. จุดเชื่อมในโค้ดโปรบุ๊ค (ถ้าเลือก A/B)

- **Hook หลัก:** IIFE ปฏิทินใน `src/app/api/admin/[id]/approve/route.ts` (ตรงที่เรียก `createCalendarEvent` — ราวบรรทัด 183–304) → เพิ่มการจองห้องแบบ best-effort background เหมือน Drive pre-create/calendar ที่มีอยู่ (ห้ามบล็อกการ approve)
- **โมดูลใหม่:** `src/lib/room-booking.ts` — ห่อ `checkRoomConflict()`, `reserveRoom()`, `cancelRoomReservation()`, และ **ตารางแมป `locationId → roomId`** (§4). อ่าน base URL + credential จาก env
- **DB (Prisma, เพิ่ม field เท่านั้น ไม่ลบของเดิม):** `roomBookingId String?`, `roomBookingStatus`(`PENDING|OK|FAILED|SKIPPED|CONFLICT`), `roomBookingError String?`, `roomBookingSyncedAt DateTime?` — เลียนแบบ pattern `calendarSyncStatus` ที่ทีมคุ้นอยู่แล้ว
- **Reconciler:** ต่อยอด `src/lib/calendar-reconcile.ts` (retry ทุก 10 นาที) ให้ retry แถว `roomBookingStatus=FAILED` ด้วย
- **จุด lifecycle อื่นที่ต้องแตะ:**
  - แก้ location/วันเวลา (edit/reprogram) → ยกเลิกการจองเดิม + จองใหม่
  - ยกเลิก/ลบ/CANCELLED booking → `PATCH cancel` การจองห้อง
- **ข้อมูลโปรบุ๊คมีครบแล้ว** สำหรับเติมฟอร์ม: `locationName`(→roomId), `producer`/`producerEmail`, `shootDate`/`shootEndDate`, `callTime`/`estimatedWrap`, title จาก `buildEventTitle()`, department จาก `outlet.name`

---

## 7. Auth (ตามแต่ละ option)

- **Option A:** ต้องมี identity แบบ server-to-server จาก IT — เรียงตามความชอบ: (1) รับ **Google-signed ID token** จาก service account ของโปรบุ๊ค (มี service account อยู่แล้ว ปลอดภัยสุด), (2) **API key/service token** เฉพาะโปรบุ๊ค (หมุนได้), (3) mint `portal_token` ให้ service user (เลี่ยง — ผูกกับตัวคน). เก็บใน env: `ROOM_BOOKING_BASE_URL`, `ROOM_BOOKING_TOKEN` (+ enable flag `ROOM_BOOKING_ENABLED`)
- **Option B:** ไม่มี credential ใหม่ — reuse `getCalendarAuth()` (service account + DWD impersonate `narasit.k@thestandard.co`, scope `calendar`). แต่ต้องให้ `narasit.k`/service account **มีสิทธิ์ "Make changes to events"** บนปฏิทิน `3b43062e…`
- **Option C:** ไม่มี auth ฝั่ง server — โปรดิวเซอร์ล็อกอิน Google เองในเบราว์เซอร์

---

## 8. การจัดการ conflict / failure (ห้องถูกจองไปแล้ว)

- **กันชนก่อนจอง:** เรียก `check-conflict` เสมอ ก่อน `POST /booking` (กัน race ระดับหนึ่ง — แต่ระบบเขาควรกันซ้ำอีกชั้นด้วย 409)
- **ถ้าชน (ห้องเต็ม):** **ไม่ล้มการ approve** — booking ยัง CONFIRMED ตามปกติ, ตั้ง `roomBookingStatus=CONFLICT`, ขึ้น chip แดง "ห้องถูกจองแล้ว จองมือ" ในหน้า admin + audit log + อีเมลแจ้ง (reuse `notifyCalendarAlert` pattern). โปรดิวเซอร์ตัดสินใจเอง (เปลี่ยนห้อง/ประสานงาน)
- **ถ้า API ล่ม/timeout:** `roomBookingStatus=FAILED` → reconciler retry ทุก 10 นาที (idempotent: เช็ก `roomBookingId` ว่ามีแล้วยัง กันจองซ้ำ — เหมือน CAS `calendarEventId` ที่มีอยู่)
- **หลักการ:** การจองห้องเป็น **best-effort เสริม** ไม่ใช่ blocker ของ approve (คือ path เดียวกับ calendar/Drive ที่โปรบุ๊คทำอยู่)

### Edge cases ต้องคุย
- ⏰ **เวลา 08:00–21:00 / ราย 30 นาที เท่านั้น** → ถ่ายเลิกดึก/ข้ามคืน/ก่อน 8 โมง แทนในระบบจองไม่ได้ → ต้อง clamp เวลา หรือ mark เป็น "จองมือ" (SKIPPED) + แจ้งเตือน
- 📅 **ถ่ายข้ามหลายวัน** (`shootEndDate`) → ระบบจองมี start/end date รับได้ แต่ต้องเช็กว่ารับช่วงข้ามวันจริงไหม (Q5)
- 🚪 **Lounge (2/F)** (โปรบุ๊คมี ระบบจองไม่มี) → mark SKIPPED เสมอ
- 🔁 **Multi-van / on-location** และ location กลุ่ม EXTERNAL → ข้าม ไม่จองห้อง

---

## 9. Rollback / ความปลอดภัยของการเปลี่ยนแปลง

- ทุกอย่างอยู่หลัง **feature flag `ROOM_BOOKING_ENABLED`** (default off) → ปิดได้ทันทีถ้าพัง โดยไม่กระทบ approve/calendar เดิม
- DB **เพิ่ม column อย่างเดียว** (additive migration) — ไม่แตะ schema เดิม, rollback = ปิด flag (column ค้างไว้เฉย ๆ ไม่มีผล)
- การจองห้องเป็น background best-effort → ต่อให้ integration ล้มเหลวทั้งหมด **การ approve/สร้าง calendar/ส่งเมล ยังทำงานปกติ**
- ถ้าถอดออกทั้งหมด: ปิด flag + (ถ้าต้องการ) รัน cancel การจองที่ค้าง; Option C (deep link) เป็น fallback ที่ยังพึ่งได้เสมอ
- **ไม่แตะโค้ดแอปในงานนี้** — เอกสารนี้เป็นแผนล้วน

---

## 10. เฟสการทำ (เสนอ)

1. **เฟส 0 (ทำได้เลย):** Option C deep link — ปุ่ม "จองห้องในระบบกลาง" prefill ในหน้า booking/approve ลดงานทันที ระหว่างรอ IT
2. **เฟส 1:** คุย IT ได้ credential (§11) → สร้าง `src/lib/room-booking.ts` + ตารางแมป + DB fields (flag off) → ทดสอบกับ 1–2 ห้องบน staging
3. **เฟส 2:** ต่อ hook ใน approve + reconciler + chip/แจ้งเตือน conflict → เปิด flag เฉพาะบางห้อง (เช่น Studio) ดูจริง
4. **เฟส 3:** ครอบทุกห้อง + lifecycle (edit/cancel/reprogram) + monitor audit

---

## 11. คำถามเปิดถึง IT (เจ้าของ service.thestandard.co) / ops

- **Q1 (สำคัญสุด):** ระบบจองเช็กห้องว่างจาก **DB ของแอป** หรือจาก **Google Calendar `3b43062e…`**? (ตัดสินว่า Option B ใช้ได้ไหม)
- **Q2:** จะออก **service credential** ให้โปรบุ๊คเรียก `/api/liff/*` แบบ server-to-server ได้ไหม (แบบไหน: Google ID token / API key / อื่น ๆ) และ rate limit เท่าไร
- **Q3:** `POST /api/liff/booking` — required fields ครบตามที่เดา (`name,email,roomId,startDate,startTime,endDate,endTime,title,note,department,allDay`) ไหม, รูปแบบวัน/เวลา, และ `check-conflict` เรียกยังไง (params/response)
- **Q4 (ตอบแล้ว = ไม่):** ฟอร์ม `/booking` **ไม่รองรับ prefill ผ่าน query string** ในปัจจุบัน (ทดสอบ 2026-07-09) → ขอให้ IT เพิ่มการอ่าน `URLSearchParams` ตอน mount (roomId/startDate/startTime/endDate/endTime/title/note/department) เพื่อให้ Option C2 ใช้ได้ — เป็นงานเล็ก
- **Q5:** รองรับ **จองข้ามหลายวัน** และ **นอกช่วง 08:00–21:00** ไหม (ถ่ายกลางคืน)
- **Q6:** ห้อง **5A (5/F)** (roomId 11) คือห้องอะไร ควรเพิ่มใน `locations.ts` ไหม; และ **Lounge (2/F)** ของโปรบุ๊คจองผ่านระบบกลางไม่ได้จริงหรือ
- **Q7:** commitment เรื่อง **backward-compat / แจ้งก่อนเปลี่ยน API** — เพราะเป็น API ภายในไม่มีเอกสาร
- **Q8:** ธรรมเนียมเจ้าของการจอง — จองในนามโปรดิวเซอร์ (ต้อง `register-email` ก่อน?) หรือในนาม service user เดียว
