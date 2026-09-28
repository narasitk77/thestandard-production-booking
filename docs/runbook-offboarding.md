# Runbook — เมื่อคนออกจากทีม (offboarding)

> เขียน 28 ก.ย. 2569 จากเคส ซัง→หวาน (6 ก.ย.) และเคสแก้ว (TSS Co-Producer, 28 ก.ย.)
> เป้าหมาย: operator คนเดียวทำจบใน ~15 นาที (ไม่นับรอ CI) โดยไม่ลืมอะไร และไม่มี "ผี" ส่งเมล/เชิญปฏิทินหาคนที่ไม่อยู่แล้ว
> **ห้ามเขียน secret / ปลายทางบอท / ชื่อห้องแชตในหน้านี้** (รีโป public)

## เมื่อไหร่ต้องใช้

ทันทีที่รู้ว่าคนหนึ่ง **จะไม่ได้รับอีเมล @thestandard.co อีก** (ลาออก / ย้ายบริษัท / บัญชีถูกระงับ) และเขาอยู่ในระบบอย่างน้อยหนึ่งบทบาท:

| บทบาท | อยู่ที่ไหน | ทำไมต้องจัดการ |
|---|---|---|
| เจ้าของงาน | `bookings.producerEmail` / `coProducerEmail` ของใบที่ยังไม่ถ่าย | ปฏิทิน (`src/lib/calendar-attendees.ts`) และอีเมลทุกเส้น (footage-ready, qu-reminder, review invite) **เลือกผู้รับจากช่องนี้** ไม่ได้ดู `users.active` |
| ทีมงาน/ผู้กำกับ | `assignedEmails`, `directorEmail`/`2`/`3`, `mainVideographerEmail` ของใบอนาคต | เหมือนกัน |
| กฎอัตโนมัติที่ฝังชื่อเขา | `src/lib/outlet-coproducer.ts` (`BUILT_IN_DEFAULT_COPRODUCERS`), `src/lib/vp-assign.ts`, `src/lib/shared-mailboxes.ts`, ค่าตั้งต้นใน `review-access.ts` / `shoot-review.ts` | กฎพวกนี้อ่านจากโค้ด — ปิด active แล้วมันยังเติมชื่อเขาลงใบใหม่ต่อไป (แก้ว: +2 ใบระหว่างรู้ว่าออกจนถึง deploy) |
| ร่างฟอร์มจองที่ค้างในเบราว์เซอร์ของคนอื่น (`localStorage` `booking-draft-v1`) | `BookingWizard.tsx` เก็บ `coProducerSel` ในร่างและคืนค่าตอน resume | ใบใหม่จะพก `coProducerEmail` ของคนที่ออกขึ้นมาได้ — ตั้งแต่ v1.243 server ปฏิเสธ (400) ถ้า Producer/Co-Producer เป็นบัญชีที่ `active=false` ผู้ใช้ต้องเลือกใหม่ |
| บัญชีที่ระบบ impersonate | `GOOGLE_IMPERSONATE_SUBJECT` | ทำ `docs/runbook-impersonate-swap.md` **ก่อน** หน้านี้ |

ไม่ใช่เคสนี้: Google เด้ง `unauthorized_client` เป็นครั้ง ๆ = Google ล่มชั่วคราว ไม่ใช่คนออก

## ข้อมูลที่ต้องถามก่อนเริ่ม (ไม่ครบ อย่าเพิ่งแตะ DB)

1. **อีเมลคนออก** และวันสุดท้ายที่อีเมลยังรับได้
2. **ผู้รับโอน ต่อบทบาท** — Producer **ต้องมีคนรับเสมอ** (ใบไม่มี Producer = ปฏิทินไม่มีแขก) · Co-Producer รับได้ 2 แบบ: คนใหม่ หรือ **ปล่อยว่าง**
3. **ชื่อเล่นของผู้รับโอน — ห้ามเดา** (ชีทและคิวใช้ชื่อเล่นเป็น key) ต้องตรงกับ `users.nickname` หรือค่าที่เคยอยู่ในใบของเขา:
   ```sql
   SELECT nickname, "producerOutlets", active FROM users WHERE lower(email)='<to>';
   SELECT DISTINCT producer FROM bookings WHERE lower("producerEmail")='<to>'
   UNION SELECT DISTINCT "coProducer" FROM bookings WHERE lower("coProducerEmail")='<to>';
   ```
4. **ผู้รับโอนถูกแท็ก outlet นั้นหรือยัง** — ถ้า `producerOutlets` ไม่มี ให้เพิ่มที่ `/admin/permissions` ก่อน (ไม่ต้อง deploy) ไม่งั้นฟอร์มเลือกคนนี้ไม่ได้ทั้งที่อยู่บนใบ
5. **ข้อความที่จะลงใบจอง** — audit `booking.*` **ทุกคนที่ล็อกอินอ่านได้** ในประวัติใบ (`src/lib/booking-history-visibility.ts`) เขียนแค่ "โอนงานจาก X → Y เมื่อวันที่ · ดำเนินการโดย …" เหตุผลส่วนตัวไม่ต้องใส่

เครื่องมือ (`scripts/ops/offboard.py`) บังคับข้อ 2–4 เป็น guard: ตกข้อเดียวหยุดทั้งหมด ไม่แตะอะไร

## ขั้นตอน (เรียงตามลำดับ · ทำข้ามไม่ได้)

### ขั้น 0 — นับรอยเท้า [อ่านอย่างเดียว · 1 นาที]

```bash
python3 scripts/ops/offboard.py --leaver <email> --actor <อีเมลคนสั่ง>
```
ค่าเริ่มต้นคือ dry-run: พิมพ์รอยเท้าทุกคอลัมน์อีเมลใน schema (users, team_members, ใบอนาคตต่อบทบาท, ใบอดีต, createdBy, OT, review invites, ตั๋ว, mix/switcher, purchase, ยืมของ) + รายการใบอนาคตที่จะแตะ แล้วรัน transaction ชุดเดียวกับของจริงจบด้วย `ROLLBACK`

และตรวจนอก DB (เครื่องมือพิมพ์เตือนแต่ไม่ทำให้):
- `grep -rn '<ชื่อผู้ใช้อีเมล>' src scripts docs` → ถ้าโผล่ในไฟล์กฎ (ตารางบน) = ต้องทำขั้น 1
- env ของ stack (Portainer → stack → Environment) ว่ามีอีเมลเขาใน `REVIEW_*_EMAILS`, `SOUND_COORDINATOR_EMAILS`, `INITIAL_ADMIN_EMAILS`, `AUTO_COPRODUCER_*` ไหม
- สคริปต์ cron บนเครื่อง operator (`~/.hermes/scripts/`)

### ขั้น 1 — ถอดชื่อออกจากกฎในโค้ด แล้ว deploy [ทำ **ก่อน** ขั้น 2]

ทำเฉพาะเมื่อขั้น 0 เจอชื่อเขาในไฟล์กฎ · ทำก่อน apply เพราะถ้า apply ก่อน กฎจะเติมชื่อเขากลับเข้าใบใหม่ระหว่างรอ deploy

1. `src/lib/outlet-coproducer.ts` — เอาออกจาก `BUILT_IN_DEFAULT_COPRODUCERS` (หรือเปลี่ยนเป็นคนใหม่ — ต้องเป็นคนเดียวกับ seed ใน `outlet-producers.ts`) · เทส `src/lib/__tests__/outlet-coproducer.test.ts` ทดสอบกลไกผ่าน env ไม่ pin ชื่อคน (v1.242) จึงไม่ต้องแก้ตามชื่อ
2. `vp-assign.ts`, `shared-mailboxes.ts`, ค่าตั้งต้นใน `review-access.ts` / `shoot-review.ts` — ถ้ามี
3. **เก็บแถว seed ไว้:** `src/lib/outlet-producers.ts` และ `team-profiles.ts` / `team-roster.ts` ไม่ต้องลบ — `POST /api/admin/import-producers` เป็น endpoint ที่แอดมินกดเอง ไม่ใช่ตอนบูต และแถวที่มีอยู่แล้วมัน**ไม่แตะ role/active** (`src/app/api/admin/import-producers/route.ts` คอมเมนต์ v1.108) · `prisma/seed.ts` ตอนบูต upsert คนใน `team-profiles.ts` — path `create` ตั้ง `active:true` ฉะนั้น**ลบแถว users ทิ้ง = ถูกสร้างคืนเป็น active** (ดู "สิ่งที่ห้ามทำ")
4. CHANGELOG → CI → `python3 scripts/ops/deploy.py <sha>` (`docs/runbook-deploy-rollback.md`)

ทางลัดถ้า deploy วันนี้ไม่ได้: ตั้ง `AUTO_COPRODUCER=0` บน stack แล้ว **Update the stack** (compose ส่งตัวนี้เข้า container จริง) — หยุดกฎเติม Co-Producer ทั้งระบบทันที · **อย่าใช้ `AUTO_COPRODUCER_<CODE>` แทน** เพราะ compose ไม่ได้ประกาศ key แบบ dynamic ค่านั้นไม่ถึง container · ข้อจำกัด: ฟอร์มจองยังพิมพ์ "ไม่เลือก = ระบบใส่ <ชื่อ> ให้อัตโนมัติ" จนกว่าจะ deploy (client bundle ไม่เห็น env)

### ขั้น 2 — โอนใบอนาคต + ปิดบัญชี [เครื่องมือ · transaction เดียว + audit · 2 นาที]

```bash
# Co-Producer → ว่าง (ไม่มีคนแทน)            
python3 scripts/ops/offboard.py --leaver <email> --actor <me>            # dry-run
python3 scripts/ops/offboard.py --leaver <email> --actor <me> --apply
# โอนให้คนใหม่ (Producer และ/หรือ Co-Producer)
python3 scripts/ops/offboard.py --leaver <email> --to <email> --nick <ชื่อเล่น> --actor <me> --apply
```

ขอบเขตของทุก statement: `deletedAt IS NULL` · status ไม่ใช่ CANCELLED/COMPLETED · `shootDate >=` วันนี้ (BKK)

| ที่เขียน | ค่า | ทำไม |
|---|---|---|
| `bookings.coProducer` + `coProducerEmail` | ผู้รับโอน หรือ NULL | ปฏิทินและ "งานของฉัน" อ่านช่องนี้ · **แอปไม่มี API แก้ช่องนี้** (PATCH รับ `producerEmail` แต่ไม่รับ `coProducer`) จึงต้อง SQL |
| `bookings.producer` + `producerEmail` | ผู้รับโอน (ต้องมี `--to`) — ขอบเขตกว้างกว่า Co-Producer: รวมใบ COMPLETED ที่ถ่ายไม่เกิน **8 วัน** | ความเป็นเจ้าของ · footage-ready (3 วัน) และคำเชิญรีวิวหลังถ่าย (หน้าต่าง วันนี้-8 ถึง วันนี้-1) ยังอ่าน `producerEmail` ของใบที่เพิ่งถ่าย — ใบพวกนั้นยังไม่ใช่ประวัติ |
| `bookings.adminNotes` | ต่อท้ายบรรทัดโอน | เห็นที่ `/admin/[id]`, calendar drawer, workspace (ไม่โผล่ `/dashboard/[id]`) |
| `audit_logs` 1 แถว/ใบ | `booking.update` · `changes={field:{from,to}, offboardRun}` | รูปเดียวกับ PATCH ของแอป — ประวัติใบมีร่องรอย และ `from` ครบพอย้อนได้ |
| `users.active=false` (+ `team_members.active=false` ถ้ามีแถว) | ปิด ไม่ลบ | ปิดล็อกอิน · หายจาก dropdown Producer (`/api/producers` กรอง active) · หายจากตัวจับคู่ backfill |
| `audit_logs` 1 แถว/ตาราง | `user.deactivate` · entityType `User`/`TeamMember` · entityId = อีเมล | รูปเดียวกับเคสซัง · ปุ่ม Disable บน `/admin/permissions` และ `/admin/team` **ไม่เขียน audit** — ถ้าปิดผ่าน UI ต้อง INSERT เอง |

dry-run กับ apply ต่างกันแค่ token สุดท้าย (`ROLLBACK`/`COMMIT`) — จำนวนแถวที่ dry-run พิมพ์คือจำนวนที่ apply จะเขียนจริง · apply แล้วเครื่องมืออ่านปลายทางซ้ำ (post-check) ไม่เชื่อว่า "รันจบ = สำเร็จ"

- ใบที่ถ่าย**วันที่ทำ offboarding** อาจพลิกเป็น COMPLETED ระหว่าง dry-run กับ apply (auto-complete) → จำนวนแถวต่างกันได้ 1–2 ใบ ใบนั้นคงชื่อไว้ตามกฎประวัติ และ event ของมันยังมีเขาเป็นแขก (reconciler ไม่แตะ COMPLETED) — ยอมรับ (เคสแก้ว: TSS-ITV-260928-01)
- **ถ้ามีผู้รับโอน แจ้งเขาก่อน apply** — เขาจะได้คำเชิญปฏิทิน 1 ฉบับ/event ภายใน 10 นาทีหลัง apply (reconciler ใช้ `sendUpdates:'all'` ตายตัว ลดไม่ได้) อย่าให้คำเชิญเป็นข่าวแรกที่เขาได้ยิน

**เครื่องมือตั้งใจไม่แตะ** (พิมพ์เป็น checklist):
- `assignedEmails` / `directorEmail` / `mainVideographerEmail` ใบอนาคต → แก้ที่ `/admin/<id>` มอบหมายทีม เพราะ route นั้น patch แขกปฏิทินในคำขอเดียวกัน
- `createdByEmail` และใบอดีตทุกใบ (ประวัติ)
- Google API ทุกตัว (ปฏิทินให้ reconciler · ชีทมือ)

### ขั้น 3 — ปฏิทิน Google [ตามเอง ≤10 นาที]

- worker `calendar-reconcile` ทุก 10 นาที (`limit=200`) ประกอบแขกใหม่จากช่องบนใบ แล้ว patch เฉพาะใบ **CONFIRMED** → คนเก่าถูกถอด (ได้ใบยกเลิก 1 ฉบับ/event) คนใหม่ได้ invite · ใบ REQUESTED ไม่มี event อยู่แล้ว
- **รอบที่กำลังวิ่งตอน apply จะประทับ `calendarSyncStatus=OK` ด้วยลิสต์แขกเก่าในหน่วยความจำโดยไม่ patch** (พิสูจน์แล้ว 28 ก.ย.: 23 ใบขึ้น OK ที่ 08:50–08:52 UTC ทั้งที่ยังมีแก้ว; รอบถัดไป 09:02 ถึงถอดจริง) → **อย่าใช้ `calendarSyncStatus` หรือ heartbeat ตัดสิน** ตรวจด้วย audit ของการ patch จริง:
  ```sql
  SELECT count(*) FROM audit_logs WHERE action='calendar.reconcile_patched' AND at > '<เวลา apply UTC>' AND changes::text LIKE '%<leaver>%';
  -- ต้องเท่ากับจำนวนใบ CONFIRMED ที่มี event ที่โอน (เครื่องมือพิมพ์ทั้งเลขและ SQL ให้)
  ```
  หรืออ่านแขกจาก Google ตรง ๆ: `/api/admin/<id>/calendar-resync?dryRun=1` กับใบตัวอย่าง ต้องได้ `action:"ok"` และไม่มีอีเมลเขาใน attendees
- **ห้ามแก้แขกในปฏิทินมือ ๆ** — รอบถัดไป reconciler ถอดกลับตามค่าบนใบ
- คำบรรยายใน event (`Producer: … / Co-Producer: …`) **ไม่ตาม** — reconciler patch แขกอย่างเดียว · `POST /api/admin/calendar-refresh` ก็ไม่ช่วย (เขียนใหม่เฉพาะ event ที่ชื่อเรื่องเปลี่ยน) → ค้างจนกว่ามีคน PATCH ใบผ่าน `/admin/<id>` · เคสแก้วใช้สคริปต์ operator ลบบรรทัด `Co-Producer:` แบบ `sendUpdates:'none'` (มีแค่ 2 event)

### ขั้น 4 — ชีท [มือ · 2 นาที]

| ที่ | ต้องทำไหม | เหตุผล |
|---|---|---|
| Producer Dashboard › `Bookings` คอลัมน์ `PD` / `PD Email` | **ต้องแก้มือ ถ้าโอน Producer** — กรอง PD Email = คนออก + Status ไม่ใช่ CANCELLED/COMPLETED | `updateBookingRow()` ใน `src/lib/google-sheets.ts` ไม่มีฟิลด์ producer — แม้ PATCH ของแอปก็ทิ้งชีทค้าง |
| Producer Dashboard › `Bookings` Co-Producer | ไม่ต้อง | ไม่มีคอลัมน์ |
| Producer Dashboard › `_Users` (email · nickname · role) | ลบแถว **ถ้ามี** | dropdown ฟอร์ม AGN อ่านแท็บนี้ (`src/lib/people.ts`) ไม่มีช่อง active · หลังลบกด `?refresh=1` หรือรอ cache 5 นาที |
| ชีท "DB Outlet Booking" (ต้นทาง seed) | ของ ops — ไม่แตะ | ops ไม่เคยลบคนออก (ซังยังอยู่) |
| `_SHOOT.txt` ใน Drive | ไม่ทำ | มีบรรทัด Producer แต่ marker reconciler ไม่นับว่าเปลี่ยน — ยอมรับว่าค้าง |

### ขั้น 5 — นอกแอป

- **HR/IT** ระงับบัญชี Workspace — ระบบไม่มีอะไรต้องโอน ถ้าเขาไม่ใช่ impersonate subject (organizer ของทุก event คือ subject; เขาเป็นแค่ attendee)
- ถ้าเขาเป็น **เจ้าของ** ชีท/โฟลเดอร์ที่แอปเขียน → โอน ownership ก่อนบัญชีถูกลบ
- บันทึก `docs/ops-log.md` — ใบที่โอน จำนวน วันที่ ใครรับ

## สิ่งที่ห้ามทำ และทำไม

1. **ห้ามแก้ `createdByEmail`** — ประวัติว่าใครกดสร้าง แก้แล้วประวัติโกหก (เคสซังตั้งใจปล่อยไว้)
2. **ห้ามลบแถว `users` / `team_members`** — 3 ทางที่สร้างคืน: `prisma/seed.ts` ตอนบูต (คนใน `team-profiles.ts`), `POST /api/admin/import-producers` (คนใน `outlet-producers.ts`) และ **sign-in ครั้งแรกผ่าน Google** (`src/lib/auth.ts` สร้าง user ใหม่ถ้าไม่มีแถว — ใช้ได้ตราบที่ IT ยังไม่ระงับ Workspace) · แถว `active=false` คือตัวบล็อกทางที่ 3 (`/login?error=disabled`) · OT/ประวัติผูกอีเมลนี้อยู่
3. **ห้ามเชื่อว่า `active=false` หยุดอีเมล/ปฏิทิน** — ทุกเส้นเลือกผู้รับจากช่องบนใบ ไม่ join `users.active` → หยุดได้เมื่อ**ช่องบนใบ**เปลี่ยน (ขั้น 2) เท่านั้น · ยกเว้นตั้งแต่ v1.243: เมลเตือนเลข QU ข้าม Producer ที่ `active=false` แล้วรายงานในแชต ops ว่าต้องมีคนตามแทน (ใบ ADVERTORIAL ที่ COMPLETED และยังไม่มีเลขจะไม่มีวันถูกโอน จึงต้องกันที่ตัวส่ง)
4. **ห้ามเชื่อว่า `active=false` หยุดกฎในโค้ด** — `BUILT_IN_DEFAULT_COPRODUCERS` และเพื่อน ๆ อ่านจากโค้ด (ขั้น 1)
5. **ห้ามแตะใบอดีต (COMPLETED/CANCELLED)** — เก็บเป็นประวัติ ("ข้อมูลเก่าเก็บไว้" — คำสั่ง operator เคสซัง)
6. **ห้ามเดาชื่อเล่น / ห้ามใส่คนที่ยังไม่ถูกแท็ก outlet** — ใส่ผิดคน = invite ผิดคน แย่กว่าปล่อยว่าง
7. **ห้ามเขียน DB โดยไม่มีแถว audit / นอก transaction** — เครื่องมือทำให้ครบอยู่แล้ว ถ้าทำมือต้อง INSERT เอง
8. **ระวังทางเปิดบัญชีคืนโดยไม่ตั้งใจ** — ปุ่ม "+ Add user" (`POST /api/admin/users` upsert `active:true`), ปุ่ม Enable บน `/admin/permissions`, toggle `/admin/team` — ทั้งสาม**ไม่เขียน audit**
9. **ห้ามใช้ `AUTO_COPRODUCER_<CODE>` เป็นสวิตช์บน stack** — ไม่ถึง container (ขั้น 1)

## วิธีตรวจว่าครบ

เครื่องมือทำ post-check ให้ตอน `--apply` แล้ว · ตรวจซ้ำได้ทุกเมื่อด้วย `python3 scripts/ops/offboard.py --leaver <email> --verify` (อ่านอย่างเดียว · exit 1 ถ้ามีบทบาทที่โอนแล้วยังค้าง · บรรทัด `qu.pending.asProducer` เป็นประวัติที่ต้องมี**คน**ตามแทน ไม่ใช่ตัวเลขที่ต้องเป็น 0) · หรือ SQL มือ:

```sql
WITH e AS (SELECT '<leaver>'::text AS v),
 fut AS (SELECT * FROM bookings WHERE "deletedAt" IS NULL AND status::text NOT IN ('CANCELLED','COMPLETED')
                                  AND "shootDate" >= (now() AT TIME ZONE 'Asia/Bangkok')::date)
SELECT 'users.active' k, count(*) FROM users, e WHERE lower(email)=e.v AND active
UNION ALL SELECT 'team_members.active', count(*) FROM team_members, e WHERE lower(email)=e.v AND active
UNION ALL SELECT 'future producerEmail', count(*) FROM fut, e WHERE lower("producerEmail")=e.v
UNION ALL SELECT 'future coProducerEmail', count(*) FROM fut, e WHERE lower("coProducerEmail")=e.v
UNION ALL SELECT 'future crew/director', count(*) FROM fut, e WHERE e.v = ANY("assignedEmails")
        OR e.v IN (lower("directorEmail"),lower("director2Email"),lower("director3Email"),lower("mainVideographerEmail"))
UNION ALL SELECT 'audit ของรอบนี้', count(*) FROM audit_logs WHERE changes->>'offboardRun' = '<run_id>'
UNION ALL SELECT 'ปฏิทิน patch จริงหลัง apply (ต้อง = ใบ CONFIRMED ที่มี event)', count(*) FROM audit_logs
        WHERE action='calendar.reconcile_patched' AND at > '<เวลา apply UTC>' AND changes::text LIKE '%'||(SELECT v FROM e)||'%'
UNION ALL SELECT 'OT ยังไม่อนุมัติ', count(*) FROM ot_records, e WHERE lower("userEmail")=e.v AND "approvalStatus"::text IN ('DRAFT','SUBMITTED','REJECTED')
UNION ALL SELECT 'ยืมของยังไม่คืน', count(*) FROM equipment_loans, e WHERE lower(coalesce(email,''))=e.v AND status::text <> 'RETURNED';
```
ทุกบรรทัดต้อง 0 ยกเว้น `audit ของรอบนี้` (= จำนวนใบที่โอน + บัญชีที่ปิด) และ `ปฏิทิน patch จริง` (= จำนวนใบ CONFIRMED ที่มี event) · **`calendarSyncStatus` ใช้ตัดสินไม่ได้** (ดูขั้น 3) · `grep -rn '<ชื่อ>' src` เหลือแค่ seed + fixture ในเทส · ฟอร์มจอง outlet นั้นไม่มีชื่อเขาใน dropdown และไม่มีข้อความ "ระบบใส่…ให้อัตโนมัติ"

## ผลข้างเคียงที่ยอมรับ

- ชื่อค้างในใบอดีตและ `createdByEmail` — ตั้งใจ
- พรอดตั้ง `FOOTAGE_READY_AUDIENCE=team` → ใบที่เขาสร้าง (`createdByEmail`) / เป็น Producer / อยู่ในทีม ที่ถ่ายไม่เกิน 3 วันและยังไม่แจ้งฟุตเทจ จะยิงเมล "ฟุตเทจพร้อม" หาเขา 1 ฉบับ/ใบ แล้วตีกลับ — เครื่องมือพิมพ์รายการรหัสใบให้ ไม่มีใครเสียหาย
- คนเก่าได้ใบยกเลิกจากปฏิทิน 1 ฉบับต่อ event (ถ้าบัญชีถูกระงับแล้วก็ตีกลับเงียบ ๆ)
- คำบรรยาย event ยังมีชื่อคนเก่าจนกว่าจะมีคนแก้ใบหรือสั่ง calendar-refresh
- "ผีในกอง": ชื่อค้างใน `assignedEmails` ใบเก่าถอดจากหน้า admin ไม่ได้ · OT `/ot/admin` ต้องติ๊ก "แสดงคนที่ disabled"

## ถอยกลับ

- ทุกแถว audit ของเครื่องมือมี `from` ครบและ key `changes->>'offboardRun'` → UPDATE ย้อนทีละใบจาก `changes` แล้ว INSERT audit อีกแถวบอกว่าย้อน · reconciler สลับแขกปฏิทินกลับเองรอบถัดไป
- `users.active=true` ผ่าน `/admin/permissions` Enable (ไม่มี audit — เขียนเอง)
- โค้ดขั้น 1: revert commit แล้ว deploy

## บันทึกเคส

| วันที่ | ใคร | ทำอะไร |
|---|---|---|
| 6 ก.ย. 2569 | ซัง → หวาน | โอน Producer 2 ใบ ก.ย. ด้วย SQL + audit มือ · ปิด users/team_members · บทเรียน: `active=false` ไม่หยุดเมล, ชีท/_SHOOT ไม่ตาม, `_Users` ไม่มีช่อง active |
| 28 ก.ย. 2569 | แก้ว (TSS Co-Producer) → ว่าง (แพรดูแลคนเดียว) | v1.242 ถอด `BUILT_IN_DEFAULT_COPRODUCERS.TSS` · `offboard.py` ถอด Co-Producer **26 ใบอนาคต** (23 CONFIRMED + 3 REQUESTED; TSS-ITV-260928-01 พลิกเป็น COMPLETED ก่อน apply) + ปิด users · reconciler รอบ 09:02 UTC ถอดเธอจากแขก 23/23 event · `_Users` ไม่มีเธอ · v1.243 ปิดช่องโหว่ 3 ข้อที่ผู้ตรวจเจอ · ดู `docs/ops-log.md` |
