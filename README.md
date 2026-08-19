# THE STANDARD — Production Booking

> ระบบ Booking การผลิต · Production ID auto-generation · Google Calendar sync · Drive footage pipeline · คลังอุปกรณ์ · OT

**Live**: https://probook.xtec9.xyz (self-hosted Docker via Portainer)
**Version**: 1.177.1 · Next.js 14 · 483 tests passing

---

## What it does

Producer กรอก Booking ครั้งเดียว → Coordinator approve → ระบบ generate Production ID, สร้าง Google Calendar event + ส่ง invite ทีมงานทุกคน, สร้างโครงโฟลเดอร์บน Google Drive ให้พร้อมรับ footage → ทีมถ่ายเสร็จก็ดรอปไฟล์ลงโฟลเดอร์ของวันนั้น → background worker ย้าย/รวมไฟล์เข้ากล่องของงาน แล้วติ๊กส่งงานกลับไปที่ชีท

รอบเดียวจบตั้งแต่ "ขอคิว" ถึง "ไฟล์อยู่ในกล่องที่ถูกต้อง" โดยมี worker คอย reconcile ทุกชั้นให้ตรงตลอด

### Booking core

| Feature | Detail |
|---------|--------|
| Booking wizard | 5-step, sticky summary on desktop, bottom action bar on mobile |
| Outlets / Programs | **11 outlets · 155 programs** — dropdown filtered by outlet (`src/lib/data.ts`) |
| Production ID | `[OUT]-[PROG]-[YYMMDD]-[EE]` e.g. `NWS-KYM-260616-01` (v1.109 dropped the `[TYPE]` segment; legacy IDs still parse) |
| Project ID layer | Dropdown (`PP-YY-NNN`) sourced live from Producer Dashboard "All Projects" |
| Status flow | `REQUESTED → ASSIGNED → CONFIRMED → COMPLETED` (+ `CANCELLED`) |
| Load warning (v1.177) | เตือนตอนจองเมื่อ**กล้องหรือคนเต็ม** — 3 pool: กล้อง (9 ตัว, คงที่) · ช่างวิดีโอ · สวิตเชอร์ (สองตัวหลังนับสดจาก roster) · งาน off-site ไม่คืนของทันทีที่ wrap บวกอีก 60 นาที · **advisory เท่านั้น ไม่บล็อกการจอง** |
| Producer self-service | แก้ไข/ขอเลื่อนเวลาเองได้ที่ `/producer` และ `/bookings/[id]/edit` ตอนยัง REQUESTED |
| Week plan (v1.175) | `/admin/week-plan` — export ตารางทั้งสัปดาห์เป็นข้อความ |
| Room / studio schedule | `/admin/room-schedule` — ตารางว่างต่อห้องต่อวัน สำหรับวางแผนกำลังผลิต |
| Calendar Packet | Auto-generated, copy-paste ready for coordinator |

### Google Calendar

| Feature | Detail |
|---------|--------|
| Auto-create on approve | Google Calendar event พร้อม crew เป็น guest (DWD impersonate) |
| Guest auto-reconciler | Worker ทุก 10 นาที patch drift ระหว่าง crew ที่ assign กับ attendee จริง |
| Sync visibility | `calendarSyncStatus` (PENDING / OK / FAILED) ต่อ booking + dry-run guest verification บนหน้า detail |
| Notes on event | Admin notes + freelance contacts เขียนลง event description ตอน assign/re-assign |
| Director auto-flow (v1.143) | AGN-only — เลือก Director → approve แล้วส่ง invite + อีเมลอัตโนมัติ |

### Google Drive footage pipeline

| Feature | Detail |
|---------|--------|
| กล่องของงาน | `<root>/<NN · Outlet>/<program\|category>/<Show · Job (Production ID)>/<CAM-x>/` |
| Landing drop zone | Shared Drive **Production Team** — โฟลเดอร์แบนใบเดียวต่อการถ่าย สร้าง**เฉพาะของพรุ่งนี้** ตอน 19:00 BKK คืนก่อน (`docs/landing-folder-policy.md`) |
| id-first links (v1.114) | booking เก็บ **Drive folder ID** (box / landing / staging / photo) — เปลี่ยนชื่อหรือย้ายโฟลเดอร์แล้ว detect/merge ไม่พัง |
| video-merge | MOVE footage จาก landing เข้ากล่องของงาน · มี whole-folder fast path (ย้ายข้ามไดรฟ์ทั้งก้อน) |
| sound-merge | รวมไฟล์เสียงเข้า `AUDIO` ของกล่องนั้น |
| folder-integrity (v1.151) | เช็ก+ซ่อมโครงโฟลเดอร์ทุกชั่วโมง — **สร้าง/เปลี่ยนชื่อเท่านั้น ไม่เคยลบ** |
| `_SHOOT` marker | ไฟล์ marker ในโฟลเดอร์ ใช้จับคู่โฟลเดอร์กับ booking แบบทนการเปลี่ยนชื่อ |
| Delivery tick (v1.162) | กด "ส่งงาน" แล้วติ๊กชีท footage log ให้อัตโนมัติ (จับคู่ด้วย Production ID / box id) |
| Upload | `/upload` — log ไฟล์ตาม Production ID + camera slot ตรงเข้า Google Shared Drive (Drive-only ตั้งแต่ v1.130) |
| เอกสารการเงิน | `DRIVE_DOCS_ROOT` แยก 4 หมวด — `เช่า (Rentals)` · `จัดซื้อ (Purchases)` · `ซ่อม (Repairs)` · `ยืม-คืน (Loans)` · เช่า/จัดซื้อ ซ้อนอีกชั้นตามเดือน (`<YYYY-MM>/<งาน>/`) และเก็บ folder id ไว้กับ record จึงไม่ย้ายตามการแก้ข้อมูลทีหลัง |

> **ไม่มีการลบถาวรใน codebase นี้** — ทุกการลบไปที่ Shared-Drive trash (กู้ได้ ~30 วัน) และต้อง fresh-read เป้าหมายก่อนลงมือเสมอ

### Production Space — คลังอุปกรณ์

`/admin/production-space` เป็นหน้ารวมของโดเมนอุปกรณ์ทั้งหมด

| Module | หน้า |
|--------|------|
| Equipment | `/admin/equipment` — ทะเบียนอุปกรณ์ + ประกันใกล้หมด |
| Loans · ยืม-คืน | `/admin/loans` |
| Repairs · ซ่อม | `/admin/repairs` |
| Rentals · เช่าเข้า (v1.122) | `/admin/rentals` — ตัวติดตามเอกสาร 5 ช่องต่อ booking จัดกลุ่มตามเดือน |
| Purchases · จัดซื้อ | `/admin/purchases` — สั่งซื้อรายเดือน + อนุมัติ |
| Vendors | `/admin/vendors` |
| ราคาเช่า | `/admin/vendor-prices` — เปรียบเทียบราคาข้าม vendor |
| Reminders | `/admin/reminders` — แจ้งเตือนของค้าง |

### People, permissions & OT

| Feature | Detail |
|---------|--------|
| Role tiers | DB roles 5 ชั้น: `USER / COORDINATOR / MANAGER / SUPPORT / ADMIN` |
| UI tiers (v1.90) | `src/lib/tiers.ts` ยุบ (role × position) เป็น 5 tier — `admin · coordinator · sound-mgmt · producer · crew` · **ใช้ที่เดียวทั้ง Nav และ middleware** เมนูกับสิทธิ์จึงเพี้ยนกันไม่ได้ |
| Team roster | `/admin/team` — crew CRUD |
| Permissions | `/admin/permissions` — เพิ่ม Producer/Co-producer ได้โดยไม่ต้อง deploy |
| OT | `/ot` self-service (HOLIDAY / OVERTIME) → `/ot/admin` manager sign-off · ลายเซ็นดิจิทัลที่ `/profile/signature`, export PDF |

### Feedback, review & observability

| Feature | Detail |
|---------|--------|
| Feedback queue (v1.166) | `/feedback` (ของฉัน) · `/admin/feedback` (คิวรวม, FB-###) |
| Post-shoot peer review | แบบประเมินไม่ระบุชื่อผ่าน token link (`/review/[token]`) · เนื้อหาอ่านได้เฉพาะผู้จัดการ 3 คน (บังคับฝั่งเซิร์ฟเวอร์) · มีปุ่มสร้างฟอร์มตัวอย่างส่งเข้าอินบ็อกซ์ตัวเอง |
| ศูนย์ติดตาม (v1.170) | `/admin/monitor` — KPI: งานไหนถึงคิวส่ง · ส่งออกไปหรือยัง · ใครตอบแล้ว · อะไรค้าง |
| Health | `/admin/health` — runtime config + live checks (DB, Calendar DWD, Sheets read/write) |
| Dead-man switches (v1.172) | worker ทั้ง 12 ตัวเขียน heartbeat · `/api/health-summary` เตือนเมื่อ tick หายเกิน interval + 2 ชม. |
| Audit log | ทุก mutation ลง `AuditLog` · booking history กรองแบบ fail-closed ก่อนโชว์ |
| MCP server (v1.49) | `POST /api/mcp` — สั่งงานด้วยภาษาคนจาก Claude/MCP client: `list_bookings` · `get_booking` · `list_outlets_and_programs` · `list_projects` · `list_project_episodes` · `create_booking` · `cancel_booking` (ดู `docs/mcp.md`) |

## ID Layers

ระบบมี **สาม** ชั้น ID แต่ละชั้นมีเจ้าของคนละที่:

| Layer | Owner | Format | Example |
|-------|-------|--------|---------|
| **Project ID** | Producer Dashboard | `PP-YY-NNN` | `PP-26-008` |
| **Episode ID** (Director) | Producer Dashboard | `{Project}-{Type}{NN}` | `PP-26-008-L01` |
| **Production ID** (this app) | Production Booking | `OUT-PROG-YYMMDD-EE` | `NWS-KYM-260616-01` |

ตอน Producer สร้าง booking จะเลือก **Project ID** จาก dropdown (ดึงสดจากชีท Producer Dashboard) → Production ID ที่แอปนี้ generate จึงย้อนกลับไปหา Project ต้นทางได้

### Production ID rules

```
NWS  -  KYM  -  260616  -  01
 │        │        │        │
OUT     PROG    YYMMDD   Sequence
```

1. **Immutable** — ไม่เปลี่ยนชื่อหลังสร้าง (มีปุ่ม Regenerate สำหรับกรณีพิเศษ + บันทึก audit)
2. **Folder-only** — ID อยู่บนชื่อโฟลเดอร์เท่านั้น ไฟล์คงชื่อจากกล้อง
3. Sequence รีเซ็ตต่อวันถ่าย ต่อ outlet+program

## Pages

43 หน้า — เมนูซ่อน/แสดงตาม tier แต่**ตัวจริงคือ gate ฝั่งเซิร์ฟเวอร์** (พิมพ์ URL เข้ามาก็โดน 403/redirect)

### ทุกคนที่ล็อกอิน

| URL | Description |
|-----|-------------|
| `/` | Overview home — KPI cards |
| `/login` | Google sign-in (`@thestandard.co` เท่านั้น) |
| `/new` | Booking wizard (5 steps) |
| `/booking/success` | Confirmation + IDs + Calendar Packet |
| `/calendar` | Month view + agenda drawer |
| `/my-bookings` | Inbox-style tabs ของคนที่ล็อกอิน |
| `/bookings/[id]/edit` | Producer แก้งานของตัวเองตอนยัง REQUESTED |
| `/dashboard/[id]` | Booking detail (read) |
| `/upload` | Footage upload — log ไฟล์ตาม Production ID + camera |
| `/ot` | OT self-service |
| `/profile/signature` | ลายเซ็นดิจิทัลสำหรับใบ OT |
| `/feedback` | เรื่องที่ฉันแจ้งไว้ |
| `/review/[token]` | แบบประเมินหลังงาน (token-only ไม่เชื่อ session) |
| `/manual` · `/changelog` | คู่มือ · อัปเดต |

### Producer

| URL | Description |
|-----|-------------|
| `/producer` | Per-producer dashboard — ขอแก้/ขอเลื่อนเวลา |
| `/dashboard` | Charts + team workload + CSV export + Sheet Data Monitor |

### Console (คิวงาน)

| URL | Description |
|-----|-------------|
| `/admin` | Admin Console — REQUESTED / Confirmed / Completed / Cancelled, bulk approve |
| `/admin/[id]` | Booking detail — edit, approve, assign, re-sync calendar |
| `/admin/upload-review` | คิว Mark-as-Done ของไฟล์ที่อัปโหลด |
| `/admin/workspace` | รายงาน |
| `/admin/routine` | Routine planner (component เดียวกับโหมด Routine ใน `/new`) |
| `/admin/room-schedule` | ห้อง/สตูดิโอ |
| `/admin/monitor` | 📊 ศูนย์ติดตาม |
| `/admin/feedback` | Feedback จากทีม |
| `/admin/reviews` | ผลประเมินหลังงาน (จำกัด 3 คน) |
| `/ot/admin` · `/ot/admin/review/[email]` | OT approval |

### Admin hub

| URL | Description |
|-----|-------------|
| `/admin/production-space` | หน้ารวมคลังอุปกรณ์ |
| `/admin/equipment` · `/loans` · `/repairs` · `/rentals` · `/purchases` · `/vendors` · `/vendor-prices` | โมดูลอุปกรณ์ (ดูตารางด้านบน) |
| `/admin/week-plan` | แผนทั้งสัปดาห์ + export |
| `/admin/team` | Crew roster CRUD |
| `/admin/permissions` | Role management |
| `/admin/reminders` | Reminder engine |
| `/admin/footage-tools` | รวม/ย้าย footage ทั้งระบบ |
| `/admin/health` | Runtime config + live health checks + Danger Zone |

> `/booking/[outlet]` เป็นฟอร์มเก่าที่ไม่มีลิงก์จากที่ไหนแล้ว และไม่ได้รับ improvement รอบหลัง ๆ — ดู "Known follow-ups" ใน `docs/ops-log.md`

## Background workers

12 ตัว supervise อยู่ใน container โดย `start.sh` ทุกตัวเป็น **นาฬิกาปลุกล้วน ๆ** — ไม่แตะ Postgres หรือ Drive เอง แค่ยิง HTTP ไป `/api/internal/...` พร้อม shared secret (ยกเว้น `backup` ที่ต้องใช้ DB จริง) ย้าย worker ออกไปอีก container จึงเท่ากับ "เปลี่ยนปลายทาง + แจก secret" ตั้ง `APP_ROLE=worker` + `WORKER_APP_URL` (ดู `docs/worker-service-split.md`)

| Worker | Script | Default interval | Default state |
|--------|--------|------------------|---------------|
| Calendar reconcile | `calendar-reconcile-worker.js` | 10 min | ON เสมอ |
| Prep folders | `prep-folders-worker.js` | 1 h | ON |
| Folder integrity | `folder-integrity-worker.js` | 1 h | ON |
| Sound merge | `sound-merge-worker.js` | 1 h | ON |
| Video merge | `video-merge-worker.js` | 6 h fallback (NAS sync-gated) | ON |
| Landing drop folders | `landing-worker.js` | 24 h @ 19:00 BKK | ON |
| Footage sheet sync | `footage-sheet-sync-worker.js` | 10 min | OFF |
| Footage ready notify | `footage-ready-worker.js` | 30 min | OFF |
| Reminders | `reminders-worker.js` | 24 h | OFF |
| DB backup | `backup-worker.js` | 24 h | OFF |
| `_SHOOT` marker reconcile | `shoot-marker-worker.js` | 24 h | OFF |
| Post-shoot review invites | `shoot-review-worker.js` | 24 h | OFF |

> **"Default state" คือค่าใน compose ไม่ใช่ค่าที่ prod ใช้จริง** — `${VAR:-0}` บอกได้แค่ค่าตั้งต้น ต้องอ่าน env ของ stack (หรือ `/admin/health`) ถึงจะรู้ว่าตัวไหนเปิดอยู่จริง `RUN_WORKERS=0` ปิดทุกตัวใน container นั้น

## Local Development

```bash
# 1. Copy env
cp .env.example .env
# แก้ DATABASE_URL (+ Google OAuth, Sheets, Calendar, Drive credentials)

# 2. Install + setup DB
npm install
npx prisma db push
npx tsx prisma/seed.ts

# 3. Run
npm run dev
```

เปิด http://localhost:3000

```bash
npm test          # 483 tests — node:test ผ่าน tsx (npm run build เรียกให้เองก่อน build)
npm run db:studio # Prisma Studio
```

ดู [docs/architecture.md](docs/architecture.md) สำหรับ code map + lifecycle diagram

## Production deploy (Portainer)

Push เข้า `main` → GHA workflow `.github/workflows/docker-build.yml` build + push ขึ้น GHCR ด้วย tag `sha-<short>`, `<branch>`, `latest` (main เท่านั้น) · `ci.yml` รัน lint + `npm run build` บนทุก PR (build เรียก `npm test` ให้เองก่อน)

จากนั้นใน Portainer stack `production-booking` (id **125**):

1. แก้ env `IMAGE_TAG` เป็น `sha-<short>` ใหม่ → **Save settings**
2. กด **Pull and redeploy** (เปิด "Re-pull image")
3. `start.sh` ทำงานตอน container ขึ้น — prisma db push, backfill SQL, seed, ปลุก worker supervisor แล้ว `npm start`

Stack endpoint: `http://thestandard.fortiddns.com:9000` (id 2)

```bash
# Local dev ด้วย compose ชุด production
cp .env.production .env
docker compose up -d
```

| Compose file | Services | ใช้ตอนไหน |
|---|---|---|
| `docker-compose.yml` | `db` · `app` (`APP_PORT:-3000`→3000) · `nginx` (`NGINX_PORT:-80`) | dev/self-host แบบมี nginx ในตัว |
| `docker-compose.portainer.yml` | `db` · `app` (`APP_PORT:-3001`→3000) · `worker` | **prod stack 125** — ออกทาง nginx-proxy-manager (`npm-network`) |
| `docker-compose.staging.yml` | `db-staging` · `app-staging` | stack staging |

service `worker` มี `profiles: ["workers"]` จึง**ไม่ขึ้นโดย default** — เปิดด้วย `--profile workers` (หรือเพิ่ม `workers` ใน profiles ของ stack) และ**ต้องตั้ง `RUN_WORKERS=0` ที่ service `app` พร้อมกัน** ไม่งั้นทุกงานรันซ้ำสองรอบ · worker คุยกับแอปผ่าน `http://app:3000` ในเน็ตเวิร์ก ไม่ผ่าน public URL (reverse proxy ตัดที่ ~60 วิ = 504 ที่เจอประจำ)

Base image: `node:20-alpine`

ดู [docs/ops-log.md](docs/ops-log.md) สำหรับ deploy journal และ [docs/runbook-ghcr-pull-denied.md](docs/runbook-ghcr-pull-denied.md) เมื่อ pull image ไม่ผ่าน

### Staging

stack คู่ขนาน — image เดียวกัน, DB แยก, **Drive แยก**, อีเมล sandbox (compose path `docker-compose.staging.yml`) กันพลาด 2 ชั้นแบบ fail-closed: compose บังคับ drive root ทั้ง 3 ด้วย `:?` และเมื่อ `APP_ENV=staging` โค้ดจะ **ปฏิเสธทำงาน** ถ้า root ตัวไหนเป็น id ของไดรฟ์จริง · อีเมลทุกฉบับเด้งไปที่ `REMINDER_ADMIN_EMAIL` พร้อมหัวเรื่อง `[STAGING]` · Calendar + Sheets ตายสนิทจนกว่าจะ opt-in

ขั้นตอนตั้งค่า: [docs/staging-setup.md](docs/staging-setup.md)

### Runbooks

- [docs/runbook-impersonate-swap.md](docs/runbook-impersonate-swap.md) — เปลี่ยนคน DWD impersonate (เมื่อมีคนออกจาก Workspace)
- [docs/runbook-sheet-swap.md](docs/runbook-sheet-swap.md) — ชี้ไปชีท Producer Dashboard ใบอื่น (sandbox ↔ prod)
- [docs/runbook-backup.md](docs/runbook-backup.md) — Postgres backup + restore
- [docs/runbook-ghcr-pull-denied.md](docs/runbook-ghcr-pull-denied.md) — GHCR pull ถูกปฏิเสธ
- [docs/landing-folder-policy.md](docs/landing-folder-policy.md) — กติกาโฟลเดอร์ drop zone
- [docs/worker-service-split.md](docs/worker-service-split.md) — แยก worker ออกเป็น service ของตัวเอง

## Email delivery

Prod ส่งผ่าน SMTP (ดู env ของ stack) · แอปยังส่งผ่านบัญชี Google ของแอดมินที่ล็อกอินอยู่ด้วย Gmail HTTPS API ได้ (ใช้ได้ในที่ที่ outbound SMTP ถูกบล็อก) — แอดมินต้อง sign out + sign in ใหม่หนึ่งครั้งหลัง deploy สด เพื่อให้สิทธิ์ Gmail send

รองรับ provider แบบ HTTP ด้วย (`resend`, `sendgrid`) ดู `.env.example`

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14.2 · TypeScript · App Router |
| Database | PostgreSQL 16 · Prisma 5 (27 models · ยังใช้ `prisma db push` ไม่ใช่ migrations) |
| Auth | NextAuth · Google OAuth (จำกัดโดเมน `@thestandard.co`) |
| Google APIs | `googleapis` — Sheets + Calendar + Drive · DWD impersonate |
| Styling | Tailwind CSS (internal-tool dense layout) |
| Charts · Icons | Recharts · Lucide React |
| PDF | `pdf-lib` + `@pdf-lib/fontkit` (ใบ OT + ลายเซ็น) |
| Email | `nodemailer` (SMTP) · Gmail HTTPS API · Resend / SendGrid |
| Tests | `node:test` ผ่าน `tsx` — **483 ผ่าน** (`npm test` รันอัตโนมัติก่อน build) |
| Container | Docker (`node:20-alpine`) · docker-compose · Nginx |
| Hosting | Self-hosted Docker via Portainer (https://probook.xtec9.xyz) |

## Outlets & Programs

| Code | Name | คำอธิบาย | Programs |
|------|------|----------|----------|
| NWS | News | ข่าว | 16 |
| WLT | Wealth | การเงิน การลงทุน | 13 |
| SPT | Sport | กีฬา | 12 |
| POP | POP | บันเทิง ไลฟ์สไตล์ป๊อป | 16 |
| POD | Podcast | รายการ Podcast | 13 |
| KND | KND (คำนี้ดี) | ภาษาอังกฤษและเนื้อหาการเรียนรู้ | 16 |
| LIF | LIFE | ไลฟ์สไตล์ สุขภาพ ธรรมชาติ | 14 |
| TSS | The Secret Sauce | ธุรกิจ ผู้บริหาร | 25 |
| AGN | Content Agency | งานลูกค้า / Agency | 10 |
| EVT | Event | ทีม Event / Forum | 11 |
| PM | PM | Project Management Office | 9 |
| | | **รวม** | **155** |

master list อยู่ใน `src/lib/data.ts` แล้ว seed ลง Postgres ตอน container ขึ้น

## Roadmap

### Robustness plan — 4 ข้อ

- ✅ **Drive test harness** — `FakeDrive` (`src/lib/__tests__/helpers/fake-drive.ts`) ทำให้ Drive logic เทสต์ได้จริง
- ✅ **id-first Drive links** — booking เก็บ folder id (v1.114 → ปิดงาน v1.157) เปลี่ยนชื่อ/ย้ายโฟลเดอร์แล้วไม่พัง
- ✅ **Staging environment** — stack คู่ขนาน fail-closed (v1.159)
- 🚧 **Reconciler** — ยุบ ~10 Drive sweep เหลือ pass เดียวต่อ booking · design ผ่าน adversarial review แล้ว ([docs/reconciler-design.md](docs/reconciler-design.md)) · ฐานลงแล้ว: lease + 19 invariant guards (v1.167), DriveView listing cache (v1.171) · **ยังไม่มีอะไรเรียกใช้ — เหลือแค่ implementation**

### เปิดอยู่

- [ ] Prisma migrations จริง (แทน `prisma db push --accept-data-loss`)
- [ ] Sentry / structured logging
- [ ] Multi-tenant DWD config (เลิก hardcode fallback)
- [ ] Bulk + resumable footage upload
- [ ] Proxy workflow & MAM-native search
- [ ] จัดการฟอร์มเก่า `/booking/[outlet]` (ลบหรือ redirect)

---

See [CHANGELOG.md](CHANGELOG.md) for the full version history.
