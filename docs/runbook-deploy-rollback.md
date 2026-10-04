# Deploy และการถอยกลับ (rollback)

> เขียนหลังเคส 2026-09-23 ที่นัทสั่งว่า "ก่อน deploy ใหม่ ให้ backup ของเดิมไว้ ถ้าใหม่พังต้องถอยกลับได้"
> ทุกขั้นตอนในเอกสารนี้ **รันจริงแล้ว** ไม่ใช่เขียนจากความเข้าใจ

## ⚠️ อย่าต่อ `| head` / `| grep -m` ท้าย `deploy.py`

`python3 scripts/ops/deploy.py <sha> | head -12` ฆ่าสคริปต์ด้วย SIGPIPE ตอนบรรทัดที่ 12
แล้ว pipeline คืน **exit 0** (โค้ดของ `head`) — อ่านแล้วเหมือน deploy สำเร็จ ทั้งที่
การเฝ้าผลถูกตัดกลางคัน PUT ยิงไปแล้วแต่ไม่มีใครยืนยันว่าลงจริงไหม (เกิดจริง 2026-09-24)

ตั้งแต่ตอนนี้สคริปต์ ignore SIGPIPE และเขียน stdout แบบ "เขียนไม่ได้ก็ไม่ตาย" แล้ว
แต่กฎยังเหมือนเดิม: **ให้มันพิมพ์จนจบ** อยากดูย่อ ๆ ให้เก็บลงไฟล์แล้วค่อย tail
```bash
python3 scripts/ops/deploy.py <sha> > /tmp/deploy.log 2>&1; rc=$?; tail -30 /tmp/deploy.log; echo "exit=$rc"
```

**อ่านผลจาก exit code เสมอ** (v1.252) — `; tail` เปล่า ๆ คืน 0 ของ tail ทับ exit ของสคริปต์:
0 สำเร็จ · 1 ยกเลิก **หรือ Portainer ปฏิเสธ redeploy** (พิมพ์ HTTP code + body + สถานะจริงของ stack — ทั้ง deploy.py และ rollback.py · 502/503/504 ยังเฝ้าต่อเพราะงานอาจเริ่มแล้ว) · 2 ใช้ผิด · 3 ไม่ครบสามชั้นใน 20 นาที · **4 ขึ้นแล้วแต่ schema ไม่ลง** · **5 ปฏิเสธเพราะ schema** (ตัวเลขเดียวกันทั้ง deploy.py และ rollback.py)


## สั่งงาน

```bash
cd "Production Booking"
python3 scripts/ops/deploy.py 717a8e1     # deploy (จด backup + จุดถอยให้เอง)
python3 scripts/ops/rollback.py           # ถอยกลับจุดที่จดไว้
python3 scripts/ops/rollback.py 0ab035f   # ถอยไปเลขที่ระบุเอง
python3 scripts/ops/rollback.py 4a99668 --check   # v1.252 ตรวจอย่างเดียวว่าถอยได้ไหม (ไม่ backup ไม่ยิง)
python3 scripts/ops/deploy.py <sha> --check     # v1.252 ตรวจอย่างเดียวว่าอิมเมจนี้จะทำอะไรกับ DB
```

`deploy.py` ทำ 5 อย่างตามลำดับ และ **ห้ามสลับลำดับ**:

1. จด `IMAGE_TAG` ปัจจุบัน (= จุดที่รู้ว่าดี) ลง `~/.probook/deploy-state.json`
2. **(v1.252) เทียบ schema ปลายทางกับ DB จริง** — จะลบของที่มีข้อมูล = ปฏิเสธก่อนแตะอะไร (ดูหัวข้อกับดักข้างล่าง)
3. สั่ง backup DB แล้ว **ยืนยันว่ามีไฟล์จริง** (ชื่อ + driveFileId + ขนาด > 0) ไม่ใช่แค่ HTTP 200
4. ค่อยเปลี่ยน tag แล้ว redeploy
5. ยืนยันครบสาม: `stack env == container image == tag` **และ** แอปตอบ 200 · (v1.252) ต้องเป็นคอนเทนเนอร์ใหม่จริง (Id) และ `schemaSync` ต้องเป็น `in-sync`/`accepted` ไม่งั้น exit 4

ข้อ 5 สำคัญเพราะคอนเทนเนอร์เก่ายังตอบ HTTP อยู่ระหว่างที่ Portainer ดึงอิมเมจใหม่ —
เคยเกือบประกาศว่า deploy แล้วทั้งที่ยังเป็นของเก่า (2026-08-24)

## ⚠️ กับดัก: ถอยอิมเมจ ไม่ได้ถอย schema (มีด่านแล้วตั้งแต่ v1.252 — อ่านข้อยกเว้น)

คอนเทนเนอร์ push schema **ทุก boot** · อิมเมจที่ schema ไม่มีตาราง/คอลัมน์ที่ DB มี = DROP พร้อมข้อมูล
ตัวอย่างจริง: v1.231 เพิ่ม `director2..3` → ถอยกลับไปก่อนหน้านั้น = ผู้กำกับคนที่ 2-3 ของทุกใบหายหมด

**v1.252 มีสามชั้น:**

| ชั้น | ทำอะไร | กันได้แค่ไหน |
|---|---|---|
| `scripts/schema-sync.js` (ในอิมเมจ) | push แบบไม่ยอมลบ · จะลบข้อมูล = ข้าม + `[schema-guard] run failed:` ใน log · แอปบูตต่อ | เฉพาะอิมเมจ **v1.252 ขึ้นไป** |
| `rollback.py` / `deploy.py` | เทียบ schema ปลายทางกับ **DB จริง** ก่อนยิง · อิมเมจเก่าที่จะลบของที่มีข้อมูล = ปฏิเสธ (exit 5) | ทุกอิมเมจ **ถ้าถอยผ่านสคริปต์** |
| `/api/version` → `schemaSync` | บอกว่ารอบบูตล่าสุด push ลงไหม (`in-sync`/`accepted`/`skipped`/null) | ทำให้ "ขึ้นแล้วแต่ schema ไม่ลง" มองเห็น |

**🔴 ห้ามเปลี่ยน `IMAGE_TAG` เองใน Portainer ไปอิมเมจก่อน v1.252** — ทางนั้นไม่ผ่านสคริปต์ และอิมเมจเก่ายัง
push แบบ `--accept-data-loss` = ลบข้อมูลใหม่ทิ้งเหมือนเดิม · จุดถอยที่จดไว้ใน ops-log เก่า ๆ (เช่น `sha-4fd1d8b`)
**ตรวจก่อนเสมอ:** `python3 scripts/ops/rollback.py <sha> --check`

| ผลของ `--check` | แปลว่า |
|---|---|
| ผ่าน · "ของว่างที่ push จะลบทิ้ง" | ลบแต่ของว่าง ไม่มีข้อมูลเสีย (นับ ณ ตอนตรวจ — backup ใหม่ก่อนยิงเก็บไว้ให้) |
| ผ่าน · อิมเมจมีด่าน · "ด่านจะข้าม push และเก็บของไว้" | ถอยได้ DB เก็บของใหม่ไว้ · `schemaSync=skipped` เป็นเรื่องปกติของการถอย · **อย่าตั้ง SCHEMA_ACCEPT_DATA_LOSS** |
| ปฏิเสธ · อิมเมจเก่าจะลบของที่มีข้อมูล | ทางที่ถูก: revert แล้ว deploy ไปข้างหน้า · หรือเลือกอิมเมจที่ใหม่กว่า · ฝืนได้ด้วย `--allow-schema-drop` + พิมพ์ยืนยันใน terminal (นัทเท่านั้น) |
| ปฏิเสธ · ต้องทั้งลบและเพิ่ม | ด่านข้าม push ทั้งก้อน → โค้ดเก่าไม่ได้คอลัมน์ของมัน · ฝืนไม่ได้ · revert แล้ว deploy ไปข้างหน้า |

**release ที่ตั้งใจลบคอลัมน์/ตาราง/ค่า enum** (ต้องได้คำอนุญาตจากนัทก่อนทุกครั้ง):
1. release แรก "เลิกใช้" (โค้ดไม่อ่าน/ไม่เขียนแล้ว แต่ schema ยังมี) · release ถัดไปมี **แต่การลบ**
   — เพราะ push เป็น all-or-nothing: ถ้าด่านข้าม ของที่ release เดียวกันต้องเพิ่มก็ไม่ลงด้วย
2. `deploy.py <sha> --check` → มันพิมพ์รายชื่อที่ต้องใส่ เช่น `--set SCHEMA_ACCEPT_DATA_LOSS='table:purchase_items column:uploads.wasabiKey'`
3. รันด้วย `--set` นั้นในเทอร์มินัล พิมพ์ยืนยันเอง · ค่านี้ถูกล้างทิ้งในรอบ deploy/rollback ถัดไปอัตโนมัติ
4. เปลี่ยนชนิดคอลัมน์ที่มีข้อมูล: ไม่มีทาง opt-in ผ่าน env — ทำด้วย SQL ก่อน push ใน start.sh แบบเดียวกับ enum rename

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
