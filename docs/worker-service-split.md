# แยก worker ออกเป็น service ของตัวเอง (v1.168)

เตรียมไว้สำหรับย้าย worker ไป workspace/โครงสร้างพื้นฐานอื่น **ยังไม่เปิดใช้** —
ค่า default ทุกตัวเท่าเดิม deploy ปกติไม่มีอะไรเปลี่ยน

## ทำไมมันง่ายกว่าที่คิด

worker ทั้ง 12 ตัวเป็น **นาฬิกาปลุกล้วนๆ** ไม่มีตัวไหนแตะ Postgres หรือ Google Drive เลย
แต่ละตัวทำแค่: เช็ค env → นอนรอถึงเวลา → ยิง HTTP ไป `/api/internal/...` พร้อม secret

ดังนั้นการย้ายคือ **เปลี่ยนปลายทาง URL + แจก secret** ไม่ต้องแก้ตรรกะ

**ยกเว้น `backup-worker`** — ตัวนี้ต้องการ `DATABASE_URL` (pg_dump) และสิทธิ์ Drive
ถ้าย้ายออกไปต้องให้ container ใหม่เข้าถึง DB ด้วย มิฉะนั้น**ปล่อยไว้ที่แอป**

## กลไก

`start.sh` มี 2 โหมด (`APP_ROLE`):

| | `web` (default) | `worker` |
|---|---|---|
| รอ Postgres, สร้าง DB, enum migration, seed | ✅ | ❌ ข้ามทั้งหมด |
| `prisma db push` | ✅ | ❌ |
| Next.js | ✅ | ❌ |
| worker supervisors | ตาม `RUN_WORKERS` (default 1) | ✅ เสมอ |
| รออะไรตอน boot | Postgres | `${WORKER_APP_URL}/api/version` |

**กฎเหล็ก: มีเพียง web เท่านั้นที่แตะ schema** — สอง container รัน
`prisma db push --accept-data-loss` พร้อมกันบนฐานเดียว = โอกาสสูญคอลัมน์

`APP_ROLE=worker` ที่ไม่ตั้ง `WORKER_APP_URL` จะ **FATAL ทันที** ไม่ยอมบูต —
เพราะถ้าปล่อยผ่าน worker จะยิงหา `127.0.0.1` คือตัวมันเอง แล้วเงียบไปเฉยๆ

## เปิดใช้ยังไง

```
# 1) ในไฟล์ env ของ stack
RUN_WORKERS=0            # ← สำคัญที่สุด: ปิด worker ในแอป ไม่งั้นทำงานซ้อนกัน

# 2) ขึ้น service worker
docker compose --profile workers up -d
```

บน Portainer: เพิ่ม `workers` เข้าช่อง profiles ของ stack แล้ว redeploy

## ทำไมต้องคุยกันผ่าน `http://app:3000` ไม่ใช่ URL สาธารณะ

reverse proxy ตัดการเชื่อมต่อที่ ~60 วินาที ซึ่งคือ **504 ที่เราเจอประจำ**เวลาสั่ง
endpoint ที่แก้ Drive นานๆ — การคุยกันภายใน compose network ไม่ผ่าน proxy จึงไม่มีเพดานนี้

ถ้าปลายทางอยู่คนละเครื่อง/คนละ workspace จริง ต้องยอมรับข้อจำกัดนี้ หรือเปิดทางเชื่อม
ภายในระหว่างสองฝั่ง (VPN / private network) — **อย่าให้ worker ยิงผ่าน public URL**

## ลำดับที่แนะนำ

1. ขึ้น worker service คู่กับแอปโดย **ยังไม่ปิด `RUN_WORKERS`** แล้วดู log ว่ามันคุยกับแอปได้
   (ตอนนี้จะทำงานซ้อนกันชั่วคราว — pass lease v1.167 กันไม่ให้ชนกันจนพัง แต่เปลืองโควตา)
2. พอเห็นว่าเรียกได้ครบ ตั้ง `RUN_WORKERS=0` แล้ว redeploy แอป
3. ดู `/api/health` ว่า heartbeat ของแต่ละ worker ยังเดินปกติ
4. ค่อยย้าย container ไป workspace ปลายทาง

## ย้อนกลับ

ตั้ง `RUN_WORKERS=1` แล้ว redeploy แอป จากนั้นดับ service `worker` — กลับสภาพเดิมทันที
