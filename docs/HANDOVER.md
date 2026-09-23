# HANDOVER — Production Booking (probook)

> เอกสารตั้งต้นสำหรับ **คนใหม่ หรือ AI session ใหม่ที่ไม่มีความจำอะไรเลย**
> เขียน 2026-09-23 · prod = **v1.233.1** · repo นี้ **public บน GitHub** — อย่าเขียน secret ลงที่ไหนในนี้
>
> อ่านหน้านี้จบแล้วจะรู้ว่า "ไปอ่านต่อที่ไหน" ไม่ใช่ "รู้ทุกอย่าง" — หน้านี้เป็นแผนที่ ไม่ใช่คลัง

---

## 1. นี่คืออะไร

ระบบจองคิวถ่ายวิดีโอภายในของ THE STANDARD · Producer กรอกใบจอง → Coordinator อนุมัติ → ระบบออก Production ID, สร้าง Google Calendar event พร้อม invite ทีมงาน, สร้างโครงโฟลเดอร์บน Google Drive รอรับ footage → ทีมถ่ายเสร็จดรอปไฟล์ → background worker ย้าย/รวมไฟล์เข้ากล่องของงานแล้วติ๊กส่งงานกลับชีท

คนใช้: **Producer** (จองงานของตัวเอง) · **Coordinator/Admin** (คิวงาน อนุมัติ จัดคน) · **ทีมถ่าย/ตัดต่อ** (ดูตาราง ดรอปไฟล์ กรอก OT) · ~27 คนที่ใช้ประจำ ผลิตใบจองหลักร้อยใบต่อไตรมาส · ระบบเดียวกันนี้ยังกินงานคลังอุปกรณ์ · เช่า/จัดซื้อ/ซ่อม · OT · จองห้องกลาง (~98% ของการจองห้องทั้งบริษัทตอนนี้มาจากที่นี่) ด้วย

**Scale จริง ณ วันนี้** (นับเองจาก repo — ตัวเลขใน `architecture.md` ค้างอยู่ที่ v1.177.1 เชื่อไม่ได้):

| | จำนวน |
|---|---|
| หน้า (`src/app/**/page.tsx`) | **45** |
| API routes (`src/app/api/**/route.ts`) | **156** — admin 66 · internal 29 · bookings 16 · ot 8 · upload 7 · ที่เหลือกระจาย |
| Supervised workers (`scripts/*-worker.js`) | **15** |
| Prisma models | **32** (ยังไม่มี `prisma/migrations/` เลย — ดูข้อ 6) |
| โมดูลใน `src/lib` | **133** ไฟล์ `.ts` ชั้นบน |
| เทส | **900 ผ่าน** ใน 99 ไฟล์ (`npm test`, รันจริง 2026-09-23) |
| MCP tools | **14** (`src/lib/mcp/tools.ts`) |
| Outlets × Programs | 11 × 155 (hardcode ใน `src/lib/data.ts` แล้ว seed ทุก boot) |

Stack: Next.js 14.2 App Router · TypeScript · Prisma 5 → Postgres 16 · NextAuth (Google OAuth จำกัด `@thestandard.co`) · `googleapis` (Sheets + Calendar + Drive, DWD impersonate) · Tailwind · container `node:20-alpine`

---

## 2. อ่านอะไรก่อน ตามลำดับนี้

`docs/` มี 15 ไฟล์และไม่เคยมีสารบัญ — นั่นคือเหตุผลที่หน้านี้มีอยู่

**รอบแรก (จำเป็นทุกคน, ~40 นาที)**

1. **`README.md`** (ราก, 332 บรรทัด) — ฟีเจอร์ทั้งหมด, ตารางหน้า, ตาราง worker, ID 3 ชั้น (Project ID / Episode ID / Production ID) · อ่านเพื่อรู้ว่า "ระบบทำอะไรได้บ้าง"
2. **`docs/architecture.md`** (312 บรรทัด) — mental model ที่ดีที่สุดที่มี: lifecycle diagram 11 ขั้น, code map, auth model, **ตารางวินิจฉัยเวลาอะไรพัง**, safety contract ของโค้ด Drive
   ⚠️ **ปรับปรุงล่าสุด v1.177.1 = ค้างมา 56 เวอร์ชัน** ตัวเลขทุกตัวในนั้นต่ำกว่าจริง (43 หน้า/133 routes/12 workers/27 models/483 tests) และตาราง worker ขาดไป 3 ตัว · **โครงสร้างยังจริง ตัวเลขไม่จริง** — ใช้ตารางข้อ 1 ข้างบนแทน
3. **`CHANGELOG.md`** (8,138 บรรทัด) — อ่านแค่ส่วน `[Unreleased]` + 3-4 release ล่าสุดก็พอ · แต่ละรายการเขียนว่า *ทำไม* ถึงแก้ ไม่ใช่แค่แก้อะไร
4. **`docs/ops-log.md`** (3,366 บรรทัด, ใหม่สุดอยู่บน) — journal ของเหตุการณ์จริงบน prod · **อ่าน 200 บรรทัดแรกก่อนแตะอะไรก็ตาม** มันคือรายการของกับดักที่เพิ่งเหยียบไปสด ๆ

**เปิดเมื่อจะทำเรื่องนั้นจริง ๆ**

| ไฟล์ | เปิดเมื่อ |
|---|---|
| `docs/runbook-deploy-rollback.md` | **ก่อน deploy ทุกครั้ง** — ขั้นตอน 5 ข้อ + วิธีกู้ DB จาก backup (ทดสอบจริงแล้ว drop ทั้ง schema แล้วกู้กลับครบ 32 ตาราง) |
| `docs/runbook-backup.md` | backup ทำงานอยู่ไหม / จะ restore |
| `docs/staging-setup.md` | จะทดสอบของเสี่ยงก่อนขึ้น prod · มี **กฎห้าม restore DB prod เข้า staging** อยู่ท้ายไฟล์ ต้องอ่าน |
| `docs/landing-folder-policy.md` | แตะโค้ด landing/drop folder · กติกา "สร้างเฉพาะของพรุ่งนี้" กับ no-delete zone อยู่ที่นี่ |
| `docs/worker-service-split.md` | จะย้าย worker ออกไป container/host อื่น (`APP_ROLE`) |
| `docs/reconciler-design.md` | จะแตะงานยุบ Drive sweep เป็น pass เดียว — **design เท่านั้น ยังไม่มีใครเรียกใช้** |
| `docs/room-booking-integration-plan.md` | งานเชื่อมระบบจองห้องของ IT · **อ่าน §12 ก่อน §1** (ของเก่าล้าสมัยแล้ว) |
| `docs/mcp.md` | ต่อ AI client เข้า `/api/mcp` |
| `docs/runbook-impersonate-swap.md` | คนที่ระบบ DWD impersonate ลาออก/ย้าย |
| `docs/runbook-sheet-swap.md` | ชี้ไปชีท Producer Dashboard ใบอื่น |
| `docs/runbook-ghcr-pull-denied.md` | Portainer ดึงอิมเมจไม่ได้ `denied: denied` |
| `docs/runbook-lark-export.md` | คลังข้อมูลรายวันบน Lark (ของที่ระบบจะลบทิ้ง) |
| `docs/gha-smoke-test.yml.proposed` | workflow ที่เสนอไว้ ยังไม่ได้เปิดใช้ |
| `USER_MANUAL_TH.md` | คู่มือของ**ผู้ใช้จริง** — อ่านเมื่ออยากรู้ว่าทีมคาดหวังอะไรจากหน้าจอ |
| `PORTAINER_DEPLOY.md` | ขั้นตอน deploy แบบมือ (ไม่ใช้สคริปต์) |
| `CLAUDE.local.md` | **ไม่ commit** (gitignore บรรทัด 51) — ค่าเฉพาะเครื่อง/ช่องแจ้งเตือน/อะไรที่พูดในที่สาธารณะไม่ได้ |

---

## 3. ของจริงรันอยู่ยังไง

- **URL**: `https://probook.xtec9.xyz` · หลัง nginx-proxy-manager (`npm-network`)
- **Portainer**: `http://thestandard.fortiddns.com:9000` · endpoint id **2** · **stack 125** (`production-booking`) · compose path `docker-compose.portainer.yml`
- **Image**: `ghcr.io/narasitk77/thestandard-production-booking:${IMAGE_TAG}` — **pin ด้วย `sha-<short>` เสมอ ไม่ใช่ `latest`** เพราะ `latest` ทำให้ "รันอยู่เวอร์ชันอะไร" ตอบไม่ได้ และถอยกลับไม่ได้ · `IMAGE_TAG` เป็น env ของ stack แก้ที่ Portainer แล้ว **Pull and redeploy** (เปิด Re-pull)
- **CI**: push เข้า `main` → 2 workflow (`ci.yml` = lint + build, `docker-build.yml` = build + push GHCR tag `sha-<short>` / `<branch>` / `latest`) · **ต้องดูตัวที่สอง** — เคยมี CI เขียวแต่ Docker build แดงจนไม่มีอิมเมจ 3 ครั้ง (ดูข้อ 6.8)
- **container 2 บทบาท** (`start.sh`, `APP_ROLE`): `web` (default) ทำ schema + seed + worker + Next.js · `worker` ทำแต่ worker (ต้องมี `WORKER_APP_URL` ไม่งั้น FATAL ตั้งใจ) · **มีแค่ web เท่านั้นที่แตะ schema** — สอง container รัน `db push` พร้อมกันบนฐานเดียว = คอลัมน์หาย · ถ้าเปิด service `worker` ต้องตั้ง `RUN_WORKERS=0` ที่ app พร้อมกัน ไม่งั้นทุกงานรันสองรอบ

**15 supervised workers** ทุกตัวเป็น **นาฬิกาปลุกล้วน ๆ**: เช็ค env → นอนรอ → ยิง HTTP ไป `/api/internal/...` พร้อม shared secret · ไม่มีตัวไหนแตะ Postgres หรือ Drive เอง (ยกเว้น `backup` ที่ต้องใช้ `pg_dump`) การย้ายจึงเท่ากับเปลี่ยน URL

`calendar-reconcile` (10 นาที) · `prep-folders` (1 ชม.) · `folder-integrity` (1 ชม.) · `sound-merge` (1 ชม.) · `video-merge` (NAS sync-gated, fallback รายชั่วโมง) · `landing` (19:00 BKK สร้าง + เที่ยง prune) · `footage-integrity` (13:00) · `footage-sheet-sync` (10 นาที) · `footage-ready` (30 นาที) · `reminders` · `backup` · `shoot-marker` (03:10) · `shoot-review` · `room-booking` (1 ชม.) · `lark-export` (23:00)

> **"default state" ในโค้ด/compose ไม่ใช่ค่าที่ prod ใช้จริง** — `${VAR:-0}` บอกได้แค่ค่าตั้งต้น ต้องอ่าน env ของ **stack** หรือ `/admin/health` · เรื่องนี้หลอกไปแล้วสองรอบในวันเดียว (`SHOOT_MARKER_WORKER_ENABLED`)
> ทุก worker เขียน heartbeat ลง `system_heartbeats`; `/api/health-summary` ตอบ 503 เมื่อตัวที่เปิดอยู่เงียบเกิน `interval + 2 ชม.`

**`prisma db push --accept-data-loss` รันทุก boot** (`start.sh` + `npm start`) และโปรเจกต์ **ไม่มี migration history เลย** แปลว่า:

- แก้ `schema.prisma` = สั่ง DROP ทันทีตอน container ขึ้น ไม่มีขั้นให้ทาน
- **ถอยอิมเมจ ≠ ถอย schema** — อิมเมจเก่าจะ push schema เก่าทับ = คอลัมน์ใหม่หายพร้อมข้อมูล (เคสจริง: v1.231 เพิ่ม `director2/3` ถอยกลับ = ผู้กำกับคนที่ 2-3 ของทุกใบหาย)
- ลบค่าออกจาก enum ที่ยังมีแถวค้าง = boot ล้ม (`set -e`) → container วนรีสตาร์ท → **ทั้งบริษัทเข้าเว็บไม่ได้**
- ก่อน `db push` `start.sh` รัน SQL pre-migration มือ ๆ ไว้หลายชุด (rename ค่า enum `Category`, เพิ่มค่า `UploadStatus`/`OTApprovalStatus`, ย้าย `PENDING`→`SUBMITTED`) ทุกชุด idempotent — ถ้าต้องเปลี่ยน enum ให้เขียนแบบเดียวกันเพิ่ม **ก่อน** บรรทัด `db push`

---

## 4. ลงมือทำงานยังไง

### 4.1 Local dev

มี 2 ทาง — ทางที่สองเร็วกว่าและใช้จริงเมื่อ 2026-09-23

**ทาง A — compose ทั้งชุด** (`docker-compose.yml`: db + app + nginx) ใช้เมื่ออยากได้ภาพเหมือน prod

**ทาง B — Postgres เปล่า ๆ ตัวเดียว + `.env.local`** (แนะนำสำหรับงานโค้ด/เทส/ดู UI)

```bash
# Postgres ใช้แล้วทิ้ง พอร์ต 55432 กันชนกับ 5432 ของ compose ที่อาจรันอยู่
docker run -d --name probook-localtest -p 55432:5432 \
  -e POSTGRES_USER=prod_booking -e POSTGRES_PASSWORD='<ตั้งเอง>' \
  -e POSTGRES_DB=production_booking postgres:16-alpine

npx prisma db push && npx tsx prisma/seed.ts && npm run dev
```

`.env.local` (Next.js โหลดทับ `.env`, อยู่ใน gitignore แล้ว) — หัวใจคือ **ตัดขาดจากของจริงทุกเส้น**:

```
DATABASE_URL=postgresql://prod_booking:<ตั้งเอง>@localhost:55432/production_booking
APP_ENV=staging          # ← เปิด staging guard ใน src/lib/app-env.ts
GOOGLE_SERVICE_ACCOUNT_EMAIL=   GOOGLE_PRIVATE_KEY=   GOOGLE_SERVICE_ACCOUNT_JSON=
GOOGLE_SHEETS_ID=   GOOGLE_CALENDAR_ID=   GOOGLE_IMPERSONATE_SUBJECT=
DRIVE_FOOTAGE_ROOT=   DRIVE_PRODUCTION_TEAM_ROOT=   DRIVE_PHOTO_ROOT=
SMTP_HOST=   SMTP_USER=   SMTP_PASS=
ROOM_BOOKING_ENABLED=0
NEXTAUTH_URL=http://localhost:3000   NEXT_PUBLIC_APP_URL=http://localhost:3000
AUTH_DISABLED=1
SEED_ADMIN_EMAIL=<อีเมล @thestandard.co ของคุณ>
```

**ทำไมสองชั้น** — ล้าง credential = สร้าง Google client ไม่ได้เลย (แตะ Drive/ปฏิทิน/ชีท/เมลไม่ได้) และ `APP_ENV=staging` ทำให้ `assertStagingDriveIsolation()` **throw ทันที**ถ้ามีโค้ดไหนพยายามสร้าง Drive client โดยยังชี้ไดรฟ์จริง (id จริงทั้ง 3 ฝังเป็น blocklist ในโค้ด) แทนที่จะไปแตะของจริงเงียบ ๆ · `AUTH_DISABLED=1` + `SEED_ADMIN_EMAIL` ทำให้ล็อกอินข้ามได้แต่ยังได้ **role จริงจาก DB** — ใช้ทดสอบสิทธิ์แบบ "เป็นคนอื่น" ได้ (บั๊กสิทธิ์ที่เจ็บที่สุดมองไม่เห็นจากตาแอดมิน)

### 4.2 เทส

```bash
npm test         # node:test ผ่าน tsx — 900 tests, ~8 วินาที, ไม่ต้องมี DB
npm run build    # ← ด่านจริง = npm test && prisma generate && next build
```

**`npm test` + `tsc --noEmit` ไม่ใช่ด่าน** — ทั้งคู่ไม่อ่าน `package.json` เคยเขียว ๆ ทับไฟล์ที่ truncate เหลือ 0 ไบต์มาแล้ว · `Dockerfile` รัน `npm run build` ข้างในอิมเมจ ฉะนั้น**สิ่งที่ Docker รันคือสิ่งเดียวที่นับ** (และใช้ `npm ci --legacy-peer-deps` — peer ของ next-auth ขอ nodemailer v7 แต่ lockfile มี v6 ถ้ารัน `npm ci` เปล่า ๆ จะล้มโดยที่ Docker ไม่ล้ม)

เทสอยู่ที่ `src/lib/__tests__/` · มี `FakeDrive` harness (`__tests__/helpers/fake-drive.ts`) ทำให้ตรรกะ Drive เทสได้โดยไม่แตะ Google — **ใช้ตัวนี้ อย่า mock googleapis เอง**

### 4.3 Deploy / rollback

```bash
python3 scripts/ops/deploy.py <short-sha>    # จด backup + จุดถอย ก่อนแตะ prod
python3 scripts/ops/rollback.py              # ถอยไปจุดที่จดไว้
python3 scripts/ops/rollback.py <short-sha>  # ถอยไปเลขที่ระบุ
```

`deploy.py` ทำ 5 อย่างตามลำดับที่ **ห้ามสลับ**: (1) จด `IMAGE_TAG` ปัจจุบันลง `~/.probook/deploy-state.json` (2) เตือนถ้า release นี้แตะ `prisma/schema.prisma` (3) สั่ง backup แล้ว**ยืนยันว่ามีไฟล์จริง** ชื่อ+id+ขนาด>0 ไม่ใช่แค่ HTTP 200 (4) ค่อยเปลี่ยน tag + redeploy (5) ยืนยันครบสาม: `stack env == container image == tag ที่ต้องการ` **และ**แอปตอบ 200

ข้อ 5 สำคัญเพราะคอนเทนเนอร์เก่ายังตอบ HTTP อยู่ระหว่างที่ Portainer ดึงอิมเมจใหม่ — เคยเกือบประกาศว่า deploy แล้วทั้งที่ยังเป็นของเก่า (2026-08-24)

`~/.probook/deploy-state.json` อยู่นอกรีโปโดยตั้งใจ (เป็นสถานะของเครื่อง + รีโปนี้ public)

---

## 5. เข้าถึง prod แบบอ่านอย่างเดียว (ท่าที่ AI ต้องใช้)

ไม่ต้องมี session เบราว์เซอร์ ไม่ต้องเปิดพอร์ต DB — ใช้ docker proxy ของ Portainer

**SQL บน prod**

```
POST /api/endpoints/2/docker/containers/production-booking-db/exec     → ได้ exec id
POST /api/endpoints/2/docker/exec/<id>/start   {"Detach":false,"Tty":true}   → ผลอยู่ใน body
Cmd: psql -U <user> -d <db> -A -F'|' -P pager=off -c "<SQL>"
```

- **`-P pager=off` ห้ามลืม** — `Tty:true` ทำให้ psql คิดว่าอยู่บนเทอร์มินัลแล้วเปิด pager ผลลัพธ์ที่ยาวกว่าจอจะค้างจน call timeout โดยไม่มี output เลย (เสียไปสองรอบ ๆ ละ 2 นาที)
- **ชื่อตารางเป็น snake_case พหูพจน์** (`bookings`, `ot_records`, `audit_logs`) ไม่ใช่ชื่อ Prisma model · **ชื่อคอลัมน์เป็น camelCase ต้องใส่ double quote** (`"bookingCode"`) เพราะ schema ไม่มี `@map` · `audit_logs` ใช้คอลัมน์ `at` ไม่ใช่ `createdAt`
- หาชื่อตารางเร็ว ๆ: `SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%xxx%'`
- credential (Portainer API key, ชื่อ user/db) อยู่ในไฟล์ env เฉพาะเครื่องที่ `scripts/ops/deploy.py` อ่าน — **ไม่อยู่ในรีโปและห้ามเขียนลงรีโป** ดูไฟล์ `CLAUDE.local.md` (ไม่ commit)

**งาน Drive บน prod** — ยิงเข้า container **`production-booking-app`** แทน (`Cmd: ['node','-e', <script>]`, `WorkingDir:'/app'`) เพราะที่นั่นมี service account + DWD + `googleapis` ครบแล้ว

- auth ต้องมี **fallback สองทาง**: `GOOGLE_SERVICE_ACCOUNT_JSON` หรือคู่ `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY` (prod ใช้ทางหลัง — เขียนอ่านแค่ทางแรกจะได้ `FATAL No key or keyFile set.`)
- **ทุก call ต้องมี `supportsAllDrives:true` + `includeItemsFromAllDrives:true`** ไม่งั้นมองไม่เห็น Shared Drive
- ลบ = `files.update({ requestBody:{ trashed:true }})` เท่านั้น **ไม่ใช่ `files.delete`**
- Drive MCP connector ของบัญชีส่วนตัวใช้แทนไม่ได้: มันลบไม่ได้ และไม่คืน `md5Checksum`

**ขอบเขตที่ถือมาตลอด**: SELECT ได้อิสระ · เขียนเมื่อผู้ใช้สั่งเท่านั้น ทำใน `BEGIN…COMMIT` เดียว และ**ต้องแทรกแถว `audit_logs` เอง** (id เป็น `text` ไม่มี default — ใช้ `gen_random_uuid()::text`) ไม่งั้นการแก้จะมองไม่เห็นจากประวัติในแอป

---

## 6. กฎเหล็ก — ผิดข้อไหนคือเสียหายจริง

1. **ห้าม redeploy prod โดยข้ามขั้น backup + จุดถอย** ใช้ `scripts/ops/deploy.py` เสมอ · และก่อน deploy ให้เช็กว่า backup ยังเดินจริง: `SELECT key, at, note FROM system_heartbeats WHERE key='backup'` — ถ้า `at` เก่ากว่า ~25 ชม. **ห้าม deploy จนกว่าจะแก้** (heartbeat `footage` เคยค้าง 84 วันโดยไม่มีใครรู้)
2. **ห้ามลบคอลัมน์ / ห้ามลบค่า enum ที่ยังมีแถวค้าง** — `db push` ทุก boot ทำให้ "ถอด UI ก่อน ค่อยคิดเรื่องตารางทีหลัง" เป็นไปไม่ได้ · ลบค่า enum ที่มีแถว = container วนรีสตาร์ท = ทุกคนเข้าเว็บไม่ได้ · ทางที่คุ้มคือ **ซ่อนทางเข้า ไม่แตะ schema** ได้ผลที่คนใช้เห็น ~90% ด้วยการลบไม่กี่บรรทัด
3. **endpoint ที่แก้ Drive นาน ๆ แล้ว 504 — ห้ามยิงซ้ำ** reverse proxy ตัดที่ ~60 วินาที แต่**งานฝั่งเซิร์ฟเวอร์มักยังวิ่งอยู่และมักสำเร็จ** ยิงซ้ำ = race กันเองจนได้ของซ้ำ · ไปดู audit log หรืออีเมล digest แทน (นี่คือเหตุผลที่ worker คุยกับแอปผ่าน `http://app:3000` ในเน็ตเวิร์ก ไม่ผ่าน public URL)
4. **env บน stack ที่ compose ไม่ได้อ้างถึง = ไม่มีอยู่จริงในคอนเทนเนอร์** เคสจริง `AUTH_SECRET` ถูกตั้งถูกต้องบน stack มาตลอดแต่ compose ไม่เคยส่งเข้าไป → footage-ready 401 เงียบอยู่หลายสัปดาห์ (แก้ที่ v1.213) · มีเทส `compose-env-coverage` คุ้มกันอยู่แล้ว — **เพิ่ม env ใหม่ต้องเพิ่มใน compose ด้วย** และเลี่ยงการสร้าง secret ใหม่ ใช้ `internalSecretAllowed` (รับ secret ตัวไหนก็ได้) แทน chain `A || B || C` ที่เคยทำให้ cron เงียบ 401 ไป 13 วัน
5. **ห้าม restore DB จาก prod เข้า staging เด็ดขาด** — ระบบเป็น id-first แถว booking จริงพก Drive folder id จริงมาด้วย แล้ว worker จะตามไปแก้/ย้ายโฟลเดอร์ **ของจริง** ทันที · การ์ด drive-root validate แค่ env ไม่ได้ validate id รายแถว
6. **ไม่มี permanent delete ใน codebase นี้ และจะไม่มี** ทุกการลบไป Shared-Drive trash (กู้ได้ ~30 วัน) · และ **ห้ามลบจากผลอ่านที่แคชไว้** — `DriveView` แคช listing ทั้ง pass (เป็นนาที) ระหว่างนั้นทีมอัปไฟล์เข้าโฟลเดอร์เก่าจริง ๆ ต้องใช้ `freshFiles`/`freshChildren` เท่านั้นก่อนลบ (`assertNotForDeletion('cached')` throw ให้กฎนี้โผล่ใน diff) · โฟลเดอร์ drop ของ**วันนี้และพรุ่งนี้เป็นเขตห้ามลบแบบไม่มีเงื่อนไข**
7. **"อ่านไม่ได้" ≠ "ไม่มี/ว่าง"** — `r.ok ? r.json() : []` ทำให้งานที่มี 15 ตอนขึ้นว่าไม่มี episode · `.catch(() => null)` ในตัว reconcile ห้องเคยจะล้างเลขจองห้องทิ้งทั้งที่ห้องยังถูกยึดฝั่งเขา · ทุกตัวอ่านต้องแยกสามสถานะ: มี / ไม่มี / **บอกไม่ได้** แล้ว fail-closed
8. **dry-run ต้องเดินโค้ดเส้นเดียวกับของจริง** `if (dryRun) { push; continue }` = preview โกหก — เกิดซ้ำมาแล้ว 3 ครั้ง
9. **เทสที่อ่านไฟล์ในรีโปต้องระวัง `.dockerignore`** มันตัด `.git .github Dockerfile* docker-compose*.yml docs README.md backups .env*` ออกจาก build context · เทสที่อ่านไฟล์พวกนี้ตรง ๆ = **CI เขียว / docker build แดง / ไม่มีอิมเมจให้ deploy** (โดนมาแล้ว v1.204, v1.205, v1.215) · ใช้ `test(name, { skip: 'เหตุผล' }, fn)` ของ node:test ไม่ใช่ `if (!existsSync) return` ที่ผ่านเงียบ ๆ จนไม่มีใครรู้ว่า guard ตายไปแล้ว
10. **มี record ≠ ส่งถึงจริง · heartbeat เต้น ≠ งานสำเร็จ** อีเมล footage-ready เคยถูกบันทึกว่า "ส่งแล้ว 85/85" ทั้งที่ไม่มีใครได้รับเลย 5 สัปดาห์ · liveness กับ outcome ต้องแยกกันเสมอ

---

## 7. ความรู้อยู่ที่ไหน (และอันไหนจะหายไปกับเครื่อง)

ความจริงเชิงปฏิบัติของโปรเจกต์นี้อยู่ **สามที่** และมีที่หนึ่งที่ไม่ติดไปกับรีโป:

| ที่ | ติดไปกับ repo ไหม |
|---|---|
| `docs/` + `README.md` + `CHANGELOG.md` + `USER_MANUAL_TH.md` | ✅ |
| **คอมเมนต์ในโค้ด** — โดยเฉพาะ `src/lib/*.ts` และ `start.sh` คอมเมนต์ที่นี่มักเขียน *อุบัติเหตุที่ทำให้โค้ดบรรทัดนั้นเกิดขึ้น* ไม่ใช่แค่ว่าโค้ดทำอะไร **อ่านคอมเมนต์ก่อนแก้ ไม่ใช่หลังแก้** | ✅ |
| `~/.claude/projects/-Users-narasit-Desktop-Google-Drive-Project/memory/` — **93 ไฟล์ markdown** ที่ AI session ก่อน ๆ เขียนไว้ (`MEMORY.md` เป็นสารบัญ) เป็นบันทึกอุบัติเหตุ กับดัก และเหตุผลของการตัดสินใจที่ละเอียดที่สุดที่มี | ❌ **อยู่บนเครื่อง Mac เครื่องเดียว** |

**ผลที่ตามมา และเป็นกฎ**: ไฟล์ memory ทั้ง 93 ไฟล์ไม่เดินทางไปกับ repo — เครื่องพัง/คนเปลี่ยน/AI session ใหม่บนเครื่องอื่น = ความรู้ก้อนนั้นหายทั้งก้อน **อะไรที่ต้องอยู่ต่อ ต้องย้ายมาอยู่ใน `docs/`** โดยระวังข้อจำกัดข้อเดียว: รีโปนี้ public ฉะนั้นค่าที่พูดในที่สาธารณะไม่ได้ (secret, API key, ปลายทางของบอทแจ้งเตือน, ชื่อ/id ห้องแชท) ให้เขียนว่า *"ดูไฟล์ `CLAUDE.local.md` (ไม่ commit)"* แทนค่าจริง

ถ้าคุณเป็น AI session ใหม่บนเครื่องนี้: เปิด `memory/MEMORY.md` ก่อน มันคือสารบัญของทุกกับดักที่เคยเหยียบ แล้วค่อยกลับมาที่ `docs/ops-log.md`

---

## 8. สิ่งที่รู้อยู่แล้วว่ายังไม่เสร็จ

- **Prisma migrations จริง** — ยังเป็น `db push --accept-data-loss` ทุก boot (ต้นตอของกฎข้อ 6.2 ทั้งข้อ)
- **Reconciler** — ยุบ ~10 Drive sweep เหลือ pass เดียวต่อ booking · design ผ่าน adversarial review แล้ว, `lease`/`guards` (16 ตัว)/`DriveView` ลงแล้ว แต่ **ยังไม่มีอะไรเรียกใช้** และ `reconciler/phases/` ว่างเปล่า
- **Sentry / structured logging** — ยังเป็น `console.log` · `AuditLog` เก็บเหตุการณ์ธุรกิจ ไม่ใช่ error ของแอป
- **Multi-tenant DWD config** — ยัง hardcode fallback ใน `google-calendar.ts` (เห็นเป็นคำเตือนสีเหลืองบน `/admin/health`)
- **Outlets/Programs ยัง seed จาก `src/lib/data.ts`** ทุก boot → เพิ่มรายการ = แก้โค้ด + redeploy
- **`/booking/[outlet]`** — ฟอร์มเก่าที่ไม่มีลิงก์จากที่ไหน และข้าม improvement ทุกรอบหลัง · ควรลบหรือ redirect
- **Bulk + resumable footage upload**, **proxy workflow / MAM-native search** — ยังไม่เริ่ม
