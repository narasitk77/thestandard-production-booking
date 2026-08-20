# Hermes cron scripts (probook watchdogs)

สคริปต์ 3 ตัวนี้เคยเป็น **Claude Code scheduled routine** แล้วย้ายมาอยู่บน **Hermes cron**
เมื่อ 2026-08-18. ตัวที่รันจริงคือสำเนาใน `~/.hermes/scripts/` — โฟลเดอร์นี้คือต้นฉบับที่ git คุม
(`~/.hermes` ไม่มีระบบสำรอง และ `updates.pre_update_backup: false` ใน `~/.hermes/config.yaml`
หมายความว่าการอัปเดต Hermes ไม่ได้สำรองอะไรให้)

| script | cron (เวลาไทย) | ทำอะไร |
|---|---|---|
| `probook-worker-check.py` | `0 9,21 * * *` | **1** probe `/api/health-summary` + `/api/version` · **2** สแกน log container 24 ชม. ผ่าน Portainer API · **3** เฝ้า launchd NAS agent · **4** เตือนหมุนงวดไดรฟ์ฟุตเทจ |
| `probook-idfirst-monitor.py` | `30 9 * * *` | อ่าน `/api/internal/id-first-stats` เก็บ snapshot 14 วัน; แจ้งเมื่อ fallback พุ่ง / hit ตกเกือบ 0 / endpoint ล่ม 2 วันติด |
| `probook-landing-cleanup.py` | `0 12 * * *` | `landing/manage?prune=today` แบบ dry-run → apply → verify; ลบเฉพาะ drop folder ที่ว่าง (ฟุตเทจส่งเข้ากล่องแล้ว) |

## หลักการที่ต้องรักษาไว้

1. **ไม่มี LLM** — ทั้งสามตัวเป็น Python stdlib ล้วน เพราะงานคือ "อ่านเลข → ใช้กฎ → รายงาน"
   เอา LLM ออกแล้วได้ทั้งความนิ่งและความประหยัด (Hermes ต่อ provider `nous` โมเดล default
   `upstage/solar-pro4:free` ซึ่งวัดแล้วว่าไม่ควรให้ตัดสินใจเรื่องแก้โค้ด)
2. **เงียบเมื่อปกติ** — ไม่ print อะไร = Hermes ไม่ส่งข้อความ (`--no-agent` + empty stdout)
   scheduler จะบันทึกรอบนั้นว่า `[SILENT] — skipping delivery` ใน `~/.hermes/logs/gateway.log`
   และเขียนไฟล์ `**Status:** silent (empty output)` ไว้ที่ `~/.hermes/cron/output/<job-id>/`
   → "เงียบเพราะปกติ" กับ "สคริปต์ crash" แยกออกจากกันได้จากร่องรอยนี้

   **แต่ร่องรอยนั้นอยู่บนดิสก์ ไม่ได้อยู่ในสายตาคน** — 20 ส.ค. แผง cron ขึ้น "No runs yet"
   ทั้งที่ job รันครบทุกรอบ และเจ้าของระบบสรุปว่ามันไม่เคยทำงานเลย ซึ่งเป็นข้อสรุปที่สมเหตุสมผล
   มากเมื่อไม่เคยมีข้อความมาสักครั้ง · แก้ด้วย **heartbeat รอบเช้า** (ข้อ 3) ไม่ใช่ด้วยการ
   เลิกเงียบ — รอบค่ำยังเงียบเหมือนเดิม
3. **heartbeat เฉพาะรอบเช้า** — `probook-worker-check` รอบ `0 9` พูดเสมอแม้ทุกอย่างปกติ
   (`✅ ตรวจแล้วปกติ — worker เปิดอยู่ N/12 ตัว tick ครบ · prod <version>`) ส่วนรอบ `0 21`
   ยังเงียบตามข้อ 2 · เลือกวันละครั้งเพราะข้อความ "ไม่มีอะไรเกิดขึ้น" วันละสองครั้งจะถูกมองข้าม
   ภายในสัปดาห์เดียว แล้วเราจะกลับมาที่ปัญหาเดิม
4. **OUTBOX — รายงานที่ส่งไม่ออกต้องถูกส่งซ้ำ** (บล็อก `OUTBOX` ในทั้งสามสคริปต์)

   `RETRY_DELAYS` กันได้แค่ **ขาไปหา probook** แต่การส่ง Discord เป็นขั้นของ **Hermes ที่เกิด
   หลังสคริปต์จบไปแล้ว และ Hermes ไม่ retry** — 19 ส.ค. 21:26 DNS ล่ม รายงานจึงหายไปเลย
   (`last_delivery_error` ค้างใน `jobs.json` โดยไม่มีใครเห็น)

   วิธี: จบรอบแล้วเก็บ payload ลง `~/.hermes/state/probook/outbox-*.json` · รอบถัดไปอ่าน
   `last_delivery_error` ของ job ตัวเองจาก `~/.hermes/cron/jobs.json` — ค้างอยู่ = รอบก่อน
   ไม่ถึงคนอ่าน จึงพิมพ์ซ้ำนำหน้า · ไม่ค้าง = ถึงแล้ว ล้าง outbox

   - **ทนเน็ตล่มนานเท่าไรก็ได้** ต่างจาก retry ที่ยอมรอได้แค่ ~200 วินาที
   - เก็บ **payload ทั้งก้อน** (รวมของที่หอบมา) ไม่ใช่แค่รายงานรอบนี้ — ล่มติดกันหลายรอบ
     ของเก่าจะได้ไม่หล่นหายตั้งแต่รอบที่สอง (cap 60 บรรทัด)
   - **heartbeat ไม่เข้า outbox** — heartbeat ที่หายแก้ตัวเองรอบหน้า ส่วนคำเตือนที่หายคือ
     ความเสียหายจริง
   - **ลำดับสำคัญ**: อ่าน+ล้าง outbox ของรอบก่อนให้เสร็จ *ก่อน* เขียนของรอบนี้ทับ สลับลำดับ
     เมื่อไร `undelivered_lines()` จะลบรายงานรอบนี้ที่เพิ่งเขียนไปทิ้ง
   - บล็อกนี้ **ซ้ำกันทั้งสามไฟล์โดยเจตนา** — deploy คือการก๊อปไฟล์ด้วยมือ module ร่วมที่ลืม
     ก๊อป = ImportError = job ตายทั้งตัว ซึ่งแย่กว่าโค้ดซ้ำ 40 บรรทัด **แก้ที่ไหนต้องแก้ให้ครบสามที่**
5. **landing: ห้ามลบโฟลเดอร์ของคิวถ่ายวันหลัง** — `prune=today` เก็บแค่ของ "วันนี้" ส่วน
   landing worker ในคอนเทนเนอร์สร้างของ "วันพรุ่งนี้" ตอน 19:00 BKK ดังนั้นถ้ารอบเที่ยงถูกเลื่อน
   ไปรันหลัง 19:00 มันจะลบของพรุ่งนี้ทิ้ง (เกิดขึ้นจริงตอนพอร์ตงานนี้) — `future_targets()`
   จึงบล็อกการ apply ไว้ ถ้าจะลบจริงต้องสั่งมือด้วย `--force`
6. **ยิง apply ครั้งเดียว** — endpoint ที่เดิน Drive นาน ๆ ถูก proxy ตัดที่ ~60s ทั้งที่งานเดินต่อ
   ฝั่ง server การยิงซ้ำ = race/ของซ้ำ สคริปต์จึงรอแล้ว verify ไม่ยิงใหม่

## Step 2 — Portainer log scan

health-summary จับได้แค่ "heartbeat ค้าง" แต่จับ **ไม่ได้** เคสที่ worker ยิง HTTP ล้มทุกรอบ
ทั้งที่งานข้างล่างยังเสร็จ (เคสจริง `[sound-merge] run failed: fetch failed` 48/48 รอบ ก่อน v1.172)
step 2 จึงอ่าน log ของ container ย้อน 24 ชม. แล้วนับต่อ worker:

- `run failed` / `no activity for NNNs` / `] 4xx:` / `] 5xx:` → นับเป็น error พร้อมยกตัวอย่างบรรทัด
- บรรทัด `supervisor: worker exited` / `is off — exiting` / `WORKER_ENABLED=0` → ข้าม (ปิดเองถูกต้องแล้ว)
- worker ที่ health-summary บอกว่า `enabled` แต่ 24 ชม. ไม่มีร่องรอยใน log เลย → เตือน (supervisor อาจไม่ได้รันสคริปต์)
- ตีความให้ด้วย: `no activity for` = endpoint ค้างจริง · `fetch failed` = deploy เก่ากว่า v1.172 · `401` = shared secret ไม่ตรง · `409` ทุกรอบ = pass เดินนานเกิน interval

**ต้องใช้ Portainer access token ไม่ใช่ session ของ Chrome** — Hermes ขับบราวเซอร์ของตัวเอง
ยืม session ที่คนใช้ล็อกอินไว้ไม่ได้ วิธีออก token:

> Portainer → ไอคอนผู้ใช้มุมขวาบน → **My account** → **Access tokens** → **Add access token**
> → ตั้งชื่อ `hermes-worker-check` → copy ค่า (โชว์ครั้งเดียว) → วางใน `~/.hermes/scripts/probook.env`

```
PORTAINER_URL=http://thestandard.fortiddns.com:9000
PORTAINER_API_KEY=<paste>
PORTAINER_ENDPOINT_ID=2
PORTAINER_CONTAINER=production-booking-app
```

ปล่อย `PORTAINER_API_KEY` ว่าง = ข้าม step 2 เงียบ ๆ (ไม่กวน ไม่พัง) · token เสีย/หมดอายุ → สคริปต์
รายงาน `⚠️ ข้าม log scan — Portainer API token ใช้ไม่ได้แล้ว` ไม่เงียบหาย · สคริปต์ยิงแค่ `GET .../logs`
ไม่มีการเขียน ไม่ redeploy (token มีสิทธิ์เท่าเจ้าของบัญชี — ไฟล์จึง chmod 600)

## Step 3 — เฝ้า launchd NAS agent

`co.thestandard.probook-nas-agent` (launchd ทุก 600s) รัน `~/.probook/nas-manifest-agent.sh`
สแกน SMB share แล้ว POST manifest เข้า `/api/internal/nas-manifest` **มันออกแบบให้เงียบเมื่อ
`/Volumes/production team` ไม่ได้ mount** (โน้ตบุ๊กไม่อยู่ออฟฟิศ) — "not mounted" จึงไม่ใช่ความผิดพลาด
แต่ถ้าเงียบยาว manifest ฝั่ง server ค้าง และอีเมล "โฟลเดอร์ sync เสร็จ" จะไม่มาเลยโดยไม่มีใครรู้

- แจ้งเมื่อ log ไม่ขยับเกิน 45 นาที (agent ไม่ได้เด้ง — ควรทุก 10 นาที)
- แจ้งเมื่อไม่ mount ต่อเนื่องเกิน 48 ชม. พร้อมบอกว่าถอน agent ได้ถ้าไม่ใช้ฟีเจอร์นี้แล้ว
- ก็อป log ไปเก็บถาวรที่ `~/.hermes/state/probook/nas-agent.log` เพราะตัวจริงอยู่ใน `/tmp` ซึ่งหายทุกครั้งที่รีบูต

## Step 4 — งวดของไดรฟ์ฟุตเทจ (กันระเบิดเงียบตอนขึ้นปี/ครึ่งปีใหม่)

`DRIVE_FOOTAGE_ROOT` ชี้ Shared Drive ชื่อ **"VIDEO 2026 [JUL–DEC]"** ซึ่งหมุน **ด้วยมือ** ทุกครึ่งปี
ไม่มีโค้ดตรงไหนเทียบชื่อไดรฟ์กับปฏิทิน ⇒ ถ้าขึ้นงวดใหม่แล้วไม่มีใครหมุน env ระบบจะสร้างกล่อง/EP/CAM
ลงไดรฟ์งวดเก่าต่อไป **เงียบ ไม่มี error** = คลาส "เขียนของผิดลงระบบ" ที่แก้ย้อนหลังแพงที่สุด

- สคริปต์เก็บงวดที่ยืนยันแล้วไว้ที่ `~/.hermes/state/probook/footage-root.json` (seed `2026-H2`)
- ขึ้นงวดใหม่แล้วยังไม่ยืนยัน → เตือนทุกรอบจนกว่าจะหมุน
- ใกล้ปลายงวด → เตือนล่วงหน้าเป็น "ช่วง" (≤14, ≤7, ≤3, ≤1 วัน) ช่วงละครั้ง ไม่ก่อกวนทุกวัน
- หมุน env บน stack แล้วยืนยันด้วย:
  `python3 ~/.hermes/scripts/probook-worker-check.py --ack-footage-root 2027-H1`

## Secret

`/api/internal/*` รับ shared secret ทาง header `x-reconcile-secret` (ค่า = prod
`PREP_FOLDERS_SECRET || NEXTAUTH_SECRET || AUTH_SECRET`) สคริปต์ landing อ่านจาก
`~/.hermes/scripts/probook.env` (chmod 600, **ห้าม commit เข้า repo นี้**):

```
PROBOOK_LANDING_SECRET=<prod NEXTAUTH_SECRET>
```

ถ้า prod หมุน secret สคริปต์จะรายงาน 401 พร้อมบอกไฟล์ที่ต้องแก้ ไม่เงียบหาย

## ลงทะเบียนใหม่ (กรณี Hermes ถูกติดตั้งใหม่ / job หาย)

```bash
cp scripts/hermes/probook-*.py ~/.hermes/scripts/
cd ~/.hermes/hermes-agent
H="./venv/bin/python -m hermes_cli.main"
$H cron create "0 9,21 * * *" --name probook-worker-check      --script probook-worker-check.py      --no-agent --deliver discord:1536651002667601980
$H cron create "30 9 * * *"   --name idfirst-fallback-monitor  --script probook-idfirst-monitor.py   --no-agent --deliver discord:1536651002667601980
$H cron create "0 12 * * *"   --name probook-landing-cleanup   --script probook-landing-cleanup.py   --no-agent --deliver discord:1536651002667601980
$H cron list && $H cron status
```

ปลายทาง `discord:1536651002667601980` คือห้อง `hermes-agent` — ทดสอบแล้วส่งได้จริง
ห้อง `probook-noti` (`1516833315561144341`) ตอบ `403 Missing Access` เพราะบอทยังไม่มีสิทธิ์
ถ้าให้สิทธิ์บอทแล้วก็เปลี่ยนได้ด้วย `cron edit <job-id> --deliver discord:1516833315561144341`

**อย่าใช้ `--deliver local`**: ในโค้ด Hermes มันหมายถึง "no delivery, save only" — เขียนไฟล์แล้วไม่แจ้งใคร

## สำเนาที่ยังอยู่บน Claude Code

`probook-nightly-check` ยังรันบน Claude Code (ต้องใช้ LLM จริงเพื่อวินิจฉัย test/tsc แล้วแก้โค้ด)
และมันเป็นตัวเฝ้าว่า 3 job นี้ยังยิงอยู่ (ถ้า Hermes gateway ตาย จะไม่มีใครรู้จากฝั่ง Hermes เอง)
routine เดิมอีก 3 ตัวถูก **disable ไว้ ไม่ได้ลบ** ที่ `~/.claude/scheduled-tasks/<id>/SKILL.md`
เผื่อย้อนกลับ
