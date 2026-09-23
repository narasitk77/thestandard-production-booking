# Deploy และการถอยกลับ (rollback)

> เขียนหลังเคส 2026-09-23 ที่นัทสั่งว่า "ก่อน deploy ใหม่ ให้ backup ของเดิมไว้ ถ้าใหม่พังต้องถอยกลับได้"
> ทุกขั้นตอนในเอกสารนี้ **รันจริงแล้ว** ไม่ใช่เขียนจากความเข้าใจ

## สั่งงาน

```bash
cd "Production Booking"
python3 scripts/ops/deploy.py 717a8e1     # deploy (จด backup + จุดถอยให้เอง)
python3 scripts/ops/rollback.py           # ถอยกลับจุดที่จดไว้
python3 scripts/ops/rollback.py 0ab035f   # ถอยไปเลขที่ระบุเอง
```

`deploy.py` ทำ 5 อย่างตามลำดับ และ **ห้ามสลับลำดับ**:

1. จด `IMAGE_TAG` ปัจจุบัน (= จุดที่รู้ว่าดี) ลง `~/.probook/deploy-state.json`
2. เตือนถ้า release นี้แก้ `prisma/schema.prisma` — ดูหัวข้อกับดักข้างล่าง
3. สั่ง backup DB แล้ว **ยืนยันว่ามีไฟล์จริง** (ชื่อ + driveFileId + ขนาด > 0) ไม่ใช่แค่ HTTP 200
4. ค่อยเปลี่ยน tag แล้ว redeploy
5. ยืนยันครบสาม: `stack env == container image == tag` **และ** แอปตอบ 200

ข้อ 5 สำคัญเพราะคอนเทนเนอร์เก่ายังตอบ HTTP อยู่ระหว่างที่ Portainer ดึงอิมเมจใหม่ —
เคยเกือบประกาศว่า deploy แล้วทั้งที่ยังเป็นของเก่า (2026-08-24)

## ⚠️ กับดัก: ถอยอิมเมจ ไม่ได้ถอย schema

คอนเทนเนอร์รัน `prisma db push --accept-data-loss` **ทุก boot** (`start.sh`)

ถอยอิมเมจกลับไปเวอร์ชันที่ `schema.prisma` ยังไม่มีคอลัมน์ใหม่ = อิมเมจเก่าจะ push
schema เก่าทับ = **DROP คอลัมน์นั้นพร้อมข้อมูลในนั้น**

ตัวอย่างจริง: v1.231 เพิ่ม `director2/director2Email/director3/director3Email`
ถอยกลับไปก่อนหน้านั้น = ผู้กำกับคนที่ 2-3 ของทุกใบหายหมด

| release แบบไหน | ถอยยังไง |
|---|---|
| แก้แต่โค้ด | `rollback.py` พอ ปลอดภัย |
| แตะ `prisma/schema.prisma` | ต้องกู้ DB ด้วย ไม่งั้นข้อมูลในคอลัมน์ใหม่หาย |

`deploy.py` จดไว้ให้แล้วว่า release ไหนแตะ schema (`schema_changed` ใน state file)
และ `rollback.py` จะหยุดถามก่อนในกรณีนั้น

## กู้ฐานข้อมูลจาก backup

Backup รันวันละครั้ง + ทุกครั้งที่คอนเทนเนอร์ boot + ทุกครั้งที่ `deploy.py` ทำงาน
เก็บใน Google Drive โฟลเดอร์ `BACKUP_DRIVE_FOLDER_ID` เก็บย้อนหลัง `BACKUP_RETENTION_DAYS` (พรอด = 365)
รูปแบบ `backup-YYYY-MM-DDTHHMMSS.sql.gz` (UTC) จาก `pg_dump --no-owner --no-privileges` แล้ว gzip

**ขั้นตอนที่ทดสอบแล้ว** (ลอง drop ทั้ง schema แล้วกู้กลับมาได้ครบ 32 ตาราง):

```bash
# 1. หยุดแอปก่อน — ห้ามกู้ทับขณะแอปยังเขียนอยู่ และกัน db push ตอน boot มาแทรก
docker stop production-booking-app

# 2. เอาไฟล์ backup มา (โหลดจากโฟลเดอร์ใน Drive ด้วยมือก็ได้)
#    แล้ว copy เข้าเครื่องที่รัน db
docker cp backup-2026-09-22T165638.sql.gz production-booking-db:/tmp/b.sql.gz

# 3. ล้างแล้วกู้  ⚠️ ขั้นนี้ลบข้อมูลปัจจุบันทิ้งทั้งหมด
docker exec production-booking-db psql -U prod_booking -d production_booking \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker exec production-booking-db sh -c \
  'gunzip -c /tmp/b.sql.gz | psql -U prod_booking -d production_booking'

# 4. ตรวจว่ากลับมาจริง ก่อนเปิดแอป
docker exec production-booking-db psql -U prod_booking -d production_booking -A -F'|' -c \
  "SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema='public') AS tables,
          (SELECT count(*) FROM bookings) AS bookings, (SELECT count(*) FROM users) AS users;"

# 5. ค่อยเปิดแอป (boot จะรัน db push ให้ schema ตรงกับอิมเมจที่รันอยู่)
docker start production-booking-app
```

ทำผ่าน Portainer API ก็ได้ถ้าเข้าเครื่องไม่ได้ — `scratchpad/appexec.py` pattern
(`POST /api/endpoints/2/docker/containers/<name>/exec`)

## ตรวจว่า backup ยังทำงานอยู่จริง

อย่าเชื่อว่ามันทำงานเพราะ env เปิดอยู่ — เช็กว่ามี **ไฟล์** โผล่จริง:

```sql
SELECT key, at, note FROM system_heartbeats WHERE key = 'backup';
```

`note` จะเป็นชื่อไฟล์ + ขนาด เช่น `backup-2026-09-22T165638.sql.gz (1100KB)`
ถ้า `at` เก่ากว่า ~25 ชม. แปลว่า backup หยุดไปแล้ว — **ห้าม deploy จนกว่าจะแก้**
(เคสเทียบเคียง: heartbeat `footage` ค้างมา 84 วันโดยไม่มีใครรู้)

## state file

`~/.probook/deploy-state.json` — ไม่อยู่ในรีโปเพราะเป็นสถานะของเครื่อง/สภาพแวดล้อม
ไม่ใช่ของโค้ด และรีโปนี้เป็น public

```json
{
  "rollback_to": "sha-0ab035f",
  "deploying": "sha-717a8e1",
  "schema_changed": false,
  "backup": { "fileName": "...", "driveFileId": "...", "sizeBytes": 1126400 },
  "at": "2026-09-23T...",
  "history": [ ... 10 รอบล่าสุด ... ]
}
```
