# Staging Environment — Setup (v1.159)

stack ทดสอบคู่ขนานกับ prod: image เดียวกัน, DB แยก, Drive แยก, อีเมล sandbox
— ไว้ทดสอบ worker/ฟีเจอร์เสี่ยงก่อนขึ้นจริง (ข้อ 3 ของแผน robustness)

## กันพลาดยังไง (2 ชั้น, fail-closed)

1. **compose บังคับ** — drive root ทั้ง 3 ใช้ `:?` : ไม่ตั้ง = stack ไม่ขึ้นเลย
2. **ในโค้ด** (`src/lib/app-env.ts`) — เมื่อ `APP_ENV=staging`:
   - Drive auth ทุกตัว **ปฏิเสธทำงาน** ถ้า root ตัวไหนว่าง หรือเป็น id ของไดรฟ์จริง
     (id จริงทั้ง 3 ฝังอยู่ในโค้ดเป็น blocklist)
   - อีเมลทุกฉบับถูกเปลี่ยนผู้รับเป็น `REMINDER_ADMIN_EMAIL` + หัวเรื่อง `[STAGING]`
     (บอกไว้ในเนื้อความว่าเดิมจะส่งถึงใคร)
   - ปฏิทิน**ตายสนิท**จนกว่าจะตั้ง `STAGING_ALLOW_CALENDAR=1` + calendar ทดสอบ
   - Google Sheets ตายสนิทเช่นกัน จนกว่าจะตั้ง `STAGING_ALLOW_SHEETS=1` + **สำเนา**ชีท
     (id ชีทจริงอยู่แค่ใน env จึง blocklist แบบไดรฟ์ไม่ได้ — เลยใช้ opt-in แทน)
   - แบนเนอร์เหลือง "⚠️ STAGING" ทุกหน้า
   - Discord: ปล่อย `DISCORD_WEBHOOK_URL` ว่าง = ไม่มีอะไรส่ง

## เช็คลิสต์ (ฝั่งแอดมิน ~30 นาที)

### 1. สร้าง Shared Drive ทดสอบ 3 ใบ (Google Drive → Shared drives → New)

| ชื่อแนะนำ | ใช้แทน | ใส่ env |
|---|---|---|
| `STAGING · VIDEO` | VIDEO 2026 (กล่อง footage) | `DRIVE_FOOTAGE_ROOT` |
| `STAGING · Production Team` | โซน NAS drop | `DRIVE_PRODUCTION_TEAM_ROOT` |
| `STAGING · Photo` | ไดรฟ์ช่างภาพ | `DRIVE_PHOTO_ROOT` |

แต่ละใบ: **Manage members → เพิ่ม `narasit.k@thestandard.co`** (ตัวที่ระบบ
impersonate — ใช้ SA เดิมได้เลย สิทธิ์ถูกคุมด้วยว่าแชร์ไดรฟ์ไหนให้)
แล้วคัดลอก **drive id** จาก URL (`drive.google.com/drive/folders/<ID>`)

### 2. สร้าง stack ใน Portainer

- Stacks → Add stack → Repository (repo เดิม) → Compose path: **`docker-compose.staging.yml`**
- Environment variables ขั้นต่ำ:

```
POSTGRES_PASSWORD=<random ใหม่ ไม่ใช่ของ prod>
NEXTAUTH_URL=http://<host>:3100
NEXTAUTH_SECRET=<random ใหม่ ไม่ใช่ของ prod>
DRIVE_FOOTAGE_ROOT=<id STAGING · VIDEO>
DRIVE_PRODUCTION_TEAM_ROOT=<id STAGING · Production Team>
DRIVE_PHOTO_ROOT=<id STAGING · Photo>
GOOGLE_SERVICE_ACCOUNT_JSON=<ก๊อปจาก stack prod>
EMAIL_PROVIDER + SMTP_* / RESEND_API_KEY=<ก๊อปจาก prod ได้ — sandbox คุมผู้รับให้>
```

- ค่า default ที่ตั้งให้แล้ว: `AUTH_DISABLED=1` (เข้าได้เลยไม่ต้อง login),
  port `3100`, worker Drive-mutating เป็น report-only, calendar/Discord/backup ปิด

### 3. ตรวจหลัง deploy

1. เปิด `http://<host>:3100` → ต้องเห็น**แบนเนอร์เหลือง STAGING**
2. `GET /api/version` → ตอบเวอร์ชันปกติ
3. ลองจองงานทดสอบ 1 งาน → approve → ดูว่าโฟลเดอร์ไปเกิดใน **STAGING · VIDEO**
   (ถ้า config ผิด จะเห็น error `[staging-guard] ...` ใน log แทน — นั่นคือการ์ดทำงาน)

## ใช้ทดสอบอะไร

- ข้อ 4 ของแผน (ยุบ sweep → reconciler เดียว): รันคู่ขนานเทียบผลบน staging ก่อนสลับ
- ฟีเจอร์ Drive-mutating ใหม่ทุกตัว: เปิด `FOLDER_INTEGRITY_APPLY=1` ที่นี่ก่อน prod
- การทดสอบ migration schema (DB แยก พังได้ไม่เจ็บ)

> ⚠️ อย่า point NAS agent / Airtable crawler / PMDC มาที่ staging เด็ดขาด
> และห้ามใส่ sheet id จริง (`PRODUCER_DASHBOARD_SHEET_ID`) — ใช้สำเนาเท่านั้น
> (มีการ์ดในโค้ดดักทั้งคู่แล้ว: ชีท/ปฏิทินที่ชี้ของจริงจะโดนปฏิเสธแม้เปิด opt-in)

> 🔴 **ห้าม restore ข้อมูล DB จาก prod เข้า staging เด็ดขาด** — ระบบเป็น id-first:
> แถว booking ของจริงพก Drive folder id จริงมาด้วย (`driveFolders`) และ worker
> จะตามไปแก้/ย้ายโฟลเดอร์จริงทันทีโดยการ์ด drive-root ช่วยอะไรไม่ได้
> (มัน validate แค่ env ไม่ได้ validate id รายแถว) ถ้าจะซ้อม migration ให้ใช้
> DB ว่าง + seed หรือ dump ที่ล้างคอลัมน์ `driveFolders`/`calendarEventId` แล้วเท่านั้น
