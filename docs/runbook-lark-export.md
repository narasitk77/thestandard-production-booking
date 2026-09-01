# Runbook — คลังข้อมูลรายวันบน Lark (v1.212)

> **สรุปหนึ่งบรรทัด:** ทุกคืน 23:00 BKK ระบบดัมป์ทั้งฐานข้อมูลเป็นไฟล์ `.json.gz`
> หนึ่งไฟล์ต่อหนึ่งวันขึ้น Lark Drive (**ไม่ลบทิ้งเลย**), mirror ตารางลง Lark Base
> ให้เปิดดูได้, และบันทึก "แถวที่หายไปตั้งแต่เมื่อวาน" เป็นตารางแยก

---

## 1. ทำไมต้องมี ทั้งที่มี backup อยู่แล้ว

`BACKUP_WORKER_ENABLED=1` บน prod อยู่แล้ว: `pg_dump` ทั้ง DB → Google Drive ทุกวัน
ทำงานดี แต่มีข้อจำกัดสองข้อที่ทำให้มันไม่ใช่ "คลัง":

1. **มัน prune ตัวเองที่ 30 วัน** (`BACKUP_RETENTION_DAYS`) — แถวที่ถูกลบไป 31 วันที่แล้ว
   ไม่เหลือในสำเนาไหนเลย
2. **มันคือ `.sql.gz`** — กู้ทั้งฐานได้ แต่ "ขอดูงานเดือนมีนาคมหน่อย" ทำไม่ได้

และแอปนี้ **ลบแถวจริง ๆ ตามนโยบาย**:

| ข้อมูล | ถูกลบเมื่อไหร่ | โค้ด |
| --- | --- | --- |
| `audit_logs` เกิน 90 วัน | **ทุกครั้งที่ container boot** + ปุ่มใน admin | `start.sh` · `api/audit/purge` |
| `ot_records` นอกหน้าต่าง 10 วัน | ทุกครั้งที่มีคนเปิดหน้า `/ot` (lazy) | `lib/ot-cleanup.ts` |
| ร่าง OT ของ booking | `deleteMany` + สร้างใหม่ทุกครั้งที่แก้ booking | `lib/ot-sync.ts` |
| `audit_logs` / `footage_log` / `ot_records` ของใบนั้น | แอดมินกดลบ booking | `api/admin/[id]/delete` |
| ทุกอย่าง | `purge-bookings` | `api/admin/purge-bookings` |

ตัวนี้คือฝั่งที่ **ไม่ลบ**

---

## 2. สิ่งที่ต้องทำใน Lark ก่อน (ทำครั้งเดียว ~10 นาที)

> ⚠️ **custom bot webhook ที่มีอยู่ (`LARK_WEBHOOK_URL`) ใช้แทนไม่ได้** — มันส่งได้แค่
> ข้อความ เขียนไฟล์หรือตารางไม่ได้ ต้องเป็น **self-built app** คนละอย่างกัน

1. **สร้างแอป** — [open.larksuite.com](https://open.larksuite.com) → Developer Console →
   Create Custom App → ตั้งชื่อเช่น `probook-archive`
   จดค่า **App ID** และ **App Secret**
2. **เพิ่ม scope** — Permissions & Scopes → เพิ่ม
   - `drive:drive` — อัปโหลดไฟล์เข้า Lark Drive
   - `bitable:app` — สร้าง/เขียนตารางใน Lark Base
3. **Publish** — Version Management → Create version → Submit
   (แอดมิน workspace ต้องกดอนุมัติ ถ้าคุณเป็นแอดมินเองก็กดได้เลย)
4. **สร้างที่เก็บ**
   - โฟลเดอร์ใน Lark Drive เช่น `Probook Archive` — โทเคนคือส่วนท้ายของลิงก์
     `…/drive/folder/<LARK_DRIVE_FOLDER_TOKEN>`
   - Base ใหม่ (Lark Base → สร้างเปล่า) — โทเคนคือส่วนท้ายของลิงก์
     `…/base/<LARK_BASE_APP_TOKEN>`
5. **แชร์ทั้งสองอย่างให้แอป** ← **ขั้นที่คนลืมบ่อยที่สุด**
   เปิดโฟลเดอร์/Base → Share → ค้นชื่อแอป (`probook-archive`) → ให้สิทธิ์ **แก้ไขได้**
   *มี scope อย่างเดียวยังเขียนไม่ได้* — scope บอกว่าแอปทำอะไรเป็น, share บอกว่าทำกับ
   ของชิ้นไหนได้

---

## 3. ตั้งค่าใน Portainer (stack 125)

```
LARK_APP_ID=cli_xxxxxxxxxxxx
LARK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
LARK_DRIVE_FOLDER_TOKEN=fldxxxxxxxxxxxxx
LARK_BASE_APP_TOKEN=bascnxxxxxxxxxxxxx
LARK_EXPORT_ENABLED=1
```

ค่าที่เหลือมีค่าเริ่มต้นให้แล้ว (`LARK_EXPORT_HOUR=23`, `LARK_MIRROR_ENABLED=1`,
`LARK_BASE_MAX_ROWS_PER_TABLE=5000`) — ดูคำอธิบายทั้งหมดใน
`docker-compose.portainer.yml`

**อย่าเพิ่งใส่ `LARK_EXPORT_ENABLED=1` ในรอบแรก** — deploy โดยยังปิดไว้ แล้วทำข้อ 4 ก่อน

---

## 4. ตรวจก่อนเปิด (ทำตามลำดับ)

ทั้งสามคำสั่งเป็น **read-only** ยกเว้นที่ระบุ ต้องรันจากในเครือข่ายที่เข้า prod ได้
`$SECRET` = `LARK_EXPORT_SECRET` (ค่าเริ่มต้นคือ `NEXTAUTH_SECRET`)

**4.1 — Lark ต่อติดไหม, scope ครบไหม, แชร์แล้วหรือยัง**

```bash
curl -s -H "x-lark-export-secret: $SECRET" 'https://probook.xtec9.xyz/api/internal/lark-export/preflight?write=1'
```

`write=1` จะอัปไฟล์ทดสอบเล็ก ๆ หนึ่งไฟล์ — **นี่เป็นวิธีเดียวที่พิสูจน์ว่าแชร์โฟลเดอร์
ให้แอปแล้วจริง** (ลบไฟล์ `probook-preflight-*.json.gz` ทิ้งได้หลังตรวจเสร็จ)
`problems[]` ว่าง = พร้อม · ถ้าไม่ว่าง ในนั้นบอกเป็นภาษาไทยว่าขาดขั้นไหน

**4.2 — จะส่งอะไรออกไปบ้าง (ยังไม่แตะ Lark เลย)**

```bash
curl -s -X POST -H "x-lark-export-secret: $SECRET" 'https://probook.xtec9.xyz/api/internal/lark-export/run?dryRun=1'
```

อ่าน `tables[]` — ทุกตารางพร้อมเหตุผลว่าเข้าหรือไม่เข้า และ `sizeBytes` = ขนาดไฟล์จริง
ที่จะอัป (ต้องต่ำกว่า 20MB ซึ่งเป็นเพดานของ `upload_all`)

**4.3 — รันจริงหนึ่งรอบ** (หลังตั้ง `LARK_EXPORT_ENABLED=1` แล้ว)

```bash
curl -s -X POST -H "x-lark-export-secret: $SECRET" 'https://probook.xtec9.xyz/api/internal/lark-export/run'
```

ดูว่ามี `archiveOk: true` **และ** `fileToken` ไม่เป็น null — `code 0` จาก Lark แปลว่า
"รับคำสั่งแล้ว" เท่านั้น `file_token` คือหลักฐานว่ามีไฟล์อยู่จริง

---

## 5. อะไรออกไป อะไรไม่ออก

จัดชั้นไว้ที่เดียวใน `src/lib/lark-export-policy.ts`

**ชั้น 1 — ไม่ออกเด็ดขาด (env เปิดไม่ได้ ต้องแก้โค้ด)**

- `shoot_reviews` — คะแนนรีวิวไขว้ทีมแบบไม่เปิดเผยชื่อ `review-access.ts` ล็อกให้อ่านได้
  3 คน และ **ฟอร์มบอกพนักงานไว้แบบนั้น** · ก็อปลง Lark Base = ย้ายคำสัญญานั้นจากโค้ดที่
  บังคับได้ ไปเป็นช่องติ๊กแชร์ของ Lark = ผิดคำสัญญา โดยที่คนที่ถูกสัญญาไม่มีทางรู้
- `shoot_review_invites` — มีคอลัมน์ `token` ซึ่งเป็น bearer credential ใครถือก็ส่งคะแนน
  แทนคนนั้นได้

**ชั้น 2 — ปิดไว้ (ใส่ชื่อใน `LARK_EXPORT_INCLUDE` เพื่อเปิด)**
`users` · `ot_records` · `page_events` · `feedback_tickets` · `feedback_messages`
— มติของนัท 2026-08-31: ไม่เอาเข้า Lark, ให้ pg_dump บน Google Drive คุมต่อ

**ชั้น 3 — ออกทั้งหมด** — 23 ตารางที่เหลือ (bookings, episodes, audit_logs,
footage_log, uploads, equipment, rental_jobs, switcher_jobs, …)

**ระดับคอลัมน์** — ทุกตารางที่ออก จะตัดคอลัมน์ที่ชื่อลงท้ายว่า `token` / `secret` /
`password` / `apikey` / `credential` ทิ้งอัตโนมัติ (ตาข่ายกันคอลัมน์ใหม่ในอนาคต) แต่ไม่
แตะ `driveFileId` / `boxFolderId` / `externalKey` ซึ่งเป็นตัวระบุที่ต้องใช้

---

## 6. ได้อะไรใน Lark

| ที่ | ชื่อ | เป็นอะไร |
| --- | --- | --- |
| Drive | `probook-YYYY-MM-DD.json.gz` | **คำสัญญา** — ทั้งฐาน ครบทุกแถว วันละไฟล์ ไม่มีอะไรในโค้ดนี้ลบมัน |
| Base | `probook_<ตาราง>` | **ความสะดวก** — สภาพปัจจุบัน เขียนทับทุกคืน เปิดดู/กรอง/ค้นได้ |
| Base | `probook__deleted_rows` | **แถวที่หายไป** — เพิ่มอย่างเดียว ไม่เคยลบ ชี้ไปที่ไฟล์ที่ยังมีเนื้อเต็ม |

**ทำไม Base ถึงเขียนทับ ไม่ใช่เพิ่มทบ:** ถ้าเพิ่มทบ ตารางจะโตวันละ ~11,000 แถว
และชนเพดานแถวของ Lark ภายในสองสัปดาห์ · สิ่งที่เก็บของที่ถูกลบคือไฟล์ + ตาราง
tombstone ไม่ใช่ mirror

**`probook__deleted_rows` อ่านยังไง** — `key` (primary key ของแถวนั้น) · `table` ·
`label` (เช่น `AGN-260630-01 · ถ่ายรายการ X`) · `vanishedAt` · `lastSeenIn`
(ชื่อไฟล์ snapshot ที่ยังมีเนื้อแถวเต็ม) → โหลดไฟล์นั้นจาก Lark Drive แล้วหา key

---

## 7. เฝ้ายังไง

- **`/api/health-summary`** — worker `lark-export` มี dead-man switch 26 ชม.
  (นี่คือ *liveness*: "รอบกลางคืนวิ่งไหม")
- **`/api/internal/lark-export/stats`** — *outcome*: "ไฟล์ลงจริงไหม, เมื่อคืนมีแถวหายไป
  กี่แถว" คำนวณ `alerts[]` เป็นภาษาไทยมาให้เอง
- **nightly check เที่ยงคืน** อ่าน endpoint ที่สองแล้วรายงาน — export รัน 23:00 จึงถูกตรวจ
  ตอนอายุ 1 ชั่วโมง ไม่ใช่ของเมื่อวาน

แยก liveness กับ outcome ไว้คนละที่โดยตั้งใจ (บทเรียน footage-ready v1.181): worker
เต้นครบทุกนัดได้ ในขณะที่ไม่มีไฟล์ไปถึงใครเลย

---

## 8. เจอปัญหา

| อาการ | แปลว่า |
| --- | --- |
| `code 99991663` / token ขอไม่ผ่าน | App ID/Secret ผิด หรือแอปยังไม่ publish |
| `code 91403` / `Forbidden` ตอนอัปไฟล์ | **ยังไม่ได้แชร์โฟลเดอร์ให้แอป** (ข้อ 2.5) |
| `code 1254045 FieldNameNotFound` | คอลัมน์ใหม่ใน DB กับ field ใน Base ไม่ตรง — รอบถัดไปสร้าง field ให้เอง |
| `alerts` มี `ไม่มี snapshot ใหม่มา NN ชม.` | worker ตาย หรือ endpoint 401 (เช็ค `LARK_EXPORT_SECRET`) |
| `รอบล่าสุดบอกว่าสำเร็จแต่ไม่มี file_token` | อย่าเชื่อว่าสำเร็จ — ไปเปิดโฟลเดอร์ Lark ดูด้วยตา |
| ไฟล์เกิน 20MB | `upload_all` รับไม่ไหว ต้องทำ chunked upload (ตอนนี้ ~13,000 แถว ยังห่างมาก) |

**ปิดฉุกเฉิน:** `LARK_EXPORT_ENABLED=0` แล้ว redeploy · ปิดแค่ Base โดยยังเก็บไฟล์ต่อ:
`LARK_MIRROR_ENABLED=0`
