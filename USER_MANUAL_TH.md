# คู่มือการใช้งาน Production Booking — THE STANDARD

ระบบจองงานถ่ายทำสำหรับทีม Production Platform · เวอร์ชัน 1.7+

🔗 **ลิงก์เข้าใช้งาน:** [https://production-booking-app.onrender.com](https://production-booking-app.onrender.com)

---

## สารบัญ

1. [การเข้าสู่ระบบ](#1-การเข้าสู่ระบบ)
2. [การสร้าง Booking](#2-การสร้าง-booking)
3. [My Bookings — งานของฉัน](#3-my-bookings--งานของฉัน)
4. [Calendar — ปฏิทินงาน](#4-calendar--ปฏิทินงาน)
5. [Admin Console — เฉพาะแอดมิน](#5-admin-console--เฉพาะแอดมิน)
6. [Dashboard — สรุปและสถิติ (เฉพาะแอดมิน)](#6-dashboard--สรุปและสถิติ-เฉพาะแอดมิน)
7. [OT — บันทึกเวลาทำงานวันหยุด/ล่วงเวลา](#7-ot--บันทึกเวลาทำงานวันหยุดล่วงเวลา)
8. [Permissions — จัดการสิทธิ์ (เฉพาะแอดมิน)](#8-permissions--จัดการสิทธิ์-เฉพาะแอดมิน)
9. [คำถามที่พบบ่อย](#9-คำถามที่พบบ่อย)

---

## 1. การเข้าสู่ระบบ

ระบบใช้บัญชี Google ของ THE STANDARD เท่านั้น (`@thestandard.co`)

### ขั้นตอน

1. เปิด [https://production-booking-app.onrender.com](https://production-booking-app.onrender.com)
2. ระบบจะพาไปหน้า **Sign in**
3. กดปุ่ม **"Sign in with Google"**
4. เลือกบัญชี `@thestandard.co` ของคุณ → กด Continue
5. จะถูกพาเข้าหน้าแรกของระบบ

### หมายเหตุ
- ครั้งแรกที่ Sign in ระบบจะสร้างบัญชีให้อัตโนมัติเป็น **User** (ผู้ใช้ทั่วไป)
- บัญชี `narasit.k@thestandard.co` เป็น **Admin** อัตโนมัติ
- ถ้าต้องการเป็นแอดมิน ให้แอดมินคนใดคนหนึ่งโปรโมตให้ผ่านหน้า [Permissions](#7-permissions--จัดการสิทธิ์-เฉพาะแอดมิน)
- ถ้าใช้บัญชีอีเมลอื่นที่ไม่ใช่ `@thestandard.co` จะถูกปฏิเสธ

### ออกจากระบบ
- กด **"Sign out"** มุมขวาบนของแถบนำทาง (ข้างชื่ออีเมล)

---

## 2. การสร้าง Booking

หน้าแรก ( `/` ) คือฟอร์มสร้าง Booking งานถ่ายทำใหม่

### ขั้นตอน

1. เลือก **Outlet** (สังกัด เช่น News, Wealth, Sports ฯลฯ)
2. เลือก **Program** (รายการ) — รายการจะถูกกรองตาม Outlet ที่เลือก
3. กรอก **Shoot Date** วันถ่ายทำ
4. เลือก **Category** หมวดหมู่งาน:
   - Recurring · งานประจำ
   - Agency Job · งาน Agency
   - Service Job · งานบริการ
   - Internal · งานภายใน
5. เลือก **Shoot Type** ประเภทการถ่าย:
   - Studio · ในสตูดิโอ
   - On Location · นอกสถานที่
   - Remote / Online · ทางไกล/ออนไลน์
   - Event · งานอีเวนต์
6. ถ้าไม่ใช่ Studio → กรอก **Location Name** สถานที่ถ่าย
7. ถ้าเป็น Agency Job → กรอก **Agency Ref** เลขอ้างอิง
8. กรอก **Call Time** (เวลาเริ่ม) และ **Estimated Wrap** (เวลาคาดว่าจะจบ) รูปแบบ `HH:MM` เช่น `09:00`
9. กรอก **Producer** ชื่อโปรดิวเซอร์
10. กรอก **Creative / Host** (ถ้ามี) — กดเพิ่มได้หลายชื่อ
11. เลือก **Crew Required** (Videographer, Sound, Lighting, Photographer ฯลฯ)
12. กรอก **Notes** (ถ้ามี)
13. **Episode Titles** — กรอกชื่อตอน อย่างน้อย 1 ตอน กดเพิ่มได้หลายตอน
14. กด **"Submit"**

### Episode ID จะถูกสร้างอัตโนมัติ

รูปแบบ: `[OUT]-[YYMMDD]-[PROG]-[EE]`

- `OUT` = รหัส Outlet 3 ตัวอักษร (เช่น NWS)
- `YYMMDD` = วันที่ถ่าย เช่น 260427 = 27 เม.ย. 2026
- `PROG` = รหัส Program (เช่น KYM)
- `EE` = ลำดับตอนของวัน 01, 02, ...

**ตัวอย่าง:** `NWS-260427-KYM-01` = News, 27 เม.ย. 2026, Key Message, ตอนที่ 1

> ⚠️ **Episode ID เปลี่ยนไม่ได้** — ใช้ในการตั้งชื่อโฟลเดอร์ NAS / Drive

### หลังกด Submit
- งานจะถูกบันทึกในฐานข้อมูล สถานะเริ่มต้นคือ **`[REQUESTED]`**
- ระบบจะส่งข้อมูลไป Google Sheet อัตโนมัติเป็นบันทึก
- รอ Admin ตรวจสอบ → Assign ทีม → Approve

---

## 3. My Bookings — งานของฉัน

หน้า `/my-bookings` แสดงงานที่เกี่ยวข้องกับคุณเท่านั้น

### แท็บที่มี

- **Mine (Requested + Assigned)** — งานที่คุณสร้าง หรือที่คุณถูก Assign ให้ไปทำ
- **All Confirmed** — งานทุกอันที่ได้รับการ Approve แล้ว (ดูได้ทุกคน เพื่อรู้ว่าทีมกำลังจะมีงานอะไรบ้าง)

### การคลิกการ์ด
- คลิก Booking ใดๆ → ไปหน้า Detail (`/dashboard/[id]`)
- ในหน้า Detail จะเห็น:
  - Episode IDs ทั้งหมด
  - Calendar Packet (ก็อปไปลง Google Calendar / Slack ได้)
  - Drive folder path
  - สถานะ + ปุ่มเปลี่ยนสถานะ (เฉพาะแอดมิน)

---

## 4. Calendar — ปฏิทินงาน

หน้า `/calendar` ปฏิทินรายเดือนแสดงงานทั้งหมด

### สิ่งที่เห็น

- **กริดปฏิทิน 1 เดือน** — งานทุกสถานะแสดงในวันที่ตรงกัน
- **สีแสดงสถานะ:**
  - 🔴 แดง = `[REQUESTED]` (รอ Approve)
  - 🟢 เขียว = `CONFIRMED` (Approve แล้ว)
  - 🔵 น้ำเงิน = `COMPLETED` (เสร็จแล้ว)
  - ⚪ เทา = `CANCELLED` (ยกเลิก)

### การใช้งาน

- **Hover เมาส์** ที่งานใดๆ → จะมี popup เล็กๆ โผล่ขึ้นมาแสดง:
  - สถานะ + เวลา
  - Outlet · Program
  - ประเภทถ่าย + สถานที่
  - โปรดิวเซอร์
  - Episode IDs (สูงสุด 3 อัน)
- **คลิกที่วัน** → จะเห็นรายการงานทั้งหมดของวันนั้นด้านล่าง พร้อมรายละเอียด
- **คลิกที่งาน (จากรายการล่าง)** → ไปหน้า Admin Edit ของ Booking นั้น (เฉพาะแอดมิน)
- **เปลี่ยนเดือน** → ปุ่ม < / > ด้านขวาบน
- **กลับวันนี้** → ปุ่ม "Today"

### Google Calendar (ฝั่งบริษัท)

เมื่อ Admin กด Approve → ระบบจะส่ง Event ไปยังปฏิทิน Google ชื่อ **"THE STANDARD Production Bookings"**

วิธี Subscribe (ครั้งแรกครั้งเดียว):
1. เข้า [https://calendar.google.com/calendar/u/0/r/settings/addbyid](https://calendar.google.com/calendar/u/0/r/settings/addbyid)
2. วาง ID:
   ```
   72bf6ae390fb09d1e0a117dbaf421799be6bcc3b21ec2b7c3e2d7a65e65f9dc5@group.calendar.google.com
   ```
3. กด **Add Calendar**

เมื่อ Subscribe แล้ว Event ทุกอันของทีมจะปรากฏใน Google Calendar ของคุณ ดูได้ทั้งบนเว็บและบนมือถือ

---

## 5. Admin Console — เฉพาะแอดมิน

หน้า `/admin` ศูนย์รวมการจัดการ Booking

### หน้าหลัก

- **แท็บกรองสถานะ:** `[REQUESTED]` · `Confirmed` · `Completed` · `Cancelled` · `All`
- การ์ดแต่ละอันแสดง: สถานะ · วัน/เวลา · Outlet · Program · Producer · ผู้ที่ถูก Assign · Episode IDs

### ปุ่มที่มี

- **EDIT** — ไปหน้าแก้ไข + Assign ทีม
- **APPROVE** — Approve ทันที (สำหรับงาน `[REQUESTED]`) → สร้าง Event บน Google Calendar
- **CANCEL** — ยกเลิกงาน → ลบ Event จาก Calendar + อัปเดต Sheet

### หน้า Edit (`/admin/[id]`) — Assign ทีม

แบ่งหมวดหมู่ทีมตามสายงาน:

- **Videographer** (Bird, Arm, Noom, Dome, F, P, Kim, Tew)
- **Video Director** (Pook · Head, Top, PAT, Paii)
- **Sound Team** (Art · Sr., Note, Thee, Peace)
- **Photographer** (Mod)
- **Switcher** (Dream, Ting)

#### การใช้งาน

1. ติ๊กชื่อคนที่จะ Assign (ติ๊กได้หลายคนหลายหมวด)
2. **Freelance** — ถ้าต้องการเพิ่ม Freelance:
   - กรอก Name (จำเป็น) + Contract No. (ถ้ามี) + Email (ถ้ามี)
   - กด **+ Add Freelancer**
   - เพิ่มได้ไม่จำกัดจำนวนคน
3. **Add by Email (Other)** — เพิ่มอีเมลคนอื่นที่ไม่อยู่ในรายชื่อ
4. **Admin Notes** — ข้อความเพิ่มเติม จะส่งไปในอีเมลแจ้งเตือนด้วย
5. กด **"Save & Send Email"** → ระบบจะ:
   - บันทึกการ Assign
   - เปลี่ยนสถานะเป็น `ASSIGNED`
   - ส่งอีเมลแจ้งทีมที่ถูกเลือก
   - อัปเดต Sheet

### การ Approve

- กด **"✓ Approve & Add to Calendar"**
- ระบบจะสร้าง Event บน Google Calendar
- เปลี่ยนสถานะเป็น `CONFIRMED`
- บันทึก Calendar Event ID
- แสดงข้อความยืนยัน

### การ Cancel
- กด **CANCEL** ในการ์ด Booking
- ยืนยันใน popup
- ระบบจะ: เปลี่ยนสถานะเป็น `CANCELLED` + ลบ Calendar Event + อัปเดต Sheet

### การ Restore (นำกลับมา)
- งานที่ Cancel ไปแล้ว มีปุ่ม **↺ RESTORE** ที่การ์ด
- กด → ยืนยัน → สถานะกลับเป็น `[REQUESTED]`
- หมายเหตุ: Calendar event เก่าถูกลบแล้ว ต้อง **Approve** อีกครั้งเพื่อสร้าง event ใหม่
- ทำได้ในหน้ารายการ `/admin` หรือในหน้า Edit `/admin/[id]` (มีแถบเตือนเหลืองบนสุด)

### การแก้ไขรายละเอียด Booking
- เปิดหน้า Edit ของ Booking → ในส่วน **Booking Details** กดปุ่ม **Edit**
- แก้ได้: Call Time, Wrap Time, Shoot Type, Location, Producer, Creative/Host, Crew, Agency Ref, Notes, ชื่อตอน (Episode title)
- **แก้ไม่ได้** (เพราะกระทบ Booking number / Episode ID):
  - Outlet
  - Program
  - Shoot Date
  - Episode ID (ตัว `NWS-260427-KYM-01` ห้ามเปลี่ยน)
  - ลำดับตอน (sequence)
- ถ้าต้องเปลี่ยน Outlet/Program/Date/ID → ต้อง **Cancel** แล้วสร้าง Booking ใหม่

---

## 6. Dashboard — สรุปและสถิติ (เฉพาะแอดมิน)

หน้า `/dashboard` แสดงภาพรวมและสถิติทั้งหมด

### กราฟด้านบน

- **Donut Chart: Bookings by Status** — แสดงจำนวนงานแยกตามสถานะ คลิกชิ้นพายเพื่อกรองตาราง
- **Bar Chart: Bookings by Outlet** — งานแยกตาม Outlet คลิกแท่งเพื่อกรองตาราง

### Team Workload — สถิติการทำงานของทีม

ส่วนสำคัญที่สุดสำหรับการติดตามภาระงานของทีม

#### ฟิลเตอร์
- **ช่วงวันที่ (Date Range)** — เลือกได้ตามต้องการ ค่าเริ่มต้นคือ "ตั้งแต่ต้นเดือนถึงวันนี้"
- **ปุ่ม "This month"** — ปรับช่วงเป็นเดือนปัจจุบันอย่างรวดเร็ว
- **Include `[REQUESTED]`** — ติ๊กถ้าต้องการนับงานที่ยังไม่ได้ Approve ด้วย (ค่าเริ่มต้นนับเฉพาะ CONFIRMED + COMPLETED)
- **Sort** — เรียงตาม Total Hours หรือ Bookings

#### สิ่งที่แสดง

**สรุปด้านบน:** จำนวนคน · จำนวน Assignment ทั้งหมด · ชั่วโมงรวมทั้งหมด

**Bar Chart แนวนอน:** Top 12 คนที่ทำงานเยอะสุด (จะเห็นทันทีว่าใครรับงานเยอะเกินหรือน้อยเกิน)

**ตารางละเอียด:**
| คอลัมน์ | ความหมาย |
|---|---|
| # | ลำดับ |
| Email | อีเมลทีมงาน |
| Bookings | จำนวน Booking ที่ถูก Assign ในช่วงเวลานั้น |
| Total Hours | ชั่วโมงรวมทั้งหมด (คำนวณจาก Call Time → Wrap Time, ถ้าไม่มี Wrap ใช้ค่า default 4 ชั่วโมง) |
| Avg / Booking | เฉลี่ยชั่วโมงต่อ 1 Booking |

#### Export CSV

กดปุ่ม **"Export CSV"** ในแถบ Team Workload → ดาวน์โหลดไฟล์ `team-workload_YYYY-MM-DD_to_YYYY-MM-DD.csv`

ไฟล์มีคอลัมน์:
- Email
- Bookings Assigned
- Total Hours
- Avg Hours per Booking
- Date Range
- Booking IDs (รายการ ID งานที่เขาถูก Assign)

> 💡 ใช้ไฟล์ CSV นี้สำหรับ:
> - คำนวณค่าตอบแทนทีม
> - รายงานภาระงานรายเดือน
> - วิเคราะห์การกระจายงาน

### Export Bookings

นอกจาก Team Workload ยังมีปุ่ม **"Export Bookings"** ขวาบน → ดาวน์โหลด CSV ของ Booking ทั้งหมดที่กรองอยู่ในตอนนั้น (ตามฟิลเตอร์ค้นหา/Outlet/Status)

### ตาราง Bookings ด้านล่าง

- ค้นหาด้วย Episode ID, ชื่อรายการ, Producer
- กรองตาม Outlet
- กรองตามสถานะ
- คลิก **View →** เพื่อดูหน้า Detail

---

## 7. OT — บันทึกเวลาทำงานวันหยุด/ล่วงเวลา

หน้า `/ot` สำหรับบันทึกการทำงานวันเสาร์-อาทิตย์/วันหยุด และค่าทำงานล่วงเวลาประจำเดือน — ทดแทนการกรอกใน Google Sheet

### ใครเข้าได้

- **User ทุกคน** (ที่ Login ด้วย @thestandard.co) เห็นและแก้ไขเฉพาะของตัวเอง
- **Admin** ดู/Export ของทุกคนได้

### การใช้งาน (User)

1. เปิดเมนู **OT** ในแถบนำทาง
2. ระบบแสดงเดือนปัจจุบัน + รายการของคุณ + ยอดสรุป (วันหยุด/ชั่วโมง OT)
3. คลิก **เพิ่มรายการ:**
   - เลือกประเภท: 
     - **ทำงานล่วงเวลา (เกิน 8 ชั่วโมง)** → กรอกจำนวนชั่วโมง (ทศนิยมได้)
     - **วันหยุด (เสาร์-อาทิตย์ / วันหยุดประกาศ)** → ไม่ต้องกรอกชั่วโมง (นับ 1 วัน)
   - กรอกวันที่ (ภายในเดือนปัจจุบัน)
   - กรอกรายละเอียด (optional) — ใช้บอกว่าทำงานอะไร โปรเจกต์ไหน
4. กด **+ เพิ่ม** → บันทึกทันที
5. ลบรายการที่ไม่ต้องการได้ด้วยปุ่มถังขยะ

### กฎการคำนวณ OT (Thai Labor)

**อัตราคงที่ — ไม่บวกซ้อน:**

| ประเภทวัน | เงื่อนไข | อัตรา |
|---|---|---|
| **วันธรรมดา** (Mon–Fri) | ทำงานต่อเนื่องเกิน 8 ชั่วโมง (start ของงานแรก → end ของงานสุดท้าย) | **300 THB/วัน** |
| **เสาร์-อาทิตย์** | มีงานช่วงไหนก็ได้ | **500 THB/วัน** |
| **วันหยุดประกาศ** (ตามปฏิทินไทย Google) | มีงานช่วงไหนก็ได้ | **500 THB/วัน** |
| วันหยุด + ตรงกับ Sat/Sun | (ไม่บวกซ้อน) | คงที่ **500 THB** |

### Standby

ถ้าใส่หลายงานในวันเดียวกันแต่มีช่วงว่างระหว่างงาน → ระบบจะ tag ว่า **"Standby"**

ตัวอย่าง: วันธรรมดา ทำงาน 06:00–08:00 + 17:00–19:00 → span = 13 ชั่วโมง > 8 ชม. → 300 THB · มี gap → "Standby" ✓

### Required Fields (ทุกครั้งที่ใส่/แก้)

- **วันที่** (date)
- **เวลาเริ่ม → สิ้นสุด** (start, end — รูปแบบ HH:MM)
- **งานที่ทำ** (Job Task) — จำเป็น
- **เหตุผล** (Justification) — จำเป็น (ทำไม OT ถึงจำเป็น)

### กฎการเก็บข้อมูล (Auto-reset)

- **เดือนปัจจุบัน:** แก้ไขได้เต็มที่
- **เดือนก่อนหน้า:** เก็บไว้ 10 วันแบบ read-only (ดูได้ แก้ไม่ได้)
- **หลัง 10 วันของเดือนใหม่:** ระบบลบเดือนก่อนหน้าอัตโนมัติ
- ⚠️ **Admin ต้อง Export CSV ภายใน 10 วันแรกของเดือนใหม่** ก่อนระบบลบของเดือนเก่า

### การใช้งาน (Admin)

ที่หน้า `/ot` กดลิงก์ **"→ Admin / Cover Sheet"** มุมขวาบน → ไปหน้า `/ot/admin`

#### หน้า Admin OT Cover Sheet

- เลือกเดือนได้
- ตารางสรุปแบบ Cover Sheet (เหมือนใบฟอร์มเดิม):
  - ชื่อ-นามสกุล · รหัสพนักงาน · ตำแหน่ง · วันหยุด · OT (ชม.)
- ยอดรวม: คนที่บันทึก / วันหยุดรวม / OT รวม

#### Export CSV

ปุ่ม Export 2 แบบ:

| ปุ่ม | ได้อะไร |
|---|---|
| **Cover Sheet CSV** | ไฟล์เหมือนแบบฟอร์มเดิม "ใบปะหน้า" — ส่งให้ฝ่ายบุคคลได้เลย |
| **Detail CSV** | รายการรายวันละเอียด ทุกคน ทุก entry ในเดือนนั้น |

ทั้งสองไฟล์ใช้ UTF-8 BOM → ภาษาไทยเปิดได้ทันทีใน Excel/Numbers/Sheets

### ข้อมูล Profile (ชื่อไทย/รหัสพนักงาน/ตำแหน่ง)

- ระบบ pre-load ข้อมูลทีม Production ทุกคนไว้แล้ว (จาก HR roster)
- เมื่อ Login ครั้งแรก ข้อมูลนี้จะแสดงใน Profile ของคุณอัตโนมัติ
- ใช้ในการ Export Cover Sheet (รหัสพนักงาน TSDxxx จะถูกกรอกให้)

---

## 8. Permissions — จัดการสิทธิ์ (เฉพาะแอดมิน)

หน้า `/admin/permissions` จัดการบัญชีผู้ใช้และสิทธิ์

### สิ่งที่ทำได้

#### Add / Update User
- กรอกอีเมล `@thestandard.co`
- เลือก Role: **User** หรือ **Admin**
- กด **Save**
- ถ้ามีอยู่แล้ว → อัปเดต Role + เปิดใช้งาน

#### ตารางผู้ใช้ทั้งหมด
แสดง Email · Role · Status · ปุ่ม Action

##### Action ที่ทำได้:

| ปุ่ม | ความหมาย |
|---|---|
| **Make Admin** | เลื่อนเป็นแอดมิน |
| **Demote** | ลดเป็น User ปกติ |
| **Disable** | ปิดบัญชี → คนนั้นจะ Login ไม่ได้ |
| **Enable** | เปิดบัญชีอีกครั้ง |

> ⚠️ **กันตัวเองออก:** ระบบไม่ให้คุณ Demote หรือ Disable ตัวเอง เพื่อกัน lockout

### ใครจะถูกเพิ่ม
- ทุกคนที่ Sign in ด้วย Google `@thestandard.co` ครั้งแรก จะถูกเพิ่มเป็น **User** อัตโนมัติ
- คุณไม่ต้องเพิ่มเอง รอให้พวกเขา Sign in ก่อน แล้วเลื่อน Role ทีหลัง

---

## 9. คำถามที่พบบ่อย

### Q: Login แล้วเข้าไม่ได้ ขึ้นว่า "Only @thestandard.co"
**A:** คุณใช้บัญชี Google ส่วนตัว เปลี่ยนไปใช้บัญชีบริษัทที่เป็น `@thestandard.co`

### Q: เป็น User ทั่วไป เข้า /admin ไม่ได้
**A:** ถูกต้อง — `/admin` และ `/dashboard` เปิดเฉพาะ Admin เท่านั้น คุณดูได้ที่ `/my-bookings` และ `/calendar` แทน

### Q: สร้าง Booking แล้ว แต่ไม่เห็นใน Google Calendar
**A:** ต้องรอ Admin กด **Approve** ก่อน → จึงจะมี Event บน Calendar (สถานะ `[REQUESTED]` ยังไม่ส่ง Calendar)

### Q: Approve แล้วแต่ใน Google Calendar ของฉันไม่เห็น
**A:** ต้อง Subscribe ปฏิทิน "THE STANDARD Production Bookings" 1 ครั้งก่อน ดูวิธีในหัวข้อ [Calendar](#4-calendar--ปฏิทินงาน)

### Q: Episode ID ซ้ำได้ไหม / แก้ได้ไหม
**A:** ไม่ซ้ำ และ **แก้ไม่ได้** — ระบบสร้างอัตโนมัติและล็อกตายตัว ใช้ในการตั้งชื่อโฟลเดอร์/ไฟล์ทุกอย่าง

### Q: ส่งอีเมลแจ้งทีมไม่ถึง
**A:** ตรวจสอบ:
1. คนที่ติ๊กมีอีเมลถูกต้องหรือไม่
2. Spam folder
3. แอดมินตรวจ log ฝั่งระบบ

### Q: Cancel แล้วกลับมา Approve ได้ไหม
**A:** ไม่ได้โดยตรง — ต้องสร้าง Booking ใหม่ (ป้องกันความสับสนของสถานะ)

### Q: ทีม Freelance นับใน Team Workload ไหม
**A:** **ใส่อีเมลของ Freelance เวลา Add ตอน Assign** → ถึงจะถูกนับ ถ้าใส่แค่ชื่อ จะไม่ถูกนับใน Dashboard (เพราะ track จากอีเมล)

### Q: Export CSV ไม่เปิดในภาษาไทย / มี ?
**A:** ไฟล์ CSV ใส่ BOM (UTF-8) ไว้แล้ว เปิดด้วย Excel/Numbers/Google Sheets ได้ทันที ภาษาไทยอ่านได้ปกติ

---

## ติดต่อ / รายงานปัญหา

- **Code:** [github.com/narasitk77/thestandard-production-booking](https://github.com/narasitk77/thestandard-production-booking)
- **เจ้าของระบบ:** narasit.k@thestandard.co (Production Administrator)
- **Bug / ฟีเจอร์ใหม่:** เปิด Issue บน GitHub หรือแจ้งผ่าน Slack

---

*คู่มือนี้อัปเดตล่าสุด: เม.ย. 2026 · เวอร์ชันระบบ 1.7+*
