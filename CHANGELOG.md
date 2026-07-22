# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.151.3] — 2026-07-22

### Fixed — footage ของงานเดียวถูกแยกเป็น 2 โฟลเดอร์ EP (ต้นเหตุ "หาไฟล์ไม่เจอ")
- **video-merge จับคู่โฟลเดอร์ EP ด้วยชื่อเป๊ะๆ** — แต่สองต้นไม้ตั้งชื่อชั้น EP ไม่เหมือนกันโดยตั้งใจ: กล่องใช้ `EP01 · <ชื่อตอน>` ส่วน drop zone ใช้ชื่อฝั่งทีมงานที่มักมีโน้ตรถ/เบอร์ติดมาด้วย (`EP01 · … (รถ. 22. ก.ค …)`) ผลคือ**แทบทุกงานที่มี EP หาโฟลเดอร์คู่ไม่เจอ** merge เลยยก**ทั้งโฟลเดอร์ EP จาก drop zone เข้าไปวางในกล่องข้างๆ ของเดิม** → ไฟล์ของงานเดียวกันกระจายอยู่สอง `EP01` (ยืนยันกับ POP-PIV-260722-01 ที่กล่องมีทั้ง `EP01 · THE INTERVIEW …` และ `EP01 · …(รถ. 22.`)
- ตอนนี้จับคู่ด้วย **lead ที่ไม่เปลี่ยน** (`EP01` / project EP id) แบบเดียวกับ `ensureEpisodeFolder` — ชื่อ CAM-A/AUDIO ที่ไม่มี `·` ยังจับคู่แบบเป๊ะๆ เหมือนเดิม ไม่มีทาง fuzzy ไปโดนอย่างอื่น

### Fixed — folder-integrity worker (จากการตรวจซ้ำหลัง deploy)
- **ตรวจแค่ 60 งานแรกซ้ำๆ ทุกชั่วโมง** — window มี 121 งานแต่เพดาน 60 และ query เรียงคงที่ ทำให้ 61 งานท้ายไม่เคยถูกตรวจเลย ตอนนี้มี cursor หมุนต่อจากรอบก่อน ครบทั้ง window ภายในไม่กี่รอบ
- **อีเมลซ้ำทุกชั่วโมง** — โหมด report-only เจอ drift ชุดเดิมทุกรอบ ถ้าส่งทุกครั้งคือ 24 ฉบับ/วัน แล้วก็โดน filter ทิ้งภายในสองวัน (เสียประโยชน์ทั้งระบบ) ตอนนี้ส่งเมื่อ**ภาพเปลี่ยน** + ส่ง heartbeat ทุก 12 ชม. เพื่อให้ "เงียบ" แปลว่า "ตรวจแล้วไม่มีอะไร" ไม่ใช่ "worker ตาย"
- dry-run รายงานตรงขึ้น: ถ้าจะสร้างโฟลเดอร์ EP ใหม่ จะบอกด้วยว่าจะสร้าง CAM/AUDIO อะไรข้างในต่อ (เดิมเงียบเพราะยังไม่มีโฟลเดอร์ให้เดินเข้าไป)

### Verified — ไม่ใช่บั๊ก
- `[sound-merge] staged=258 merged=0` = สภาวะปกติ ตรวจรายงานทีละงานแล้ว (POP-PIV-260722-01 staged 5, TSS-TSS-260721-01 staged 4 ฯลฯ) ทุกไฟล์ถูก copy เข้ากล่องไปแล้ว `merged=0` แปลว่า "ไม่มีของใหม่" ไม่ใช่ "ย้ายไม่ได้"

---

## [1.151.2] — 2026-07-22

### Fixed — รัดกุม folder-integrity ก่อนเปิดใช้จริง (จากรีวิวเชิงลึก)
รีวิวจับได้ว่าเวอร์ชันแรก (v1.151.0) มีบั๊กที่อาจ **ทำ footage ปนกันทั้งระบบ** — แก้ครบก่อน deploy (prod ยังอยู่ v1.150.2 ตลอด ไม่มีอะไรหลุดออกไป):
- **[ร้ายแรง] ห้ามเก็บกล่องโปรเจกต์ AGN เป็น `box` ของคิว** — ถ้าโฟลเดอร์ย่อยของคิวยังไม่ถูกสร้าง (สถานะปกติของคิว AGN ที่ยังไม่ approve) resolver จะคืน**กล่องรวมของทั้งโปรเจกต์** แล้ว worker เก็บ id นั้นลง `driveFolders.box` → video-merge/sound-merge ที่เชื่อ id ก่อนชื่อ จะย้าย footage ของคิวนั้นเข้ากล่องรวม ปนกันหลายคิว ตอนนี้ถ้าไม่ถึงชั้นของคิวจริง **ข้ามและรายงาน** ไม่แตะเลย + เช็คซ้ำว่าชื่อ box ที่ผูกไว้เป็นของคิวนี้จริง
- **เช็คชื่อชนกันทุกกรณี** (เดิมเช็คเฉพาะ AGN — outlet อื่นการ์ดว่างเปล่า เสี่ยงสร้างโฟลเดอร์ชื่อซ้ำเป็นชุด) และต้องอยู่ใน footage tree จริง (`classifyFootageTreeFolder === 'in-tree'`) ถึงจะเปลี่ยนชื่อ
- **fail closed เมื่อ Drive ตอบไม่ชัด** — `unknown` = "อาจมีไฟล์อยู่" กันเคส 429/token หลุดแล้ว worker ไล่สร้างกล่องซ้ำทั้งชุด
- **โฟลเดอร์ EP ต้องเป็นรูปแบบของระบบ** (`EP01` หรือ `EP01 · <ชื่อตอน>`) ถึงจะเปลี่ยนชื่อ — ชื่อที่ทีมงานเขียนเองไม่ถูกทับทุกชั่วโมง
- **drop zone** — ตรวจก่อนว่าขาดจริงค่อยแตะ (เดิมยิงซ้ำทุกรอบแล้วรายงานว่า "ซ่อมแล้ว" ทั้งที่ไม่ได้ทำอะไร), เพิ่ม delivered-check กันสร้างโฟลเดอร์ผีให้งานที่ไฟล์ลงกล่องแล้ว, และจำกัด **เฉพาะงานวันนี้** (ของพรุ่งนี้เป็นหน้าที่ worker 19:00 — ถ้าสร้างเองจะไปชนกับ prune ตอนเที่ยง วนสร้าง-ลบทุกวัน)
- **ปล่อยแบบ staged** — worker เปิดอยู่แต่เป็น **report-only** (`FOLDER_INTEGRITY_APPLY=0`) และ **rename ปิดไว้** (`FOLDER_INTEGRITY_RENAME=0`): อ่านอีเมลสรุปก่อนว่ามันจะแก้อะไรบ้าง แล้วค่อยเปิดให้แก้จริง

---

## [1.151.1] — 2026-07-22

### Added — รายการใหม่จากชีต outlet-DB
- **KND → `TMH` "ถามให้"** (โค้ดถอดเสียงไทยแบบเดียวกับ `AVK` = อวกาศคาดไม่ถึง ของ Podcast)
- **The Secret Sauce → `WYS` "WYS : What your secret"**
- seed รันทุกครั้งที่ container boot และเป็น upsert อยู่แล้ว รายการจึงเข้า DB เองตอน deploy — เปิดจองได้ทันที (Production ID จะออกเป็น `KND-TMH-…` / `TSS-WYS-…`)

---

## [1.151.0] — 2026-07-22

### Added — worker ตรวจ+ซ่อมโครงสร้างโฟลเดอร์อัตโนมัติ (`folder-integrity`)
ที่ผ่านมาปัญหาโฟลเดอร์กลับมาเรื่อยๆ ในรูปแบบใหม่ทุกสัปดาห์ (CAM หาย, AUDIO ราย EP หาย, ชื่อ box ค้างชื่องานเก่า, ทีมงานสร้าง "Cam A" เอง) — แต่ละครั้งแก้เฉพาะจุด แล้ว**ไม่เคยมีใครกลับไปถามว่า "โครงสร้างบน Drive ของงานนี้ยังตรงกับข้อมูลใน DB อยู่ไหม"** คนที่เจอปัญหาก่อนจึงเป็นทีมงานหน้างานเสมอ ตัวนี้ถามคำถามนั้นทุกชั่วโมงแทน

- **ตรวจทุกงานที่ยัง active** (CONFIRMED/COMPLETED, คิวถ่าย -14 ถึง +30 วัน) ทั้งกล่อง VIDEO 2026 และ drop zone ของทีมงาน: หา box แบบ id-first (`Booking.driveFolders` → รหัสงาน) แล้วเทียบ EP / CAM-A..N / AUDIO / ชื่อโฟลเดอร์ กับสิ่งที่ booking บอกว่าควรมี
- **ซ่อมได้ 2 อย่างเท่านั้น: สร้างที่หาย กับเปลี่ยนชื่อในที่เดิม** — ไม่ย้าย ไม่ลบ ไม่ทิ้งถังขยะ อะไรก็ตาม การเปลี่ยนชื่อใช้ id เดิม (ลิงก์/ไฟล์/marker ที่ผูกไว้ไม่หลุด) และการสร้างเรียก `ensure*` ตัวเดียวกับที่ approve/prep/landing ใช้ ผลลัพธ์จึงเหมือนสร้างปกติทุกประการ
- **รั้วกันพลาดของการ rename** (ท่าเดียวที่ดูอันตราย): (1) แตะเฉพาะโฟลเดอร์ที่ resolve มาจากงานนี้เท่านั้น (2) ชื่อเดิมต้องเป็น**รูปแบบที่ระบบสร้างเอง** — ชื่อที่คนตั้ง ("งานพี่ต้น อย่าลบ") ไม่แตะ รายงานอย่างเดียว (3) ถ้ามีโฟลเดอร์ชื่อเป้าหมายอยู่แล้วให้ข้าม (4) มีเพดานเขียนต่อรอบ + `FOLDER_INTEGRITY_RENAME=0` ปิดได้ทันที
- **ชื่อ drop folder เป็น report-only** โดยตั้งใจ — ไดรฟ์นั้นมิเรอร์ลง NAS ผ่าน SMB การเปลี่ยนชื่อกลางคันคือที่มาของไฟล์ซ้ำ "(1)" ตอน v1.111 และทุกการค้นหาที่นั่นใช้รหัสงานอยู่แล้ว
- เคสที่ตัดสินใจแทนคนไม่ได้ (box หายแต่มีไฟล์อยู่ที่อื่น, ชื่อชนกัน, ชื่อที่คนตั้งเอง) เข้า**อีเมลสรุป** ไม่เดาเอง
- ค่าเริ่มต้น: เปิด, รันทุก 1 ชม. (หน่วงหลัง boot 4 นาที ไม่ให้ชน prep sweep), เพดาน 60 งาน/120 การเขียนต่อรอบ; endpoint `GET /api/internal/folder-integrity/run` (dry-run เป็นค่าเริ่มต้น, `?dryRun=0` ถึงจะแก้จริง, `?report=1` บังคับส่งอีเมล)

### Fixed — Drive API 429 ไม่ทำให้งานตายกลางคันอีก
- เพิ่ม `withDriveRetry` (exponential backoff + jitter, retry เฉพาะ 429/5xx) ครอบทุกคำสั่ง**เขียน** Drive: สร้างโฟลเดอร์ / เปลี่ยนชื่อ / ย้าย / ทิ้งถังขยะ / copy / เขียน `_SHOOT.txt` — เดิมไม่มี retry เลย backfill วันที่ 21 ก.ค. เลยตายที่แถว ~161 จาก 181 เพราะชน "Write requests per minute per user" ต้องมายิงซ้ำเอง ตอนนี้ทุก sweep ที่มีอยู่ได้อานิสงส์ด้วย

---

## [1.150.2] — 2026-07-22

### Fixed — CAM-A..C / EP / AUDIO ใน Production Team หายทุกคืน (บั๊กค้างมาตั้งแต่ v1.127)
- **video-merge ย้ายโครงโฟลเดอร์เปล่าออกจาก drop zone**: `mirrorMove` ใช้ fast path "ย้ายทั้งโฟลเดอร์" เมื่อกล่องปลายทางไม่มีฝาแฝด (หรือฝาแฝดว่าง — ซึ่งมันจะ **ลบทิ้งก่อน**) โดย**ไม่เคยเช็คว่าโฟลเดอร์ต้นทางมีไฟล์ไหม** โครง EP/CAM-A..N/AUDIO ที่ lifecycle สร้างไว้ตอน 19:00 จึงถูกยกไปทั้งดุ้นภายในชั่วโมงถัดมา — เช้ามาทีมงานเปิด drop zone เจอโฟลเดอร์ว่าง ไม่มีช่อง CAM ให้วางไฟล์ (ยืนยันกับ AGN-260722-01: EP+CAM-A+CAM-B ที่สร้าง 19:00 ไปโผล่ใต้กล่อง VIDEO 2026 แล้ว)
- ตอนนี้ `mirrorMove` **ข้ามโฟลเดอร์ย่อยที่ไม่มีไฟล์จริง** (`isLandingShell`) — ไม่ย้าย ไม่ลบฝาแฝด: subtree ว่างไม่มีอะไรให้ merge อยู่แล้ว การข้ามจึงไม่กระทบการย้ายไฟล์จริงเลย แต่ drop target ยังอยู่ครบ
- อาการที่ตามมาเป็นลูกโซ่ (ทีมงานหาโฟลเดอร์ไม่เจอ → วางไฟล์มั่ว → detect ไม่เห็น → ต้องย้ายเอง) ควรหายไปด้วย

---

## [1.150.1] — 2026-07-22

### Added — Producer แก้สถานที่/ลิงก์แผนที่ได้หลัง approve
- เดิม producer แก้งานตัวเองได้เฉพาะสถานะ REQUESTED — พองานถูก approve แล้ว ลิงก์สถานที่ (Google Maps) ที่มักเปลี่ยนตอนใกล้ถ่ายกลับวางใหม่ไม่ได้ ต้องไล่ตามแอดมินทุกครั้ง
- ตอนนี้งาน **CONFIRMED** เจ้าของงาน (ผู้สร้าง/producer) แก้ได้ **เฉพาะฟิลด์สถานที่** ผ่านหน้า `/bookings/[id]/edit` (โหมดย่อ มีเฉพาะช่องสถานที่) — ปุ่มใน My Bookings เปลี่ยนเป็น "📍 แก้สถานที่" สำหรับงาน Confirmed
- การแก้กระจายผลอัตโนมัติแบบเดียวกับ admin PATCH: อัปเดต Google Calendar event + refresh `_SHOOT.txt` marker + อีเมลแจ้งทีมงาน (route `producer-edit` เป็น authority — ฟิลด์อื่นถูก drop ที่ server แม้ยิงตรง)
- COMPLETED/CANCELLED ยังแก้ไม่ได้เหมือนเดิม

---

## [1.150.0] — 2026-07-22

_PR #14 + #15 โดยปุ๊ก/Neo (PMDC) + review fixes ตอน merge_

### Added — `_SHOOT.txt` ซ่อมตัวเองได้ (PR #14)
- `refreshShootMarker()` — อัปเดต marker จาก DB ทุกครั้งที่ identity ของ booking เปลี่ยน (regenerate ID, PATCH booking) แบบ find-only ไม่สร้างโฟลเดอร์; prep sweep รายชั่วโมงเติม marker ที่หาย (create-missing-only); agn-restructure เปลี่ยนชื่อ marker legacy ตอนย้าย; reconciler กลางคืนขยายครอบ**ทุก outlet** (เดิมซ่อมเฉพาะกล่อง AGN)
- **Review fix ตอน merge**: (1) AGN subfolder audit normalize marker ชื่อ legacy ก่อนตรวจเนื้อหา — กันสร้าง `_SHOOT.txt` ซ้อนข้างไฟล์เก่าแบบถาวร (2) การ์ด reentrancy ของ reconcile route เปลี่ยนเป็น timestamp + หมดอายุ 15 นาที (บทเรียน v1.149)
- ⚠️ **`SHOOT_MARKER_WORKER_ENABLED` ยังไม่เปิดพร้อม deploy นี้** — ต้อง staged rollout: dryRun=1 ดู digest → รันจริง `limit=20&sinceDays=7` → ค่อยเปิด env (คืนแรกแบบ full-scale = Drive หลายพัน calls)

### Fixed — จับคู่โฟลเดอร์ด้วย key ถาวร + กันสร้างซ้ำ (PR #15)
- กล่องโปรเจกต์ AGN จับคู่ด้วย `projectId` (เดิมชื่อเป๊ะๆ → แก้ชื่อ/approve พร้อมกัน = กล่องซ้ำ footage แตกสองที่); `dedupeEnsure` กัน race ตอนสร้างพร้อมกันทุก path; EP folder จับคู่ด้วย lead ถาวร (`EP01`/project EP id) ทุก create path — แก้ชื่อตอนไม่ fork โฟลเดอร์ใหม่อีก; delivered-check ของ prep ไม่โดนไฟล์ใน `_SOUND-STAGING` หลอกแล้ว (`isFootageTreeFolder`); soft-delete + bulk-cancel ล้าง Status/col W บนชีต; normalize sweep กันสองตัวแปรชนกันเอง; regenerate กู้กล่องที่ ops ย้ายที่ (rename-only, เฉพาะเจอ 1 เดียว)
- **Review fixes ตอน merge**: (1) conflict กับ v1.149 ที่ approve แก้แบบเก็บทั้งสองฝั่ง (`bookingFolderCode` + `camerasToPreCreate` 2-arg — AUDIO fix ไม่ถูกย้อน) (2) filter `_SOUND-STAGING` ใส่ให้ delivered-check ของ `ensureLandingForBooking` ด้วย (ตัวแฝดที่ PR ตกหล่น — เสี่ยงขึ้นเพราะ v1.149 ให้ approve เรียกอัตโนมัติ) (3) undelete เขียน Status คืนลงชีต (inverse ของ soft-delete — เดิมงานที่กู้คืนโชว์ CANCELLED ถาวรฝั่ง PMDC) (4) col-A lookup ใช้ `bookingCode || id` ตรงกับตอน append

---

## [1.149.0] — 2026-07-22

### Fixed — โฟลเดอร์ CAM/AUDIO ไม่ถูกสร้าง (รายงานจากหน้างาน 22 ก.ค.)
- **คืน `micCount` ให้ `camerasToPreCreate`** (revert ของ v1.147.0): การตัด AUDIO pre-creation พังสองเวิร์กโฟลว์จริง — (1) ช่อง `<EP>/AUDIO` ราย EP หายไปทั้ง box และ landing เพราะ `resolveAudioTarget` ของ sound-merge สร้าง AUDIO ได้เฉพาะใน EP folder ที่มี CAM อยู่แล้ว งานเสียงหลาย EP เลยไม่มีที่แยกไฟล์ราย EP อีกเลย (2) งานเสียงนำที่ `cameraCount` 0/null ได้ `[]` ทำให้ landing lifecycle **ข้ามการสร้าง drop folder ทั้งใบ**แบบเงียบๆ
- **ปิดช่องโหว่ approve-หลัง-19:00 (ค้างมาตั้งแต่ v1.139)**: worker กลางคืนสร้าง landing folder เฉพาะ "งานพรุ่งนี้" ตอน 19:00 — งานที่เพิ่ง CONFIRMED หลังจากนั้น (ถ่ายวันนี้/พรุ่งนี้) ไม่เคยได้ folder เลย ทีมงานเจอ Production Team ว่างเปล่าตอนเช้าแล้วแอดมินต้องยิง `?create=` เองตอนเที่ยงคืน (เกิดจริงกับ POP-PIV-260721-01) ตอนนี้ approve จะ `ensureLandingForBooking` ให้ทันทีเมื่อคิวถ่ายคือวันนี้/พรุ่งนี้ (fire-and-forget เหมือน box pre-create, สืบทอด skip checks เดิมครบ)
- **การ์ด reentrancy ของ landing/manage เปลี่ยน boolean → timestamp + หมดอายุ 15 นาที**: request ที่ตายโดยไม่ถึง `finally` (Drive call ค้าง) เคย latch การ์ดถาวร → nightly run โดน 409 เงียบทุกคืน (created=0 = ไม่มีเมลรายงาน ไม่มี audit row) — ตอนนี้ latch เก่าหมดอายุเอง

---

## [1.148.3] — 2026-07-21

### Fixed — Producer Dashboard sheet was mislabeled "sandbox" (unblocks v1.148 backfill)
- `10TnR0…pSzL4` is the team's **real production** Producer Dashboard (confirmed by ปุ๊ก/PMDC — the PMDC Airtable sync reads its `Bookings` tab daily). The code hardcoded it as `SANDBOX_PRODUCER_DASHBOARD_SHEET_ID`, so `isUsingSandboxSheet()` returned **true** whenever the app pointed at the live sheet → `/api/health` permanently showed `SANDBOX`, and the v1.148.1 backfill guard **409'd every `apply`** against the real sheet. That was the "prod still points at sandbox" blocker — it was a label bug, not an env misconfig.
- Renamed the constant → `PRODUCTION_PRODUCER_DASHBOARD_SHEET_ID` (same value, now the correct **default** when `PRODUCER_DASHBOARD_SHEET_ID` is unset) and **inverted** `isUsingSandboxSheet()` to mean "env override points at a *different*, non-production sheet". Default deploy is now correctly `isSandbox:false`, so `POST /api/admin/backfill-bookings-sheet {apply:true}` runs against production without `force`.
- `/api/health` now reports `productionId` instead of `sandboxId`. `docs/runbook-sheet-swap.md` updated: production is the default; set the env var only to point at a throwaway/test sheet. No separate sandbox sheet exists.
- Follow-up (same PR): `/admin/health` banner now reads `productionId` (was still reading the removed `sandboxId` field → would render an empty `()`), and its remediation text is un-inverted — the fix for sandbox mode is now to **remove** the `PRODUCER_DASHBOARD_SHEET_ID` override, not set it. Same inversion applied to the backfill 409 message and to runbook step 5 / verification checklist / rollback plan (post-swap, `⚠ SANDBOX` is the *expected* mode when deliberately pointing at a test sheet).

---

## [1.148.1] — 2026-07-17

### Fixed — backfill-bookings-sheet: กัน apply ตอนยังชี้ SANDBOX
- `POST /api/admin/backfill-bookings-sheet` ตอน `{apply:true}` จะ **409 ถ้าระบบยังชี้ SANDBOX sheet** (`isUsingSandboxSheet()`) — เดิมถ้าเผลอรันตอน env ชี้ sandbox จะ append งานจริงหลายร้อยแถวลง sheet ผิดตัว, กิน quota, และดูเหมือนเสร็จทั้งที่ Airtable ฝั่ง PMDC ยังไม่เห็นอะไร. ต้องสลับ sheet เป็น production ก่อน (docs/runbook-sheet-swap.md) หรือส่ง `{apply:true, force:true}` ถ้าตั้งใจ backfill sandbox จริง. dry-run (อ่านอย่างเดียว) รันได้เสมอ และทุก response บอก `sheetTarget`/`sheetId`/`tab` ที่กำลังทำงานด้วย เพื่อไม่ให้เขียนผิด sheet โดยไม่รู้ตัว

---

## [1.148.2] — 2026-07-19

### Fixed — เมนู Producer หายสำหรับคนที่เป็น producer จริงแต่ตำแหน่งไม่ใช่ "Producer"
- พบ 9 คน (เช่น aphisit.h — "Assistant to KND Manager" แต่เป็น producer บน 16 งาน, รวมถึง Content Creator/Project Manager หลายคน) ไม่เห็นเมนู Producer และเปิด /producer ไม่ได้ → ส่งคำขอแก้ไข/ขอเลื่อนเวลาไม่ได้เลย เพราะ tier ผูกกับ**ชื่อตำแหน่ง** ("position contains producer") แต่การเป็น producer คือ**บทบาทบนงาน**
- แก้ 2 จุด: (1) `getProducerAccess` เพิ่มเงื่อนไข "เป็น producerEmail บนงานที่ยังไม่ถูกลบอย่างน้อย 1 งาน" → เมนูโชว์ตามความจริง (2) `/producer` เข้า ALWAYS ใน tier gate — หน้า/API scope ข้อมูลด้วย producerEmail ของ session เองอยู่แล้ว เปิดกว้างจึงปลอดภัย (บทเรียนเดียวกับ /new และ /dashboard)
- การส่งคำขอ (producer-message) ไม่ต้องแก้ — เช็ค owner ต่อ booking อยู่แล้ว

## [1.148.1] — 2026-07-19

### Added — รั้วกัน backfill ยิงใส่ sandbox sheet
- `POST /api/admin/backfill-bookings-sheet` ปฏิเสธ (409) เมื่อ `PRODUCER_DASHBOARD_SHEET_ID` ยังชี้ sandbox — กันมือลั่น apply ระหว่างรอสลับ sheet จริง (override ได้ด้วย `{ apply: true, force: true }` เมื่อจงใจเทสกับ sandbox)

---

## [1.148.0] — 2026-07-16

_PR โดยปุ๊ก/Neo (PMDC) — เปิดทาง Production ID spine ฝั่ง outlet ไหลเข้า Airtable_

### Changed
- **Bookings tab export ครอบทุก outlet** — เดิม `create-booking.ts` เขียนแถวลง Bookings tab เฉพาะ AGN (Content Agency) ทำให้ booking ของ outlet (NWS/TSS/KND/WLT/...) ไม่มีแถวใน sheet → PMDC Airtable sync ไม่เห็น Production ID ของงาน outlet → Service Job ฝั่ง outlet ไม่มี ID ให้ footage pipeline join (พบ 2026-07-16: Footage Log มี PID ครบทุก outlet 147 รายการ แต่ join ได้เฉพาะ AGN) ตอนนี้ทุก booking ได้แถวเสมอ — row lifecycle (approve/assign/cancel patch) outlet-agnostic อยู่แล้ว (คีย์ด้วย sheetRowIndex + col-A lookup) จึงไม่ต้องแก้อะไรเพิ่ม kill-switch: `BOOKINGS_EXPORT_AGN_ONLY=1` คืนพฤติกรรมเดิม (compose default 0)

### Added
- **`POST /api/admin/backfill-bookings-sheet`** `{ apply?: boolean }` (admin, dry-run default) — one-off เติมย้อนหลังหลังเปิด export ทุก outlet: (1) append แถวให้ booking ที่ยังไม่มี (รวมคิวอนาคตที่ CONFIRMED ไว้แล้ว) (2) claim `sheetRowIndex` ให้ booking ที่มีแถวอยู่แล้วแต่ flag ยัง null (3) เติม Calendar Event ID (col W) ที่ DB รู้แต่ cell ว่าง

### Fixed
- **Calendar Event ID ไม่เคยถูกเขียนกลับลง sheet นอก approve path** — event ที่เกิดจาก calendar reconciler (ทั้ง 3 ทาง: create/recreate/recreate-หลัง-attendees-patch-fail) และจาก assign auto-recover ไม่เคย backfill ลง col W → cell ว่างถาวร ทั้งที่ PMDC Airtable sync ใช้ Calendar Event ID เป็นคีย์ dedupe Service Job (พบจริง: booking 2 ตัวที่ eid หายทำให้เกิด record ซ้ำใน Airtable) เพิ่ม `syncEventIdToSheet` ใน `calendar-reconcile.ts` + ใส่ `calendarEventId` ใน sheet patch ของ assign route
- **cancel ไม่ล้าง col W** — ทั้ง PATCH cancel และ DELETE ลบ calendar event แล้ว แต่ทิ้ง event id ค้างในแถว CANCELLED → id ผี pointing ไป event ที่ตายแล้ว (เสี่ยงหลอก dedupe ฝั่ง PMDC) ตอนนี้ blank col W พร้อมกับ set status

---

## [1.147.3] — 2026-07-14

### Added — admin sweep: normalize ชื่อโฟลเดอร์กล้อง
- `POST /api/admin/normalize-camera-folders` (dryRun default, `{execute:true}` เพื่อ rename จริง) — กวาดทั้ง VIDEO + Production Team shared drives หาโฟลเดอร์กล้องชื่อไม่ตรงมาตรฐาน ("Cam A", "cam-b", "Audio", "camera d") แล้ว rename เป็น vocab กลาง (CAM-A.., AUDIO/DRONE/SWITCHER/PHOTO/SCREEN). เฉพาะชื่อที่ตรง variant เป๊ะเท่านั้น (ชื่อมีข้อความต่อท้ายไม่แตะ); ถ้า parent มีชื่อ canonical อยู่แล้วจะไม่ rename ซ้อน (รายงานเป็น collision ให้ merge มือ — กันเคสโฟลเดอร์แฝดแบบ landing-dedupe).

---

## [1.147.2] — 2026-07-14

### Added — แจ้ง Discord เมื่อ NAS ซิงค์ระบายครบ
- Event "✅ ส่งขึ้น Drive ครบ" (คิว NAS ของโฟลเดอร์ระบายหมด — ไฟล์ทั้งหมดขึ้น Production Team แล้ว) เดิมส่งแค่อีเมล ตอนนี้ยิงเข้า Discord webhook ด้วย (ผ่าน `notifyDiscord` — เงียบเองถ้า `DISCORD_WEBHOOK_URL` ไม่ได้ตั้ง). ตั้ง `DISCORD_WEBHOOK_URL` บน stack แล้ว → footage-ready (โหมด admin), reminders digest และ video-merge ?notify=1 เริ่มยิง Discord ทันทีโดยไม่ต้องแก้อะไรเพิ่ม.

---

## [1.147.1] — 2026-07-14

### Changed — settle window ของ auto-แจ้งไฟล์: 1 ชม. → 2 ชม. (default)
- ตาม ops: ช่องโหว่หลักของ 1 ชม. คือ dump การ์ดแรกหลังเก็บกอง → เดินทาง/กินข้าว (60-90 นาที) → dump การ์ดสอง ทำให้แจ้ง "พร้อม" เร็วไปหลังการ์ดแรก; 2 ชม. คลุมช่องว่างนี้ โดยแลกกับแจ้งช้าลง 1 ชม. ซึ่งไม่มีผล (กองจบไปแล้ว). ยัง override ได้ด้วย `FOOTAGE_READY_SETTLE_MS`.

---

## [1.147.0] — 2026-07-14

### Added — 📣 Auto-แจ้งไฟล์พร้อม (footage-ready worker)
ระบบแจ้งอัตโนมัติเมื่อไฟล์ของงานครบ — คู่ขนานกับปุ่ม ส่งงาน/📣 เดิม (ปุ่มทำงานเหมือนเดิมทุกอย่าง):
- **นิยาม "ไฟล์พร้อม"** (ต้องครบทุกข้อ): งาน CONFIRMED/COMPLETED ที่ไม่ถูกลบ/ขอยกเลิก · กองถ่ายจบแล้ว (isShootOver, รองรับ multi-day) · ไม่มี upload ค้าง (PENDING/UPLOADING ที่สดกว่า 24 ชม.) · คิว NAS ระบายหมด · Drive walk เจอไฟล์จริง (ครอบทั้ง browser-upload และ NAS→video-merge) · จำนวนไฟล์+ขนาด**นิ่งเกิน 60 นาที** (settle window กันแจ้งกลาง batch)
- **ส่งครั้งเดียวต่องาน**: คอลัมน์ใหม่ `Booking.readyNotifiedAt` (ปุ่ม 📣 manual ก็ stamp ด้วย — กด manual แล้ว auto ไม่ส่งซ้ำ) + `readySnapshot` เก็บสถานะ settle ข้าม restart; งานที่ ส่งงาน แล้ว (deliveredAt) ไม่ถูกแจ้งซ้ำ
- **Rollout guard**: มองเฉพาะงานที่ถ่ายภายใน `FOOTAGE_READY_LOOKBACK_DAYS` (default 3 วัน) — เปิดครั้งแรกไม่ blast งานเก่า; จำกัด Drive walk `FOOTAGE_READY_MAX_PER_RUN` (default 5) ต่อรอบ
- **ปิดเป็น default**: worker ใหม่ `scripts/footage-ready-worker.js` + `GET /api/internal/footage-ready/run` (dormant จนกว่า `FOOTAGE_READY_WORKER_ENABLED=1`); ผู้รับตาม `FOOTAGE_READY_AUDIENCE` = `producer` (default) / `everyone` (producer+crew+ผู้สร้าง แบบเมลแยกรายคน) / `admin` (digest+Discord เท่านั้น — แนะนำใช้ทดลองก่อน); `?dryRun=1` ดู candidate โดยไม่เขียน/ไม่ส่ง; ลง workerSpecs แล้ว (dead-man alert ครอบ)
- ทดสอบ: unit 7 ตัว (settle logic) + live sweep กับ Postgres จริง 8 เคส (gate ครบ: shoot-not-over, multi-day, photo-album, in-flight upload, delivered/notified/old excluded, dryRun ไม่เขียนอะไร)

### Added — ฟิลเตอร์ตามวันในหน้า Producer
- `/producer` มีแถวปุ่มกรองเหนือรายการงาน: **ทั้งหมด / วันนี้ / พรุ่งนี้ / 7 วันข้างหน้า / เลือกวันจากปฏิทิน** — กรองฝั่ง client จากรายการที่โหลดแล้ว (ไม่ยิง API เพิ่ม) งานหลายวันนับติดทุกวันในช่วง `shootDate → shootEndDate`, "วันนี้" อิงเวลากรุงเทพฯ (unit test 8 เคสครอบ boundary/timezone)

### Changed — เลิก pre-create โฟลเดอร์ AUDIO (ops)
- โฟลเดอร์กล้องยังสร้างตามที่จองเป๊ะ (กล้อง 3 → CAM-A/B/C, cap ที่ D) แต่ **AUDIO ไม่ถูกสร้างล่วงหน้าจาก micCount อีกแล้ว** — เสียงเข้ามาทาง _SOUND-STAGING → sound-merge ซึ่ง ensure-create โฟลเดอร์ AUDIO ปลายทางเองอยู่แล้ว (soundDestination ใน sound-merge.ts) การ pre-create ทิ้งไว้ได้แค่ shell ว่างทุกกล่อง/landing
- Dropdown อัปโหลดยังมีตัวเลือก AUDIO เหมือนเดิมสำหรับงานที่มีไมค์ (สร้างโฟลเดอร์ตอนอัปไฟล์แรก) — พฤติกรรมหน้า upload ไม่เปลี่ยน
- หมายเหตุ: งาน Block Shot / ไม่ระบุจำนวนกล้อง ยังคงไม่ pre-create CAM (ตาม design เดิม — สร้างตอนอัปโหลด); ถ้าแก้จำนวนกล้องหลัง approve, prep-folders worker รายชั่วโมงจะเติม CAM ให้เองในวันถ่าย

### Fixed — จาก live DB testing (Docker + Postgres 16 จริง)
- **advisory lock ใช้ `$executeRaw`** — `$queryRaw` deserialize ค่า `void` ของ `pg_advisory_xact_lock` ไม่ได้ (เจอตอนเทสจริง — ถ้าไม่เทสจะพังตอน deploy); ยืนยันแล้ว 5 concurrent creates ได้ sequence 1-5 ไม่ชน
- **upsert outlet/program กัน P2002 race** — สอง booking แรกสุดของ program ใหม่ที่สร้างพร้อมกัน ตัวแพ้จะ re-read row ที่ตัวชนะสร้าง แทนที่จะ 500
- ยืนยันบน Postgres จริง: index ใหม่ 4 ตัว apply, คอลัมน์ wasabi/storagePolicy หายจริง, collision-pair guard บล็อกจริง, CAS กัน stale write จริง, purge จำกัดขอบเขตจริง (17/17)

---

## [1.146.0] — 2026-07-13

### Fixed — Hardening pass จาก code audit (19 จุด: security / race / data-integrity)
**Security & สิทธิ์การเข้าถึง**
- `GET /api/bookings/[id]/history` เช็ค `canViewBooking` เหมือนหน้า detail แล้ว (เดิมใครล็อกอินก็เปิด audit log ของงานทีมอื่นได้ รวม diff ของ adminNotes).
- `POST /api/admin/purge-bookings` ต้องส่ง `confirm: 'DELETE ALL'` ตรงตัว (เดิมเช็คแค่ boolean), ลบ AuditLog เฉพาะที่เกี่ยวกับ Booking (เดิมกวาดทั้งตาราง), และเก็บกวาด OTRecord ที่ค้าง bookingId ด้วย.
- `/api/admin/documents` (เอกสารการเงิน เช่า/ยืม/ซ่อม) จำกัด upload/delete เฉพาะ ADMIN ให้ตรงกับ CRUD route (เดิม console tier ไหนก็เรียกตรงได้).
- `internal-auth` เทียบ secret แบบ constant-time (`timingSafeEqual`) เหมือน `/api/mcp`.

**Race conditions & compare-and-swap**
- `calendar-reconcile` เขียน event กลับพร้อม CAS `status:'CONFIRMED', deletedAt:null` ทั้ง 3 จุด (เดิม path attendees-patch-failure ไม่มี CAS เลย) — งานที่ถูกยกเลิกกลาง reconcile จะไม่มี event ค้างบนปฏิทินอีก.
- PATCH/DELETE booking เช็ค status เดิมตอนเขียนจริง (409 ถ้าสถานะขยับไปแล้ว เช่นชนกับ auto-complete) — กัน COMPLETED โดน revert เป็น CANCELLED.
- สร้าง booking จองเลข sequence ใต้ Postgres advisory lock ต่อ outlet+วัน — สองงานที่กดพร้อมกันไม่แย่งเลข Episode ID กันแล้ว.
- ปุ่ม sweep ที่แตะ Drive ทั้ง 6 ตัว (video-merge / sound-merge / footage-sync / prep-folders / landing manage / landing-dedup) มี reentrancy guard คืน 409 ระหว่างรัน — กดซ้ำตอน proxy timeout ไม่เกิดโฟลเดอร์ซ้ำ.

**Data integrity**
- Rental ที่ ARCHIVED (legacy 221 รายการจากชีทเก่า) ไม่โผล่ใน reminder รายวัน / MCP `list_unpaid_rentals` แล้ว และ `mark_rental_paid` ปฏิเสธการเขียนทับแถว archived.
- นโยบาย Director auto-invite เฉพาะ AGN บังคับฝั่ง server แล้ว (createCalendarEvent + reconciler + อีเมลตอน approve) — เดิมเช็คแค่ที่ wizard.
- ปุ่ม Regenerate ID เช็ค collision แบบ pairwise เหมือน bulk planner — กดกับหนึ่งใน 4 คู่ collision v1.109 จะโดน 409 แทนที่จะ migrate ครึ่งเดียว.
- marker reconciler เช็ค raw id ก่อน normalize — ไม่ลบ `_SHOOT-<id>.txt` ของ booking คู่ collision ที่ยังใช้รหัส [TYPE] เดิม.
- landing lifecycle ใช้ `shootEndDate` (วันสุดท้ายของกอง) ตัดสินอายุโฟลเดอร์ + prune=today นับงานหลายวันที่คร่อมวันนี้เป็น "ของวันนี้" — โฟลเดอร์ drop ไม่โดนลบกลางกองหลายวัน.
- reconciler ส่ง `specialEquipment` + `projectName` ครบตอนสร้าง/สร้างซ้ำ event — รายการอุปกรณ์พิเศษและชื่อ show (AGN) ไม่หายจาก event ที่ reconciler สร้าง.
- `callTime`/`estimatedWrap` validate เป็น HH:MM (24h, zero-padded) ทุก path ที่รับค่า (create / PATCH / producer-edit / MCP schema pattern).
- MCP `create_booking`: `requestedBy` ที่ตรงกับ User จริงถูกเก็บเป็น `createdByEmail` สะอาดๆ (self-cancel/self-edit/อีเมลยืนยันใช้งานได้), ตัวตน MCP + requestedBy ดิบไปอยู่ใน audit แทน — เลิกต่อ string ปนลงคอลัมน์ identity.
- `assessCompleteness`: `DRIVE_OK` (legacy dual-write — ไฟล์อยู่ใน Drive จริง) นับเป็น COMPLETE, `WASABI_OK` (ไฟล์อยู่ cloud ที่ถอดไปแล้ว) นับเป็น failed — เลิกค้าง "in-flight" ตลอดกาล.
- `notifyCalendarAlert` มี cooldown 6 ชม. ต่อ booking+ชนิด (ตาม pattern heartbeat.ts) — DWD เสียทั้งระบบไม่ถล่มอีเมลทุก 10 นาทีอีก; AuditLog ยังบันทึกทุกครั้ง.

### Added — Prisma indexes
- `Booking @@index([deletedAt, status, shootDate])`, `Episode @@index([bookingId])` + `@@index([programId])`, `Upload @@index([bookingId])` — คอลัมน์ที่ทุก listing/dashboard filter+sort เดิมไม่มี index เลย (มีผลอัตโนมัติตอน deploy ผ่าน `prisma db push` ใน start.sh).

### Added — MCP: key รายไคลเอนต์ + backoff (backward-compatible)
- `MCP_API_KEYS` (ทางเลือก): key ต่อไคลเอนต์แบบ `<label>:<key>` คั่น comma — หลุดตัวไหน revoke ตัวนั้นได้โดยไม่ rotate ทุกไคลเอนต์. `MCP_API_KEY` เดิมใช้ต่อได้ตามปกติ.
- Auth ผิดซ้ำเกิน 10 ครั้ง/15 นาทีต่อ IP → 429 ชั่วคราว (กัน brute-force เงียบๆ).

### Removed — ซาก Wasabi (verify แล้วว่าไม่มีโค้ดไหนอ่าน)
- ลบคอลัมน์ `Upload.wasabiBucket/wasabiKey/wasabiMultipartId/wasabiEtag` และ `Outlet.storagePolicy` + enum `StoragePolicy` ออกจาก schema — Wasabi ถูกถอดตั้งแต่ v1.130 ไม่มีอะไรอ่าน/เขียนอีก (คอลัมน์หายจริงตอน deploy ผ่าน `prisma db push --accept-data-loss` ใน start script; rollback image เก่าจะ re-create คอลัมน์เป็น null เองไม่พัง). ค่า enum `UploadStatus.DRIVE_OK/WASABI_OK` **คงไว้** เพราะแถวเก่ายังถืออยู่.

### Changed — perf
- `reconcileEquipmentStatus` batch เป็น 2 groupBy + updateMany ต่อกลุ่มสถานะ (เดิม 1-3 query ต่อชิ้นใน loop — เช็คเอาท์ 15-20 ชิ้น = 30-60+ round-trips ใน transaction เดียว).

---

## [1.141.1] — 2026-07-09

### Changed — หน้าเช่า: ช่อง "ผูกกับ Booking" คลิกแล้วโชว์รายการงานให้เลือกเลย
- `BookingPicker` (ใน `/admin/rentals`) เดิมต้องพิมพ์ ≥2 ตัวอักษรก่อนถึงจะขึ้นรายการ. ตอนนี้**พอคลิก/โฟกัสก็ดึงงานล่าสุดมาโชว์ทันที** (ไม่ต้องรู้รหัสก่อน) — เลือกจากลิสต์ผูกกับงานเช่าได้เลย, พิมพ์เพื่อค้นหาแคบลงเหมือนเดิม. ใช้ `/api/bookings?scope=all&limit=15` (เรียง shootDate ใหม่สุดก่อน) สำหรับลิสต์ default; มี header "เลือกงาน · พิมพ์เพื่อค้นหา" กำกับ. ตามที่ ops ขอ: เชื่อมโยง booking ↔ งานเช่าให้ง่ายขึ้น.

---

## [1.145.3] — 2026-07-13

### Fixed — PATCH booking รับ `director`/`directorEmail` (แก้อีเมล Director ที่บันทึกผิดได้)
- ใช้กวาดแก้ booking เก่าที่เก็บ `tanapak.l@` (ที่อยู่ไม่มีจริง — I/l typo ในชีท _Users ที่แก้ไปแล้ว) → `tanapak.i@` โดยเฉพาะงาน CONFIRMED ที่ calendar ยังพยายามเชิญที่อยู่ตาย.

---

## [1.145.2] — 2026-07-13

### Changed — ป้ายวันของงานหลายวัน: "ต่อ" → ตัวนับวัน + drawer โชว์ช่วงวันที่
- ป้ายบนปฏิทิน/agenda/day drawer เปลี่ยนจาก "ต่อ" เป็น **ตัวนับวัน** (`2/6`…`6/6`; วันแรกโชว์เวลา call พร้อม `1/6` กำกับ) — เห็นทันทีว่าเป็นวันที่เท่าไรของกอง.
- **Booking drawer › Schedule** โชว์**ช่วงวันที่เต็ม** เช่น "Wed 22 → Mon 27 Jul 2026 · 6 วัน" (เดิมโชว์วันแรกวันเดียว) — ใช้ formatDateRange เดียวกับหน้า detail.

---

## [1.145.1] — 2026-07-13

### Fixed — Calendar View: งานถ่ายหลายวันแสดงทุกวันในช่วง (เดิมโผล่แค่วันแรก)
- ปฏิทินในระบบ (month grid + agenda + day drawer) จัดงานที่มี `shootEndDate` ลง**ทุกวัน**ของช่วงถ่าย ไม่ใช่เฉพาะวันเริ่ม. วันต่อเนื่องติดป้าย **"ต่อ"** แทนเวลา call ของวันแรก (chip ในตาราง + แถวใน agenda/day drawer มี tooltip ช่วงวันเต็ม). กันข้อมูลเพี้ยน: end < start ถือว่าวันเดียว, ช่วงยาวเกิน 31 วันถูกตัด (กันปีพิมพ์ผิดท่วมตาราง).

---

## [1.145.0] — 2026-07-13

### Changed — ฟอร์มงานเช่า: เลือกงานแล้ว "เติมให้เลย" + แยก "ชื่องาน" ออกจาก "เช่าอะไร"
ตาม ops: "มันควรจะเป็นชื่องานอะไร แล้วเขาเช่าอะไร ไม่ใช่ให้ผมไปใส่เช่าอะไรที่ชื่องาน"
- เลือก Booking ในฟอร์ม → **เติมอัตโนมัติ**: ชื่องาน (ชื่อโชว์/งานจริง) · AD/NON-AD (จาก category) · Quote No. (จาก Agency Ref) · วันเช่า/กำหนดคืน (จากวันถ่าย) · Outlet · และ **"เช่าอะไร" ดึงจากช่อง 📦 เช่า ใน Week Plan** ของงานนั้น (เติมเฉพาะช่องที่ยังว่าง — ไม่ทับที่พิมพ์ไว้; ชื่องาน mirror ตาม booking เสมอ). ปุ่ม "เพิ่มงานเช่า" จากหน้างานก็ได้ prefill ชุดเดียวกัน.
- คอลัมน์ใหม่ `RentalJob.items` ("เช่าอะไร") — โชว์บนการ์ด (📦) + ค้นหาได้; ชื่องาน = ชื่องานจริงเสมอ.
- **Migration ข้อมูลเก่า**: `POST /api/admin/rentals/backfill-from-booking?apply=1` (admin, dry-run ดีฟอลต์) — งานเช่า live ที่ผูก booking: ย้ายชื่อเดิม (ที่เป็นรายการเช่า) → items, ตั้งชื่องานจาก booking, เติม AD/QU/วันเช่า/Outlet ที่ว่าง. ARCHIVED + งานที่ไม่ผูกไม่แตะ. Idempotent.

### Added — Week Plan: ปุ่ม "👁 ดูสรุป"
มุมมองอ่านง่าย (ตาม ops "พอใส่เยอะๆ มันดูยาก"): แถวข้อความเต็มไม่มีกล่อง/สกรอลบาร์ สแกนไล่ทั้งวันได้ · สลับกลับ "✏️ พิมพ์" ได้ปุ่มเดียว · จำโหมดล่าสุดไว้ (localStorage).

---

## [1.144.0] — 2026-07-12

### Changed — Booking picker หน้าเช่า: กรองตามวัน + โชว์ชื่องานจริง (เหมือน My Bookings)
- แถวในลิสต์ "ผูกกับ Booking" เปลี่ยนจาก รหัส+โปรดิวเซอร์ → **ชื่อโชว์/งานจริง** (`bookingDisplayName` แบบเดียวกับ /my-bookings) + ชื่อตอน + บรรทัดล่าง `รหัส · วันถ่าย · โปรดิวเซอร์`.
- เพิ่ม **ช่องเลือกวันที่** ในกล่องค้นหา → กรองลิสต์เหลือเฉพาะงานของวันถ่ายนั้น (`/api/bookings?date=` ที่มีอยู่แล้ว; ใช้คู่กับพิมพ์ค้นหาได้, ปุ่ม × ล้างตัวกรอง). งานที่ไม่มี Production ID ถูกซ่อน (ผูกไม่ได้อยู่แล้ว).
- จาก review: ปิดลิสต์ด้วยคลิกข้างนอก/Esc ได้แล้ว · เปลี่ยนวันแล้วเคลียร์แถวเก่าทันที (ไม่ค้างใต้หัวข้อวันใหม่) · เพิ่ม limit เผื่อแถวที่ถูกซ่อน · empty-state ครบทุกโหมด · กันชื่อตอนซ้ำกับชื่องานแบบ partial.

### Changed — Week Plan: เปลี่ยนจาก chip จัดกล้อง → 2 ช่องพิมพ์ "อุปกรณ์ / เช่า" (ops: "ให้ผมพิมพ์ก่อน")
- แต่ละงานในหน้า `/admin/week-plan` เหลือ 2 ช่อง textarea: **🎬 อุปกรณ์** (`equipmentNote`) และ **📦 เช่า** (`rentalGearNote`) — พิมพ์แล้วบันทึกอัตโนมัติ (debounce 700ms), โชว์ต่อในหน้า Booking + คำอธิบาย Google Calendar event เหมือนเดิม. Header วันสรุป "✍️ ใส่แล้ว x/y".
- ระบบ chip จัดกล้องรายตัว + ⚡ auto-assign + เตือนชนเวลา ถูกถอดจากหน้านี้ (โค้ดอยู่ใน git history; ข้อมูล `assignedEquipmentIds` เดิมไม่ถูกแตะ และงานที่เคยจัดกล้องไว้ยังโชว์ "📷 จัดไว้เดิม: …" แบบอ่านอย่างเดียว) — "ใส่ข้อความก่อน ปรับกันทีหลัง".
- **โน้ตทั้งสองช่องขึ้น Google Calendar จริง** — `buildEventDescription` เพิ่มบรรทัด `🎬 อุปกรณ์:` / `📦 เช่า:` (เดิมหน้าเคลมแต่ builder ไม่รู้จัก field — review จับได้) และ thread ผ่านทุกจุดสร้าง event (approve/assign/reconcile ครบ 3 จุด recreate).
- **ข้อความที่พิมพ์ไม่มีวันหาย**: PATCH ล้มเหลว → คืน patch เข้าคิว + retry อัตโนมัติ 3 วิ (ไม่ reload ทับที่กำลังพิมพ์) · re-sync แบบ background ไม่ unmount textarea · เปลี่ยนสัปดาห์ flush ค่าที่ค้างก่อน · reload/ปิดแท็บ flush ด้วย keepalive · reminder "ยังไม่จัดอุปกรณ์" นับช่อง เช่า ด้วยแล้ว.

---

## [1.143.1] — 2026-07-12

### Changed — จำกัด Director picker ไว้ที่ Content Agency ตามเดิม (ops: "มีแค่ของ Content Agency อย่างเดียวพอ")
- ถอน dropdown "Video Director" ของ outlet อื่นออกจาก wizard + ลบ `GET /api/team/directors` (เพิ่มใน 1.143.0 — ใช้งานจริงแค่ AGN). **ระบบอัตโนมัติตอน Approve คงอยู่ครบ**: Director ที่เลือกในฟอร์ม AGN ถูกเชิญเข้า Google Calendar + ได้เมลมอบหมายงาน + ไม่โดนถอดตอน re-assign/reconcile.

---

## [1.143.0] — 2026-07-12

### Added — Director ที่เลือกตอนจอง (AGN) → Approve แล้วเชิญเข้า Calendar + ส่งเมลอัตโนมัติ
ตามที่ ops ขอ: "ให้คน Assign มันไม่ทำหรอก" — Director ที่ถูกเลือกตั้งแต่ตอนจองจะถูกดูแลโดยระบบเอง ไม่ต้องรอใครมา assign.
- ฟอร์ม AGN มี Director select อยู่แล้ว → เก็บลง `Booking.director`/`directorEmail`; โชว์ในหน้า booking detail (🎬 Director). *(1.143.0 เคยเพิ่ม picker ให้ outlet อื่นด้วย — ถอนออกใน 1.143.1 ตาม ops.)*
- **ตอน Approve:** (1) directorEmail ถูก union เข้า **attendees ของ Google Calendar event** (คู่กับ producer/crew, dedupe case-insensitive) → Google ส่ง invite ให้เอง (2) ส่ง **assignment email** ("คุณได้รับมอบหมายงาน Production ใหม่") ให้ Director ด้วย — ข้ามถ้า Director คือคน approve เองหรือคนจองเอง (ได้เมลยืนยันไปแล้ว). Best-effort ไม่บล็อก approve.
- **คงอยู่ถาวร:** re-assign ทีม (assign route) และ calendar reconciler (10-min sweep + resync) union director เข้า attendee set เหมือน producer — director ไม่โดนถอดออกจาก event ตอน patch/recreate (`withProducer()` รับ directorEmail เพิ่ม — ครบทั้ง 3 จุด recreate).
- จาก adversarial review ก่อน ship: กรอง `active: true` ใน `/api/team/directors` (director ที่ถูกลบต้องไม่โผล่) + seed fallback เฉพาะตอน DB error · reset ตัวเลือก director ตอนเปลี่ยน Outlet · โชว์ director ในหน้า Review/สรุป (non-AGN) · draft autosave จำ director · กันส่งเมลซ้ำตอน re-open (COMPLETED→CONFIRMED).
- **หมายเหตุ:** booking AGN ที่ CONFIRMED อยู่แล้วและมี director — reconcile รอบแรกหลัง deploy จะเชิญ director เหล่านั้นเข้า event ด้วย (พฤติกรรมตรงตามฟีเจอร์ — director ควรอยู่ใน invite ของงานที่ยัง active).

---

## [1.142.0] — 2026-07-09

### Added — หน้างานโชว์ "งานเช่า" ของงานนั้น (เชื่อมโยง booking ↔ งานเช่า สองทาง)
เดิมลิงก์ไปทางเดียว (การ์ดงานเช่า → หน้างาน). ตอนนี้เปิดหน้างานก็เห็นงานเช่าที่ผูกไว้ทั้งหมด.
- **Section "📦 งานเช่า"** ในหน้า booking (`/admin/[id]`) + calendar drawer: ลิสต์งานเช่าของงานนั้น — vendor · ยอดเงิน · สถานะเช่า/จ่าย · เอกสารครบ/ขาด (5 ใบ) · เตือน "เกินกำหนดคืน" + ปุ่ม **"เพิ่มงานเช่า"** ที่พาไปหน้าเช่าพร้อม**ผูก booking นี้ให้อัตโนมัติ** และคลิกงานเช่าเปิดแก้ไขได้เลย (`?focus=<id>`).
- **Endpoint ใหม่ `GET /api/bookings/[id]/rentals`** — console-only (ข้อมูลการเงิน: vendor/ยอด/ใบเสร็จ). หน้างานที่โปรดิวเซอร์เปิดดูได้จะไม่เห็น section นี้ (403 → ไม่ render อะไรเลย, drawer gate ด้วย canEdit). Component กลาง `src/app/_components/BookingRentals.tsx`.
- Deep-link เข้า `/admin/rentals`: `?newForBooking=<id>&code=<code>` เปิดฟอร์มเพิ่มพร้อมผูกงาน · `?focus=<rentalId>` เปิดงานเช่านั้นเพื่อแก้ไข (URL ถูกล้างหลังเปิด ไม่เด้งซ้ำตอน refresh).

---

## [1.141.0] — 2026-07-09

### Added — สร้างโฟลเดอร์ดรอปของงานเดียวแบบ on-demand ("ขอเพิ่มพิเศษ")
- `GET /api/internal/landing/manage?create=<Production ID>` (admin) — สร้างโฟลเดอร์ landing ของ **booking ที่ระบุ** ตัวเดียว (idempotent — มีอยู่แล้วใช้ซ้ำ). ต่างจาก `?offset=N` ที่ทำได้เฉพาะวันในอนาคต — `?create=` ใช้กับงาน**ย้อนหลัง/จบไปแล้ว**ที่โดน prune ไปแต่ต้องอัปไฟล์เพิ่มได้ด้วย. `ensureLandingForBooking()` ใน landing-lifecycle.ts; ข้ามงาน photo/ไม่มีกล้อง/outlet ไม่มี mapping พร้อมเหตุผล. เป็นเครื่องมือหลักของเคส "ขอเพิ่มพิเศษ" ใน `docs/landing-folder-policy.md`.
- **Guard: งานที่ footage ส่งมอบแล้ว → ไม่สร้าง drop.** `ensureLandingForBooking()` เช็คก่อนสร้างว่ามีไฟล์จริง (นอกจาก `_SHOOT` stub) อยู่ใต้ Production ID นั้นไหม (`findFoldersByCode` → `listFilesRecursive`) — ถ้ามี = ย้ายเข้ากล่อง box แล้ว → คืน `footage already delivered` ไม่สร้างโฟลเดอร์ว่างซ้ำ (mirror ตรรกะ delivered-check ของ prep-folders). ตามที่ ops กำชับ 2026-07-09: "งานไหนย้ายไฟล์แล้ว ไม่ต้องสร้าง drop มา" (เคส TSS-KDM-260708-01 มี 84 ไฟล์ใน box อยู่แล้ว).

---

## [1.140.0] — 2026-07-09

### Added — prune landing drive ให้เหลือเฉพาะงานวันนี้ (คำสั่งมือ)
- `GET /api/internal/landing/manage?prune=today&keep=<ชื่อโฟลเดอร์>` (admin) — ลบโฟลเดอร์ดรอปที่**ไม่ใช่งานวันนี้** (Bangkok) ทิ้ง เว้นชื่อใน `keep` (ใส่ซ้ำได้). ปลอดภัย: ลบเฉพาะโฟลเดอร์**ว่าง**; โฟลเดอร์ที่มี footage หรือโฟลเดอร์ manual (ไม่มี Production ID ในชื่อ) จะ**เก็บไว้ + รายงาน** ไม่ลบเงียบ. dryRun ดีฟอลต์. `pruneLandingToToday()` ใน landing-lifecycle.ts.

---

## [1.139.0] — 2026-07-09

### Changed — โฟลเดอร์ดรอปไฟล์ "Production Team" เป็นระบบ **สร้างเฉพาะงานวันถัดไป + เก็บ drive ให้ lean**
ตามที่ตกลง (ops 2026-07-09): drop drive ต้องโล่ง เห็นเฉพาะงานที่เกี่ยวข้องตอนนี้ ไม่ใช่โฟลเดอร์ของงานที่จบไปแล้วเป็นกอง (ก่อนหน้านี้ผมรีสโตร์ย้อนหลัง 21 วันมาทั้งหมด = รก — แก้แล้ว).
- **Policy ใหม่ (มี MD: `docs/landing-folder-policy.md`):** สร้างโฟลเดอร์ดรอป **เฉพาะงาน "วันถัดไป"** ตอนเย็นวันก่อนหน้า (ไม่สร้างล่วงหน้าไกลกว่านั้น) · เก็บไว้ระหว่างวันถ่าย + ช่วงอัปโหลด (`LANDING_KEEP_PAST_DAYS`, default 3 วัน) · **ลบโฟลเดอร์ว่าง**ของงานที่จบเกิน grace แล้วเท่านั้น (มีไฟล์ = ไม่แตะ).
- **worker ใหม่ `scripts/landing-worker.js`** (ON by default) รันทุกคืน `LANDING_WORKER_HOUR` (default 19:00 น. BKK): สร้างงานพรุ่งนี้ + ลบของเก่าที่ว่าง + ส่งอีเมลสรุป (`LANDING_REPORT_EMAIL`). Logic: `src/lib/landing-lifecycle.ts`; endpoint `GET /api/internal/landing/manage` (dryRun ดีฟอลต์; `?offset=N` สร้างล่วงหน้ากรณีพิเศษ).
- **prep-folders เลิกสร้าง landing** (คงสร้างแค่กล่อง VIDEO 2026 ของวันนี้) — ถอด `?days` catch-up + delivered-branch ensure (ที่ผมทำเฉพาะหน้ารอบก่อน) ออก. `video-merge` ยังไม่ trash landing (v1.137) — การลบเป็นหน้าที่ lifecycle นี้ (past+empty เท่านั้น) กันโฟลเดอร์หายระหว่างถ่าย.

---

## [1.138.0] — 2026-07-09

### Added — dedup โฟลเดอร์ landing ซ้ำใน "Production Team"
- ตอนกู้โฟลเดอร์ (v1.137 catch-up) ถ้ารันซ้อนกันอาจสร้างโฟลเดอร์ดรอปของกองเดียวกัน 2 อัน — `dedupeLandingFolders` (src/lib/landing-dedup.ts) เก็บ**อันเดียวต่อ 1 Production ID** แล้ว trash เฉพาะ **shell ว่างที่ซ้ำ** (โฟลเดอร์ที่มีไฟล์จริงไม่แตะเด็ดขาด; ถ้า 2 อันมีไฟล์ทั้งคู่ → รายงานให้คนรวมเอง). เร็ว (list ราก 1 ครั้ง). `GET /api/internal/landing-dedup/run?dryRun=1` (admin/secret; dryRun ดีฟอลต์).

---

## [1.137.0] — 2026-07-09

### Fixed — โฟลเดอร์ดรอปไฟล์ใน "Production Team" หายเอง (คนลงไฟล์ไม่ได้)
- **ต้นตอ (2 worker รวมกัน):** (1) `video-merge` ย้าย footage เข้า box แล้ว **trash โฟลเดอร์ landing** ทิ้ง (`cleanupLandingShell`), (2) `prep-folders` พอเห็น footage อยู่ใน box แล้ว **ข้ามไม่สร้าง landing ใหม่** ("skip empty re-prep") → โฟลเดอร์ดรอปไฟล์รายวันหายถาวร ทีมงานอัปโหลด batch ต่อไป/วันถัดไปไม่ได้.
- **แก้:** landing = ที่ดรอปไฟล์**ถาวร** ไม่ใช่ของชั่วคราว. `video-merge` **เลิก trash landing โดยดีฟอลต์** (footage อยู่ใน box ปลอดภัยแล้ว เหลือ shell ว่างไว้เป็นที่ดรอป; เปิด cleanup คืนด้วย `VIDEO_MERGE_TRASH_LANDING=1` ถ้าอยากเคลียร์). `prep-folders` พอ delivered แล้ว **ยัง ensure โฟลเดอร์ landing ไว้เสมอ** (แต่ไม่สร้าง box skeleton ซ้ำ กัน ghost loop) → โฟลเดอร์ดรอปของงานวันนี้กลับมา + ไม่หายอีก.
- โฟลเดอร์ที่หายไปก่อนหน้าอยู่ใน Drive trash (กู้ได้ ~30 วัน) — prep tick ถัดไปจะสร้างของงานวันนี้กลับให้เอง.
- **กู้ย้อนหลังครั้งเดียว:** `GET /api/internal/prep-folders/run?days=N` (admin) สร้างโฟลเดอร์ landing ของงานย้อนหลัง N วันกลับมาให้ครบในรอบเดียว (reuse logic เดิม + landing-ensure ใหม่ ปลอดภัย).

---

## [1.136.0] — 2026-07-09

### Changed — worker เก็บกวาด `_SHOOT` marker: ตรวจ**เนื้อไฟล์**ด้วย + รัน**ทุกคืน** + ส่งรายงาน
- ต่อยอด v1.135 (เดิมดู marker ซ้ำจากชื่อไฟล์อย่างเดียว) — ตอนนี้ worker **อ่านเนื้อ marker** ทุกอันแล้วเทียบกับ DB: ถ้าบรรทัด `Production ID :` ไม่ตรง code ปัจจุบัน **หรือ** วันที่เป็นปีพุทธ (≥2500 เช่น 2569/3112) → **เขียน marker ใหม่จาก DB** (ID typeless + วันที่ ค.ศ.). สร้าง marker ให้ถ้ากอง CONFIRMED/COMPLETED มีโฟลเดอร์แต่ยังไม่มี marker. โฟลเดอร์ที่ชื่อยังติด TYPE → **เตือน** (ไม่ rename เอง เพราะเป็นงานของ regenerateBookingId).
- **รันทุกคืน** (default 03:00 น. BKK ตั้งได้ด้วย `SHOOT_MARKER_WORKER_HOUR`) แทน interval รายชม. — marker drift ช้า ทุกคืนพอ.
- **ส่งรายงานอีเมล** (`SHOOT_MARKER_REPORT_EMAIL`, default = `FEEDBACK_EMAIL`) ทุกคืนที่เจอ/แก้อะไร: สรุปจำนวนที่ลบซ้ำ/ลบค้าง/ย้าย/เขียนใหม่/สร้าง + รายการ "ต้องดูเอง" (โฟลเดอร์ติด TYPE, กำกวม, orphan) + รายละเอียดต่อ box. คืนที่ clean = เงียบ (ไม่กวน). Dry-run/แอดมินกดเองใส่ `?report=1` เพื่อบังคับส่ง.
- เพิ่ม `readDriveTextFile` (google-drive.ts) อ่านเนื้อไฟล์ Drive; endpoint เดิมรับ `report=1`.

---

## [1.135.0] — 2026-07-09

### Added — worker เก็บกวาด `_SHOOT` marker ซ้ำ (footage 1 กอง = การ์ด 1 ใบ)
- **ต้นตอ (Neo memo 2026-07-09 ข้อ 3):** กล่อง project ของ AGN มี `_SHOOT` marker กองเดียวกัน **2 อัน** — box-level `_SHOOT-AGN-260708-LOC-01.txt` (ของเก่าก่อน migration มี TYPE) + subfolder `_SHOOT.txt` (ปัจจุบัน). crawler เก็บทั้งคู่ → หยอดการ์ด footage 2 ใบต่อ 1 กอง และกลับมาทุกรอบ deposit.
- **แก้ยั่งยืน:** `reconcileShootMarkers` (src/lib/shoot-marker-reconcile.ts) บังคับกติกา **"1 marker ต่อ 1 กอง อยู่ใน subfolder ของ booking"** ต่อกล่อง AGN: dedupe `_SHOOT.txt` ในแต่ละ subfolder, แล้ว box-level `_SHOOT-<id>.txt` ตัวไหน — parse ID + ตัด [TYPE] (LOC/STD → typeless) เทียบ DB — ถ้า booking มี marker ใน subfolder อยู่แล้ว → **trash ตัวซ้ำ**; ถ้า subfolder ยังไม่มี marker → **ย้ายเข้าไปเป็น `_SHOOT.txt`**; ถ้าไม่ตรง booking ไหนเลย → **trash (stale)**. ลบเฉพาะไฟล์ stub เล็กๆ ที่สร้างใหม่ได้ → ลง Shared Drive trash (กู้คืนได้ ~30 วัน), ไม่แตะโฟลเดอร์ footage. Idempotent + dry-run ก่อนเสมอ.
- **worker + endpoint:** `scripts/shoot-marker-worker.js` (supervised, ปิดโดยดีฟอลต์ — เปิดด้วย `SHOOT_MARKER_WORKER_ENABLED=1`, ราย ชม.) เรียก `GET /api/internal/shoot-markers/reconcile` (auth: shared secret สำหรับ worker / ADMIN session สำหรับ dry-run บนเบราว์เซอร์; `dryRun` เป็นดีฟอลต์ — ต้อง `dryRun=0` ถึงจะแก้จริง). Audit ทุกครั้งที่แก้ Drive จริง.
- ป้องกันไม่ให้เกิดใหม่: โค้ดปัจจุบันเขียนแค่ `_SHOOT.txt` ใน subfolder เท่านั้น (ไม่มี path ไหนเขียน box-level `_SHOOT-<code>.txt` แล้ว) — worker คอยกวาดของค้าง/ที่หลุดเข้ามาจาก re-import หรือแก้ Drive มือ.

---

## [1.134.0] — 2026-07-09

### Fixed — วันที่ในไฟล์ `_SHOOT.txt` เพี้ยนเป็นปีพุทธ (+543) / ซ้อนเป็น 3112
- Marker `_SHOOT.txt` เคย render วันที่ด้วย `th-TH` เฉยๆ ซึ่ง default เป็น**ปฏิทินพุทธ** → งานปกติปี 2026 ขึ้นเป็น "2 ก.ค. 2569", และงานที่ shootDate เผลอถูกเก็บเป็นพุทธ-2569 อยู่แล้วก็ซ้อนเป็น "2 ก.ค. 3112" (บวก 543 สองรอบ — ตาม memo 2026-07-09). แก้เป็น `th-TH-u-ca-gregory` ให้ออกเป็น ค.ศ. ("2 ก.ค. 2026") ตรงกับที่แอปที่อื่นใช้อยู่แล้ว.

### Fixed — กัน Production ID ปีเพี้ยน (AGN-69… แทน AGN-26…) ให้ครบทุกทาง
- ต้นตอ ID ปี "69": ถ้า `shootDate` ถูกเก็บเป็นปีพุทธ (2569) → `generateEpisodeId` ตัด 2 หลักท้ายได้ "69" แทน "26". รวม guard แปลงปีพุทธ→ค.ศ. เป็น helper กลาง `normalizeBuddhistYear` (src/lib/thai-date.ts) ใช้ร่วมกันทั้ง**ทางสร้าง** (createBookingFromPayload — ครอบ wizard/routine/MCP/API) และ**ทางแก้ไข** (PATCH shootEndDate ที่เดิมไม่มี guard) — เพิ่มเทสครบ.
- งาน Hat Yai ที่ memo พูดถึง (PP-26-025-S05) **DB ถูกต้องอยู่แล้ว** = `AGN-260702-02` (ปี 26, 2 ก.ค. 2026); `AGN-690702-LOC-01` ที่เจอเป็น marker เก่าค้างบน Drive ก่อน migration.

### หมายเหตุ — Production ID เพี้ยนระหว่างโฟลเดอร์/marker กับ Bookings sheet
- ปัจจุบันทั้งชื่อโฟลเดอร์ / marker / sheet มาจาก `Booking.bookingCode` เดียวกันหมด (typeless) — ตรงกันแล้วสำหรับงานใหม่. ส่วนที่เพี้ยนคือ**โฟลเดอร์/marker เก่าก่อน migration v1.109** ที่ยังค้าง ID เดิม (มี TYPE / ปี 69) — เป็น data ค้างบน Drive ไม่ใช่บั๊กโค้ดปัจจุบัน. รอตัดสินใจแนวทางเก็บกวาด (แตะ prod Drive) แยกต่างหาก.

---

## [1.133.0] — 2026-07-08

### Added — กล่องติชม/แจ้งปัญหา ลอยมุมขวาล่างทุกหน้า (Feedback box)
- ปุ่มม่วง "ติชม / แจ้งปัญหา" ลอยมุมขวาล่างทุกหน้า (เฉพาะคนที่ล็อกอินแล้ว) → เปิดกล่องเลือกอารมณ์ (😊 ชอบเลย / 😖 เจอปัญหา / 💡 มีไอเดีย) + พิมพ์ข้อความ + ส่ง — ออกแบบให้ง่าย เป็นมิตรทุกวัย.
- ส่งเป็นอีเมลเข้า `FEEDBACK_EMAIL` (default narasit.k) พร้อมชื่อผู้ส่ง + หน้าที่กดส่ง + เวลา — ตอบกลับหาคนส่งได้เลย. บันทึกลง AuditLog ด้วย (`feedback.submitted`) เผื่ออีเมลล่ม ข้อความไม่หาย.
- ซ่อนเฉพาะหน้า `/new` (ปุ่มลอยชนแถบ "ยืนยันการจอง" บนมือถือ).

---

## [1.132.0] — 2026-07-08

### Changed — การ์ดงาน AD เป็นสีอำพันทุกหน้า (global UI)
- ต่อยอดจาก v1.131: booking ที่เป็น **Advertorial** ตอนนี้การ์ด/แถวทั้งใบติดสีเดียวกันหมด (ขอบซ้ายอำพัน + พื้นอำพันจาง + ป้าย "AD") ผ่าน helper กลาง `categoryCardClass()` ใน `StatusPill.tsx` — ใช้ที่ **คิวงาน admin**, **My Bookings**, **Overview (หน้าแรก)**, **Producer dashboard**, **หน้า Upload**, และ header หน้า `/dashboard/[id]` (ป้าย AD แทนข้อความเทา). ปฏิทิน/drawer/ตารางห้อง ได้ไปแล้วตั้งแต่ v1.131 — ตอนนี้ "งาน AD" อ่านเหมือนกันทุกจุดในแอป.

---

## [1.131.0] — 2026-07-08

### Added — สีเน้น AD/Original Content ในปฏิทิน
- เดือน/agenda/day-drawer: booking ที่เป็น **AD (Advertorial)** มีป้าย "AD" สีอำพัน + ขอบซ้ายสีอำพันบน month-grid chip + ring บน mobile dot — เทียบง่ายกับงาน Original Content โดยไม่ไปรบกวนสีสถานะเดิม.

### Added — จองรถตู้ได้มากกว่า 1 คัน
- `needsVan` (Boolean) → `vanCount` (จำนวนคัน) ทั้ง wizard/admin/drawer/producer self-edit — ใช้ NumberStepper/number input แทน checkbox. ชื่องานบนปฏิทิน (เว็บ+Google) และอีเมลขึ้น 🚐 ×N เมื่อมากกว่า 1 คัน. **DB ไม่มี migration ทำลายข้อมูล**: เพิ่มคอลัมน์ `vanCount` ใหม่ + backfill จาก `needsVan=true` เดิมตอน boot (`start.sh`), คอลัมน์ `needsVan` เก่ายังอยู่เป็น legacy.

### Added — ตารางห้อง/สตูดิโอ ดูว่าวันไหนว่าง (`/admin/room-schedule`)
- หน้าใหม่สำหรับ Management: เลือกวันที่ → เห็นทุกห้อง (Studio/A/B) เป็น timeline 07:00–23:00 พร้อมช่วงที่ถูกจองสีตามสถานะ + ป้าย AD, "ว่างทั้งวัน" ถ้าไม่มีคิว, และ list แยกสำหรับ booking ที่ location ไม่ตรงกับห้องในระบบ (กัน silent-drop จากข้อมูลเก่า/พิมพ์เอง). อ่านอย่างเดียว ไม่มีการเขียน — เข้าได้ทุก console tier (ไม่ใช่แค่ ADMIN).

### Changed — Calendar Packet กลายเป็นรายละเอียดการจองแบบอ่านง่าย มีสีเน้น
- แทนที่ text block แบบ copy-paste ล้วน ด้วย component ใหม่ (`CalendarPacketDetails`) ที่จัดเป็นหมวดหมู่ชัดเจน (เวลา/วันที่/สถานที่/Production Project/Producer/Crew/NAS) — **Notes เด่นเป็นพิเศษด้วยกรอบสีแดง** เพราะสำคัญ, เก็บบรรทัดตามที่พิมพ์มาจริง. ใช้ทั้งหน้า `/dashboard/[id]` และ `/booking/success`; ปุ่ม Copy ยังคัดลอก plain-text เดิมได้เหมือนเดิม (เผื่อวางในแชท/ปฏิทินอื่น).
- ตัด field ที่ซ้ำกับ Calendar Packet ออกจากหัวข้อ booking ในหน้า `/dashboard/[id]` (Producer/Creative/Crew/Agency Ref) เหลือแค่ "ทีมงาน (assigned)" ที่ไม่มีที่อื่นแสดง.

### Fixed — โน้ตในหน้ารีวิวจองงาน (wizard) รวมเป็นบรรทัดเดียว
- ขั้นตอน Review ของ booking wizard ไม่ได้ใส่ `whitespace-pre-line` ให้ค่าที่แสดง — โน้ตหลายบรรทัดเลยรวมเป็นก้อนเดียวอ่านไม่รู้เรื่อง (คนละจุดกับหน้า admin/dashboard ที่แก้ไปแล้วก่อนหน้านี้).

### Fixed — user ทั่วไปกด booking จากหน้า Overview เจอ Forbidden
- หน้า Overview (`/`) โชว์ทุก booking ที่ CONFIRMED ให้ทุกคนดู (ตั้งใจ เพื่อวางแผนกำลังคน) แต่กดเข้าไปดูรายละเอียดกลับโดน 403 เพราะ `canViewBooking` ไม่รู้จักเงื่อนไข "CONFIRMED = ดูได้ทุกคน" — แก้ให้ตรงกับ list แล้ว.

### Changed — Confirm booking แล้วอีเมลไปหาคนจอง + เชิญ Producer เข้า Google Calendar
- Approve (CONFIRMED) ตอนนี้ส่งอีเมลแจ้งไปหา `createdByEmail` (คนจอง) ด้วย (เดิมไม่มีอีเมลอะไรส่งเลยตอน confirm), และเพิ่ม Producer เป็น guest ใน Google Calendar event (เดิมมีแค่ทีมที่ assign) — คงอยู่ข้าม re-assign/reconcile รอบต่อไปด้วย (ไม่ถูก patch หลุดออกไป).

### Changed — ช่อง Agency Ref (QU-xxxx) โชว์เฉพาะงาน AD
- Product Code / Agency Ref เป็นรหัสอ้างอิงฝั่ง agency ที่มีความหมายเฉพาะงาน Advertorial — ซ่อนช่องนี้เมื่อเลือก Original Content ทั้งใน wizard/admin edit/drawer (ยังโชว์ถ้ามีค่าเก่าอยู่แล้วในบันทึกที่ไม่ใช่ AD กันข้อมูลหาย).

### Changed — ปุ่ม Original Content / AD ในฟอร์มจองห่างกันขึ้น
- ป้องกันกดพลาดสลับ AD ↔ Original Content โดยไม่ตั้งใจ (`gap-2` → `gap-4`).

---

## [1.130.0] — 2026-07-08

### Removed — ถอดการผูก Wasabi ออกจากเส้นทางอัปโหลดทั้งหมด (Drive เป็นปลายทางเดียว)
- `/api/upload/init|complete|cancel|list` เลิกยุ่งกับ Wasabi ทั้งหมด: ไม่ presign multipart, ไม่ verify ฝั่ง S3, ไม่ abort ตอน cancel — เหลือ Drive resumable upload เส้นเดียว. ลบ `src/lib/wasabi.ts`, `uploadToWasabi` ใน upload-client, ถอด dependency `@aws-sdk/*` ออกจาก package.json.
- UI: checkbox "ส่ง Wasabi ด้วย" + ป้าย DUAL + progress bar Wasabi หายไปจากหน้า upload/UploadSection.
- **DB ไม่แตะ** (ไม่มี migration): คอลัมน์ `wasabi*`, enum `DRIVE_OK`/`WASABI_OK`, `storagePolicy` ยังอยู่เป็น legacy เพื่อไม่ทำลายแถวเก่า — โค้ดไม่เขียนค่าเหล่านี้อีกแล้ว. compose/env ตัด `WASABI_*` ออก (ตัวแปรใน stack env เก่าไม่มีผลอะไร).

### Fixed — dropdown โปรดิวเซอร์ใน drawer ปฏิทินติดรายชื่อทีมอื่น (เวลธ์โผล่ในงานข่าว)
- `BookingDrawer` เคย fetch รายชื่อครั้งเดียวแล้ว cache ข้าม booking (`if (producers.length === 0)`) — เปิดงาน Wealth ก่อนแล้วค่อยเปิดงานข่าวจะเห็น ปิ่น/แอ๊นท์ ในงานข่าว. ตอนนี้ล้าง list ตอนสลับ booking + fetch ใหม่ตาม outlet ทุกครั้งที่เข้าโหมดแก้ไข (มี dead-flag กัน response ช้ามาทับ) + ระหว่างโหลดล็อกช่องกันพิมพ์แล้ว email หลุด. ข้อมูล `producerOutlets` ใน DB ตรวจแล้วถูกต้องครบทุก outlet และไม่มี booking ไหนถูกเซฟชื่อผิดทีม (สแกน 184 งาน).

### Fixed — /upload เปิดงานจาก list แล้วติดข้อมูลงานอื่น
- คลิกงานจากรายการ: render แรก `single` เคยชี้ไปงานบนสุดของ list (ไม่ใช่งานที่คลิก) แล้ว `UploadSection` จำ state ต่องาน (EP ที่เลือก) ของงานผิดไว้ → อัปโหลดโดน 400 BAD_EPISODE ทุกไฟล์จนต้อง reload. ตอนนี้จับคู่ด้วย id + `key={booking.id}` ให้ remount ต่องาน, และล้าง error banner ค้างจากงานก่อนหน้า.

---

## [1.129.0] — 2026-07-08

### Changed — side window ในปฏิทินกลายเป็น Full Edit + จัดทีม (แยกไฟล์เป็น `calendar/BookingDrawer.tsx`)
- **แก้ไขครบทุกฟิลด์เท่าหน้า admin**: โปรดิวเซอร์ (dropdown รายชื่อตาม outlet + พิมพ์เอง), Creative/Host, Crew ที่ต้องการ, กล้อง/ไมค์/จำนวนช่างภาพ/Switcher, Block Shot, รถตู้, อุปกรณ์พิเศษ, จัดอุปกรณ์/ของเช่า/คิวถ่าย (Itinerary), Agency Ref, ชื่อตอนราย EP, Notes + Admin notes — PATCH ตัวเดิม.
- **ปุ่ม "จัดทีม" (Assign)**: เลือกทีมจาก roster จริง (จัดกลุ่มตามตำแหน่ง), เลือกช่างภาพหลัก ⭐, ปุ่ม "บันทึก" / "บันทึก + ส่งเมล" — ใช้ endpoint assign ตัวเดียวกับหน้า admin (อัปเดต guest ปฏิทิน + เมลแจ้งทีม + OT อัตโนมัติ). Freelancers แสดงเป็น chip (แก้ที่หน้า admin).
- **แถบสถานะเหมือนการ์ด My Booking**: ป้ายกล้อง/ไมค์ (หรือ 📦 Block Shot / ⚠️ ไม่ระบุ), ป้าย footage (มีไฟล์/ครบแล้ว), เตือน "⚠️ ทีมงานยังไม่ครบ — ยังขาด: …" (จาก crew-status จริง), รายชื่อคนที่ไปกอง 👥 (ช่างภาพหลักมี ⭐, ชื่อคุณเป็นตัวหนา) + freelancer chips + ส่วน Planning (คิวถ่าย/อุปกรณ์/ของเช่า).

---

## [1.128.0] — 2026-07-07

### Added — แก้ไข booking จากหน้า Calendar (sidebar ขวา) สำหรับ Coordinator ขึ้นไป
- คลิกงานในปฏิทิน → drawer เดิมมีปุ่ม **แก้ไข** (เห็นเฉพาะ role ระดับ Coordinator ขึ้นไป — gate เดียวกับ `requireConsole` ฝั่ง server): แก้เวลา call/wrap, สถานที่, ประเภทถ่าย, โปรดิวเซอร์, จำนวนกล้อง/ไมค์, รถตู้, อุปกรณ์พิเศษ, notes ได้ในที่เดียวโดยไม่ต้องออกจากปฏิทิน (PATCH `/api/bookings/[id]` ตัวเดิม) — ฟิลด์ identity (outlet/รายการ/วันถ่าย/EP) ยังแก้ที่หน้า admin เท่านั้น.
- **กด "วัน" ก็เป็น side window ขวาเหมือนกัน**: รายการงานของวันนั้นเลิกโผล่เป็นการ์ดใต้ปฏิทิน — เปิดเป็น drawer ด้านขวา (มือถือ = bottom sheet), กดงานในรายการเพื่อดู/แก้ไขต่อได้เลย พร้อมปุ่ม ← กลับไปรายการของวัน.

### Added — Projector ในอุปกรณ์พิเศษ + รวมรายการอุปกรณ์เป็นชุดเดียว
- เพิ่ม **Projector** ใน "อุปกรณ์พิเศษ" และย้าย list ที่เคย copy ซ้ำ 3 ที่ (Wizard / producer edit / admin edit) มาเป็น `SPECIAL_EQUIPMENT_OPTIONS` ใน `src/lib/data.ts` ที่เดียว.

### Added — แอดมินแก้ "คิว Block Shot" ได้จากหน้า EDIT
- ฟอร์มแก้ไขในหน้า admin booking เพิ่ม: ติ๊ก **📦 Block Shot** เปิด/ปิดได้ (เดิมตั้งได้ตอนสร้างเท่านั้น), ปรับ **จำนวนช่างภาพ** และ **จำนวน Switcher** ได้ (งาน block shot มักรู้อุปกรณ์จริงทีหลัง) — `PATCH /api/bookings/[id]` รองรับ `isBlockShot` / `videographerCount` / `switcherCount` แล้ว.

### Changed — อีเมล "อัปเดตจาก Producer" ส่งเข้า inbox เดียว
- เมลแจ้ง **Producer แก้ไขรายละเอียดงาน** (producer-edit) และ **ข้อความ/ขอแก้เวลาจาก Producer** (producer-message) เลิกส่งหา admin/queue ทุกคน — ส่งหา **narasit.k คนเดียว** (override ได้ด้วย env `PRODUCER_UPDATE_NOTIFY_EMAIL`, ใส่หลายคนคั่น comma). เมลขอยกเลิกงาน (request-cancel) ไม่เปลี่ยน — ยังไปตาม `CANCEL_NOTIFY_EMAIL`/Manager เดิม.

### Added — endpoint แก้ชื่อรายการ + แก้ชื่อ 7TG
- `POST /api/admin/programs/rename { outletCode, code, newName }` (admin, audited): แก้ชื่อ Program ใน DB (data.ts เป็น seed แบบ create-only — แก้ชื่อแล้วแถวเก่าไม่เปลี่ยน จึงต้องมี endpoint) + rename โฟลเดอร์รายการใน Drive ให้อัตโนมัติถ้ายังใช้ชื่อเก่า.
- แก้ชื่อรายการ POP `7TG`: "7 Things I love about..." → **"7 THINGS WE LOVE ABOUT..."** (data.ts แก้แล้ว; โฟลเดอร์ Drive rename แล้ว; DB row ต้องยิง endpoint นี้หลัง deploy).

---

## [1.127.0] — 2026-07-07

### Changed — video-merge ลีนขึ้นมาก: ย้ายทั้งโฟลเดอร์ + auto-run เมื่อ NAS sync เขียว
- **Fast path ย้ายทั้งโฟลเดอร์ (1 API call ต่อ subtree)**: โฟลเดอร์ย่อยใน landing (EP/กล้อง) ที่ฝั่งกล่องยังไม่มีชื่อซ้ำ — หรือมีแต่เป็น skeleton เปล่าจาก prep (ระบบ trash ตัวเปล่าแล้วเอาของจริงเข้าแทน) — ถูกย้ายทั้งก้อนด้วย `files.update` ครั้งเดียว แทนการย้ายทีละไฟล์ (งาน 300 ไฟล์: ~316 calls → ~10 calls). ทดสอบจริงข้าม Shared Drive (Production Team → Video 2026) ผ่านแล้ว; ถ้า Google ปฏิเสธเมื่อไหร่ fallback กลับ per-file mirror เดิมอัตโนมัติ (dedup ชื่อ+ขนาดยังทำงานใน path นั้น).
- **เก็บกวาด landing shell**: หลัง merge ที่ย้ายของจริงสำเร็จ (ไม่มี error) โฟลเดอร์ landing ที่เหลือแต่ `_SHOOT*.txt` กับโฟลเดอร์เปล่าจะถูก **trash** (กู้คืนได้ ~30 วัน) — เลิกสะสมโครงเปล่าใน Production Team. gate ด้วย "ต้องมีของย้ายในรอบนั้น" กันไปกิน skeleton ที่ prep เพิ่งสร้างรอ NAS.
- **worker ใหม่ `video-merge`** (supervised ใน start.sh, ON by default, heartbeat-monitored): ตั้ง `NAS_DSM_URL/USER/PASS` → poll สถานะ Synology Cloud Sync (SYNO.CloudSync) แล้วสั่ง merge อัตโนมัติทันทีที่ sync เปลี่ยนเป็นเขียว (uptodate) + แจ้งผลเข้า Discord (`?notify=1`, เงียบเมื่อไม่มีอะไรย้าย); ไม่ตั้ง → รันตาม interval รายชั่วโมงแบบ sound-merge. เดิม sweep วิดีโอทั้งระบบรันเฉพาะตอนกดปุ่ม admin เท่านั้น.
- ผล merge รายงาน `movedFolders` เพิ่ม (UI ทั้ง 3 จุดอัปเดตเป็น "ย้าย X ไฟล์ + Y โฟลเดอร์").
- baseline: tsc 0 · 217 tests pass · live E2E บน Drive จริง 10/10 assertions (fast-path, swap skeleton, per-file fallback, shell cleanup).

---

## [1.108.1] — 2026-06-30

### Fixed — QA sweep (20-agent audit): back-nav / redirect / feature-gate correctness
ผู้ใช้ขอ "ตรวจทุกฟีเจอร์ + ปุ่มย้อนกลับ/redirect ต้องถูกต้อง". 20-agent audit เจอ 9 จุดจริง (6 false-positive) — รวมเป็น 5 แก้:
- **Sound engineers อัปโหลดไม่ได้ (root cause)**: `getUploadAccess` คืน true ให้ sound roster แต่ tier gate (`ALLOW['sound-mgmt']`) ไม่มี `/upload` → ปุ่ม Upload ที่โชว์ทุกที่ (admin queue, my-bookings, admin/[id] card) เด้งกลับ /admin. แก้: เพิ่ม `/upload` ใน `ALLOW['sound-mgmt']` (ตรงกับ workflow v1.108 ที่ทีมเสียงต้องอัปไฟล์เสียงเอง). ตัวเดียวปิด 4 จุดเด้ง.
- **[HIGH] BookingWizard ลบ episode ของ AGN ตอน "ทำต่อ" (resume draft)**: effect `[projectId]` เรียก `setSelectedEpisodeIds([])` ทุกครั้งที่ projectId เปลี่ยน รวมถึงตอน resumeDraft restore → episode ที่เลือกไว้หาย. แก้: ย้ายการเคลียร์ไป Project ID `<select>` onChange (เลียนแบบ pattern `[outletCode]`/producerSel) — switch project จริงยังเคลียร์, แต่ resume ไม่โดนลบ.
- **Dashboard "Upload Footage" link เด้ง producer**: ลิงก์โชว์ทุกคนที่เปิด /dashboard/[id] แต่ producer อัปไม่ได้ → bounce. แก้: gate ด้วย `canUpload` (จาก /api/me).
- **Booking success "View Dashboard" → กำแพง staff-only**: CTA href `/dashboard` (staff page) เด้ง user ธรรมดา. แก้เป็น `/my-bookings` (ทุกคนเข้าได้, งานที่เพิ่งสร้างอยู่ที่นั่น).
- **Signature page back เด้งตาย**: ปุ่ม "กลับหน้า OT" hardcode `/ot` → คนที่มาจาก /profile ติดกำแพง. แก้เป็น `router.back()` fallback `/profile`.
- baseline: tsc 0 · 169 tests pass.

---

## [1.108.0] — 2026-06-30

### Added — ทีมเสียง: Sound staging + routine merge (เข้ากล่องเดียวกับวิดีโอ)
- งานที่ `crewRequired` มี **Sound** → ระบบ pre-create โฟลเดอร์ **staging** `<FOOTAGE_ROOT>/_SOUND-STAGING/<Production ID · job>/` (อยู่นอกโฟลเดอร์โปรเจควิดีโอ → ไม่โดน overwrite ของช่างภาพ). ทีมเสียงลงไฟล์ **direct** ที่นี่ (ลิงก์โผล่บนการ์ด Detect ใน /upload).
- **routine `sound-merge`** (worker รายชั่วโมง, ON by default, supervised ใน start.sh + heartbeat): ก๊อปไฟล์เสียงจาก staging → โฟลเดอร์ `AUDIO/` ในกล่องวิดีโอ ตาม Production ID. idempotent (dedup ชื่อ+ขนาด), copy-only (staging เป็น master), self-healing (ถ้ากล่องโดน re-overwrite รอบหน้าก๊อปกลับ). endpoint `GET /api/internal/sound-merge/run` (+dryRun) + ปุ่ม admin "🎙️ รวมไฟล์เสียง".
- helpers: `ensureSoundStagingFolder`, `copyFileToFolder`, `findChildFolder`, `listChildFolders` (google-drive.ts); `bookingNeedsSound` (outlet-folders.ts); branch ที่ approve + prep worker (additive).
- **Pre-deploy review (20 agents) แก้ 2 medium**: (1) staging lookup เปลี่ยนเป็น match ด้วย Production-ID prefix (กัน title rename หลัง approve ทำให้หาโฟลเดอร์ไม่เจอ); (2) bound query ที่ shootDate ≤ 45 วัน (กัน worker scan ทุก booking ในประวัติทุกชั่วโมง). **CEILING**: AGN ข้าม (project box ใช้ร่วม); box resolution ยัง drift ตาม title เหมือน detect (pre-existing).

### Fixed — โปรดิวเซอร์ผู้มีสิทธิ์จอง: re-check ทั้งหมดเทียบชีต (DB Outlet Booking)
- **ปลั๊กไฟ (narongkorn.m): KND → NWS** (ชีต Section = NEWS; KND เป็น mis-assignment 2026-06-30). **มิ้ง (jatuphorn.l): TSS → KND** (ชีต knd/Content Creator). **+ ขวัญ (karuna.m) → PM, + ปู๊น (aphisit.h) → KND** (คนใหม่จากชีต). วิว/แพท คงเดิม (ops decision).
- **`import-producers` เปลี่ยนเป็น authoritative**: `producerOutlets` = seed outlet (SET ไม่ใช่ merge) → ย้าย outlet ใน seed แล้ว stale tag หายจริง (เดิม merge-only ทำให้ ปลั๊กไฟ ค้าง KND). **อย่าให้เกิดอีก** = seed เป็นแหล่งความจริงของ outlet membership.
- baseline: tsc 0 · 169 tests pass.

---

## [1.107.2] — 2026-06-30

### Fixed — crew-gap warning ไม่เตือน Lighting/DIT/Art Director (false positive)
- พบจาก verify live: "ช่างไฟ (Lighting)" ขึ้น "ขาด" เกือบทุกงาน เพราะ Lighting/DIT/Art Director **ไม่มี staff position** (เป็น freelancer ล้วน) → track ไม่ได้ → flag ตลอด = noise. แก้: `missingCrewRoles` จำกัดเฉพาะ **STAFF_TRACKABLE_ROLES** = Videographer/Sound/Photographer/Switcher/Virtual Production (role ที่มี staff จริง "ไม่มีคน assign" ถึงจะมีความหมาย). freelancer-only roles ไม่เตือน (assigner จัด freelancer เอง).
- baseline: tsc 0 · 168 tests pass.

---

## [1.107.1] — 2026-06-30

### Added — คิวงาน: filter "เฉพาะงานที่ทีมงานยังไม่ครบ" (แท็บ CONFIRMED)
- บนแท็บ **CONFIRMED** ของ /admin เพิ่ม toggle **"🚨 เฉพาะงานที่ทีมงานยังไม่ครบ (N งาน)"** + **badge "⚠️ ขาด: ช่างภาพ, …"** บนการ์ดงานที่ทีมไม่ครบ → คน assign เห็นทั้งหมดในที่เดียว ไม่ต้องเปิดทีละงาน.
- Endpoint `GET /api/bookings/crew-gaps` (requireConsole) — batch resolve ตำแหน่งของคนที่ assign ทุกงาน CONFIRMED/ASSIGNED ใน query เดียว แล้วคืน map `{bookingId: {missing, missingTh}}` เฉพาะงานที่ขาด. โหลดเฉพาะตอนอยู่แท็บ CONFIRMED, reset filter เมื่อออกจากแท็บ. ใช้ logic เดียวกับ v1.107.0 (`missingCrewRoles`).
- baseline: tsc 0 · 167 tests pass.

---

## [1.107.0] — 2026-06-30

### Added — เตือน "ทีมงานยังไม่ครบ" บนงาน CONFIRMED
- งานที่ confirm แล้วบางที assign ไม่ครบ (เช่น ใส่แค่ช่างเสียง ลืมช่างวิดีโอ/ภาพ) → เพิ่ม **แถบเตือนบน /admin/[id]**: "ทีมงานยังไม่ครบ — ยังขาด: ช่างภาพ, ช่างวิดีโอ …" เพื่อให้คน assign คิวเพิ่มคนให้ถูก.
- กลไก: `crewRequired` (ตำแหน่งที่งานต้องการ) เทียบกับตำแหน่งของคนที่ assign — resolve `assignedEmails` (เฉพาะ staff) → `User.position` → classify เป็น crew role (`crewRoleFromPosition`, src/lib/crew-gaps.ts) → role ใน crewRequired ที่ไม่มีใคร cover = "ยังขาด". Endpoint `GET /api/bookings/[id]/crew-status` (canViewBooking). โชว์เฉพาะ CONFIRMED/ASSIGNED, refresh เมื่อ assignedEmails เปลี่ยน.
- **CEILING**: freelancer ไม่มี field ตำแหน่ง → classify ไม่ได้ → เตือนแบบ soft hint (โชว์จำนวน freelancer ที่เช็คตำแหน่งไม่ได้ "ถ้าครอบคลุมแล้วข้ามได้"). DIT/Lighting/Art Director ไม่มี staff position → ถ้าใส่ใน crewRequired จะขึ้น "ขาด" เสมอ (เป็น freelancer ล้วน). classifier ครอบคลุม Videographer/Sound/Photographer/Switcher/Virtual Production (มี staff จริง).
- baseline: tsc 0 · 167 tests pass.

---

## [1.106.0] — 2026-06-30

### Added — ช่างภาพเบิกอุปกรณ์เองได้ (crew self-requisition แบบ Cheqroom)
- **การ์ด "🎒 เบิกอุปกรณ์" บน /dashboard/[id]:** ช่างภาพ/ทีมงานที่อยู่ในงาน เปิดการ์ดในหน้างานของตัวเอง → ค้นหา/กรองตามหมวด (กล้อง/เลนส์/เสียง/ไฟ/กริป/แบต/สตอเรจ) → ติ๊กเลือกอุปกรณ์ที่ "พร้อมใช้" → ส่งคำขอเบิก. เห็นสถานะคำขอของตัวเอง (รออนุมัติ/เบิกแล้ว/คืนแล้ว) + ยกเลิกคำขอที่ยัง "รออนุมัติ" ของตัวเองได้.
- **API `/api/bookings/[id]/equipment-request`** (GET/POST/DELETE) gate ด้วย `canViewBooking` — เบิกได้เฉพาะงานที่ตัวเองอยู่ (console/ผู้สร้าง/โปรดิวเซอร์/ทีมที่ถูก assign). POST สร้าง `EquipmentLoan` สถานะใหม่ **REQUESTED** (ไม่ล็อกอุปกรณ์ — รอผู้ดูแลเช็คเอาท์). availability guard: เลือกได้เฉพาะ loanable + AVAILABLE. DELETE ยกเลิกได้เฉพาะคำขอ REQUESTED ของตัวเอง.
- **`LoanStatus` += `REQUESTED`** — เฉพาะ `ACTIVE` เท่านั้นที่ทำให้อุปกรณ์เป็น ON_LOAN (reconcileEquipmentStatus คีย์ที่ ACTIVE) → คำขอที่ยังไม่อนุมัติไม่ไปกันอุปกรณ์.
- **/admin/loans:** tab "🆕 ขอเบิก" + ปุ่ม "เช็คเอาท์" (REQUESTED→ACTIVE = ผูกอุปกรณ์ ON_LOAN ให้อัตโนมัติ). badge REQUESTED = "ขอเบิก".
- **Checkout conflict guard:** เช็คเอาท์ (→ACTIVE) re-validate ว่าอุปกรณ์ชิ้นนั้นไม่ได้ถูกเช็คเอาท์ใน loan ACTIVE อื่นอยู่ → ถ้าชนคืน error ชื่ออุปกรณ์ (กันสองคนถืออุปกรณ์ชิ้นเดียวกันเงียบๆ).
- Pre-deploy review (2 มิติ: permission/inventory + UI/crash/build) = 0 blockers. 2 non-blocker: soft double-checkout (กันด้วย guard ข้างบนแล้ว), เบิกบน booking ที่ถูกยกเลิก (policy gap, ผู้ดูแลเห็นในคิว). tsc 0 · 164 tests · build ✓.

---

## [1.105.4] — 2026-06-30

### Fixed — correctness audit (9-agent find→verify ของฟีเจอร์วันนี้) เจอ 3 จุด (low) แก้ครบ
- **เงินติดลบ/ล้น:** `decOrNull` (admin-parse.ts) เก็บเครื่องหมายลบ → ใส่ unitPrice/total ติดลบได้ → ยอดรวมเดือน + อีเมลอนุมัติเพี้ยน; และค่า 13+ หลักเกิน Decimal(12,2) → 500. แก้: reject ค่าติดลบ (คืน null, ไม่แปลงเป็นบวก) + cap ที่ 9999999999.99. มีผลกับทุก money field ที่ใช้ decOrNull (amount/cost/price/total). +unit test.
- **Nav tab ผิด:** `week-plan` ไม่อยู่ใน `ADMIN_HUB` regex ของ Nav (มีใน middleware) → เปิด /admin/week-plan แล้ว tab "คิวงาน" ติดสว่างแทน "Admin". แก้: เพิ่ม week-plan ใน ADMIN_HUB.
- **Week Plan ปุ่มกล้องล็อกตอน debounce:** คลิกกล้อง 1 ตัว → ปุ่มกล้องทั้งงานนั้น disabled 700ms+ → กดต่อเร็วๆ ไม่ได้ (ขัดกับ debounce ที่ตั้งใจรวบ). แก้: เอา disabled ออก (optimistic + reschedule คุมความถูกต้องอยู่แล้ว).
- tsc 0 · 164 tests · build ✓. (ฟีเจอร์อื่นทั้งหมด audit แล้ว = สะอาด.)

---

## [1.105.3] — 2026-06-30

### Changed — แสดงผล ค.ศ. ทุกที่ + คิวงาน tab เดือน + ปุ่ม sort
- **ค.ศ. เท่านั้น:** วันที่ที่ใช้ `toLocaleString('th-TH')` เคยขึ้นปี พ.ศ. (2569) — เปลี่ยน locale เป็น `'th-TH-u-ca-gregory'` (คงข้อความไทย แต่ปีเป็น ค.ศ.) ทั้ง 10 จุด: หน้า OT (ส่ง/อนุมัติ), producer dashboard, console dashboard, ลายเซ็น, ส่งงาน (upload), อีเมลอนุมัติ OT. (ยอดเงิน/จำนวน `toLocaleString('th-TH')` คงไว้ — ไม่มีปี).
- **คิวงาน (/admin): tab เดือน** (เรียง น้อย→มาก เช่น Jul→Dec, + "ทุกเดือน") กรองงานตามเดือนถ่าย + **ปุ่ม sort** สลับ วันน้อย→มาก / มาก→น้อย, **default = วันน้อยไปมาก** (เดิม API เรียง desc). สลับ status tab → reset เดือนเป็นทุกเดือน. หัวข้อเดือน inline โชว์เฉพาะตอนเลือก "ทุกเดือน". tsc 0 · 162 tests · build ✓.

---

## [1.105.2] — 2026-06-30

### Fixed/Added — คิวงาน: แก้ปี 2569→ค.ศ. + แสดงวันที่จอง (Requested) + แบ่งตามเดือน
- **🐛 ปี 2569 (พ.ศ.) บนการ์ดคิวงาน** ไม่ใช่บั๊คการแสดงผล — เป็น **ข้อมูลผิด**: booking `AGN-690702-LOC-01` (จาก calendar migration) เก็บ `shootDate=2569-07-02` (พ.ศ.) → **แก้ data เป็น 2026-07-02** (prisma update ผ่าน exec; ทุก booking ที่ปี≥2500 แปลง −543). *(Production ID ยังเป็น AGN-690702 — ไม่แตะ เพราะผูกกับโฟลเดอร์ Drive; calendar event ต้องกด Re-sync ให้ย้ายมา 2026).*
- **กัน Buddhist year ซ้ำ:** `create-booking.ts` ถ้าปี shootDate/shootEndDate ≥ 2500 → −543 อัตโนมัติ (กัน migration/API ใส่ พ.ศ.; wizard ใช้ `<input type=date>` เป็น ค.ศ. อยู่แล้ว) — แก้ทั้งวันที่ + Production ID ที่ derive จากวันนั้น.
- **คิวงานแสดง "📝 ขอเมื่อ <วันที่>"** (createdAt = วันที่ทำการจอง) บนทุกการ์ด + **จัดกลุ่มตามเดือน** (หัวข้อเดือนคั่นระหว่างการ์ด, en-US ค.ศ.). tsc 0 · 162 tests · build ✓.

---

## [1.105.1] — 2026-06-30

### Changed — อัพเดตรายการ KND + เพิ่ม producer narongkorn.m
- **KND program list** (data.ts) sync จากชีต (Program tab): Featuring (KNF), Walking English (WKE), Long Story Short (LSS), Word of The Day (WOD), Play Along (PLY), English Unlock (ENU), Short Form (SHF) — แทนของเดิม (LMF/KNF/SUB). *(code 3 ตัวอักษรตั้งให้เอง — บอกได้ถ้าอยากเปลี่ยน)*
- **เพิ่ม producer ปลั๊กไฟ** (ณรงค์กร, TSD00016, narongkorn.m@) เข้า outlet **KND** (role Producer, position Content Creator) — ในชีตอยู่ News/International News, ใส่ KND ตามที่ ops จับคู่กับ KND. ต้องรัน `POST /api/admin/import-producers` หลัง deploy เพื่อ upsert เข้า User table (account + dropdown KND). tsc 0 · 162 tests.

---

## [1.105.0] — 2026-06-30

### Added — ระบุจำนวน Switcher > 1 + Outlet PM เลือก Producer "ไม่มี" (→ Co-Pro)
- **Switcher ระบุจำนวนได้ (>1 คน):** เพิ่มฟิลด์ `Booking.switcherCount` (Int default 1, additive) — ในฟอร์มจอง เลือก Switcher แล้วมีช่องจำนวน (เหมือน Videographer); แสดง "Switcher ×N" ใน Review/หน้า booking; mirror ครบทุกที่ (create-booking clamp 1–10, draft, summary, admin/[id], workspace-columns, audit, mcp, routine).
- **Outlet PM เลือก Producer = "— ไม่มี (ใช้ Co-Producer) —" ได้:** ถ้าไม่เลือก Producer → **Co-Producer กลายเป็น Producer ของงาน** (producer/producerEmail = ของ Co-Pro, booking ไปอยู่กับ Co-Pro). validation: PM ต้องมี Producer หรือ Co-Producer อย่างน้อย 1 (outlet อื่นยังบังคับ Producer). dropdown PM โผล่แม้มีแต่ Co-Producer. Review preview สะท้อนการ promote.
- Pre-deploy review (2 agents) 0 blockers; แก้ 2 non-blocker (Review preview + PM-only-CoPro dropdown). tsc 0 · 162 tests · build ✓.

---

## [1.104.2] — 2026-06-29

### Fixed — Week Plan: ดึงงานเฉพาะสัปดาห์ที่ดู (ปิด ceiling limit=200)
- เดิม `/admin/week-plan` ดึงงาน CONFIRMED 200 อันใหม่สุดแล้วกรอง client-side → ถ้าเลื่อนไปสัปดาห์เก่ามากๆ หรือ total CONFIRMED > 200 จะแสดงงานไม่ครบ + **ตรวจกล้องชนพลาดได้**. เพิ่ม date-range filter `?from=&to=` (half-open) ใน `GET /api/bookings` และให้ Week Plan ดึงเฉพาะช่วง จ.–อา. ที่กำลังดู (refetch ตอนเลื่อนสัปดาห์) → ถูกต้องทุกสัปดาห์ ไม่ขึ้นกับจำนวนงานรวม. tsc 0 · 162 tests · build ✓.

---

## [1.104.1] — 2026-06-29

### Fixed — OT 2 บั๊กจาก weekly-audit ที่ยังไม่ขึ้น prod (cherry-pick เข้า main)
- **🔴 OT แก้วันที่ย้ายเข้าเดือนที่ปิดแล้วได้:** `PATCH /api/ot/[id]` เช็คแค่เดือนเดิมของ record ว่าเปิดอยู่ไหม แล้วเขียนทับ `month` จากวันที่ใหม่โดยไม่เช็คซ้ำ → ย้าย record เข้าเดือน payroll ที่ปิด/ส่งออกไปแล้วได้ (POST กันอยู่แล้ว แต่ PATCH ไม่กัน). เพิ่ม guard เช็คเดือนปลายทาง.
- **🟡 OT "เดือนปัจจุบัน" ใช้ UTC ไม่ใช่ Bangkok:** `currentMonthYYYYMM()` (+ `cleanupOTRecords`) อิง `new Date()` บน container UTC → ช่วง ~7 ชม.แรกของแต่ละเดือน (เวลาไทย) การกรอก OT วันนี้โดนปฏิเสธว่าเป็นเดือนปิด. เปลี่ยนไปใช้ `todayBangkokStr()`.
- 2 fix นี้ผ่าน adversarial review ใน weekly-audit แล้ว (อยู่ใน PR #12 แต่ยังไม่ merge — fix `/ot` tier ของ PR นั้นขึ้น main ไปแล้วใน v1.103.3, เหลือ 2 อันนี้). PR #12 ตอนนี้ถือว่า superseded. +1 ot-cleanup regression test. tsc 0 · 162 tests · build ✓.

---

## [1.104.0] — 2026-06-29

### Added — 📅 Week Plan: จัดสรรกล้องให้งานที่ Confirmed (มุมมองรายสัปดาห์)
- หน้าใหม่ **`/admin/week-plan`** (ลิงก์ "📅 Week Plan" บนหัวคิวงาน /admin) — แสดงงานที่ **CONFIRMED** แบ่งตามวัน จ.–อา. (เลื่อนสัปดาห์ก่อน/นี้/ถัดไป) แต่ละงานเลือก **กล้อง (Equipment category = CAMERA) เป็นรายตัว** ได้ → บันทึกลง `Booking.assignedEquipmentIds` (เก็บอุปกรณ์ที่ไม่ใช่กล้องไว้เหมือนเดิม).
- **เตือนกล้องชนกัน:** กล้องตัวเดียวถูกจัดให้ ≥2 งานในวันเดียว → ขึ้นสีแดงทั้งคู่. หัวแต่ละวันสรุป "จัดแล้ว X/Y" + ⚠️ ถ้าชน.
- บันทึกอัตโนมัติแบบ debounce 700ms/งาน (กันยิง Google Calendar re-sync รัวๆ — PATCH ทุกครั้ง re-sync event). ไม่ใช้ schema/endpoint ใหม่ (ใช้ GET /api/bookings?status=CONFIRMED + GET /api/admin/equipment?category=CAMERA + PATCH /api/bookings/[id]).
- **ADMIN-only** (page redirect + ลิงก์ซ่อน + middleware isAdminOnlyModule) — ให้ตรงกับ /api/admin/equipment ที่เป็น ADMIN. load() เช็ค r.ok แล้ว surface error (ไม่เงียบ).
- **Pre-deploy review (2 agents):** 0 blockers. แก้ก่อน deploy: access-gate mismatch (page console แต่ equipment API ADMIN → กล้องว่างเงียบ) → ทำเป็น ADMIN-only + เช็ค r.ok. **CEILING (ไม่บล็อก):** ดึง CONFIRMED แค่ 200 ใหม่สุด (พอสำหรับตอนนี้ ~28 งาน); concurrent edit = last-write-wins; กล้อง RETIRED ที่เคยจัดไว้จะไม่โชว์ในตัวเลือก. tsc 0 · 161 tests · build ✓.

---

## [1.103.4] — 2026-06-29

### Fixed — 2 รายการ LOW ที่ค้างจาก QA sweep (แก้ให้ครบ)
- **back ของ /admin/[id] ลืม tab ที่เปิดอยู่:** เดิม `<Link href="/admin">` (hardcode) → กลับมาที่ tab REQUESTED เสมอ. เปลี่ยนเป็นปุ่มใช้ `window.history.back()` (กลับ tab เดิมที่มาจากจริง) + fallback `/admin` เมื่อเปิดตรง. `src/app/admin/[id]/page.tsx`.
- **resume-draft ("ทำต่อ") ลบ Producer ที่เลือกไว้** (outlet แบบ dropdown non-AGN): effect `[outletCode]` เคลียร์ `producerSel/coProducerSel` ทุกครั้งที่ outlet เปลี่ยน รวมถึงตอน resume → ทับค่าที่เพิ่ง restore. ย้ายการเคลียร์ไปไว้ที่ `handleOutletChange` (ทางที่ user เปลี่ยน outlet จริง) แทน — resume ไม่โดนทับแล้ว, การเปลี่ยน outlet ปกติยังเคลียร์เหมือนเดิม. `src/app/_components/booking/BookingWizard.tsx`.
- tsc 0 · 161 tests · next build ✓. (ปิดงาน QA sweep ครบทุกข้อที่ confirmed.)

---

## [1.103.3] — 2026-06-29

### Fixed — QA sweep (ทดสอบทุกฟังก์ชัน + การกดย้อนหลัง): 8 confirmed issues
จาก audit ทั้งแอป (18-agent workflow, find→verify) — เน้น back-navigation + ฟังก์ชันใช้งานจริง:
- **🔴 หน้า success หลังจอง booking เข้าไม่ได้สำหรับ tier ที่ไม่ใช่ admin.** `/booking/success` (เอกพจน์ `/booking`) ไม่อยู่ใน tier `ALWAYS` (มีแต่ `/bookings` พหูพจน์) → producer/crew/coordinator จองเสร็จแล้วโดนเด้งไป tierHome ไม่เห็นจอ Episode IDs/โฟลเดอร์/Calendar Packet. แก้: เพิ่ม `/booking` ใน ALWAYS.
- **🔴 ทีมงาน (crew/producer/sound-mgmt) เข้า `/ot` ไม่ได้** (บันทึก OT ตัวเอง) — `/ot` ไม่อยู่ใน ALWAYS, tier gate เด้งออกแม้ ot/layout ตั้งใจให้เข้า. รวมถึง position-based approver (Video Production Manager) เข้า /ot/admin ไม่ได้. แก้: เพิ่ม `/ot` ใน ALWAYS (layout ยัง gate roster/approver จริง). [ตรงกับที่ค้างใน weekly-audit PR #12]
- **🔴 คำขอยกเลิก (v1.103.2) ไม่มีปุ่มปฏิเสธ/เก็บงาน** → ติดค้างใน tab "ขอยกเลิก" ถาวร, producer ขอใหม่ไม่ได้. แก้: เพิ่ม `clearCancelRequest` ใน `PATCH /api/bookings/[id]` (staff-only) + ปุ่ม "เก็บงานไว้" บนการ์ด → ล้าง flag.
- **🟠 การ์ดสถานะ ASSIGNED ในคิว/tab ขอยกเลิก ไม่มีปุ่ม action** → เพิ่มให้ ASSIGNED ใช้ปุ่มเดียวกับ REQUESTED (EDIT/Approve/Cancel).
- **🟠 back link หน้า team/permissions/reminders/health ชี้ `/admin` (คิวงาน)** แทน `/admin/production-space` (hub ที่มาจาก) → แก้ทั้ง 4.
- **🟡 `/admin/vendor-prices` ไม่อยู่ใน isAdminOnlyModule** → non-admin เข้าถึงหน้าได้แต่ API 403 (จอ error). แก้: เพิ่มใน middleware regex + Nav ADMIN_HUB.
- **🟡 success page ปุ่ม "New Booking" ลิงก์ `/`** (ไม่ใช่ `/new`) → แก้เป็น `/new`.
- **🟡 error boundary ปุ่ม "Back to Admin"** เด้ง crew/producer (เข้า /admin ไม่ได้) → เปลี่ยนเป็น "Back to Home" (`/`).
- **+ back link หน้า /admin/purchases หาย** (ตอนเปลี่ยนเป็น custom page v1.103.0) → เพิ่มกลับ → /admin/production-space.
- ✅ live-tested: ทุก 28 หน้า serve 200 (admin), /upload back → /my-bookings ถูก, /dashboard/[id] back → /dashboard ถูก, /new wizard Back/Next ใช้ได้.
- **ยังเหลือ (LOW, ไม่แก้รอบนี้):** back ของ /admin/[id] hardcode `/admin` ทำให้ลืม tab เดิม (browser-back ยังถูก); resume-draft ลบ Producer ที่เลือก (อยู่ใน PR #12). regression tests: ทุก tier เปิด /new + /booking/success + /ot. tsc 0 · 161 tests · build ✓.

---

## [1.103.2] — 2026-06-29

### Added — ปุ่ม "ขอยกเลิกงาน" (ระบุเหตุผล) + อีเมลแจ้ง + tab งานที่ขอยกเลิก
- **ปุ่ม "ขอยกเลิกงาน" บนหน้า booking** (`/dashboard/[id]`) สำหรับ producer/เจ้าของงาน (non-staff) — กดแล้วใส่เหตุผล → ส่งคำขอ. ไม่ได้ยกเลิกจริง แค่ flag ไว้ให้ทีมรีวิว (staff ยังมีปุ่ม Cancel ตรงเหมือนเดิม). เมื่อขอแล้วโชว์แบนเนอร์ 🚫 พร้อมเหตุผล+ผู้ขอ.
- **อีเมลแจ้งเมื่อมีคนขอยกเลิก** → `CANCEL_NOTIFY_EMAIL` (env, ใส่อีเมล Tui) ถ้าไม่ตั้งจะส่งหา user role MANAGER ทั้งหมด. ส่งทีละคน (ไม่เผยรายชื่อใน To:), best-effort (ไม่บล็อกคำขอ).
- **Tab "🚫 ขอยกเลิก" ในคิวงาน** (`/admin`) — แสดงงานที่มีคนขอยกเลิก (ยังไม่ถูกยกเลิกจริง) พร้อมเหตุผลบนการ์ด → admin/Tui กด Cancel จริงได้จากหน้า booking.
- Schema (additive, nullable): `Booking.cancelRequestedAt / cancelReason / cancelRequestedBy` — ไม่แตะ status enum/state machine. API: `POST /api/bookings/[id]/request-cancel` (gate=canViewBooking, reason required, บล็อก CANCELLED/COMPLETED) + `GET /api/bookings?cancelRequested=1`.
- tsc 0 · 160 tests · next build ✓ · pre-deploy verify (2 agents) 0 blockers (permission/leak/null-crash ผ่าน).

---

## [1.103.1] — 2026-06-29

### Fixed — ผู้ใช้ใหม่ติดกับดัก (สร้าง booking ไม่ได้) + login ในแอป (LINE) ถูก Google บล็อก
- **🔴 New user ติดกับดัก: เปิด New Booking ไม่ได้.** `/new` ตั้งใจให้ "ทุกคน" ใช้ได้ (คอมเมนต์ในหน้า + `POST /api/bookings` ใช้แค่ session) แต่ tier middleware (v1.90) บล็อก tier **`crew`** (= ค่า default ของ user ใหม่ role USER) ออกจาก `/new` → เด้งไป `/upload` ซึ่งก็ใช้ไม่ได้ถ้าไม่อยู่ใน roster → **ติดกับดัก สร้าง booking ไม่ได้เลย**. v1.102.5 แค่ซ่อนปุ่ม (แก้ปลายเหตุ). **แก้ที่ต้นเหตุ: ใส่ `/new` ใน `ALWAYS` (src/lib/tiers.ts)** → ทุก tier เปิด wizard ได้ + ปุ่ม "New Booking" โผล่/กดได้ทุกคน (verify แล้ว: ทุก API ที่ wizard เรียกใช้ session-only ไม่ใช่ console-gated). + เพิ่มลิงก์ "+ New Booking" บนหน้า /upload dead-end (กันคนที่ไม่อยู่ roster ตัน). middleware admin-only check ยังกัน /admin/* เหมือนเดิม (รันก่อน tier gate).
- **📱 Login ในแอป (LINE/Messenger) ถูกบล็อก:** Google OAuth ปฏิเสธ embedded webview (`Error 403: disallowed_useragent`). เพิ่ม `isInAppBrowser(ua)` (src/lib/in-app-browser.ts, ตรวจ LINE/FB/Messenger/IG/WeChat/TikTok/KakaoTalk/Android wv) + แบนเนอร์เตือนบนหน้า `/login` ให้เปิดใน **Safari/Chrome** ก่อน (มีปุ่มคัดลอกลิงก์). บายพาส Google ไม่ได้ — กันก่อนชนกำแพง. (0 false positive: Safari/Chrome/CriOS ผ่านหมด).
- regression tests: ทุก tier เปิด `/new` ได้ + in-app-browser detection (LINE iOS/Android, FB, IG, wv vs Safari/Chrome). tsc 0 · 160 tests · next build ผ่าน. **Pre-deploy verify workflow (3 agents) = 0 blockers.**

---

## [1.103.0] — 2026-06-29

### Changed — ออกแบบ Purchases ใหม่: จัดซื้อรายเดือน + อนุมัติ + โฟลเดอร์ใบเสร็จ (BREAKING: ล้างข้อมูลเก่า)
- **เลิกใช้ `PurchaseItem` แบบแบนๆ** (มีแค่ `month` เป็น string, สถานะ OPEN/RECEIVED/CANCELLED). ของเดิม **ถูกลบทิ้งตอน deploy** (`prisma db push --accept-data-loss`) — ตามที่ ops สั่ง "ล้างอันเก่า ไม่ต้อง migrate". ตัว importer (`scripts/import-workspace.ts`) ฝั่ง purchases กลายเป็น no-op.
- **โมเดลใหม่ = เดือน + รายการ + อนุมัติ:**
  - `PurchaseBatch` = การจัดซื้อ 1 เดือนของผู้ซื้อ 1 คน (`@@unique([ownerEmail, month])`) มีสถานะอนุมัติ `DRAFT → SUBMITTED → APPROVED/REJECTED` (เหมือน OT) + ลิงก์โฟลเดอร์ Drive ของเดือน.
  - `Purchase` = รายการ มี **`purchaseDate` (วันที่ซื้อจริง)** — เดิมมีแค่ month string (นี่คือ "วันเดือนปี" ที่ขอให้แก้). คงไว้: qty, vendor, ราคา/หน่วย, รวม, kind, ลิงก์, หมายเหตุ, ใบเสร็จ.
  - `DocumentRef.purchaseItemId` → `purchaseId` (ชี้ `Purchase`).
- **โฟลเดอร์ Drive แบ่งตามเดือน → รายการ:** `DRIVE_DOCS_ROOT/จัดซื้อ (Purchases)/<YYYY-MM>/<รายการ>/` — ใบเสร็จ PDF อัปผ่านปุ่มแนบในแต่ละรายการ (ใช้ `DocsCell`/`/api/admin/documents` เดิม, แก้ให้ nest month→item). helper ใหม่ `src/lib/purchase-drive.ts`.
- **Flow ส่งอนุมัติ:** เพิ่มรายการ → แนบใบเสร็จ → ปุ่ม "ส่งให้ Manager อนุมัติ" (สร้างโฟลเดอร์ Drive + อีเมลแจ้ง manager พร้อมยอดรวม/ลิงก์โฟลเดอร์/ลิงก์เปิดอนุมัติ) → manager กด อนุมัติ/ไม่อนุมัติ (พร้อมเหตุผล) จากตาราง "ทุกเดือน". REJECTED → แก้แล้วส่งใหม่ได้. ผู้อนุมัติ = manager/admin (ใช้ `getOTApproverAccess` ชุดเดียวกับ OT); target อีเมล = `PURCHASE_APPROVER_EMAIL` → users role MANAGER → `REMINDER_ADMIN_EMAIL`. การสร้างโฟลเดอร์/อีเมลเป็น best-effort (ไม่บล็อกการส่ง).
- **API:** `GET /api/admin/purchases` (`?month=` เดือนของฉัน · `?batchId=` เปิดของใครก็ได้ · ไม่มี param = overview ทุกเดือนพร้อมยอดรวม) · `POST` (เพิ่มรายการ, สร้าง batch อัตโนมัติ) · `PATCH/DELETE /[id]` (แก้/ลบรายการ — เฉพาะเดือนที่ยังแก้ได้) · `POST /batch` (action: submit/sync-folder/approve/reject). gate = `requireConsole` (ผู้ซื้อ) / manager (อนุมัติ). batch ที่ส่ง/อนุมัติแล้ว ล็อกการแก้รายการ.
- **UI:** `/admin/purchases` เปลี่ยนจาก CrudTable เป็นหน้า custom — เลือกเดือน, สรุปยอด+จำนวน, ตารางรายการ (วันที่/รายการ/จำนวน/vendor/รวม/ใบเสร็จ), ฟอร์มเพิ่ม-แก้, ปุ่มโฟลเดอร์+ส่งอนุมัติ, ตารางทุกเดือน (manager อนุมัติ inline). production-space dashboard + badge ปรับเป็นสถานะใหม่.
- helper `src/lib/purchase-batch.ts` (เงิน + กฎสถานะ) + 4 unit tests. baseline: **tsc 0 · 157 tests · `next build` ผ่าน**. ⚠️ ต้องตั้ง env **`DRIVE_DOCS_ROOT`** (ยังไม่ได้ตั้งบน prod) ฟีเจอร์โฟลเดอร์/ใบเสร็จถึงจะทำงาน; `PURCHASE_APPROVER_EMAIL` (ออปชัน) ระบุผู้รับอีเมลอนุมัติ.
- **Pre-deploy adversarial review (12 agents) เจอ + แก้ก่อน deploy:** (1) 🔴 receipt upload/delete (`/api/admin/documents`) ไม่เช็ค owner+สถานะ → console user คนอื่นแนบ/ลบใบเสร็จของคนอื่น หรือแก้เดือนที่อนุมัติแล้วได้ → เพิ่ม `purchaseDocGuard` (owner-only + `isBatchEditable`); (2) PATCH/DELETE รายการไม่เช็ค owner → ใส่ ownerEmail ใน `guardEditable`; (3) manager อนุมัติเดือนตัวเองได้ → กัน self-approval (`batch.ownerEmail === session.email` → 403) + ซ่อนปุ่มใน UI; (4) quantity ติดลบ → `Math.max(1, …)`; (5) อีเมลขออนุมัติส่งทีละคน (ไม่เผย To: รวม). DocsCell เพิ่ม prop `readOnly` (เดือนที่ล็อกแล้วดูใบเสร็จได้ แต่อัป/ลบไม่ได้). **DEFERRED (non-blocking):** เปลี่ยนชื่อรายการหลังแนบใบเสร็จ → ใบเสร็จเก่าค้างโฟลเดอร์ชื่อเดิม (ไฟล์ไม่หาย, ยังเปิดได้รายตัว) — fix ทีหลังด้วยการ pin โฟลเดอร์ด้วย id.

---

## [1.102.8] — 2026-06-26

### Added — งาน Photo album → โฟลเดอร์ใน Photographer Shared Drive
- booking ที่ทุกตอนเป็น **Episode Type = Photo Album (code A)** = "งาน Photo album" → สร้าง **โฟลเดอร์เดียว** ชื่อ `<Production ID · ชื่องาน>` ที่ root ของ **Photographer Shared Drive** (`0ALBpF3fzYT-SUk9PVA`, override ด้วย env `DRIVE_PHOTO_ROOT`) แทนโครง VIDEO 2026 — ช่างภาพวางรูปข้างในได้เลย (ไม่มีชั้นกล้อง/EP).
- `isPhotoAlbumBooking(episodes)` (outlet-folders.ts, = ทุกตอน code A) + `ensurePhotoAlbumFolder()` (google-drive.ts). Branch ทั้งตอน approve (CONFIRMED) และ prep-folders worker (รายวัน) — photo job ไม่สร้างโฟลเดอร์วิดีโอ/CAM ใน VIDEO 2026 อีก. งานผสม (วิดีโอ+รูป) ยังอยู่ VIDEO 2026 ตามเดิม.
- สร้างผ่าน Drive impersonation (subject เดิมที่เขียน Shared Drive อื่นได้) — ถ้า subject ไม่มีสิทธิ์ใน Photo Drive จะ fail แบบ best-effort (log) ไม่ block approve. **CEILING**: Detect/upload ในแอปยังเป็นฝั่งวิดีโอ — รูปใน Photo Drive ยังไม่ขึ้นใน Detect (follow-up ถ้าต้องการ).
- baseline: tsc 0 · 153 tests pass.

---

## [1.102.7] — 2026-06-26

### Fixed — Outlet PM ใช้ dropdown Project Manager เสมอ (รวม Event)
- เดิม `useProducerDropdown` ปิด dropdown เมื่อ Shoot Type = Event (กฎ v1.85 สำหรับ producer แบบ ad-hoc ของงาน event) → ทำให้ outlet **PM** ที่จองงาน Event ไม่เห็น dropdown รายชื่อ Project Manager. แก้: PM ใช้ dropdown เสมอ (`shootType !== 'Event' || outletCode === 'PM'`) — producer ของ PM อยู่ใน roster (6 Project Manager) เสมอ. `/api/producers?outlet=PM` คืนครบอยู่แล้ว.
- baseline: tsc 0 · 151 tests pass.

---

## [1.102.6] — 2026-06-26

### Fixed — Project Manager ไม่ควรมีสิทธิ์ OT Approval
- `getOTApproverAccess` ให้สิทธิ์ approve OT กับ position ที่มีคำว่า "manager" (legacy path สำหรับ production manager) → **"Project Manager" (PM office) ติดไปด้วย**. PM run โปรเจค ไม่ได้อนุมัติ OT ของกอง.
- แก้: แยก predicate `positionGrantsOT(position)` (src/lib/roles.ts) = `includes('manager') && !includes('project manager')` + unit test. role MANAGER/ADMIN ยัง approve ได้เหมือนเดิม. PM users ใน DB เป็น role=USER + position="Project Manager" → ตอนนี้ไม่ได้สิทธิ์ OT แล้ว.
- baseline: tsc 0 · 151 tests pass.

---

## [1.102.5] — 2026-06-26

### Fixed — Home "New Booking" ส่ง crew ไปหน้า upload
- **บั๊ค**: หน้า Home (overview) แสดงปุ่ม "New Booking" + empty-state "Create a booking" ให้ **ทุก** user แต่ tier `crew` (วิดีโอกราเฟอร์ ~31 คน) เปิด `/new` ไม่ได้ → middleware เด้งไป `tierHome` = `/upload`. ผลคือกด New Booking แล้วเด้งไปหน้า upload งงๆ.
- **แก้**: gate ปุ่มทั้งสองด้วย `tierAllows(resolveTier(role, position), '/new')` (fetch /api/me) — เหมือนที่ Nav + /admin ทำอยู่แล้ว. คนที่จองได้ (admin/coordinator/producer) เห็นปุ่มเหมือนเดิม; crew/sound-mgmt ไม่เห็น (ไม่โดนเด้ง). default false กัน flash.
- baseline: tsc 0 · 150 tests pass.

---

## [1.102.4] — 2026-06-26

### Added — ปุ่ม "📣 แจ้งทุกคนว่าไฟล์พร้อม"
- บนการ์ด Detect (/upload): ปุ่มสีเขียวส่งอีเมลแจ้ง **ทุกคนบนงานนี้** (Producer + ทีมที่ assign + ผู้สร้าง booking + CC ตัวเอง) พร้อมลิงก์โฟลเดอร์ footage ทั้งหมด ว่า "footage พร้อมแล้ว". `POST /api/bookings/[id]/notify-ready` — gate เดียวกับ "ส่งงาน" (assigned crew/admin). UI **preview ก่อน → confirm รายชื่อผู้รับ → ค่อยส่ง**.
- resolver แชร์: แยก `resolveFootageFolders()` (src/lib/footage-folders.ts) ออกจาก detect-footage → ทั้ง Detect และ notify-ready ใช้ลิงก์ชุดเดียวกัน (server resolve เอง ไม่เชื่อ client).
- **PRE-DEPLOY review (19 agents) เจอ 1 medium**: เดิมยัด recipients ทุกคนใน `To:` เดียว → freelancer (อยู่ใน assignedEmails, อีเมลส่วนตัว) เห็นอีเมลกันหมด. แก้: **ส่งทีละคน** (Promise.allSettled, `to:[one]`) เหมือน assign route — ไม่มีใครเห็นอีเมลคนอื่น (sendEmail ไม่มี BCC).
- baseline: tsc 0 · 150 tests pass.

---

## [1.102.3] — 2026-06-26

### Changed — Detect แสดงเอง + ปุ่ม Back กลับหน้าก่อนหน้า
- **Detect auto-load**: หน้า /upload (และทุกที่ที่ใช้ UploadSection) รัน Detect ให้อัตโนมัติตอนเปิด → ลิสต์โฟลเดอร์ + ลิงก์ footage โผล่เองทุกครั้ง ไม่ต้องกด Detect เอง. ปุ่มเปลี่ยนเป็น "🔄 ตรวจใหม่" (manual refresh) + มีบรรทัด "กำลังตรวจหา…" ตอนโหลด.
- **ปุ่ม Back**: /upload เดิม hardcode ไป `/my-bookings` → เปลี่ยนเป็น `router.back()` (กลับหน้าก่อนหน้าจริง) fallback ไป /my-bookings เฉพาะตอนไม่มี history (เปิดตรงๆ). label "กลับ".
- baseline: tsc 0 · 150 tests pass.

---

## [1.102.2] — 2026-06-26

### Changed — Detect: รวมเป็นโฟลเดอร์กล้อง/กลุ่มเดียว (ไม่แตกตาม card structure)
- ของจริงพบว่า footage ในกล้องนึงกระจายในโครง card ลึก (`CAM-A/PRIVATE/M4ROOT/CLIP/…`) → เดิม Detect โชว์หลายแถว label ซ้ำ "…/ CAM-A" คนละลิงก์. แก้: `listFilesRecursive` ติด `topFolderId` (โฟลเดอร์ระดับบนสุดใต้ scan root) ให้ทุกไฟล์ → รวบไฟล์ทั้งใต้กล้องเป็น **1 แถวต่อกล้อง/กลุ่ม** (CAM-A, CAM-B, AUDIO, OB) ลิงก์ไปโฟลเดอร์กล้องนั้นตรงๆ พร้อมจำนวนไฟล์+ขนาดรวม.
- baseline: tsc 0 · 150 tests pass.

---

## [1.102.1] — 2026-06-26

### Changed — Detect: แสดงเป็นลิสต์โฟลเดอร์ + ลิงก์ (ไม่ใช่ทุกไฟล์)
- ตามที่ ops ขอ ("แสดงแค่ลิสต์ folder กับลิงก์ก็พอ"): `/detect-footage` รวมไฟล์เป็น **โฟลเดอร์** (label = `<EP/กลุ่ม> / <กล้อง>`, ลิงก์ Drive ของโฟลเดอร์, จำนวนไฟล์, ขนาดรวม) แทน list ไฟล์รายตัว → response เล็กลงมาก + คลิกเข้าโฟลเดอร์ได้เลย. UI โชว์ "เจอ N โฟลเดอร์ · M ไฟล์" + แถวโฟลเดอร์ (📁 label … จำนวน · ขนาด) + ลิงก์ "เปิดกล่องงานทั้งหมด".
- เพราะ payload เล็กแล้ว เลยดัน `maxFiles` 1000/1500 → **5000** (นับไฟล์/ขนาดต่อโฟลเดอร์ครบ — เลิกตัดที่ 1000 เหมือน L01 เดิม).
- baseline: tsc 0 · 150 tests pass.

---

## [1.102.0] — 2026-06-26

### Fixed — AGN Detect: find OB/event footage + box named by Production ID
- พบจากของจริง: booking **AGN-260625-LOC-01** (CEA, project PP-26-025) เป็นงาน **อีเวนต์ (OB)** — footage เป็นไฟล์ PGM/HyperDeck กองใน `OB / PGM OB`, `OB / Rec.Stream/…` (ไม่ได้อยู่ใต้โฟลเดอร์ EP) และ ops ตั้งชื่อกล่องด้วย **Production ID** (`AGN-260625-LOC-01 · …`) ใต้ **Content Agency → Event / Forum** ขณะที่ booking ถูกตั้ง category=ADVERTORIAL → app ไปหากล่อง `PP-26-025 · …` ใต้ *Advertorial* (กล่องว่าง) → Detect = 0.
- แก้ 3 จุด:
  1. **category → EVENT** (ข้อมูล) — งานนี้เป็นอีเวนต์จริง, ให้ app resolve ใต้ *Event / Forum* ที่ไฟล์อยู่.
  2. **resolver รับชื่อกล่องสำรอง**: `findEpisodeFolderUrls({bookingFolderNameAlts})` — AGN ลองชื่อกล่อง Production ID (`<bookingCode> · <project>`) เมื่อหากล่อง Project ID ไม่เจอ (read-side: detect-footage + ep-folders).
  3. **AGN Detect เก็บ footage นอกโฟลเดอร์ EP ด้วย**: สแกนกล่อง recursive เพิ่ม โดย `skipFolder` ข้ามโฟลเดอร์ EP ของโปรเจค (`<projectId>-…`) เพื่อไม่ปนกับใบจองอื่น → เก็บ OB/PGM/Rec.Stream. label ตาม depth จริงของ path.
- ไม่ย้ายไฟล์ ไม่ rename Drive. baseline: tsc 0 · 150 tests pass.

---

## [1.101.2] — 2026-06-26

### Fixed — Detect: label EP/camera by real folder depth + ซ่อน _SHOOT.txt
- พบจาก verify live: booking ที่มี episodes แต่ footage อยู่แบบ flat `<ID>/CAM-A/file` (legacy ก่อน per-EP) → เดิม label `CAM-A` เป็น EP ผิด (heuristic `booking.episodes.length`). แก้: อ่าน **depth จริงของ folderPath** — parent ตัวสุดท้าย = กล้อง, ตัวก่อนหน้า (ถ้ามี) = EP → ถูกทั้ง `<ID>/<EP>/<cam>/` และ flat `<ID>/<cam>/`.
- กรอง `_SHOOT.txt` / `_SHOOT-<id>.txt` (ไฟล์ข้อมูล booking ไม่ใช่ footage) ออกจากผล Detect.
- baseline: tsc 0 · 150 tests pass.

---

## [1.101.1] — 2026-06-26

### Added — Event: option "สถานที่ภายนอก" (อีเวนต์นอกบริษัท)
- Step 3 (Location) ของ wizard: เมื่อ Shoot Type = **Event** เพิ่ม checkbox **"📍 สถานที่ภายนอก (จัดงานนอกบริษัท)"**. ติ๊กแล้ว → behaves เหมือน On Location: โชว์ **Map location** + **🚐 ขอรถตู้** + validation (mapLocation required) — reuse `offsite` flag เดิม (`offsite = On Location || (Event && eventExternal)`). ไม่ติ๊ก = office (room picker เหมือนเดิม). state `eventExternal` persist ใน draft, reset เมื่อเปลี่ยน Shoot Type.
- baseline: tsc 0 · 150 tests pass.

---

## [1.101.0] — 2026-06-26

### Added — ปุ่ม "Detect" บนหน้า Upload (ตรวจหา footage ที่ย้ายจาก NAS เข้ากล่อง)
flow: ช่างภาพลงไฟล์ใน NAS (Production Team Shared Drive) → sync เข้า Drive → ย้ายโฟลเดอร์เข้า VIDEO 2026 → อยากให้หน้า Upload ตรวจเจอไฟล์ (ที่ไม่ได้อัปผ่านระบบ = ไม่มี Upload row).
- หน้า /upload (UploadSection) เพิ่มการ์ด **"🔍 ตรวจหา footage บน Drive"** + ปุ่ม **Detect** → resolve โฟลเดอร์ของ booking จาก path (read-only) แล้ว `listFilesRecursive` ลิสต์ไฟล์จริงในกล่อง (ชื่อ·กล้อง·ขนาด·ลิงก์เปิด) group ตาม EP. เห็นไฟล์ที่ย้ายจาก NAS ได้เลย ไม่ต้องรอ matcher / ไม่ต้องมี Upload row.
- endpoint `GET /api/bookings/[id]/detect-footage` (read-scope canViewBooking). **scope ถูกต้อง:** non-AGN scan ทั้งกล่อง `<Production ID>` (unique ต่อ booking); **AGN scan เฉพาะ EP folders ของ booking นี้** (เพราะ Project box ใช้ร่วมหลาย booking — ไม่ปนงานอื่น). reuse `findEpisodeFolderUrls` (เพิ่ม return `bookingFolderId` + episode `folderId`) + `listFilesRecursive` (มี folderPath บอก EP/กล้อง).
- **pre-deploy review fix (adversarial review, 4 real):** (1) 🔴 AGN-no-episodes ตกไป scan ทั้ง Project box → เปลี่ยนเป็น `if (isAgency)` (AGN ไม่มี EP → คืน empty ไม่ scan box). (2) 🔴 non-AGN ที่ไม่มี episodes โครงเป็น `<ID>/<camera>/file` (flat) → เดิม map camera เป็น EP ผิด; map ตาม `booking.episodes.length`. (3) เพิ่ม `id: f.id` ใน response + ใช้ `key={f.id}` แทน index. (4) `export const maxDuration = 120` กัน timeout. baseline: tsc 0 · 150 tests pass.

---

## [1.100.3] — 2026-06-26

### Added — Episode Type "Event" สำหรับ outlet Event (EVT)
- เพิ่ม Episode Type **`E · Event · งานอีเวนต์ / Staff`** ใน programs ของ outlet **EVT** (code 'E' = single-char → โผล่ใน Episode Type picker ของ EVT). สำหรับทีม Event จองงานอีเวนต์/Staff. picker ของ EVT ตอนนี้ = L/S/A/T (universal) + **E**. outlet อื่นไม่เห็น (scoped to EVT). episodeId รองรับ (เช่น `EVT-EVF-260626-E-01` — regex type slot `[A-Z0-9]{1,4}`). ไม่มี hardcoded L/S/A/T ที่ไหนต้องแก้.
- (ติดมากับ deploy นี้: chore dead-code cleanup `375f0e1` — ลบ unused exports + 4 one-off scripts, ไม่กระทบ runtime.) tsc 0 · 150 tests pass.

---

## [1.100.2] — 2026-06-26

### Fixed — ปุ่มสแกน: แสดงเหตุผลตอน worker idle
- ตอนกดสแกนแล้ว footage matcher idle (เช่น `FOOTAGE_LOG_SHEET_ID` ไม่ได้ตั้ง) endpoint คืน `ok:false` + `reason` (ไม่มี field `skipped`) → ปุ่มเดิมตกไป branch แสดง "สแกน 0 ไฟล์ · match 0" ซึ่งกำกวม. แก้ให้เช็ค `d.ok === false` ด้วย → แสดง **"สแกนยังไม่ทำงาน: <reason>"** ตรงๆ.
- พบจากการ verify live: prod **matcher idle** เพราะ `FOOTAGE_LOG_SHEET_ID` ไม่ได้ตั้ง (auto-match-to-sheet ไม่ทำงาน). per-EP footage links (v1.100.0) ไม่ขึ้นกับ matcher — resolve จาก path สด ทำงานอยู่แล้ว.

---

## [1.100.1] — 2026-06-26

### Added — ปุ่ม "สแกนหา footage" (trigger footage matcher on-demand)
- หน้า /upload (UploadSection) เพิ่มปุ่ม **🔄 สแกนหา footage** (เฉพาะ admin) ข้างปุ่ม Refresh → เรียก `GET /api/internal/footage/sync` ทันที (ไม่ต้องรอ worker ~10 นาที). โชว์ผล: สแกนกี่ไฟล์ · match ใหม่ · รอ booking · อ่าน ID ไม่ออก. ใช้ตอนเพิ่งย้ายไฟล์ NAS เข้ากล่องแล้วอยากให้ match เลย. ปุ่มโชว์เฉพาะ admin (endpoint 401 ถ้าไม่ใช่). tsc 0 · tests pass.

---

## [1.100.0] — 2026-06-26

### Added — ลิงก์ footage รายตอนบนหน้า producer (รองรับไฟล์ที่ย้ายจาก NAS)
ops ย้ายไฟล์จาก NAS เข้ากล่อง Drive (โครงเดียวกับที่ระบบสร้าง — มี Production ID ใน path) อยากให้ producer เปิดลิงก์ footage รายตอนได้ในระบบ.
- หน้า producer `/dashboard/[id]` การ์ด Episode IDs เพิ่มลิงก์ **"📁 footage"** ต่อตอน — เปิดโฟลเดอร์ EP บน Drive
- `findEpisodeFolderUrls()` (google-drive.ts) — resolve โฟลเดอร์ EP จาก path แบบ **read-only** (ไม่สร้างโฟลเดอร์ใหม่ตอนแค่เปิดดู), AGN-aware (ใช้ buildEpisodeFolderName + shootFolderLayers ชุดเดียวกับตอนสร้าง/อัป). คืน null ถ้าโฟลเดอร์ยังไม่มี
- endpoint `GET /api/bookings/[id]/ep-folders` (read-scope = canViewBooking) → `[{episodeId, url}]` + bookingFolderUrl. fetch แบบ non-blocking หลังโหลดหน้า
- **ไม่ต้องตั้ง routine ใหม่:** footage matcher เดิม (`runFootageSync`) เดิน Drive + match ตาม Production ID ทุก ~10 นาที (เร็วกว่ารายชั่วโมงที่ขอ) อยู่แล้ว; ลิงก์รายตอนนี้ resolve จาก path สดทุกครั้ง → ใช้ได้ทันทีกับไฟล์ NAS ที่ย้ายเข้ากล่อง โดยไม่ต้องรอ matcher.
- **pre-deploy review fix (adversarial review):** (1) 🔴 dashboard map key ด้วย `episodeId` ซึ่ง **ไม่ unique** ต่อ booking (schema ไม่มี @unique) → ถ้า EP ซ้ำ episodeId ลิงก์ทับกัน; เปลี่ยนไป key ด้วย `Episode.id` (CUID, unique เสมอ) ทั้ง endpoint + dashboard. (2) `findEpisodeFolderUrls` ใช้ `getDriveReadAuth()` ให้ตรงกับ contract read-only. tsc 0 · 150 tests pass.

---

## [1.99.2] — 2026-06-26

### Added — News producer แพท
- เพิ่ม **แพท** (ภาวิกา ขันติศรีสกุล · phawika.k@thestandard.co · TSD00056) เป็น **Producer** ของ outlet **NWS** ใน `OUTLET_PRODUCERS`. หมายเหตุ: title ใน sheet = "Project Coordinator" แต่เพิ่มเป็น Producer ตามที่ ops ขอ (`position: 'Producer'` ให้ลงคอลัมน์ Producer; ปรับเป็น Co-Producer ได้ถ้าต้องการ). ต้องรัน `POST /api/admin/import-producers` หลัง deploy.

---

## [1.99.1] — 2026-06-25

### Fixed — Notes แสดงผลตามที่พิมพ์ (ขึ้นบรรทัดใหม่ไม่หาย)
- หน้า booking detail ของ **producer** (`/dashboard/[id]`) แสดง Notes ใน `<p>` ธรรมดา → CSS `white-space: normal` ยุบ newline ที่ผู้ใช้เคาะบรรทัดให้กลายเป็นช่องว่าง (ข้อความยาวพรืดบรรทัดเดียว). เพิ่ม `whitespace-pre-line` → ขึ้นบรรทัดตามที่พิมพ์. (หน้า /admin/[id] มี `whitespace-pre-line` อยู่แล้ว — แก้เฉพาะ dashboard ให้ตรงกัน.)

---

## [1.99.0] — 2026-06-25

### Added — Outlet **Event** + **PM** (Project Management Office) + ทีมงาน
เพิ่ม 2 outlet ใหม่ตามที่ ops ขอ (รายชื่อจาก outlet-DB sheet, tab User):
- **Event** (code `EVT`, sort 10) — ทีม Event / Forum. โปรแกรม: Event / Forum, Event Recap.
- **PM** (code `PM`, sort 11) — Project Management Office. โปรแกรม: Project / Production.
- **17 ทีมงาน** เพิ่มใน `OUTLET_PRODUCERS` (Event 7 · PM 10) → import เข้า User table ผ่าน `POST /api/admin/import-producers` (idempotent). Event Producer/Project Manager → Producer dropdown; Co-Producer/Project Coordinator → Co-Producer (split ตาม `position` ใน /api/producers).
- folder mapping: `EVT`→`EVENT`, `PM`→`PM` ใน `OUTLET_FOLDER_BY_CODE` (กัน hasOutletFolderMapping บล็อก upload). Drive folder = `10 · Event` / `11 · PM` (auto-create ตอน upload/approve).
- ทุกอย่าง data-driven — outlet picker + producer dropdown โผล่อัตโนมัติ (ไม่มี hardcoded outlet list). +invariant test (ทุก producer outlet code ต้อง resolve, EVT/PM มี program, 7+10 คน, email ไม่ซ้ำ).
- **pre-deploy review fix (adversarial review):** PM "Project Coordinator" (4 คน) มี position ที่ regex `/co.?produc/i` ใน /api/producers ไม่ match → จะตกไปคอลัมน์ Producer แทน Co-Producer. ย้าย predicate ไป `src/lib/producer-role.ts` (`isCoProducer` = `/co.?produc|coordinator/i`, share กับ route + test) → coordinator นับเป็น Co-Producer. +invariant test: ทุก seed entry `isCoProducer(position) === (role==='Co-Producer')`. tsc 0 · 150 tests pass.

> ⚠️ ต้องรัน `POST /api/admin/import-producers` หลัง deploy เพื่อ import 17 คนเข้า User table (ก่อน import dropdown ของ Event/PM จะว่าง).

---

## [1.98.0] — 2026-06-25

### Changed — list views + Category (ops request)
- **Full date in list rows** — the home overview ("Booking Upcoming") and My Bookings
  rows showed only a compact `EEE d` stack (month+year dropped). Now show the full
  date via `formatDisplayDate` (e.g. `Wed 05 Aug 2026`). Producer/Admin/console already
  showed the full date.
- **Episode title in the title** — list rows now append the first episode's title after
  the show name: `[NWS] Long-form — ดีล X ตอนสปอนเซอร์` (home, my-bookings, producer).
- **Sort by date** — My Bookings status tabs now sort by shoot date (active tabs
  ascending/soonest-first; Completed/Cancelled descending/recent-first); Producer page
  sorts ascending. Home "upcoming" was already chronological.

### Removed — booking-level Category radio for non-AGN
- The Category radio (Original Content / Advertorial / Event / Internal) was **removed
  from the booking form for non-AGN outlets** — it duplicated the per-episode contentType.
  `booking.category` is now **derived** from the episodes (any Advertorial EP →
  ADVERTORIAL, else ORIGINAL_CONTENT) in `create-booking` (new `deriveBookingCategory`,
  unit-tested). **Content Agency keeps the radio** — AGN has no per-EP contentType and the
  value drives AGN Drive folder routing (Advertorial / Event · Forum). Summary rows also
  hide Category for non-AGN.
  - Note: EVENT/INTERNAL are no longer selectable for non-AGN (per-EP only expresses
    OC/AD); Event shoots remain identifiable via shootType=EVENT.

Verified on a local container: list shows full date + EP title + chronological order;
create derives ADVERTORIAL vs ORIGINAL_CONTENT correctly. tsc 0 · 145 tests pass.

---

## [1.97.1] — 2026-06-24

### Fixed — add-episodes review fixes (adversarial code review, 5 bugs)
- **Duplicate Episode rows on retry/concurrency** — `add-episodes` re-reads the
  booking's episodes INSIDE the `$transaction` and skips ones already present,
  recomputing sequence from the true max (was: check-then-insert against a stale
  snapshot → a retried/double request could double-insert an episodeId, inflating
  the upload-badge denominator). (@@unique([bookingId,episodeId]) is the durable
  fix but needs a monitored db-push window — deferred.)
- **No audit trail** — `add-episodes` now writes a `booking.episodes_added`
  AuditLog row (fire-and-forget), matching every other admin booking mutation.
- **Stale Google Calendar after adding EPs to a CONFIRMED booking** — now calls
  `updateCalendarEventDetails` (fire-and-forget) so the event title + EP list
  re-sync, same as the booking PATCH path.
- **Producer free-text mode stuck across edit sessions** — `producerCustom`
  resets to false on Edit open / Cancel / Save, so the producer field reopens in
  dropdown mode each time.

tsc 0 · 141 tests pass.

---

## [1.97.0] — 2026-06-24

### Added
- **News producer พีช** (ปภัสรา เพ็ชร์ณรงค์, papassara.p@, TSD00256) เพิ่มเข้า outlet roster
  (NWS, Producer) — ครบ 3 คนที่ขอ (ข้าวฟ่าง · หนามเตย · พีช). รัน `import-producers` หลัง deploy.
- **Agenda view โชว์จำนวนกล้อง** — แต่ละแถวใน `/calendar` (agenda + selected-day) แสดง `🎥 N`
  (+ `🎙 N` ถ้ามีไมค์) ต่อท้าย episode/producer; งาน Block Shot แสดง `🎥 TBC`. `/api/bookings`
  ส่ง cameraCount/micCount อยู่แล้ว (include) — เพิ่มแค่ใน interface + BookingRow.

tsc 0 · 141 tests pass.

---

## [1.96.0] — 2026-06-24

### Added — News producers + admin can change a booking's Producer at any status
1. **News Program producers** — added 2 to the outlet roster (`src/lib/outlet-producers.ts`,
   synced from the ops outlet-DB sheet): **ข้าวฟ่าง** (สุธามาส ทวินันท์, suthamat.t@) และ
   **หนามเตย** (ตรีนุช อิงคุทานนท์, trinuch.i@) — NWS, role Producer. หลัง deploy รัน
   `POST /api/admin/import-producers` เพื่อ upsert เข้า User table → โผล่ใน Producer dropdown ของ News.
   _(พีช · ปภัสรา เพ็ชร์ณรงค์ ยังไม่เพิ่ม — ช่องอีเมลในชีตว่าง; รออีเมลก่อน)_
2. **เปลี่ยน Producer ได้ทุกสถานะ (admin)** — หน้า `/admin/[id]` ในโหมด Edit เปลี่ยนช่อง Producer
   จาก free-text เป็น **dropdown รายชื่อ producer ตาม outlet** (`GET /api/producers?outlet=`) +
   พิมพ์เองได้ (fallback). เลือกแล้วตั้งทั้ง `producer` + `producerEmail`. ใช้ได้**ทุกสถานะ รวม CONFIRMED**
   (backend PATCH `/api/bookings/[id]` ไม่ gate สถานะอยู่แล้ว — รอบนี้เพิ่มรับ `producerEmail`).

tsc 0 · 141 tests pass.

---

## [1.95.0] — 2026-06-24

### Added — Content Agency: ลิงก์ EP ของ project เข้า booking ที่ approve แล้ว
หน้า Admin (`/admin/[id]`) เพิ่มปุ่ม **"เพิ่ม EP จาก project"** (เฉพาะ AGN ที่มี projectId) — แทรก episode เพิ่มเข้า booking ได้**ทุกสถานะ รวม CONFIRMED** (เดิมฟอร์ม edit เต็มล็อกหลัง approve). ใช้กรณี Director ขอถ่ายชิ้นงานเพิ่มหลังยืนยันคิว เช่น Highlight / สัมภาษณ์ เพิ่มจาก Wrap-up + Voxpop เดิม.

**ปลอดภัย ไม่พัง sync (สำคัญ):**
- เลือกจาก **episode ที่มีอยู่ใน project Sheet** (source of truth) เท่านั้น — **ไม่ mint EP ID เอง** (การ mint ในแอปถูกถอดไปแล้ว v1.35.17 เพราะ bypass onEdit automation ของ Dashboard = foot-gun). อยากได้ ID ใหม่ → สร้างที่ Producer Dashboard ก่อน
- **Add-only** — ไม่แตะ/ลบ episode เดิม · sequence ต่อจากตัวสูงสุด · title ใช้กฎเดียวกับ create-booking (ep label → projectName fallback)
- Admin เท่านั้น (`requireConsole`) · รองรับเฉพาะ AGN (outlet อื่น mint ID ตอนสร้าง booking อยู่แล้ว)

**โค้ด:** `POST /api/admin/[id]/add-episodes` (validate กับ `listProjectEpisodes`, mirror logic AGN ของ create-booking) + `src/lib/link-episodes.ts` (pure planner, 4 unit tests) + UI picker ใน `admin/[id]/page.tsx`. 141 tests pass · tsc 0.

> หมายเหตุ: หลังเพิ่ม EP — calendar event ไม่ auto-update (ใช้ปุ่ม Re-sync ถ้าต้องการ) · โฟลเดอร์ EP ใหม่สร้างตอน prep-worker/upload รอบถัดไป

---

## [1.94.1] — 2026-06-24

### Fixed — Content Agency: คืนชั้น category (Advertorial / Event · Forum) เหนือ Project box
v1.94.0 ตัดชั้น category ของ AGN ทิ้งไป (เอา Project box ขึ้นใต้ "09 · Content Agency" เลย) — แต่ PMC สร้างกล่อง **Advertorial** กับ **Event / Forum** รอไว้แล้วใต้ Content Agency. รอบนี้คืนชั้นนั้น: booking **Event → กล่อง "Event / Forum"**, **Advertorial → กล่อง "Advertorial"** แล้วค่อยลง Project box ข้างใน:

```
09 · Content Agency/
├── Advertorial/                    ← booking.category = Advertorial
│   └── PP-26-016 · ชื่อโปรเจค/
│       └── PP-26-016-S02 · ตอน/CAM-A/
└── Event / Forum/                   ← booking.category = Event
    └── PP-26-020 · โปรเจคอีเวนต์/
        └── ...
```

- `shootFolderLayers()` AGN: program layer = `programFolderName({category})` (Advertorial / Event / Forum, ใช้ของเดิมที่ byte-match กล่อง PMC), booking layer = Project box (ลงใต้ category). EP folder + ทุกอย่างอื่นคงเดิม.
- path hint ฝั่ง upload อัปเดตเป็น `[outlet]/[Advertorial·Event]/[Project ID · โปรเจค]/<EP>/<camera>/`.
- baseline: tsc 0 · 137 tests pass (shootFolderLayers test ครอบ Advertorial + Event).

---

## [1.94.0] — 2026-06-24

### Added — Content Agency footage จัดตาม Project → EP (แทน category/Production ID)
สำหรับ outlet **Content Agency (AGN)** เปลี่ยนโครง Drive ให้ "กล่อง Project" เป็นชั้นบนสุด (แทน "ชื่อรายการ" ของ outlet อื่น) แล้วแตกเป็น EP → กล้อง:

```
09 · Content Agency/
└── PP-26-008 · ชื่อโปรเจค/         ← Project box (Project ID · ชื่อ) — แทน category + Production ID
    ├── PP-26-008-L04 · ชื่อตอน/    ← EP folder = project EP ID (unique ในโปรเจค)
    │   ├── CAM-A/ CAM-B/ CAM-C/
    └── PP-26-008-L05 · ชื่อตอน/
        └── CAM-A/
```

- **ต่างจาก outlet อื่น:** AGN ไม่มีชั้น `<Production ID · job>` — footage ของทุกใบจองใน project เดียวกันมารวมใต้กล่อง Project เดียว, EP เป็น sub-folder. EP folder ใช้ **project EP ID** (`PP-26-008-L04`) ไม่ใช่ `EP01` — เพราะ sequence เริ่มที่ 1 ใหม่ทุกใบจอง จะชนกันถ้าใช้ EP01 ใต้ Project เดียว. outlet อื่นคงเดิม (`<show>/<Production ID · job>/EP01 · title/CAM-A`).
- **โค้ด:** `shootFolderLayers()` คืน program+booking layer แบบ AGN-aware (AGN → Project box + booking layer ว่าง = ข้าม); `buildEpisodeFolderName(ep, {useEpisodeId})` AGN ใช้ episodeId นำ. `resolveShootFolder` ข้ามชั้น booking เมื่อ `bookingFolderName===''`. wired เข้า approve / prep-worker / upload-init. read-side (folder links + footage report) + UI picker + path hint แสดง EP ID สำหรับ AGN. `_SHOOT.txt` ของ AGN ตั้งชื่อ `_SHOOT-<Production ID>.txt` (กล่อง Project ใช้ร่วมหลายใบจอง เลยไม่ทับกัน).
- Production Team landing drive (NAS drop zone) ยัง key ด้วย Production ID เหมือนเดิม (identity = ตัวงาน ไม่ใช่ project) — เฉพาะ box VIDEO 2026 ที่จัดตาม Project.
- baseline: tsc 0 · 137 tests pass (+`buildEpisodeFolderName` useEpisodeId, +`shootFolderLayers`).

> ceiling: กล่อง Project match ด้วยชื่อ `<Project ID · name>` — ถ้า projectName snapshot เปลี่ยนระหว่างใบจอง อาจเกิดกล่องซ้ำ (projectName นิ่งเป็นปกติ). ไฟล์ AGN ที่อัปก่อน v1.94 ยังอยู่โครงเดิม (category/Production ID) — ไม่ย้าย.

---

## [1.93.0] — 2026-06-24

### Added — footage แยกโฟลเดอร์ตาม EP (multi-EP shoots ไม่กองรวมกันแล้ว)
เดิมคิวที่ถ่ายหลาย EP เก็บ footage รวมในชุดโฟลเดอร์กล้องเดียว (`<Production ID · job>/CAM-A`). ตอนนี้เพิ่มชั้น **EP** คั่นไว้ — **ทุกคิว** (single-EP ก็มี EP01 เพื่อความสม่ำเสมอ):

```
<Production ID · job>/EP01 · ชื่อตอน/CAM-A, CAM-B, AUDIO/
                     /EP02 · ชื่อตอน/CAM-A, AUDIO/
```

- **โครงสร้างใหม่:** `buildEpisodeFolderName({sequence,title})` → `"EP01 · ชื่อตอน"` (sequence 1-based zero-pad, ไม่มี title → `"EP01"`). ใส่ชั้นนี้เมื่อ booking มี episodes; ไม่มี episodes → คงโครงเดิม flat. ใช้ทั้ง 3 ทางสร้างโฟลเดอร์: ตอน **approve** (CONFIRMED pre-create EP×camera ทุก EP), **prep-folders worker** (รายชั่วโมง, รวมถึง landing folder ใน Production Team drive), และตอน **upload** (`ensureUploadFolderPath` รับ `episodeFolderName`).
- **UI:** หน้า /upload มี dropdown **"ตอน / Episode"** (โผล่เฉพาะคิว ≥2 EP) เลือกก่อนอัป; ไฟล์เข้าโฟลเดอร์ EP ที่เลือก. คิว single-EP เลือกอัตโนมัติ. `Upload.episodeId` ถูก tag ทุกไฟล์.
- **read-side ตามไปด้วย:** `/api/upload/folders` + footage report (`ส่งงาน`) group ตาม **(EP × camera)** → แสดง "EP01 · ตอน / CAM-A" แยกกล่อง (เดิม group ตาม camera อย่างเดียว เลยเห็นแค่ EP เดียว). badge "อัปครบ" บน /upload นับ slot = **cameraCount × จำนวน EP** (กันการขึ้น 🟢 ทั้งที่บาง EP ยังไม่อัป — รักษา fix bug #3 ตามแกน EP).
- **pre-deploy review hardening (3 จุดจาก adversarial review):** (1) 🔴 **Wasabi key collision** — key เดิมไม่มีชั้น EP → ไฟล์ชื่อเดียวกัน/กล้องเดียวกันต่าง EP จะทับกันบน Wasabi; ใส่ segment `EP01` (ASCII) ใน `buildStoragePath` ให้ตรงกับ Drive (แม้ Wasabi ปิดอยู่ default ก็กันไว้). (2) **badge null-mixing** — uploads เก่า (episodeId=null) ปนกับ EP-tagged ทำให้ count เกิน → แยกเป็น 2 ถัง `epSlots`/`flatCams` ใน /api/upload/status; คิวมี EP ใช้ epSlots, คิวไม่มี EP ใช้ flatCams (ไม่มีทางปน). (3) init reject `episodeRowId` ที่ส่งมาทั้งที่ booking ไม่มี episodes (เดิมเงียบ).
- baseline: tsc 0 · 135 tests pass (+`buildEpisodeFolderName`, +`buildStoragePath` EP segment).

> ceiling (ponytail): ไฟล์ที่อัปไว้ก่อน v1.93 (`episodeId=null`) ยังอยู่โฟลเดอร์ flat เดิม — ไม่ย้ายของเก่า, ของใหม่เข้าโครง EP. คิวเก่าที่อัปครบแบบ flat อาจขึ้น 🟡 ชั่วคราวเพราะ badge นับตามแกน EP แล้ว.

---

## [1.92.2] — 2026-06-22

### Fixed — บั๊คตัวสุดท้าย (#4): completeWithRetry ไม่ retry FAILED ถาวรอีกต่อไป
- `/api/upload/complete` ส่ง flag **`permanent`** = true เมื่อ FAILED แบบ deterministic (size mismatch / target ผิด — re-call ก็ได้ผลเดิม). `completeWithRetry` เจอ `permanent` → throw ทันที (ไม่วน ~2.5 นาที). ส่วน FAILED ชั่วคราว (Drive metadata lag / Wasabi propagation lag) `permanent=false` → **ยัง retry เหมือนเดิม** (retry ช่วยจริง). เทสต์ครอบทั้ง 2 เคส.
- → ตอนนี้ **บั๊คทั้ง 5 จาก bug review แก้ครบ** (4 จาก v1.92.1 + อันนี้). 133 tests pass.

---

## [1.92.1] — 2026-06-22

### Fixed — บั๊คจาก multi-agent bug review (5 ยืนยัน)
- **🔴 LOCKOUT (regression v1.90):** producer/crew/coordinator เปิด **booking detail (`/dashboard/[id]`)** + **producer self-edit (`/bookings/[id]/edit`)** ของตัวเองไม่ได้ — tier gate ใน middleware เด้งกลับ (tierAllows ไม่มี `/dashboard`,`/bookings`). หน้าพวกนี้ authorize by owner ที่ data layer อยู่แล้ว → เพิ่มเข้า ALWAYS ใน `src/lib/tiers.ts` (+ regression test). กระทบผู้ใช้ส่วนใหญ่ (producer 13 + crew 31).
- **🟠 badge อัปครบ หลอก:** `/api/upload/status` นับ AUDIO/DRONE/SWITCHER/… เป็น "กล้อง" → ขึ้น 🟢 อัปครบ ทั้งที่ CAM ขาด. แก้: นับเฉพาะ `CAM-*` เทียบ cameraCount; งานไม่มีกล้อง (audio-only/block) → เขียวเมื่อมีไฟล์.
- **🟡 prep-folders:** Production Team folder error ไม่ถูกนับใน `errors` → log หัวขึ้น errors=0 ทั้งที่ landing folder ล่มหมด. เพิ่ม `prodTeamErrors` ใน result + log.
- รับทราบ (ไม่แก้): `completeWithRetry` retry กรณี FAILED ถาวร ~2.5 นาที — แต่ retry ช่วยกรณี Drive metadata lag หลังอัปไฟล์ใหญ่ (ตั้งใจ); refuted 1 finding (orphaned Drive file — trigger ไม่เกิดจริงตาม Drive ACL).
- baseline: tsc 0 · 132 tests pass.

---

## [1.92.0] — 2026-06-22

### Added — แก้ชื่อตอน (episode title) ตรงการ์ด Episode IDs ได้ทุกสถานะ (รวมหลัง approve)
- หน้า /admin/[id] เพิ่มปุ่ม **"✎ แก้ชื่อตอน"** ตรงการ์ด Episode IDs → แก้ title แบบ inline → บันทึก. **ใช้ได้ทุกสถานะรวมถึงหลัง approve** (CONFIRMED). **ID ยังล็อก** (badge อ่านอย่างเดียว, PATCH แก้แค่ title ไม่แตะ episodeId).
- เดิม admin แก้ title หลัง approve ได้อยู่แล้วผ่านโหมด Edit ของการ์ด Booking Details — แต่ไม่ obvious (ปุ่มอยู่คนละการ์ด). รอบนี้ทำให้แก้ได้ตรงจุด. reuse `PATCH /api/bookings/[id]` (episodeTitles, ID-safe). ไฟล์เดียว: `src/app/admin/[id]/page.tsx`.

> หมายเหตุ: ฝั่ง producer (self-edit /bookings/[id]/edit) ยังล็อกเฉพาะ REQUESTED — ถ้าอยากให้ producer แก้ชื่อตอนหลัง approve ด้วย เป็น follow-up.

---

## [1.91.0] — 2026-06-22

### Added — คิวงานกรอง "เฉพาะงานเสียง/ไมค์" (เติมเต็ม tier sound-mgmt)
- หน้า /admin (คิวงาน) เพิ่ม toggle **"🎙️ เฉพาะงานที่ต้องการเสียง/ไมค์"** (งานที่ `micCount > 0`). **ล็อกเปิดไว้สำหรับ tier sound-mgmt** (Senior Sound Engineer) — เห็นเฉพาะงานเสียง; tier อื่นกดเปิด/ปิดเองได้ (ช่วย coordinator กรองงานเสียงได้ด้วย).
- ซ่อนลิงก์ console (รายงาน/Routine/+New) ในหัวหน้าคิวสำหรับ sound-mgmt (สอดคล้องกับ middleware ที่บล็อกอยู่แล้ว). client-only (`src/app/admin/page.tsx`), reuse `resolveTier`/`tierAllows`.

---

## [1.90.0] — 2026-06-22

### Added — เมนู/สิทธิ์ตาม tier (role × position)
- รวม role × position เป็น **5 tier**: **admin** (Admin/Manager/Support) · **coordinator** · **sound-mgmt** (ตำแหน่ง Senior Sound Engineer) · **producer** (ตำแหน่งมี "producer") · **crew** (ที่เหลือ — Videographer/Sound/Switcher/Director/Editor/…).
- แต่ละ tier **เห็นเมนูต่างกัน + บล็อกหน้า**: crew → Upload(+My Bookings); producer → My Bookings/Producer; sound-mgmt → คิวงาน (ไม่เห็น รายงาน/Routine/Upload Review); coordinator → console เต็ม; admin → ทุกอย่าง. ปุ่ม "+ New Booking" เฉพาะ admin/coordinator/producer.
- บล็อกระดับหน้าใน `middleware.ts` (พิมพ์ URL ตรง → redirect ไปหน้าหลักของ tier); ไม่แตะ `/api` (route auth เอง). Token เก่า (ก่อน v1.90, ไม่มี position) → ใช้ gate แบบ role เดิมไปก่อน จน token refresh → **ไม่มีใครโดนล็อกเอาท์ผิด**.
- core: `src/lib/tiers.ts` (`resolveTier`/`tierAllows`/`tierHome`, +test 7 เคส) ใช้ร่วมกันทั้ง Nav (ซ่อน) + middleware (บล็อก) → เมนูกับสิทธิ์ไม่มีทางหลุดกัน. `getUserTier()` + position ใน JWT.

> ⏳ ยังเหลือ: sound-mgmt เห็น **คิวงานกรองเฉพาะงานเสียง/ไมค์** (ตอนนี้เห็นคิวเต็ม) — เป็น follow-up (ต้องเพิ่ม filter ในหน้าคิว).

---

## [1.89.0] — 2026-06-22

### Added — รายงานไฟล์ footage + ปุ่ม "ส่งงาน" แจ้ง Producer
- **รายงานไฟล์** ในหน้า upload: ต่อกล้อง แสดงไฟล์จริงในโฟลเดอร์ Drive — **ชื่อ · ขนาด · ความยาว · ความละเอียด** (ดึง `videoMediaMetadata` ที่ Drive สกัดให้). ใหม่: `GET /api/upload/report` + `listFolderFiles()`/`buildFootageReport()`.
- **ปุ่ม "ส่งงาน"** (เมื่ออัปแล้ว) → `POST /api/bookings/[id]/deliver`: email **Producer + CC ช่างภาพเอง** พร้อมรายงานไฟล์ + ลิงก์ + บันทึก `Booking.deliveredAt`/`deliveredBy` (schema, db push) + audit. **ส่งซ้ำได้** หลังอัปเพิ่ม; แสดง "✅ ส่งงานแล้วเมื่อ...". ถ้าไม่มีอีเมล Producer → ส่งถึงตัวเอง + เตือน.
- ช่างภาพเห็น task ตัวเองอยู่แล้วผ่าน `/my-bookings` (tab สถานะ) + `/upload` (badge ยังไม่อัป/ครบ จาก v1.85) — รอบนี้เพิ่มรายงาน+ส่งงานเข้าไป.
- ไฟล์: `src/lib/footage-report.ts` (+test), `google-drive.ts` (listFolderFiles), `/api/upload/report`, `/api/bookings/[id]/deliver`, `UploadSection.tsx`, `prisma/schema.prisma`.

---

## [1.88.0] — 2026-06-22

### Added — prep-folders สร้างโฟลเดอร์ใน Production Team drive ด้วย (ตั้งชื่อตาม Production ID)
- worker prep-folders (รายชั่วโมง) เดิมสร้างกล่องใน VIDEO 2026 อย่างเดียว. ตอนนี้สำหรับงาน confirm ของวันนี้ **สร้างโฟลเดอร์ landing ใน "Production Team" Shared Drive ด้วย** — แบบ flat: `<root>/<Production ID · ชื่องาน>/CAM-A·CAM-B·..` → ช่างภาพ/NAS drop footage เข้าโฟลเดอร์ที่ระบุชื่อถูกตั้งแต่ต้น (แก้ปัญหาโฟลเดอร์ "วันที่+ชื่องาน" ที่ไม่มี Production ID).
- ใหม่: `ensureFlatShootFolders()` ใน `google-drive.ts` (root→bookingFolder→cameras, idempotent). Production Team drive id hardcode default `0AGendsFHFQYKUk9PVA` (override ด้วย `DRIVE_PRODUCTION_TEAM_ROOT`) — ไม่ต้องตั้ง env ใน Portainer. best-effort: ถ้า Production Team error จะไม่ล้มการ prep VIDEO 2026.

---

## [1.87.1] — 2026-06-22

### Fixed — prep-folders worker หางานวันนี้ไม่เจอ (timezone vs @db.Date)
- `bangkokTodayRange` เดิม offset boundary -7h. แต่ `Booking.shootDate` เป็น `@db.Date` (date-only, Prisma เก็บ/เทียบเป็น midnight-UTC) → การเทียบกับ boundary ที่มีเวลา 17:00Z ถูก truncate ทำให้ `lt` **ตัดงานของวันนี้ทิ้ง** → dry-run ขึ้น today=0 ทั้งที่มีงานถ่ายวันนี้. แก้เป็น midnight-UTC ของวันที่ (Bangkok) ตรง ๆ. พิสูจน์ live: query เดิม inRange=0, query date-boundary เจองาน. test อัปเดตตามจริง.

---

## [1.87.0] — 2026-06-22

### Changed — เพิ่ม cap อัปโหลดต่อไฟล์ 100GB → 500GB
- `MAX_FILE_SIZE_BYTES` ใน `/api/upload/init` 100GB → **500GB** ต่อไฟล์ (Drive รองรับถึง 5TB; ไฟล์วิ่งเบราว์เซอร์→Google ตรง ๆ ไม่ผ่าน server).
- ⚠️ ข้อจำกัดที่ยังเหมือนเดิม: client ยัง **resume ข้าม refresh/ปิดแท็บไม่ได้** — ไฟล์ยักษ์ที่ขาดตอนกลางคันเริ่มใหม่จาก 0 (auto-retry กันได้แค่เน็ตหลุดสั้น ๆ ระหว่างแท็บเปิด). ไฟล์ใหญ่มากแนะนำ path NAS→Drive sync.

---

## [1.86.0] — 2026-06-22

### Added — Auto เตรียมกล่อง (โฟลเดอร์ Drive) สำหรับงานของวันนี้ ทุกชั่วโมง
- Worker ใหม่ `prep-folders` รันทุกชั่วโมง: หางาน (booking) ที่ **ถ่ายวันนี้** (Bangkok TZ, CONFIRMED/COMPLETED) แล้ว **pre-create โฟลเดอร์ปลายทางใน VIDEO 2026** (outlet/program/Production ID/CAM-A..) ให้ "รอไว้" — กล้องไหนยังไม่อัป = โฟลเดอร์ว่าง. Idempotent (โฟลเดอร์เดิมไม่สร้างซ้ำ), **ยังไม่ย้ายไฟล์** (ตามที่สั่ง).
- เดิม approve route สร้างโฟลเดอร์ตอน confirm อยู่แล้ว — อันนี้คือ sweep กันงานที่ confirm ก่อน v1.70 / สร้างพลาด ให้ครบทุกงานของวันนี้.
- **ON by default** (สร้างโฟลเดอร์ว่างปลอดภัย) — ไม่ต้องตั้ง env ใน Portainer แค่ deploy; ปิดได้ด้วย `PREP_FOLDERS_WORKER_ENABLED=0`. ทดสอบเองได้: `GET /api/internal/prep-folders/run?dryRun=1` (ADMIN หรือ x-prep-folders-secret=NEXTAUTH_SECRET).
- ไฟล์: `src/lib/prep-folders.ts` (+ test สำหรับ Bangkok TZ), `src/app/api/internal/prep-folders/run/route.ts`, `scripts/prep-folders-worker.js`, `start.sh` (supervised). reuse `ensureShootCameraFolders` + `camerasToPreCreate` เดิม.

> ส่วน "detect + ย้ายไฟล์จาก Production Team drive เข้ากล่อง" deferred (โฟลเดอร์ NAS ตั้งชื่อ "วันที่+ชื่องาน" ไม่มี Production ID → ต้องเลือกวิธี route ก่อน). ย้ายข้าม Shared Drive เทสต์แล้วทำได้ (instant ไม่ต้อง re-upload).

---

## [1.85.0] — 2026-06-22

### Added — ป้ายสถานะอัป + กรอกชื่อ Producer เองสำหรับงาน Event
- **ป้ายสถานะอัปต่อ booking** ในหน้า /upload (รายการงานของช่างภาพ): `🔴 ยังไม่อัป` / `🟡 อัปบางกล้อง {n}/{cameraCount}` / `🟢 อัปครบ ({ไฟล์})` — ช่างภาพดูปราดเดียวรู้ว่างานไหนยังต้องอัป. ข้อมูลจาก endpoint ใหม่ `GET /api/upload/status?bookingIds=` (groupBy กล้องที่ COMPLETE — counts only, เบา).
- **Producer แบบกรอกชื่อเอง สำหรับงาน Event** — `shootType === 'Event'` (non-AGN) กลับมาใช้ช่องกรอก Name/Phone/Email เอง แทน dropdown โปรดิวเซอร์ประจำ outlet (โปรดิวเซอร์งานอีเวนต์มักเป็นคนนอก roster). คืนพฤติกรรมก่อน v1.59.
- ไฟล์: `src/app/upload/page.tsx` (badge + fetch), `src/app/api/upload/status/route.ts` (ใหม่), `src/app/_components/booking/BookingWizard.tsx` (1 บรรทัด — `useProducerDropdown` ตัด Event ออก).

---

## [1.84.0] — 2026-06-22

### Changed — footage ขึ้นชื่อ "คนที่อัปจริง" บน Drive (ไม่ใช่ narasit.k ทุกอัน)
- เดิม service account impersonate `narasit.k` คนเดียว → Drive activity ขึ้นชื่อ narasit.k ทุกการอัป. ตอนนี้ **impersonate เมลล์ของคนที่ล็อกอินอัปจริง** (domain-wide delegation) → Drive โชว์คนนั้นเป็นผู้สร้างไฟล์/โฟลเดอร์.
- **Fallback ปลอดภัย:** ถ้าคนอัปไม่มีสิทธิ์ใน Shared Drive (VIDEO 2026) → Drive ตอบ 403/404 → ระบบ fallback ไปใช้ subject เดิม (narasit.k) อัตโนมัติ → **การอัปไม่มีวันพังเพราะเรื่องสิทธิ์** (แค่ขึ้นชื่อ narasit.k แทน). ตัวเช็ค `isDriveAccessError` มีเทสต์ครอบ (`drive-access.test.ts`).
- ไฟล์: `src/lib/google-drive.ts` (`getDriveWriteAuth(subject?)` + thread `subject` เข้า ensureUploadFolderPath/upsertTextFile/createResumableUploadSession), `src/app/api/upload/init/route.ts` (impersonate `session.email` + fallback), `src/lib/drive-access.ts` (ใหม่).

> หมายเหตุการเข้าถึง: การ **บล็อกเมลล์** ทำได้อยู่แล้วผ่านการปิด `active` ของ user ใน /admin/permissions (ล็อกอินไม่ได้). การคุมสิทธิ์เข้าถึงโฟลเดอร์ footage บน Google Drive โดยตรง เป็นงานใน Google Workspace/Shared Drive (แอปทำให้ไม่ได้) — แต่ตอนนี้ "ใครอัปเป็นชื่อตัวเองได้" ผูกกับสมาชิก Shared Drive แล้ว.

---

## [1.83.0] — 2026-06-22

### Fixed — upload เสร็จแล้วแต่ขึ้น "Failed" ตอนขั้นปิดงาน (network blip / deploy)
- **อาการ:** ไฟล์ใหญ่ (เช่น 5.7GB) อัปขึ้น Drive ครบแล้ว (เปิดเล่นได้) แต่ status ขึ้น **Failed** + error `Unexpected token '<', "<!DOCTYPE"...` — เพราะ step สุดท้าย `POST /api/upload/complete` ไปโดน 502 พอดี (เช่นตอน container restart/deploy หรือเน็ตสะดุดวินาทีนั้น) แล้ว client ไม่ retry เลยทิ้งงานทั้งที่ไฟล์ปลอดภัยบน Drive แล้ว.
- **แก้:** `completeWithRetry` (ใน `src/lib/upload-client.ts`) — ลอง `/complete` ใหม่สูงสุด 10 ครั้ง (exponential backoff) เมื่อเจอ 5xx / non-JSON / network error. `/complete` เป็น idempotent อยู่แล้ว (เรียกซ้ำบนแถวที่ COMPLETE → ok) จึงปลอดภัย. 4xx (auth/validation) ถือเป็น error ถาวร → ไม่ retry. ครอบด้วยเทสต์ `src/lib/__tests__/upload-complete-retry.test.ts` (4 เคส รวมเคส 502-deploy).
- งานที่ค้าง UPLOADING อยู่แล้วเพราะอาการนี้: ไฟล์อยู่บน Drive ครบ — re-complete ได้โดยไม่ต้องอัปใหม่.

---

## [1.82.0] — 2026-06-22

### Added — ลิงก์โฟลเดอร์ footage บน Drive ต่อกล้อง ในหน้า task booking
- ในหน้า upload ของแต่ละงาน เพิ่มกล่อง **"📁 โฟลเดอร์ footage บน Drive"** — กล้องไหนที่ upload เสร็จแล้ว (CAM-A, CAM-B, …) แสดงปุ่มลิงก์เปิดโฟลเดอร์กล้องนั้นบน Google Drive ตรง ๆ + จำนวนไฟล์.
- ลิงก์โฟลเดอร์หาได้จาก parent ของไฟล์ที่ upload เสร็จ → **ใช้ได้กับไฟล์ที่ upload ไปแล้วก่อนหน้าด้วย** (ไม่ต้องแก้ schema / ไม่ต้อง backfill).
- ใหม่: `GET /api/upload/folders?bookingId=` (auth เท่ากับ /api/upload/list) + `getDriveParentFolderId()` ใน `src/lib/google-drive.ts`; UI ใน `UploadSection.tsx` รีเฟรชพร้อมตารางประวัติ.

---

## [1.81.0] — 2026-06-22

### Added — Upload Footage: ลาก/เลือก "ทั้งโฟลเดอร์" ได้
- เดิมต้องเลือกไฟล์วิดีโอทีละไฟล์. เพิ่ม **ปุ่ม "📁 เลือกทั้งโฟลเดอร์"** (native `webkitdirectory`) — เลือกโฟลเดอร์เดียว ไฟล์ทุกไฟล์ข้างใน (รวม subfolder) เข้าคิว upload เลย.
- **ลากทั้งโฟลเดอร์มาวาง** ได้ด้วย — drop handler ใช้ `webkitGetAsEntry` ไล่ทุกไฟล์ในโฟลเดอร์ที่ลากมา (เดิม `dataTransfer.files` ไม่ recurse เข้าโฟลเดอร์).
- กรอง OS cruft อัตโนมัติ (`.DS_Store`, `._*`, `Thumbs.db`) — ไม่ขึ้นแถว error เปล่า ๆ ตอนยัดทั้งโฟลเดอร์.
- ทุกไฟล์ยัง upload ลง `<camera>/<ชื่อไฟล์>` แบบ flatten (โครงสร้าง subfolder ไม่ถูกเก็บ — ถ้าต้องการค่อยทำเพิ่ม). ไฟล์เดียว: `src/app/_components/booking/UploadSection.tsx`.

⚠️ ต้อง **redeploy** ถึงจะเห็นปุ่ม (แก้ฝั่ง client bundle).

---

## [1.80.1] — 2026-06-22

### Fixed — Upload Footage ค้างที่ Drive 0% retry 3/4 (CORS)
- **อาการ:** อัปโหลด footage เข้า Drive ค้างที่ 0% แล้ว retry จนครบ 4 ครั้งแล้ว fail (แถบสีส้ม "retry 3/4"). ทุกไฟล์ ทุกขนาด.
- **ต้นเหตุ:** เบราว์เซอร์ PUT แต่ละ chunk ตรงเข้า `googleapis.com` (cross-origin). ตอนเปิด resumable session เราไม่ได้ส่ง header `Origin` ไป → Drive **รับ bytes สำเร็จ (HTTP 200)** แต่ response ของ chunk PUT **ไม่มี `Access-Control-Allow-Origin`** → เบราว์เซอร์ block ผลลัพธ์เป็น CORS error → `xhr.onerror` → retry จนหมดแล้ว fail. (preflight มี ACAO แต่ response จริงไม่มี — พิสูจน์ด้วยการ reproduce จริง: init แบบไม่ส่ง Origin → response ACAO = null; ส่ง Origin → ACAO = ตั้งค่าถูก.)
- **แก้:** ส่ง `Origin` ของเบราว์เซอร์เข้าไปตอนเปิด session (`createResumableUploadSession`) จาก `Origin` header ของ request `/api/upload/init` (fallback `NEXTAUTH_URL` / `NEXT_PUBLIC_APP_URL` เผื่อ proxy ตัด header ทิ้ง). Drive จึงใส่ ACAO กลับมาในทุก chunk PUT.
- **ไฟล์:** `src/lib/google-drive.ts`, `src/app/api/upload/init/route.ts`.

⚠️ ต้อง **redeploy** ถึงจะมีผล (แก้ฝั่ง server). ถ้า proxy หน้าเว็บตัด `Origin` header ออก ต้องตั้ง `NEXTAUTH_URL=https://probook.xtec9.xyz` ใน stack ให้ตรงกับ origin จริงของเบราว์เซอร์.

---

## [1.80.0] — 2026-06-20

### Added/Changed — ตาราง Rentals ดูง่ายขึ้น + migrate ข้อมูลที่ขาด
- **ฟิลเตอร์ ปี / เดือน / Outlet** ในตาราง Rentals (เหมือนชีท) + เพิ่มคอลัมน์ Outlet. กรอง rentalDate ตามปี (เลือกเดือนในปีนั้นได้) + กรองตาม outlet.
- **ขยาย importer** (`scripts/import-workspace.ts rentals`) ให้ดึงคอลัมน์ที่เคยข้าม: กำหนดคืน (returnDueDate), วันคืนจริง (returnedAt), หมายเหตุ (remark).
- **migrate เอกสารจากชีท** — คอลัมน์ที่เป็นลิงก์ (ใบเสนอราคา/ใบแจ้งหนี้/ใบกำกับ/ใบเสร็จ/ไฟล์แนบ) สร้างเป็น DocumentRef ผูกกับงานเช่า → กดดูผ่านปุ่ม 📎 ในตารางได้.

⚠️ ข้อมูล/เอกสารจะเข้าจริงเมื่อ **รัน importer ใหม่กับชีท prod**: `tsx scripts/import-workspace.ts rentals --commit` (ในคอนเทนเนอร์ที่ service account อ่านชีทได้).

---

## [1.79.0] — 2026-06-19

### Added — UX จาก product review
- **ฉบับร่างจองคิว auto-save + “ทำต่อ”** — ฟอร์ม /new เซฟลง localStorage อัตโนมัติ; ปิดเบราว์เซอร์กลางคัน (โดยเฉพาะมือถือ) แล้วกลับมาทำต่อได้ ไม่หาย. ล้างอัตโนมัติเมื่อจองสำเร็จ.
- งานหลายตอน: ปุ่ม **“↑ เหมือนก่อนหน้า”** คัดลอกโปรแกรม+ประเภทจาก EP ก่อนหน้า (ลดการกรอกซ้ำ).
- error boundary เฉพาะหน้า /new (บอกว่าฉบับร่างถูกเซฟ + ปุ่มลองใหม่).

### Changed
- camera-load warning เป็นสองภาษา (ไทย/อังกฤษ).
- SMTP ส่งอีเมล retry 1 ครั้งเมื่อ fail ชั่วคราว (กัน digest เตือนหายทั้งวันเพราะ hiccup เดียว).

---

## [1.78.0] — 2026-06-19

### Added — ops reliability (จาก product review)
- **Backup DB อัตโนมัติ** → worker รายวัน `pg_dump` + gzip อัปขึ้น Google Drive (`scripts/backup-worker.js`), prune เก่ากว่า retention. เปิดด้วย env `BACKUP_WORKER_ENABLED=1` + `BACKUP_DRIVE_FOLDER_ID`.
- **Dead-man switch** — worker ทุกตัวบันทึก heartbeat; ถ้า worker ที่เปิดอยู่เงียบเกิน interval+2 ชม. (เช่น backup >~26 ชม.) ส่ง alert Discord+email (throttle 6 ชม.). + endpoint `GET /api/health-summary` (200/503, public) สำหรับ uptime probe ภายนอก.
- **`/api/version`** บอก version + commit ที่รันจริง; CI ยืนยัน manifest pull ได้ก่อน build เขียว (กัน "manifest unknown") + พิมพ์ tag ที่จะ deploy ใน job summary.
- `INITIAL_ADMIN_EMAILS` ตั้ง admin เริ่มต้นผ่าน env (เลิก hardcode คนเดียวใน auth.ts).

⚠️ deploy: model ใหม่ `SystemHeartbeat` (auto `db push` ตอน start) + env ใหม่ดูใน docker-compose.portainer.yml

---

## [1.77.0] — 2026-06-19

### Added — ฐานราคาผู้ขาย (vendor price database)
- โมดูล Admin จัดการราคาเช่าต่อวันต่อ vendor/หมวด/รายการ (`/admin/vendor-prices`, CRUD) + API lookup สาธารณะ `GET /api/vendor-prices`. model `VendorPrice` ใหม่.
- นำเข้าราคาจริง **676 รายการ** (17thanwafilm 144 รายการ + Baanfilm 532 รายการ) ผ่าน Admin API. Hiya: ภาพแหล่งข้อมูลไม่มีราคา — เพิ่มได้ภายหลัง.
- ช่อง **Price Lookup** ใน Cost Sheet Tool — ค้นหาชื่ออุปกรณ์แล้วดึงราคาจาก probook API (`/api/vendor-prices`) แบบ real-time.

---

## [1.76.1] — 2026-06-19

### Changed (ponytail audit — lean cleanup, no behavior change)
- รวม `parsePositiveInt()` ที่ก็อปซ้ำ 3 worker → `scripts/lib/env.js`; ลบ dead env `GOOGLE_SHEETS_ID` (3 ไฟล์ config, ไม่มีโค้ดอ่าน); hoist subexpression ซ้ำใน BookingWizard summary (producers/directors find, epRows filter).

---

## [1.76.0] — 2026-06-19

### Fixed
- ช่องจำนวน **crew / กล้อง / ไมค์** พิมพ์ได้แล้ว + เพิ่มปุ่ม **−/+** (NumberStepper) กดง่ายบนมือถือ — เดิมช่อง Videographer พิมพ์ไม่ได้ (เด้งกลับเป็น 1 ทุก keystroke). ใช้ทั้งฟอร์มจอง / Routine / หน้าแก้ไข booking (Producer + Admin); กล้อง/ไมค์ปล่อยว่างได้, 0 = ไม่ใช้.

---

## [1.75.0] — 2026-06-19

### Added
- **แนบเอกสารเข้า Google Drive** — ปุ่ม 📎 ทุกแถว Rentals/Purchases/Repairs/Loans: อัปโหลดใบเสนอราคา/ใบแจ้งหนี้/สลิป/ใบเสร็จ, ระบบสร้างโฟลเดอร์ตามงานให้เอง (`<DRIVE_DOCS_ROOT>/<หมวด>/<ชื่องาน>`), เปิด/ลบไฟล์ได้, ไฟล์ ≤25MB (Drive อย่างเดียว).
- ต้องตั้ง env **`DRIVE_DOCS_ROOT`** จึงจะอัปโหลดได้ (passthrough เพิ่มใน compose แล้ว).

---

## [1.74.0] — 2026-06-19

### Changed
- **ตาราง Admin 5 โมดูล — filter/ค้นหา/เรียงระดับโปรแกรมจริง**: ค้นหาข้ามทุกคอลัมน์ (equipment ค้น server `?q=` ทะลุ 1000 แถว), คลิกหัวคอลัมน์เรียง, หัวตารางลอย+เลื่อนในกรอบ, ปุ่มล้างตัวกรอง + ตัวนับ "แสดง N (กรองจาก M)". อัปเกรด CrudTable ตัวเดียว → ได้ทั้ง 5 โมดูล.

---

## [1.73.0] — 2026-06-19

### Changed — แยกเมนูตาม role (เลิกความสับสน Admin / Admin Space)

- **Top nav แยกเป็น 2 hub ตามบทบาท:**
  - **คิวงาน** (Coordinator ขึ้นไป) = หน้าจัดการคิวจอง (เดิมชื่อ "Admin") + ปุ่ม
    รายงาน / Routine / + New
  - **Admin** (ADMIN เท่านั้น) = งานหลังบ้าน (เดิมชื่อ "Admin Space"): คลังอุปกรณ์/
    ยืม-คืน/ซ่อม/เช่า/จัดซื้อ/ผู้ขาย **+ เพิ่มกลุ่ม "ระบบ/จัดการ"** (ทีมงาน · สิทธิ์
    ผู้ใช้ · Reminders · Health)
- **Workspace → "รายงาน"** และ**ยุบเมนู Dashboard เข้ามา** (รายงาน = ตาราง+export,
  มีลิงก์ "📊 ดูกราฟสรุป" ไปหน้า analytics เดิม) — ลดเมนูบนสุดลง
- **ย้ายเครื่องมือจัดการ (Team/Permissions/Reminders/Health) ออกจากหน้าคิว** ไปอยู่
  Admin hub และล็อกเป็น **ADMIN เท่านั้น** (middleware เด้ง Coordinator/Manager/
  Support กลับหน้าคิว) — ตรงเจตนา "จัดการคิว = Coordinator, จัดการ+หลังบ้าน = Admin"
- active-state ของ nav แยกถูก hub (เส้นทาง /admin/* ที่เป็นหลังบ้าน ไฮไลต์ "Admin",
  ที่เหลือไฮไลต์ "คิวงาน")

---

## [1.72.0] — 2026-06-18

### Changed

- **อัปโหลดไป Google Drive อย่างเดียว — ข้าม Wasabi (ชั่วคราว)**: เพิ่มสวิตช์
  `WASABI_ENABLED` (ค่าเริ่มต้น = ปิด). ตอนนี้ทุกการอัปโหลดลง Drive เท่านั้น
  ไม่ว่า outlet จะเป็น DUAL_WRITE หรือผู้ใช้ติ๊ก "include Wasabi" ก็ตาม. เปิด
  dual-write archive กลับเมื่อพร้อมได้โดยตั้ง `WASABI_ENABLED=1` ใน stack env
  (เพิ่ม passthrough ใน `docker-compose.portainer.yml` แล้ว — ไม่งั้น env ไม่เข้า
  container). คีย์ Wasabi เดิมคงไว้ ไม่ถูกแตะ.

---

## [1.71.0] — 2026-06-18

### Fixed — `AUTH_DISABLED` is now wired up (was dead config)

- `AUTH_DISABLED=1` previously did nothing — it was documented in
  `docker-compose.portainer.yml` + echoed by `start.sh`, but no application
  code read it, so the app always required Google OAuth.
- ตอนนี้ `AUTH_DISABLED=1` ข้าม OAuth จริง: `getSession()`
  (`src/lib/session.ts`) คืน session ของ ADMIN ที่ seed ไว้ และ
  `src/middleware.ts` ไม่ redirect ไป `/login` — ใช้บน LAN ที่เชื่อถือได้ /
  ทดสอบ local โดยไม่ต้องตั้ง OAuth
- Admin email มาจาก `SEED_ADMIN_EMAIL` (default `narasit.k@thestandard.co`)
- ปลอดภัยโดย default: ปิดอยู่ (`${AUTH_DISABLED:-0}`), ต้องเป็นสตริง `'1'`
  เป๊ะ ๆ, และมี warning ดังทั้งใน `start.sh` banner และ runtime log เพื่อให้
  การเปิดโดยไม่ตั้งใจมองเห็นได้ทันที — **ห้ามตั้งบน prod ที่เปิดสู่อินเทอร์เน็ต**

## [1.70.1] — 2026-06-18

### Removed / Cleanup (ponytail audit — dead code, ~320 lines)

- ลบ route เก่าที่ตายแล้ว `/api/upload` (อัปโหลดลงดิสก์รุ่นเก่า — ถูกแทนด้วย
  init/complete/cancel/list ตั้งแต่ v1.35) และ component `LogoutButton` ที่ไม่มี
  ใครเรียก (Nav มีปุ่ม sign-out ของตัวเอง)
- ลบ dead exports: `sendApprovalNotification` (email.ts), `PRODUCERS`/
  `CATEGORY_OPTIONS`/`SHOOT_TYPE_OPTIONS` (data.ts), `generateEpisodeIds`,
  `findProject`, `listByRole`, `isVideoCamera`, `formatThaiDate`/`formatDate`/
  `cn` (utils.ts) — ไม่มีผู้เรียกในทั้ง repo
- เอา dependency `clsx` ออก (เหลือผู้ใช้เดียวคือ `cn` ที่ลบไป) + ลบ npm script
  `db:migrate` ที่ตาย (โปรเจกต์ใช้ `prisma db push`)
- เลิก dead UI state (error banner ใน UploadSection ที่ตั้งค่าไม่ได้) + props
  `size`/`dot` ของ StatusPill ที่ไม่มีใครส่ง
- ลบ dead query param `?all` ใน /api/ot
- DRY: `bookingInfoInput()` ตัวเดียวสำหรับเขียน `_SHOOT.txt` (เลิก map 24 ฟิลด์
  ซ้ำใน init + approve) + เอา field `programFolderId` ที่ไม่มีใครอ่านออก
  (ทั้งหมดผ่าน tsc + 108 tests + next build)

---

## [1.70.0] — 2026-06-18

### Changed

- **Footage Drive path ตรงกับโครงใหม่ของ PMC "VIDEO 2026 [JUL–DEC]"** (issue #5):
  `<root>/<NN · Outlet>/<program|category>/<Production ID · งาน>/<CAM-x>/`
  - Outlet folder = `NN · Name` จาก master `OUTLETS` (field `sort`) เช่น
    `01 · News` … `09 · Content Agency` (เลิกพึ่ง `OUTLET_FOLDER_BY_CODE` สำหรับ
    Drive — เหลือใช้เฉพาะ Wasabi archive key ที่คง ASCII เดิม)
  - เพิ่มชั้น **program / รายการ**: outlet shows = ชื่อโชว์จริง (`bookingShowName`),
    Content Agency = category (`Advertorial` / `Event / Forum`)
  - shoot folder separator → ` · ` (U+00B7) เช่น `TSS-EXE-260826-L-01 · งาน`
  - camera vocab ใหม่ **CAM-A..CAM-D + AUDIO + DRONE/SWITCHER/PHOTO/SCREEN**
    (เดิม Cam1…) — dropdown จำกัด CAM-A..ตาม cameraCount + AUDIO (ถ้า micCount>0)
    + specials เสมอ
  - **pre-create โฟลเดอร์กล้องตอน CONFIRMED** (อนุมัติ): สร้าง CAM-A..CAM-{cameraCount}
    (+ AUDIO) + `_SHOOT.txt` ให้ช่างเห็นช่องรอ (best-effort ไม่บล็อกการอนุมัติ;
    ช่องว่าง = กล้องนั้นยังไม่ส่ง) — Block Shot/ไม่ระบุจำนวน = ไม่ pre-create กล้อง
  - context file `booking-info.txt` → **`_SHOOT.txt`**
  - fuzzy matcher รองรับกล่อง `NN · ` ของ PMC; footage scanner รองรับ vocab ใหม่
  - **ต้องตั้ง env `DRIVE_FOOTAGE_ROOT=0AH7f4FZNrHsOUk9PVA` ใน Portainer ตอน cutover**
    (1 ก.ค.) — โค้ดเขียนเข้าโครงใหม่ตาม root ที่ env ชี้

---

## [1.69.0] — 2026-06-18

### Added

- **แสดงจำนวนกล้อง/ไมค์เป็นไฮไลท์สีแดงเด่นๆ** ทุกที่ — ป้าย 🎥/🎙 พื้นแดงตัวหนา
  บนการ์ดในหน้า queue (/admin) และในหน้า booking detail (/admin/[id]) ทั้งส่วนหัว
  และตาราง Booking Details (เดิมไม่โชว์กล้อง/ไมค์เลย) · ถ้าไม่ระบุ → ป้ายแดง
  "⚠️ ไม่ระบุกล้อง/ไมค์" · ถ้าเป็น Block Shot → ป้ายม่วง 📦 (component ร่วม
  `CameraMicTag`)

---

## [1.68.0] — 2026-06-18

### Added

- **แถบเตือน "รายละเอียดไม่ครบ" บนหน้า booking detail** (`/admin/[id]`) — ขึ้น
  แถบสีเหลืองพร้อมรายการที่ยังไม่ได้ระบุ: จำนวนกล้อง, จำนวนไมค์, เวลาเลิก (Wrap),
  สถานที่, ทีมงาน (Crew) เพื่อให้แอดมินเห็นทันทีว่างานไหนข้อมูลไม่ครบ (โดยเฉพาะ
  งานที่ไม่ระบุกล้อง) · งาน **Block Shot** จะไม่ถูกนับเรื่องกล้อง/ไมค์ (มีป้าย 📦
  บอกว่าตั้งใจไม่ระบุ) · งานที่ยกเลิกแล้วไม่เตือน

---

## [1.67.0] — 2026-06-18

### Added

- **ตัวเลือก "จองเป็นคิว Block Shot"** ในฟอร์มจอง (/new ขั้น People & Crew) —
  เช็กบ็อกซ์ 📦 เมื่อเลือกแล้ว **ไม่บังคับ**กรอกจำนวนกล้อง/ไมค์ (สำหรับคิวที่ยัง
  ไม่ฟิกซ์อุปกรณ์) ป้ายกล้อง/ไมค์เลิกขึ้น * และ validation ข้ามให้ · บันทึกเป็น
  `Booking.isBlockShot` (แสดงในขั้น Review) · ตรวจซ้ำที่ server (`create-booking.ts`
  ข้ามเงื่อนไข required ของ v1.66 เมื่อ isBlockShot) + MCP `create_booking`
  (cameraCount/micCount กลับเป็นไม่บังคับ, เพิ่มพารามิเตอร์ isBlockShot)

---

## [1.66.0] — 2026-06-18

### Changed

- **จำนวนกล้อง (🎥) และจำนวนไมค์ (🎙) เป็นช่องบังคับ** ในการสร้าง booking ทุกทาง
  — ฟอร์มจองใหม่ (/new ขั้น People & Crew, ขึ้น * + error แดงถ้าเว้นว่าง),
  Routine Planner (ปุ่มสร้างถูกล็อกจนกว่าจะกรอก) และตรวจซ้ำที่ server
  (`create-booking.ts` → 400 ถ้าไม่ส่งมา) รวมถึง MCP `create_booking`
  (เพิ่มเข้า required). ใส่ **0 ได้** ถ้าไม่ใช้กล้อง/ไมค์ แต่ห้ามเว้นว่าง —
  ปิดช่องที่ booking เข้ามาโดยไม่ระบุจำนวนกล้อง (ทำให้ระบบเตือนกล้องเกิน +
  วางแผนทีมพลาด)

---

## [1.65.0] — 2026-06-18

### Changed

- **Production Admin Space เป็น dashboard คลังอุปกรณ์ (inventory control) จริง** —
  เลิกเป็นการ์ดลิงก์ลอยๆ จัดกลุ่มตาม lifecycle: **คลังอุปกรณ์** (Equipment +
  แถบสถานะ พร้อมใช้/ถูกยืม/ซ่อม/ปลดระวาง) → **การเคลื่อนไหว** (Loans, Repairs) →
  **จัดซื้อ-จัดหา & ผู้ขาย** (Rentals, Purchases, Vendors) ทุกการ์ดโชว์ตัวเลข
  จริง (live count) + แถบ **"ต้องจัดการ"** ด้านบน (ยืมเกินกำหนด, ค่าเช่าค้างจ่าย,
  งานซ่อมค้าง, ประกันใกล้หมด 30 วัน) ลิงก์ตรงไปหน้าที่เกี่ยวข้อง
- **ปุ่มย้อนกลับ** ในทุกหน้าโมดูล (equipment/loans/repairs/rentals/purchases/
  vendors) กลับมาที่ **Production Admin Space** แล้ว (เดิมเด้งไป Admin Console)
- **สถานะแสดงเป็น badge สี + ภาษาไทย** ทุกหน้า (พร้อมใช้/ถูกยืม/กำลังซ่อม,
  จ่ายแล้ว/วางบิล/รอจ่าย, ฯลฯ) แทน enum ดิบ; หน้า Loans ขึ้น **"เกินกำหนด"
  สีแดง** เมื่อยังไม่คืนและเลยวันกำหนด
- แถบสถานะอุปกรณ์บน dashboard นับ **เฉพาะอุปกรณ์ที่ยืมได้** (ไม่รวมทรัพย์สิน
  ถาวร 1,200+ ชิ้นที่เป็นแค่ทะเบียน) ให้สัญญาณคลังที่ใช้งานจริงชัด
- เพิ่ม alert **"ของเช่าเลยกำหนดคืน"** + แยก **"ค่าเช่ารอจ่าย"** บนแถบต้องจัดการ;
  คลิก alert ไปหน้าที่ถูก filter ให้แล้ว (เช่น rentals?payment=PENDING)
- **ช่องค้นหาในหน้า Equipment** (1,719 ชิ้น เกิน cap 1000) — ค้นชื่อ/serial/รหัส
  + ตัวกรอง "ประกันใกล้หมด 30 วัน" + ตัวนับจำนวนแถว (เตือนเมื่อชนเพดาน 1000)
- คำนวณ "วันนี้/เกินกำหนด" ด้วยโซนเวลา **Asia/Bangkok** ตรงกันทั้ง dashboard,
  หน้า Loans และ reminder engine (เดิม dashboard ใช้ UTC เพี้ยน 1 วันช่วงเช้า)

---

## [1.64.0] — 2026-06-18

### Changed

- ย้ายเมนูโมดูลหลังบ้าน (Equipment, Loans, Repairs, Rentals, Purchases,
  Vendors) ออกจากหน้า Admin Console (`/admin`) ไปไว้ในหน้าใหม่
  **Production Admin Space** (`/admin/production-space`) ที่เข้าได้
  **เฉพาะ role = ADMIN** เท่านั้น (non-admin redirect → `/admin`) — แยกเป็น
  เมนู "Admin Space" บนแถบนำทางหลัก (โผล่เฉพาะ ADMIN) ให้เข้าทำงานตรงๆ ไม่ปน
  กับหน้าจัดการคิว

### Security

- ล็อกโมดูลหลังบ้านทั้งหมดเป็น **ADMIN เท่านั้น** (เดิม `requireConsole`):
  API 10 เส้น (`/api/admin/{equipment,loans,repairs,rentals,purchases,vendors}`
  + `/[id]`) เปลี่ยนเป็น `requireAdmin`, และ middleware เด้ง non-admin ที่เปิด
  หน้า `/admin/{module}` กลับไป `/admin` — Coordinator/Manager/Support ไม่
  สามารถเข้าถึงได้อีก (rentals/[id], purchases/[id] เป็น ADMIN อยู่แล้ว)

---

## [1.63.0] — 2026-06-18

### Added

- อุปกรณ์พิเศษ (Special Equipment): เช็กบ็อกซ์ 4 รายการ (Gimbal/Ronin, Prompter,
  Clip-on Mic (DJI Mic), ไฟดวงเล็ก) ในฟอร์มจอง (/new ขั้น People & Crew) + ขั้น
  Review + หน้าแอดมิน /admin/[id] (ดู + แก้) + description ของ Google Calendar —
  เก็บเป็น `Booking.specialEquipment` (string[])
- เตือนกล้องเต็ม (>9 ตัว): แถบสีแดงแบบ "ไม่บล็อก" ขึ้นในฟอร์มจอง (/new) และหน้า
  แอดมิน เมื่อผลรวม cameraCount ของงานที่ช่วงเวลาทับกัน (REQUESTED + CONFIRMED
  รวมงานที่กำลังจอง) เกิน 9 ตัว → เตือนว่าต้องเช่ากล้องเพิ่ม รองรับด้วย
  `POST /api/camera-load` + `src/lib/booking-overlap.ts` (CAMERA_LIMIT=9)
- Producer แก้ไขงานเองได้ (เฉพาะสถานะ Requested): Producer/เจ้าของงานแก้รายละเอียด
  งานของตัวเองที่ยังเป็น Requested ได้จาก /my-bookings (ปุ่ม "✏️ แก้ไข") — แก้ได้
  ทุกฟิลด์รายละเอียด (เวลา Call/Wrap, ประเภทงาน, สถานที่, Producer, Creative, Crew,
  จำนวนกล้อง/ไมค์, รถตู้, อุปกรณ์พิเศษ, Agency Ref, Notes, ชื่อตอน) **ยกเว้น**
  วันถ่าย/Outlet/Program/Episode ID (กำหนดตายตัว) และฟิลด์ฝั่งแอดมิน (สถานะ/มอบหมาย/
  admin notes). เมื่อบันทึก ระบบส่งอีเมลสรุปสิ่งที่แก้ให้ทีมคิวงาน (Coordinator/Admin)
  อัตโนมัติ. ใหม่: POST(PATCH) /api/bookings/[id]/producer-edit + หน้า /bookings/[id]/edit
  (เซิร์ฟเวอร์บังคับสิทธิ์: เจ้าของงาน + สถานะ Requested เท่านั้น)

### Fixed

- **Migration import: rentals ล้มทั้งชุดเพราะวันที่ผิดฟอร์แมต.** `parseSheetDate`
  ใน `scripts/import-workspace.ts` ตกมาที่ `new Date(s)` เมื่อเจอค่าที่ไม่เข้า
  รูปแบบเดิม. ค่า serial date ดิบของ Google Sheets (เช่น `46035` = เซลล์วันที่
  ที่ไม่ได้ฟอร์แมต) ถูก V8 ตีเป็น **ปี 46035** → Prisma `rentalJob.findFirst()`
  พังทั้ง import (rentals: FAILED, 0 แถว). **แก้:** แปลง serial 5 หลักเป็นวันที่
  จริง (ฐาน 1899-12-30) + clamp ปีให้อยู่ 1990–2100 (ค่าหลุดช่วง/NaN → null)
  เพื่อให้เซลล์เพี้ยนเซลล์เดียวไม่ทำให้ทั้ง import ล่มอีก. ใช้ร่วมทุก importer.
- **ระบบเตือน (reminders) ไม่ทำงานบน prod**: `docker-compose.portainer.yml` ไม่ได้
  ส่ง env ของ worker เตือน (`REMINDERS_WORKER_ENABLED`, `DISCORD_WEBHOOK_URL`,
  `REMINDER_ADMIN_EMAIL`, ฯลฯ) เข้า container เลย — Portainer stack env ใช้แค่แทนค่า
  `${VAR}` ในไฟล์ compose เท่านั้น ถ้า compose ไม่อ้างถึง ตัวแปรก็ไม่เคยถึง container
  worker จึงขึ้น `REMINDERS_WORKER_ENABLED is off` ตลอด. เพิ่ม passthrough block ใน
  app service (ค่า secret ของ Discord ยังอยู่ใน Portainer stack env เท่านั้น ไม่ commit
  ลงไฟล์). ป้องกันซ้ำ: env ของ worker ใหม่ต้องประกาศใน compose เสมอ ไม่ใช่แค่ตั้งใน Portainer.

---

## [1.62.1] — 2026-06-18

### Fixed — Equipment loan/return ↔ status sync (was effectively dead in the UI)

ระบบยืม-คืนอุปกรณ์ไม่ผูกกับสถานะคลังจริง (พบจากการทดสอบ + audit 26 agent / 21 ข้อ; แก้แล้ว review 7 agent).

- **ยืมผ่าน UI ไม่เคย sync สถานะ (บั๊กหลัก):** ฟอร์ม "ยืมอุปกรณ์" เป็น free-text จึงไม่ส่ง
  `equipmentId` → ON_LOAN/คืน ไม่เคยทำงานสำหรับ loan ที่สร้างผ่านหน้าเว็บ. **แก้:** POST
  /api/admin/loans resolve `equipmentId` ฝั่ง server จาก tag/ชื่อ (fixedAssetTag/itemId/
  serialNumber/name เหมือน import) ก่อนผูกสถานะ.
- **รวม writer ของ Equipment.status เป็นแหล่งเดียว:** เพิ่ม `src/lib/equipment-status.ts`
  (`reconcileEquipmentStatus` + pure `deriveEquipmentStatus`, ลำดับ RETIRED>IN_REPAIR>ON_LOAN>
  AVAILABLE). ทุก writer (ยืม/คืน/ลบ, ซ่อม สร้าง/แก้/ลบ) **derive** จากโลกจริงแทนการเขียนตรง —
  คืน loan ไม่ทับ IN_REPAIR/RETIRED, ของมี 2 loan คืนอันเดียวไม่หลุด, เปลี่ยนอุปกรณ์ใน ticket ซ่อม
  ไม่ทิ้งตัวเก่าค้าง, un-return กลับ ON_LOAN.
- **guard:** ยืมเช็คความพร้อม (409 ถ้าไม่ loanable/ไม่ AVAILABLE); แก้สถานะมือได้เฉพาะ
  RETIRED/AVAILABLE (ON_LOAN/IN_REPAIR ระบบ derive); CrudTable แสดงค่าปัจจุบันเป็น option
  disabled เมื่อไม่อยู่ในตัวเลือก (สถานะ derive ไม่โผล่ว่าง).
- **reminder กันลืม:** booking ที่มี loan active แล้ว ไม่ขึ้น "ยังไม่จัดอุปกรณ์" อีก.
- ค้างไว้ (มีอยู่เดิม, ต่ำ): loanCode ชนกันได้ตอนสร้างพร้อมกัน → 500 เป็นครั้งคราว.
- 103 tests (เพิ่ม equipment-status.test.ts), tsc 0 errors, build ผ่าน.

---

## [1.62.0] — 2026-06-17

### Added — Unified admin workspace (เฟส 1: วางแผนอัตโนมัติ + ระบบเตือนกันลืม)

เฟสแรกของการรวม 3 Google Sheet ที่ทำมือ (อุปกรณ์+ซ่อม, วางแผนงาน, เช่า/ซื้อ/การเงิน)
เข้ามาในระบบ probook แทน Airtable — ใช้ Postgres/worker/อีเมล/ปฏิทิน/auth เดิมซ้ำ

- **วางแผนงานอัตโนมัติ** (เลิกก๊อปปฏิทิน→ชีตด้วยมือ): เพิ่ม 3 ฟิลด์บน Booking —
  `equipmentNote` (จัดอุปกรณ์), `rentalGearNote` (ของเช่า), `itinerary` (คิวถ่าย) +
  `assignedEquipmentIds` — กรอกได้ในหน้า /admin/[id], แสดงเป็นคอลัมน์ใน
  /admin/workspace, และ export รูปแบบชีตเดิมได้ที่
  `GET /api/admin/workspace/export-planning` (START/END/DESCRIPTION/DURATION/
  NOTES/LOCATION/CAMERA/เช่า)
- **ระบบเตือน "กันลืม"** (`src/lib/reminders.ts`): สแกนรายวันหา ยืมอุปกรณ์
  ใกล้ครบ/เกินกำหนด, ของเช่าถึงกำหนดคืน, ใบแจ้งหนี้ค้าง, งานซ่อมค้าง, งานถ่าย
  ที่ยังไม่จัดอุปกรณ์, ประกันใกล้หมด — ส่ง **Discord** (webhook) + **อีเมลสรุป**
  รายวัน, มีกล่องในแอปที่ `/admin/reminders` (กด Dismiss/Resolve) ·
  worker `scripts/reminders-worker.js` (supervised ใน start.sh) →
  `GET /api/internal/reminders/run` (secret-gated) · กันส่งซ้ำด้วย `dedupeKey`
- **เฟส 2 — การเงิน:** หน้า + CRUD API สำหรับ **Rentals** (สถานะจ่าย จ่ายแล้ว/
  วางบิล/รอจ่าย + ติดตามวันคืน), **Purchases**, **Vendors**, แนบ **เอกสาร** Drive
  ผ่าน `/api/admin/documents` · ทุกหน้าใช้ `CrudTable` ตัวเดียวร่วมกัน (config-driven)
  · เขียนการเงินเฉพาะ ADMIN, ดูได้ทุก console tier
- **เฟส 3 — อุปกรณ์/ยืม/ซ่อม:** หน้า **Equipment** (คลัง + ค้น/กรอง),
  **Loans** (ยืม-คืน, กดคืนแล้ว→ปล่อยอุปกรณ์เป็น AVAILABLE, รหัส LOAN-YYMMDDHHMM),
  **Repairs** (ตารางที่ขาดไป: อาการ→ร้าน→วันส่ง/รับ→ค่าซ่อม) · สถานะอุปกรณ์ผูกกับ
  loan/repair อัตโนมัติ (ON_LOAN/IN_REPAIR)
- **นำเข้าข้อมูล:** สคริปต์เดียว `scripts/import-workspace.ts <what> [--commit]`
  (vendors|equipment|fixed-assets|loans|rentals|purchases|repairs|all) — อ่านชีตเดิม,
  map คอลัมน์แบบ header-based (ทน typo QUATITY/Catelogies), **dry-run เป็นค่าเริ่มต้น**,
  upsert ซ้ำได้, พิมพ์สรุป inserted/updated/skipped/unresolved
- **เฟส 4 — MCP:** เพิ่ม read tools (`list_reminders`, `list_overdue_loans`,
  `list_unpaid_rentals`, `list_open_repairs`, `list_equipment`) + write tools
  (`create_repair_ticket`, `mark_rental_paid`) ใน `/api/mcp` — ถามผู้ช่วยได้ว่า
  "มีอะไรค้าง/เกินกำหนด" · LINE ยังเลื่อน (Notify ตายแล้ว)
- **โครงสร้างข้อมูล (เฟส 0):** models `Equipment`, `EquipmentLoan`
  (+`EquipmentLoanItem`), `RepairTicket`, `Vendor`, `RentalJob`, `PurchaseItem`,
  `DocumentRef`, `Reminder` (additive, `prisma db push`)

### Notes

- env ใหม่: `DISCORD_WEBHOOK_URL`, `REMINDERS_WORKER_ENABLED=1`,
  `REMINDER_ADMIN_EMAIL`, (ปรับได้) `INVOICE_AGING_DAYS`, `SHOOT_GEAR_LOOKAHEAD_DAYS`,
  `LOAN_DUE_LOOKAHEAD_DAYS`, `REPAIR_AGING_DAYS`, `WARRANTY_LOOKAHEAD_DAYS`,
  `REMINDERS_WORKER_INTERVAL_MS` (ดีฟอลต์รายวัน)
- อีเมลสรุปต้องใช้ provider แบบ non-interactive (SMTP/Resend/SendGrid) เพราะ
  worker ไม่มี session ผู้ใช้ (ใช้ Gmail-OAuth ไม่ได้); Discord ทำงานได้เลย

## [1.61.0] — 2026-06-17

### Added

- อุปกรณ์พิเศษ (Special Equipment): New Booking (ขั้น People & Crew) และหน้า
  แอดมินมีเช็กบ็อกซ์ 4 รายการ — Gimbal/Ronin, Prompter, Clip-on Mic (DJI Mic),
  ไฟดวงเล็ก — เก็บเป็น `specialEquipment` (string[]) แสดงในขั้น Review, หน้า
  รายละเอียดแอดมิน, และ description ของอีเวนต์ Google Calendar
- เตือนกล้องเต็ม: แถบสีแดงแบบไม่บล็อก ขึ้นใน New Booking และหน้าแอดมิน เมื่อ
  ผลรวม cameraCount ของงานที่ช่วงเวลาทับกัน (REQUESTED + CONFIRMED รวมงานนี้)
  เกิน 9 ตัว — เตือนว่าต้องเช่ากล้องเพิ่ม รองรับด้วย POST /api/camera-load +
  src/lib/booking-overlap.ts

## [1.60.1] — 2026-06-14

### Changed

- หน้า Calendar (โหมด Google): เพิ่มหมายเหตุใต้ embed — ถ้าว่างเพราะปฏิทินเป็น
  ส่วนตัว ให้กด "เพิ่มลงปฏิทินของฉัน" หรือให้แอดมินตั้งปฏิทินเป็นสาธารณะ ·
  ย้ำว่างานขึ้นปฏิทินเฉพาะที่อนุมัติแล้ว (CONFIRMED) — แก้อาการ "embed ว่าง"
  ที่จริง ๆ เป็น setting การแชร์ของ Google ไม่ใช่บั๊ก

## [1.60.0] — 2026-06-14

### Added — หน้า Calendar: สลับดู Google Calendar + Subscribe ได้

- **Toggle ด้านบน** สลับระหว่าง **ปฏิทินในระบบ** (Month/Agenda เดิม) กับ
  **Google Calendar** (ฝัง embed) · จำค่าที่เลือกไว้ใน localStorage
- โหมด Google Calendar แสดง **embed เต็ม ๆ** + แผง **Subscribe**:
  ปุ่ม "เพิ่มลงปฏิทินของฉัน" (เปิดหน้า add calendar ของ Google), "เปิดเต็มจอ",
  และ **Calendar ID** พร้อมปุ่มคัดลอก (สำหรับ Subscribe ด้วยตนเอง)
- Calendar ID = ปฏิทินที่งานอนุมัติแล้วซิงก์ไปอยู่แล้ว (`NEXT_PUBLIC_GOOGLE_CALENDAR_ID`
  override ได้, default = production calendar)

## [1.59.2] — 2026-06-14

### Changed — อัปเดตทรัพยากรในการ์ดกติกาหน้าแรก

- Camera: เพิ่ม Sony FX30 จำนวน 3 ตัว (เป็น FX6 ×3 · FX3 ×3 · FX30 ×3)
- Switcher: 1 → 2 คน

## [1.59.1] — 2026-06-14

### Changed — เพิ่มรายการตามชีทล่าสุด

เทียบ `src/lib/data.ts` กับชีท outlet DB — เติมรายการที่ขาด:
- **LIFE:** Article (ART)
- **The Secret Sauce:** Kendom (KDM), Kensight (KSG)

(รายการ "New!" อื่น ๆ — Sport 4 รายการ, TWD, Expertise Room, Geopolitics
for business, Old school — มีในระบบอยู่แล้ว)

### Ops
- รัน Import producers บน production แล้ว (v1.59.0) → dropdown Producer/Co-Producer
  ต่อ outlet ใช้งานได้: NWS=ศรุต/เค้ก · WLT=ปิ่น/แอ๊นท์ + เติร์ก(co) ·
  TSS=แพร + มิ้ง(co) · POP=ขิม · LIF=มีน · POD=ฝัน/ใหญ่ (SPT ยังไม่มีในชีท → พิมพ์เอง)

## [1.59.0] — 2026-06-14

### Added — Producer / Co-Producer เป็น Dropdown แยกตาม Outlet + บัญชีผู้ใช้

ดึงรายชื่อจากชีท "outlet DB" ของทีมมาเป็นแหล่งข้อมูล Producer/Co-Pro ต่อ outlet
และสร้างบัญชีให้คนเหล่านี้บันทึกข้อมูลได้อย่างเป็นระบบ

- **ฟอร์มจอง (non-AGN):** ช่อง Producer/ผู้ติดต่อแบบพิมพ์เอง → เปลี่ยนเป็น
  **Dropdown Producer + Co-Producer แยกตาม outlet** (ดึงจาก
  `GET /api/producers?outlet=`) · outlet ไหนยังไม่มีรายชื่อจะ fallback
  เป็นช่องพิมพ์เองเหมือนเดิม · AGN ใช้ flow เดิม (_Users + Director)
- **บัญชีผู้ใช้:** ปุ่ม **"↧ Import producers (sheet)"** ใน /admin/permissions
  (ADMIN) → สร้าง/อัปเดต User จาก `src/lib/outlet-producers.ts` พร้อม tag
  `producerOutlets` + ชื่อเล่น/ชื่อไทย/รหัสพนักงาน/ตำแหน่ง · idempotent
  (merge outlet เดิม ไม่ลบ ไม่เปลี่ยน role) · คน role Switcher ได้บัญชี
  แต่ไม่ขึ้นใน dropdown · ทุกคนล็อกอินด้วย Google SSO ได้ทันที
- **Schema:** `User.nickname`, `Booking.coProducer` + `Booking.coProducerEmail`
  (nullable, apply ผ่าน prisma db push) · Co-Producer โชว์ใน Review/summary
  และคอลัมน์ Workspace
- mapping outlet จากชีท: The Secret Sauce→TSS · Pop→POP · LIFE→LIF ·
  Wealth→WLT · News Program→NWS · Podcast→POD · Video Production→AGN

### หมายเหตุหลัง deploy
- ต้องกด **Import producers** ที่ /admin/permissions หนึ่งครั้งเพื่อสร้างบัญชี
  + เติม dropdown (รายชื่อมาจากชีท แก้เพิ่มภายหลังได้ที่ /admin/permissions)

## [1.58.0] — 2026-06-14

### Changed — ฟอร์มจอง: location + รถตู้ ปรับตามประเภทการถ่าย

หน้า /new step Location แยกชัดระหว่างถ่ายที่ออฟฟิศ vs นอกสถานที่

- เลือก **On Location (นอกสถานที่)** → แสดงกล่อง **Map location** (กรอกชื่อ
  สถานที่ / ที่อยู่ / ลิงก์ Google Maps) และ **ซ่อนตัวเลือกห้องในออฟฟิศ**
- เลือก **Studio / Event (ถ่ายที่ออฟฟิศ)** → แสดงเฉพาะ **ตัวเลือกห้องในออฟฟิศ**
  (ตัด External / Other ออก) และซ่อนกล่อง Map location
- **ตัวเลือกรถตู้ 🚐 แสดงเฉพาะเมื่อถ่ายนอกสถานที่** (ก่อนหน้านี้โชว์ตลอด) ·
  สลับโหมดแล้วล้างค่าของอีกโหมดให้อัตโนมัติ กันค่าค้าง

## [1.57.0] — 2026-06-14

### Changed — Routine เป็น "โหมด" ใน New Booking

รวม Routine planner เข้าเป็นตัวเลือกโหมดในหน้า `/new` — coordinator เข้าที่
เดียว "New Booking" แล้วสลับได้ระหว่าง **จองครั้งเดียว** (wizard เดิม) กับ
**Routine (รายสัปดาห์)**

- toggle โหมดด้านบน `/new` แสดง **เฉพาะ console** (ADMIN/Manager/Coordinator) —
  USER ทั่วไปเห็นแค่ wizard จองครั้งเดียวเหมือนเดิม (Routine สร้างทีละหลายสิบใบ
  เป็นอำนาจ console + API เป็น requireConsole อยู่แล้ว)
- ตัว planner ถูกแยกเป็น component กลาง `src/app/_components/RoutinePlanner.tsx`
  ใช้ร่วมกันทั้ง `/new` (โหมด Routine) และ `/admin/routine` (หน้าเฉพาะ) —
  โค้ดเดียว ไม่ซ้ำ · `/admin/routine` ยังอยู่เหมือนเดิม (เข้าจากปุ่มใน Admin
  Console และเมนู More)

## [1.56.0] — 2026-06-14

### Added — Routine Planner: จองงานรายการ daily ซ้ำรายสัปดาห์ (จ–ศ)

หน้าใหม่ `/admin/routine` (console) สำหรับรายการที่ถ่ายประจำอย่าง
THE STANDARD NOW — สร้างคิวยาว ๆ ทีเดียวแทนการจองมือวันต่อวัน

- **เลือกช่วงวัน + วันในสัปดาห์** (ค่าเริ่ม จ–ศ) → ระบบ generate booking
  1 ใบต่อวันทำการ · **ข้ามเสาร์-อาทิตย์ + วันหยุดราชการไทย + วันที่กำหนดเอง**
- **พรีวิวสด** ก่อนสร้าง: เห็นว่าจะสร้างกี่ใบ วันไหนบ้าง และข้ามวันไหน
  (พร้อมชื่อวันหยุด) — แก้ก่อนกดได้
- ทุกใบสร้างเป็น **REQUESTED** ผ่าน flow เดียวกับการจองปกติ
  (mint Episode ID, audit, validation ครบ) — approve/assign/ปฏิทิน/OT/upload
  ทำงานรายวันได้ตามปกติ
- **แยกชัดจากงานทั่วไป** (ตามที่ขอ): ติด `isRoutine` →
  badge "🔁 Routine" บนการ์ด, แท็บ **🔁 Routine** ใน /admin
  (status tab อื่นจะไม่ปนงาน routine), ตัวกรอง + คอลัมน์ใน Workspace
- **จัดการเป็นชุด:** หน้า Routine โชว์ชุดที่สร้างไว้ (จำนวน/ช่วงวัน/สถานะ)
  พร้อมปุ่ม "ลบทั้งชุด" (soft-delete กู้คืนได้)
- **Schema:** field ใหม่ `Booking.isRoutine` + `Booking.routineGroupId`
  (apply อัตโนมัติผ่าน `prisma db push`) · `GET /api/bookings?routine=only|exclude`
  (ปฏิทิน/dashboard/หน้าแรกไม่เปลี่ยน — ยังเห็น routine ตามปกติ)
- วันหยุดไทยปี 2026 อยู่ใน `src/lib/thai-holidays.ts` (วันพระเป็น best-effort
  — พรีวิวให้ตรวจ/แก้ก่อนสร้างได้)
- **กันจองซ้ำ:** ถ้า generate ทับวันที่มี booking ของรายการเดียวกันอยู่แล้ว
  ระบบข้ามวันนั้นและรายงาน "ข้ามวันที่มี booking อยู่แล้ว N วัน"
- ลบทั้งชุด (cancel) เป็นสิทธิ์ ADMIN (เทียบเท่า soft-delete รายใบ) ·
  เพิ่ม unit test `src/lib/__tests__/routine.test.ts` (80 tests total)

## [1.55.0] — 2026-06-13

### Added — หน้า Workspace: โต๊ะทำงานรวมทุกฟังก์ชันสำหรับ admin

หน้าใหม่ `/admin/workspace` (เข้าจากปุ่ม Workspace ใน Admin Console และเมนู
More) — ตารางงานทั้งหมดในที่เดียว กรอง เลือก และ export ได้ละเอียด

- **กรองครบ:** ค้นหา free-text (Production ID / project / producer / crew /
  notes / episode / location) · chip เลือกหลาย Status + หลาย Outlet ·
  ช่วงวันถ่าย (from–to) · toggle **"มี Freelance"** และ **"ยังไม่ assign"** ·
  ปุ่มล้างตัวกรองบอกจำนวนที่ active
- **ตาราง ~35 คอลัมน์** ครอบคลุมทุก field ของ booking (core / show / people /
  crew & gear / meta รวม freelancer detail, อุปกรณ์, calendar sync ฯลฯ) ·
  คลิกหัวคอลัมน์เพื่อ sort · sticky header + คอลัมน์ Production ID/checkbox
  ค้างซ้าย · โหมด Compact/Comfortable · เลือกซ่อน-แสดงคอลัมน์ได้
  (จำค่าใน localStorage)
- **เลือกหลายแถว** (รวม select-all-filtered) + แถบสถิติสด (จำนวนที่กรอง /
  เลือก / มี freelance / ยังไม่ assign)
- **Export CSV ละเอียด** (`POST /api/admin/workspace/export`, console เท่านั้น):
  เลือกได้ว่า export เฉพาะแถวที่เลือก หรือทั้งหมดที่กรอง · เฉพาะคอลัมน์ที่แสดง
  หรือทุกคอลัมน์ · ใช้ `escapeCSVCell` กัน formula injection + BOM อ่าน Thai
  ใน Excel ได้ · คอลัมน์ทั้งตารางและ export มาจาก registry เดียว
  (`src/lib/workspace-columns.ts`) จึงตรงกันเสมอ

## [1.54.1] — 2026-06-12

### Fixed — ชุดแก้บัคจาก multi-agent bug hunt (48 candidates → ยืนยันจริง 13)

**Workflow integrity (สำคัญสุด):**

- **Approve ชุบชีวิตใบที่ cancel แล้วได้** — route ไม่เคยเช็คสถานะ:
  ใบ CANCELLED กด Approve ได้เลย (UI ก็โชว์ปุ่ม) เด้งกลับเป็น CONFIRMED
  พร้อมสร้าง calendar event + OT ใหม่ → ตอนนี้ 409 ต้อง Restore ก่อน
  และการเขียนเป็น conditional update กันสองแอดมินกดแข่งกัน
- **Approve สร้าง calendar event ซ้ำ** — 3 ทาง: กดพร้อมกันสองคน /
  re-approve ใบ COMPLETED ที่ event เดิมยังอยู่ / reconciler ตัดหน้า
  background create → กันครบ: เช็ค event เดิมก่อนสร้าง, persist แบบ
  guarded (ถ้าใบถูก cancel ระหว่างสร้าง ลบ event ทิ้ง),
  reconciler ข้ามใบที่ PENDING สด ๆ และไม่สร้าง event ให้ใบที่ไม่ CONFIRMED
- **DELETE /api/bookings/[id] (cancel) ทิ้ง side effects** — เดิมแค่เปลี่ยน
  สถานะ: calendar event ยังค้าง (reconciler ไม่เก็บใบ CANCELLED),
  sheet ยังเขียน CONFIRMED, OT ยังนับเงิน → ทำครบเหมือน PATCH cancel
  แล้ว + เช็ค transition (cancel ใบ COMPLETED ไม่ได้แล้ว)
- **autoComplete แข่งกับ cancel** — updateMany เช็คสถานะซ้ำตอนเขียน
  กันใบที่เพิ่ง cancel โดนปั๊มเป็น COMPLETED

**Dashboard / UI:**

- **หน้า Home เรียงผิดทาง** — "My upcoming" กับ "Needs attention"
  โชว์งานไกลสุดก่อนแล้วตัดงานใกล้ทิ้ง (API ส่ง desc) → เรียง
  soonest-first ก่อน slice ทุก panel · KPI "Needs attention" เคยถูก cap
  ที่ 6 → นับจากจำนวนจริง
- **/admin โชว์แค่ 50 แถวเงียบ ๆ** → ขยายเป็น 200 + บอก "แสดง X จาก Y"
  · กัน fetch แข่งกันตอนสลับแท็บเร็ว ๆ (ผลแท็บเก่าทับแท็บใหม่)
  · loading ไม่ค้างเมื่อ fetch พัง
- **Approve บน /admin/[id] ไม่อัปเดต sync chip** — อ่าน field ที่ API
  ไม่ได้ส่ง → ใช้ booking จาก response แล้ว เห็น "sync pending" ทันที
- **Team Workload ช่วงวันที่เพี้ยนก่อน 07:00 น.** — ใช้ UTC date
  (toISOString) → ใช้วันที่ local แล้ว

**ที่ตรวจพบแต่ยังไม่แก้ในรอบนี้** (บันทึกไว้เป็น backlog): CA fallback
"จองโดยไม่มี Project ID" ที่ฟอร์มสัญญาแต่ server ปฏิเสธ 400 เสมอ
(ต้องตัดสินใจ product ก่อน) · ลิงก์ Bookings ใน Sheet Monitor ที่ส่ง
`?projectId=` แต่ dashboard ไม่อ่าน · sequence race ตอนสร้าง booking
พร้อมกัน (เจอ 500 แทน 409 — เกิดยากบนทีมเล็ก)

## [1.54.0] — 2026-06-12

### Changed — Director ของ Content Agency เป็น optional

- ฟอร์มจอง: เลิกบังคับเลือก Director สำหรับ outlet Content Agency
  (label ติดป้าย "ไม่บังคับ", ตัวเลือกแรกเป็น "ไม่ระบุ") — ฝั่ง server
  รองรับ null อยู่แล้ว ไม่ต้องแก้

### Added — Producer แยกตาม outlet ในหมวด User (ฐานข้อมูลสำหรับ dropdown)

- **Schema:** field ใหม่ `User.producerOutlets` (array ของ outlet code
  เช่น `["NWS","POP"]`) — apply อัตโนมัติผ่าน `prisma db push`
- **หน้า `/admin/permissions`:** คอลัมน์ใหม่ "Producer (Outlet)" —
  ติด/ถอด tag outlet ต่อ user ได้ inline (chip toggle ทั้ง 9 outlet)
  สิทธิ์การแก้ใช้ matrix เดิม (canEditUser) · ค้นหาด้วย outlet code ได้
- **`GET /api/producers`** — แหล่งข้อมูล dropdown:
  `?outlet=NWS` ได้รายชื่อ producer ของ outlet นั้น ·
  ไม่ใส่ param ได้ map ทั้งหมด (`byOutlet`) · เฉพาะ user ที่ active
- tag นี้**ไม่ให้สิทธิ์อะไรเพิ่ม** — Producer Dashboard ยังเช็คจาก
  `position` ตามเดิม · ขั้นถัดไป: เปลี่ยนช่อง Producer ในฟอร์มจอง
  (outlet ที่ไม่ใช่ CA) จาก free text เป็น dropdown จากข้อมูลชุดนี้

## [1.53.0] — 2026-06-11

### Added — Switcher + Photographer ในตัวเลือก Crew Required

- ฟอร์มจอง (`/new` step People & Crew) เพิ่มตัวเลือก **Photographer**
  และ **Switcher** ใน Crew Required — สอดคล้องกับหน้า Assign ที่มี
  section ทั้งสองตำแหน่ง (พร้อมรายชื่อใน roster) อยู่แล้ว
  แต่ producer ไม่เคยขอได้จากฟอร์ม
- ลำดับตัวเลือกเรียงตาม section ของหน้า Assign: Videographer · Sound ·
  Photographer · Switcher · DIT · Lighting · Virtual Production ·
  Art Director
- ค่าใหม่ไหลไปทุก surface เดิมอัตโนมัติ (ปฏิทิน Google/เว็บ, อีเมล crew,
  Bookings sheet, CSV export) — `crewRequired` เป็น list แสดงผลตรง ๆ

## [1.52.1] — 2026-06-11

### Changed

- การ์ดกติกาหน้าแรก: เอาย่อหน้า "📌 หมายเหตุ" (ลิงก์ Production Setting
  Handbook) ออกตามที่ทีมขอ

## [1.52.0] — 2026-06-11

### Added — กติกาการจองคิวบนหน้าแรก

การ์ด "🚨 คู่มือการใช้งาน Production Booking โปรดอ่านก่อนจองคิว!"
ปักไว้บนหน้า Overview (`/`) เหนือ KPI — สื่อสารกติกากับทุกฝ่ายก่อนกดจอง:

- ทรัพยากรหลักที่มีให้บริการ (FX6 ×3 · FX3 ×3 · Videographer 8 ·
  Sound 4 · Switcher 1 · Photographer 1)
- กติกา 3 ข้อ: First Come First Served · เราดีล คุณจ่าย (ค่าฟรีแลนซ์/
  เช่าอุปกรณ์คิดเป็นต้นทุนของผู้จอง) · เลี่ยงจองทับพักเที่ยง —
  คิวบ่ายเริ่มเซ็ตอัพ 13.00 น.
- ลิงก์ Production Setting Handbook + ช่องทางติดต่อพี่ตุ้ย
  (Production Coordinator)
- ยุบ/กางได้ จำสถานะใน localStorage — คนใช้ประจำยุบทิ้งได้
  dashboard ยังแน่นเหมือนเดิม ผู้ใช้ใหม่เห็นเต็มตั้งแต่ครั้งแรก

## [1.51.0] — 2026-06-11

### Added — ปุ่มลบคิว (soft delete): ซ่อนจากเว็บ แต่ข้อมูลยังอยู่ในฐานข้อมูล

สำหรับเก็บกวาดคิวทดสอบ — ลบแล้วหายจากทุกหน้าเว็บ แต่แถวยังอยู่ใน DB
(Episode ID ไม่โดน reuse, ประวัติ audit ไม่หาย) ต่างจากลบถาวร (v1.44)
ที่ล้างทุกอย่างทิ้ง

- **ปุ่ม 🗑 DELETE บนการ์ดทุกใบใน `/admin`** (ADMIN เท่านั้น) —
  กดแล้ว booking หายจาก: admin queue, dashboard, calendar, home,
  my-bookings, producer dashboard, upload, CSV export และ MCP ·
  event ใน Google Calendar ถูกลบ + auto-OT rows ถูกเคลียร์
  (เหมือนตอน cancel)
- **แท็บ 🗑 Deleted ใน `/admin`** (ADMIN เท่านั้น) — ดูคิวที่ลบไป
  พร้อมปุ่ม **↺ RESTORE** (กู้คืนกลับมาแสดง — งาน CONFIRMED กด
  Re-sync calendar ต่อเพื่อสร้าง event ใหม่) และ **ลบถาวร**
  (endpoint v1.44 เดิม ได้ UI ครั้งแรก — ลบจริงทั้ง episodes/uploads/audit)
- **Schema:** คอลัมน์ใหม่ `bookings.deletedAt` (nullable) — apply อัตโนมัติ
  ผ่าน `prisma db push` ตอน start container ไม่ต้อง migrate มือ
- **คิวที่ลบถูก "แช่แข็ง" ทุกทาง** (ผ่าน adversarial review ก่อน ship):
  PATCH / approve / assign / restore / mark-upload-done / cancel →
  409 ต้อง restore ก่อน (กันเคส assign ที่จะสร้าง calendar event
  กลับมาใหม่) · upload ไฟล์เข้าใบที่ลบไม่ได้ (`canUploadToBooking`) ·
  หน้า upload-review กับตัวนับใน Sheet Monitor ไม่นับใบที่ลบ ·
  history/producer-message มองไม่เห็นใบที่ลบ · ดู detail ได้เฉพาะ
  ADMIN (มีแบนเนอร์ 🗑 บอกสถานะ) · reconciler / auto-complete /
  OT sync ข้ามคิวที่ลบทั้งหมด
- หมายเหตุ: แถวใน Google Sheet (Bookings tab) ไม่ถูกแตะ —
  soft delete มีผลเฉพาะหน้าเว็บ/ปฏิทินตามที่ตั้งใจ

## [1.50.2] — 2026-06-11

### Fixed — USER เปิดดู booking ของตัวเองจาก My Bookings ได้แล้ว

ทุกแถวใน `/my-bookings` ลิงก์ไป `/dashboard/[id]` แต่ layout ของ
dashboard เป็น console-gate → USER ธรรมดากดดูรายละเอียด booking
ของตัวเองแล้วเจอกำแพง "Staff only" มาตลอด (ตั้งแต่ v1.28 ที่ทำ inbox)

- **ย้าย console gate เข้า route group `(console)`** — คุมเฉพาะหน้า
  list `/dashboard` · หน้า detail `/dashboard/[id]` เหลือแค่ต้อง login
  โดยฝั่ง API คุม scope ต่อ booking ให้แล้ว (`canViewBooking`,
  v1.50.1 — คนนอก booking ได้ 403 "Forbidden")
- **ปุ่ม Cancel / Mark Complete แสดงเฉพาะ staff** (เช็ค role จาก
  `/api/me`) — เดิมกดแล้วจะ 403 เงียบ ๆ · back link ชี้
  `/my-bookings` สำหรับ USER, `/dashboard` สำหรับ staff
- จัดการ PATCH ที่ fail: แสดง error แทนการ set status เป็น undefined

## [1.50.1] — 2026-06-11

### Security — กัน CSV formula injection ในไฟล์ export ทุกตัว

ค่าที่ user กรอกเอง (producer, ชื่อ project, episode ID ฯลฯ) ถ้าขึ้นต้นด้วย
`=` `+` `-` `@` (หรือ tab/CR) Excel จะ execute เป็นสูตรตอนเปิดไฟล์ CSV —
แม้ cell จะถูก quote แล้วก็ตาม และตั้งแต่ v1.50.0 export ทั้ง corpus
เปิดให้ทุก console tier สูตรที่ฝังมาจึงไปโผล่ใน Excel ของ staff ได้

- **`escapeCSVCell` (`src/lib/csv.ts`)** — เติม apostrophe (`'`) นำหน้า
  cell ที่ match `/^[=+\-@\t\r]/` ตาม OWASP CSV-injection mitigation
  (ค่าที่เป็น number จริงไม่โดนเติม — ตัวเลขติดลบยัง sort ได้ใน Excel)
  ครอบคลุม bookings export (`/api/bookings/export`) และ audit log
  ที่ใช้ helper นี้อยู่แล้ว
- **OT export (`/api/ot/export`)** — เปลี่ยน `csvCell` local
  (quote-wrap อย่างเดียว ซึ่งกันสูตรไม่ได้) มาใช้ `escapeCSVCell`
  ตัวเดียวกัน ทั้ง detail sheet และ cover sheet
- เพิ่ม unit test `src/lib/__tests__/csv.test.ts` (RFC 4180 escaping +
  formula neutralization)

### Security — `GET /api/bookings/[id]` ไม่เปิดให้ทุกคนที่ login แล้ว

เดิม user ที่ login คนไหนก็เปิดดูรายละเอียด booking ของใครก็ได้ถ้ารู้ id —
รวม `adminNotes`, รายชื่อ crew ที่ assign และประวัติ upload ทั้งหมด
(มี wasabi key / multipart id ภายในติดมาด้วย)

- **Read scope ใหม่** (`src/lib/booking-access.ts` → `canViewBooking`):
  ดูได้เฉพาะ console tier หรือคนบน booking นั้น — ผู้ขอ
  (`createdByEmail`) / producer (`producerEmail`) / crew ที่ถูก assign
  (`assignedEmails`) เทียบ email แบบ case-insensitive · นอกนั้น 403
  (ทุกหน้าเดิมยังทำงานปกติ: success page = ผู้ขอ, upload page = crew,
  /admin /dashboard = console)
- **ตัด storage internals ออกจาก payload** — `uploads` ใช้ select list
  (เลิกส่ง `wasabiKey` / `wasabiMultipartId` / `wasabiEtag` / `sha256`)
  และแถม `episode.episodeId` ที่ dashboard detail ประกาศ type รอไว้
  แต่ไม่เคยได้ข้อมูลจริง
- เพิ่ม unit test `src/lib/__tests__/booking-access.test.ts` · **68 tests total**

### Fixed — OT approver นอก roster เข้าหน้า OT ได้ครบทาง

- `/ot` parent layout + เมนู OT ใน nav เคยเช็คแค่ ADMIN + roster ทีม
  Production (hardcode 31 คน) — MANAGER ที่เป็น OT approver แต่ไม่อยู่ใน
  roster จะผ่าน gate `/ot/admin` (แก้ใน v1.50.0) แต่โดน parent บล็อก →
  เพิ่ม `getOTApproverAccess()` เข้าเงื่อนไขทั้งสองจุด
  (ยังไม่มี user จริงที่โดน — กันไว้ให้ model ตรงกันทุกชั้น)

## [1.50.0] — 2026-06-10

### Fixed — Coordinator (และทุก staff tier) เข้า Admin Console ได้จริงแล้ว

v1.38 ตั้ง role model ไว้ว่า console เปิดให้ทุก staff tier
(ADMIN / SUPPORT / MANAGER / COORDINATOR) แต่ commit นั้นแก้เฉพาะ lib +
API routes — **layout ของหน้าเพจยังเช็ค ADMIN-only ค้างจาก v1.4**
ทำให้ Coordinator เห็นลิงก์ใน nav แต่กดแล้วเจอ "Admin only"
รอบนี้แก้ gate ทุกชั้นให้ตรง model เดียวกัน:

- **`/admin/*` + `/dashboard`** (`admin/layout.tsx`,
  `dashboard/layout.tsx`) — เปลี่ยน `role !== 'ADMIN'` →
  `hasConsoleAccess()` ทุก staff tier เข้าจัดการคิวได้:
  approve / assign / restore / แก้สถานะ / calendar re-sync
  (API พวกนี้เป็น `requireConsole` อยู่แล้วตั้งแต่ v1.38)
- **คิวเต็มตา** — `GET /api/bookings` และ `GET /api/bookings/export`
  เคย scope "เห็นทั้งหมด" ให้เฉพาะ ADMIN ทำให้ tier อื่นเห็นคิว
  REQUESTED ไม่ครบแบบเงียบ ๆ → เปลี่ยนเป็น `hasConsoleAccess()`
  (USER ธรรมดาเหมือนเดิมทั้งคู่: list เห็นของตัวเอง + CONFIRMED,
  export ได้เฉพาะของตัวเอง/ที่ถูก assign)
- **Upload-review panel บน `/admin/[id]`** — `GET /api/upload/list`
  เคย 403 สำหรับ staff ที่ไม่ใช่ crew video/sound ทำให้การ์ด
  Mark-Upload-Done หายทั้งใบ → console tier อ่านได้แล้ว
  (route เขียนไฟล์ทั้งหมดยังเป็น crew/ADMIN เท่านั้น)
- **`/ot/admin`** — gate หน้าเพจเช็ค ADMIN-only ขัดกับ API
  (`requireOTApprover`) ทำให้ Manager ที่อนุมัติ OT ได้โดนบล็อก
  ที่หน้าเพจ → เปลี่ยนมาใช้ `getOTApproverAccess()` ตัวเดียวกับ API
  (Coordinator ยังเข้าไม่ได้ตามเดิม — OT เป็นอำนาจ Admin/Manager)
- **หน้า Home: panel "My upcoming" เป็นของฉันจริง ๆ แล้ว** — เดิมพึ่ง
  filter implicit ของ USER ธรรมดา พอเปิด scope ให้ staff tier
  panel นี้จะกลายเป็นงานทั้งบริษัท → fetch `scope=mine` แยกชัดเจน
  (Today / This week / Attention ของ staff เห็นทั้งคิวตามเดิม
  ซึ่งตรงกับงาน operator — Attention คือคิว REQUESTED ทั้งหมด)

### Security

- **`DELETE /api/bookings/[id]` (soft-cancel)** เคยเช็คแค่ login —
  USER คนไหนก็ cancel booking ของใครก็ได้ → ต้องเป็นเจ้าของ booking
  (`createdByEmail`) หรือ console tier เท่านั้น
- **`/api/admin/users` เลิกส่ง `signaturePng`** — เดิม GET/PATCH/POST
  คืน User ทุก field รวม e-signature base64 ของทุกคน (เอาไปปลอม
  ลายเซ็น OT ได้) ทั้งที่ไม่มีหน้าไหนใช้ → ใส่ select list ทุก response
- **ตั้ง position ที่มีคำว่า "manager" ได้เฉพาะ ADMIN/MANAGER** —
  เดิม COORDINATOR แก้ position ของ USER เป็น "Manager" ได้ ซึ่งจะ
  มอบสิทธิ์ OT approver ให้คนนั้นทันทีผ่าน legacy path
  (`getOTApproverAccess` เช็ค position) — ปิด escalation ตรงนี้แล้ว
- **ปิด user แล้วหลุดทันที** — เดิม `active=false` เช็คแค่ตอน login
  ส่วน JWT ที่ออกไปแล้วใช้ต่อได้อีกถึง 7 วัน → `getSession()` เช็ค
  active ทุก request แล้ว (jwt callback อ่านจาก DB สดอยู่แล้ว)
- **Danger Zone (purge) บน `/admin/health`** ซ่อนสำหรับ non-ADMIN
  (API เป็น `requireAdmin` อยู่แล้ว — เก็บ UI ให้ตรงสิทธิ์)
- ของ destructive ทั้งหมดยัง ADMIN-only ตามเดิม: hard-delete,
  purge-bookings, audit purge · OT approve ยัง ADMIN/MANAGER

### Tests

- เพิ่ม `src/lib/__tests__/roles.test.ts` — truth table ของ
  `hasConsoleAccess` / `canApproveOTByRole` / `canManageRoles` /
  `canEditUser` / `assignableRoles` / `canAddUser`
  (เดิม role gates ไม่มี coverage เลย) · **58 tests total**

---

## [1.49.0] — 2026-06-10

### Added — MCP server: สั่งงานระบบจองด้วย AI ได้แล้ว

`POST /api/mcp` speaks the Model Context Protocol over Streamable HTTP,
so anyone on the team can connect an AI client (claude.ai custom
connector, Claude Code, Claude Desktop, any MCP client) and operate the
booking system in plain language. Setup + examples: **docs/mcp.md**.

- **7 tools**: `list_bookings`, `get_booking`,
  `list_outlets_and_programs`, `list_projects`, `list_project_episodes`
  (read) · `create_booking`, `cancel_booking` (write).
- **Same logic as the web form** — booking creation was extracted to
  `src/lib/create-booking.ts` (1:1 move) and is now shared by
  POST /api/bookings and the MCP tool: identical validation, ID minting
  (NWS-KYM-…), audit trail, and Bookings-tab sync. MCP-created bookings
  enter as REQUESTED and still need admin approval.
- **Auth**: `Authorization: Bearer MCP_API_KEY` (constant-time compare);
  endpoint is OFF (503) until the env is set. Actions are audit-logged
  as `MCP_ACTOR_EMAIL` with an optional `requestedBy` passthrough.
  Admin powers (approve/assign/hard-delete/purge) are NOT exposed.
- **Protocol core** is dependency-free
  (initialize/ping/tools-list/tools-call/notifications, JSON responses —
  no SDK, no SSE) and covered by 11 unit tests; `/api/health` config now
  reports `mcp.enabled`. 52 tests total.

### New env (Portainer)

- `MCP_API_KEY` — generate with `openssl rand -hex 32`; unset = MCP off.
- `MCP_ACTOR_EMAIL` — audit identity for MCP actions (default `mcp@probook`).

---

## [1.48.0] — 2026-06-10

### Fixed — outlet bookings now show the real show name (per-EP program)

v1.47.0 covered Content Agency (projectName) but outlet bookings still
displayed the Episode-Type bucket ("Long-form · รายการ · ซีรีส์ ·
สัมภาษณ์ยาว") because the actual show — Key Message, End Game, … — lives
on each EPISODE's program (v1.37 per-EP dropdown), not on the booking.

- `bookingShowName` resolution is now: projectName → distinct per-EP
  program names (joined " / " for mixed bookings, "+N" beyond 2) →
  booking-level program name. EP programs that just echo the bucket are
  skipped.
- Every booking fetch now includes the episode's program
  (`episodes.include.program` — list, detail, approve, assign, restore,
  export, reconcile, OT sync), so the in-app pages AND the Google
  Calendar title (`[NWS] Key Message — <ตอน>`) all see it.
- 6 new unit tests (41 total).

---

## [1.47.0] — 2026-06-10

### Changed — show name on every calendar surface

Ops feedback: "ชื่อรายการแสดงบน calendar ทุก platform". v1.45.0 fixed the
Google Calendar event title; this release applies the same rule to every
in-app surface that labels a booking.

- New shared helper `bookingShowName` (src/lib/display.ts): project name
  when present (Content Agency — e.g. "KEY MESSAGES x DMHT"), program
  name otherwise. One rule, every platform.
- Applied to: **/calendar** (month chips, agenda rows, detail modal),
  **Overview** upcoming list, **My Bookings**, **Producer** dashboard,
  **Admin** booking list, admin + dashboard booking detail headers, and
  the Admin Dashboard "All Bookings" table.
- Search boxes on My Bookings and the Admin Dashboard now match the
  project name too.
- 3 new unit tests (36 total).

---

## [1.46.0] — 2026-06-10

### Changed — Booking/Episode ID carries the program code

Ops feedback: "รหัสรายการให้อยู่ใน Booking ID ด้วย เช่น NWS-KYM-…".

- New outlet-booking IDs are
  **`[OUT]-[PROG]-[YYMMDD]-[EpisodeType]-[NN]`** — e.g.
  `NWS-KYM-260616-L-01` for a Key Message long-form — using each
  episode's own program from the dropdown. Sequences run per
  outlet+program+date+type, so each show numbers its own stream.
- Legacy IDs (`NWS-260608-L-01`, `AGN-260423-EVT-01`) stay valid
  everywhere: the strict/loose/case-insensitive regexes accept both
  shapes, and the footage folder parser (`parseProductionId`) extracts
  both. Existing bookings/folders are untouched.
- Content Agency productions keep their shape
  (`AGN-YYMMDD-STD/LOC/EVT-NN`) — a production isn't a single show.
- Legacy clients that echo the Episode Type as the program (or any code
  that doesn't fit 2–4 alnum chars) fall back to the legacy ID shape
  instead of emitting a malformed one.
- 9 new unit tests on generate/parse/extract (33 total, still gating
  every build).

---

## [1.45.0] — 2026-06-10

### Changed — calendar event title leads with the show name

Ops feedback: Content Agency events were titled with the generic program
label (`[AGN] Long Form (project) — …`), so the calendar didn't say WHAT
show was shooting.

- `buildEventTitle` now leads with the booking's **projectName** when
  present — `[AGN] KEY MESSAGES x DMHT — Pre EP.1 - BKK` — falling back
  to the program name for outlet bookings (unchanged behavior there).
- When the first EP's title would just repeat the show name (CA episodes
  whose EP. label is "-"), the EP segment is dropped instead of reading
  `X — X`.
- `projectName` added to the createCalendarEvent /
  updateCalendarEventDetails contracts and passed from the approve /
  assign routes (reconcile + PATCH paths already pass the full booking).
- 6 new unit tests pin the title shape (24 total).

Existing events keep their old title until the booking is edited or
Re-synced from /admin/[id] (the details patch rebuilds the title).

---

## [1.44.0] — 2026-06-10

### Added — per-booking hard delete (admin API)

`POST /api/admin/[id]/delete` (ADMIN only) hard-deletes one booking and
everything attached to it: episodes + uploads (FK cascade), audit-log /
footage-log / auto-generated OT rows (explicit cleanup — no cascade on
those tables), and the Google Calendar event (best-effort). Writes an
`admin.delete_booking` audit entry with the booking's code/status as the
trail. Unlike `DELETE /api/bookings/[id]` (soft-cancel) and
`/api/admin/purge-bookings` (nukes everything), this enables selective
cleanup — e.g. purging pre-June test bookings while keeping real ones.
API-only; no UI button yet.

---

## [1.43.1] — 2026-06-10

### Fixed — Sheet Monitor: unknown episode statuses no longer vanish from counts

Post-deploy verification of v1.43.0 on production found the booking rule
exact (PP-26-025 → 16, PP-26-024 → 6 with the Published one excluded,
PP-26-003 → 0) but the Sheet Monitor counted 96 of 97 episodes:
a blank/unrecognized status fell into none of the five buckets, so
PP-26-011 showed "No EPs" despite having a bookable episode.

- New `bucketEpisodeStatus()` (unit-tested, 18 tests total): every status
  maps to exactly one bucket — unknowns land in a new **other** count, so
  Monitor totals always equal the real episode count and can never
  disagree with the booking rule again. Gray "N other" chip in the EP
  status bar; "Active" filter includes it.

---

## [1.43.0] — 2026-06-10

### Hardened — the booking rule ("only Published is excluded") is now tested, monitored, and rate-limit-proof

Goal: episode booking eligibility must stay correct without repeated
firefighting when the Dashboard sheet evolves.

- **Single source of truth**: `isPublishedStatus()` — an episode stops
  being bookable ONLY when its status is exactly "Published"
  (case/whitespace-insensitive). Pending / Pre-production / Production /
  Post-production / blank / any future status stays bookable. Booking
  form and dropdown filter both use it.
- **Unit tests** (`npm test`, 15 tests): pin the rule, both real tab
  layouts (PD + legacy _EPs), header reshuffles, tab discovery (new
  "PD <ชื่อ>" tabs picked up automatically), dedupe precedence,
  junk-row filtering. `npm run build` now runs them first, so BOTH the
  CI build and the Docker image build fail if the rule regresses (the
  push token can't edit workflow files, so the gate lives in the build
  script instead).
- **Health canary**: `/api/health` + `/admin/health` gained
  **episodeTabsRead** — runs the exact booking-form read path and fails
  loudly (with tab names in the error) if a future restructure empties
  it, instead of users discovering "ไม่มี episode ที่ถ่ายได้".
  `fetchAllEpisodeRows` now throws when no episode tab exists at all.
- **30s episode-rows cache** (+ invalidated by Sheet Monitor "Sync"):
  one dashboard refresh + form open burst could trip Google's
  60-reads/min/user quota (observed 429 while load-testing). Also makes
  the episode picker snappier.
- **E2E verifier** (`npx tsx scripts/verify-booking-rule.ts`): compares
  the app's bookable list against an independent parse of the live
  sheet for every project, smoke-tests the full `listProjectEpisodes`
  path, and checks the dropdown rule. Run after any Dashboard
  restructure. Today's run: 97 episodes / 32 projects / 33 dropdown
  checks — all green.

---

## [1.42.2] — 2026-06-10

### Fixed — new episodes invisible to booking: read the "PD <name>" tabs (real root cause)

v1.42.1's diagnosis was incomplete. The "_EPs" tab never changed layout —
what actually happened is the Dashboard's May 2026 restructure moved
episode authoring to per-producer **"PD <name>" tabs** (new column
layout), and the sheet's own PD→"_EPs" sync automation stopped copying
new rows ("_Update Log" shows them as `skipped`; "_EPs Backup
20260511-1202" marks the migration date). "_EPs" still holds only ~13
legacy episodes, so every project created after mid-May looked like it
had no bookable episodes — booking form AND Sheet Monitor.

- New shared reader `fetchAllEpisodeRows` (dashboard-episodes.ts):
  discovers all `PD *` tabs at runtime, reads them + legacy "_EPs" in one
  `values.batchGet`, resolves each tab's columns from its own header row
  (PD: Episode ID col C / Status col H · _EPs: col N / col E), validates
  IDs against `PP-YY-NNN-XNN`, dedupes by Episode ID (PD wins — fresher
  status).
- `listProjectEpisodes` (booking form), `fetchFullyPublishedProjectIds`
  (project dropdown filter), and `/api/projects/monitor` (Sheet Monitor)
  all use it now.
- Sheet Monitor: added a **pending** count to `EpCounts` — `Pending`
  episodes previously fell into no bucket, so a project with only Pending
  episodes showed "No episodes / No EPs" even though it was bookable.
  New chip in the EP status bar; "Active" filter includes pending.

Verified against the live Dashboard sheet: PP-26-025 now lists all 16
non-Published episodes (Pre-production / Production / Pending);
PP-26-019 lists its Post-production episode.

---

## [1.42.1] — 2026-06-10

### Fixed — booking episode list empty after "_EPs" tab restructure

The Producer Dashboard team reshuffled the "_EPs" tab columns (Episode ID
moved col N→C, Status col E→H). The app still read the old positions, so the
Content Agency booking form showed "ไม่มี episode ที่ถ่ายได้" for every
project even though its episodes were Pre-production/Pending.

- `listProjectEpisodes`, `fetchFullyPublishedProjectIds`, and
  `/api/projects/monitor` now resolve the "_EPs" columns **from the header
  row by name** (`Episode ID`, `Status`, `EP.`, `Product Code`,
  `Project Name`) via a shared `resolveEpsColumns` helper, falling back to
  the current known layout. The next column reshuffle won't silently empty
  the booking list.
- Booking eligibility is unchanged: an episode is bookable as long as its
  Status is not `Published`; a project drops off the dropdown only when ALL
  its episodes are Published.

---

## [1.42.0] — 2026-06-09

### Added — Overnight OT (shifts that cross midnight)

Crew sometimes work past midnight; OT could only be logged within a single day,
so an overnight shift either got rejected ("end must be after start") or, for the
calc, was silently dropped.

- **OT entry form** now has a **"วันที่เลิก (ถ้าทำข้ามวัน)"** date field next to
  the start/end times. Leave it blank for a same-day shift; set it to the next day
  when the shift runs past midnight. A live hint shows `🌙 ข้ามวัน (+N วัน)` and
  warns when the end time is earlier than the start without an end date set.
- **Calc** (`summarizeDay`) interprets the end time as
  `endOffsetDays × 24h + endTime`, so the span/worked-hours and OT amount are
  correct across the day boundary. The shift still belongs to its **START date**
  for weekday/weekend/holiday classification and rate.
- **Validation** (POST + PATCH `/api/ot`): the shift duration must be > 0 and
  ≤ 24h; overnight is allowed only when the end date is the next day.
- **Auto-OT from bookings** (`syncBookingOT`): when a booking's wrap time is at or
  before its call time (overnight shoot), the generated OT record's end date is set
  to the next day.
- Overnight shifts are flagged with a `🌙+N` marker on the OT page, the manager
  review page, the CSV export, and the PDF cover sheet.

### Schema

- `OTRecord`: added `endDate DateTime? @db.Date` (null = ends same day as `date`).
  Additive — applied via the existing `prisma db push` on container start.

---

## [1.41.0] — 2026-06-09

Batch of ops feedback after the team started using the booking flow in production.

### Added — Equipment counts on the calendar (🎥 / 🎙)

- New optional **camera count** + **mic count** fields on the booking form
  (People & Crew step). Stored as `Booking.cameraCount` / `Booking.micCount`
  (nullable Int).
- Surfaced on the **Google Calendar event title** (e.g. `… · 🎥 2 · 🎙 1`) and
  in the event description, so crew see gear needs at a glance.

### Added — Van request for off-site shoots (🚐)

- New **"ต้องการรถตู้"** toggle on the booking form (Location step). Stored as
  `Booking.needsVan` (Boolean, default false).
- When set, the calendar event title is prefixed with 🚐 on **both** the in-web
  Production Calendar and Google Calendar.

### Added — Shoot descriptor in the Google Calendar title

- The event title now includes the **Video Type** so it says what kind of item
  the shoot is (previously only `[OUTLET] Program — Episode`). Title shape:
  `🚐 [OUT] Program — Episode · Interview · 🎥 2 · 🎙 1`.
- Centralized in a shared `buildEventTitle()` so create + update paths agree.

### Fixed — Calendar event not updated when editing time / episode title

- Editing a booking's **call time / estimated wrap** or an **episode title**
  updated the DB but left the Google Calendar event showing the old title and
  time. `PATCH /api/bookings/[id]` now patches the event's summary, start/end,
  location and description via the new `updateCalendarEventDetails()` (attendees
  untouched). The 10-min reconciler remains the safety net for the guest list.

### Fixed — Freelancer names piling up on the calendar

- Adding a freelancer then saving any other change re-appended a "Freelancers:"
  block to `adminNotes` every time (the form list was never cleared and the old
  block never stripped), so names duplicated on the Google Calendar description.
- Freelancers are now a **structured** `Booking.freelancers` (Json) list. The
  assign route stores them structurally and the calendar description is **rebuilt**
  from that list every save (never appended) — re-saving is idempotent. Legacy
  bookings have their old text block parsed into the structured list on first edit
  (`src/lib/freelancers.ts`).

### Changed — Estimated Wrap is now required

- Previously optional; when blank the calendar fell back to "call time + 4h",
  which mis-stated the team's time/workload calc. The booking form now requires
  a real wrap time.

### Schema

- `Booking`: added `cameraCount Int?`, `micCount Int?`, `needsVan Boolean
  @default(false)`, `freelancers Json?`. All additive — applied via the existing
  `prisma db push` on container start; no manual migration.

---

## [1.40.0] — 2026-06-08

### Added — Danger Zone: Purge all bookings

**`GET /api/admin/purge-bookings`** — returns record counts (bookings, episodes,
audit logs, uploads, footage logs) before purge. ADMIN only.

**`POST /api/admin/purge-bookings`** — body `{ confirm: true }` — deletes ALL
bookings and related records in a Prisma transaction. Delete order: `audit_logs`
→ `footage_log` → `bookings` (cascades `episodes` + `uploads`). Writes one
post-purge audit entry with the deleted counts. ADMIN only.

**Danger Zone card** at the bottom of `/admin/health`:
- 3-step flow: (1) link to Dashboard → Export CSV backup, (2) Load counts to
  see what will be deleted, (3) type `DELETE ALL` to unlock the purge button.
- Red button only activates once confirmation text matches exactly.
- Success/error message shown inline after purge.

---

## [1.39.0] — 2026-06-08

### Added — Sheet Data Monitor on Admin Dashboard

**Section 4 "Sheet Data Monitor"** added to `/dashboard`:

- **`GET /api/projects/monitor`** — new API that reads the Producer Dashboard Sheet
  (`All Projects` + `_EPs` tabs) in real-time and joins with DB booking counts. Returns
  every project (including Published), episode-status counts per project, and non-cancelled
  booking count from DB per `projectId`.

- **Sheet monitor table** — shows all projects with:
  - Episode status breakdown: Pre-prod / Production (amber highlight) / Post-prod / Published
  - Booking count linked to filtered `/dashboard` view
  - Status badge: Active (in Production) / Bookable / Finished / No EPs
  - Rows highlighted amber when project has episodes in Production phase

- **"Sync Booking List" button** — calls `/api/projects/monitor?refresh=1` which also
  invalidates the server-side 5-minute project cache (`invalidateProjectsCache()`), so the
  `/new` booking form Project dropdown shows the freshest Sheet data on the next load —
  no need to wait up to 5 minutes.

- **Filter tabs**: All · Active (Prod) · Unbooked — plus free-text search across Project ID,
  name, client, producer, director.

- **Stats row**: total / bookable / in-production / unbooked counts at a glance.

- **"Synced X min ago"** timestamp shows cache freshness.

Lazy-loads on first scroll (projects data fetched only when the section mounts).
`tsc --noEmit` and `next build` both clean.

---

## [1.38.0] — 2026-06-04

### Added — Role tiers (Admin / Support / Manager / Coordinator / User) + team group emails

**1. Team distribution emails on the assign page** (`src/app/admin/[id]/page.tsx`)
   - A new "Team Email (กลุ่ม)" quick-select row at the top of ASSIGN TEAM with
     `video@thestandard.co` and `Sound@thestandard.co`, so an admin can notify a
     whole desk in one tick (they flow through the same assign → calendar guest +
     email path as individual crew).

**2. Five-tier role model** (`src/lib/roles.ts` — new, `prisma/schema.prisma`)
   - `UserRole` enum gains `COORDINATOR`, `MANAGER`, `SUPPORT` (additive — applied
     by `start.sh` → `prisma db push` on deploy; existing USER/ADMIN rows
     untouched). Hierarchy (rank 0 = most authority):
     `ADMIN(0) > SUPPORT(1) > MANAGER(2) > COORDINATOR(3) > USER(4)`.
   - Capability helpers centralised in `roles.ts`: `hasConsoleAccess`,
     `canApproveOTByRole`, `canEditUser`, `assignableRoles`, `canAddUser`.

**3. "Permission เต็ม" = full admin console for every staff tier**
   (`src/lib/session.ts`, 15 API routes, `src/app/_components/Nav.tsx`)
   - New `requireConsole()` gate (ADMIN / SUPPORT / MANAGER / COORDINATOR; plain
     USER excluded). The operational admin routes (booking edit, approve, assign,
     restore, calendar re-sync, team CRUD, upload-review, upload-config,
     calendar-debug, test-email, health, audit export, mark-upload-done, upload)
     switched `requireAdmin` → `requireConsole`. Destructive endpoints
     (`audit/purge`, `audit/purge-warning`) stay ADMIN-only.
   - Nav shows Dashboard / Admin / Upload Review to all console tiers.

**4. Permission-management matrix** (`src/app/api/admin/users/route.ts`,
   `src/app/admin/permissions/page.tsx`)
   - Who can change whose role / active / profile:
     - **Admin** → anyone (any role).
     - **Manager** → Coordinator + User; may assign up to Coordinator. Cannot
       touch Admin / Support / fellow Managers.
     - **Coordinator** → User only; cannot promote or add new users.
     - **Support** → no role management (read-only); and Support users are
       protected — only Admin can edit them.
   - Enforced server-side (PATCH/POST/DELETE check the actor's role against the
     target's current role + the role being assigned, and close the upsert
     privilege-escalation hole) AND reflected in the UI (role `<select>` shows
     only assignable roles, edit controls lock for out-of-scope targets, the
     "เพิ่มผู้ใช้" button hides for roles that can't add). Self-demote/disable
     guard kept.

**5. OT approval restricted to Manager + Admin** (`src/lib/session.ts`,
   `src/app/api/me/route.ts` flag, permissions page badge)
   - `getOTApproverAccess` now grants the MANAGER role directly (plus the legacy
     position-contains-"manager" path). Coordinator and Support cannot approve OT
     — it is the Manager's duty, per spec.

Verified: `tsc --noEmit` and `next lint` both clean.

---

## [1.37.1] — 2026-06-04

### Changed — Admin notes + freelance contacts now land on the Calendar event too

Previously the admin's notes (which also carry the freelance roster the admin
adds on `/admin/[id]`) only reached the **assignment email** — the Google
Calendar event never showed them. Now they appear on both.

1. **Shared description builder** (`src/lib/google-calendar.ts`)
   - Extracted `buildEventDescription(booking, assignedEmails)` and added an
     `Admin notes / Freelance:` line sourced from `booking.adminNotes`. The
     admin detail page appends `Freelancers: name · contract · email` into
     `adminNotes` before saving, so freelance contacts now surface on the event.
   - `createCalendarEvent` gained an `adminNotes` field and builds its
     description via the shared helper.

2. **Re-assign keeps the event in sync** (`updateCalendarEventAttendees`,
   `src/app/api/admin/[id]/assign/route.ts`)
   - The attendee PATCH now also refreshes the event `description` (via
     `buildEventDescription`) so editing admin notes / freelancers and clicking
     Assign updates the event details, not just the guest list. The auto-create
     branch passes `adminNotes` through as well.

3. **Approve + reconciler carry it through**
   (`src/app/api/admin/[id]/approve/route.ts`, `src/lib/calendar-reconcile.ts`)
   - Both `createCalendarEvent` call sites now pass `adminNotes`, so the event
     created on approve — and any event the 10-min reconciler recreates — keeps
     the admin notes / freelance contacts instead of dropping them.

The assignment email already rendered `หมายเหตุจาก Admin:` (`src/lib/email.ts`),
so no email change was needed — this closes the gap on the calendar side.

Verified: `tsc --noEmit` and `next lint` both clean.

---

## [1.37.0] — 2026-06-04

### Added — Per-episode Program picker + Original/AD tag (non-CA bookings)

The People & Crew step (step 4) of the booking wizard now lets non-Content-
Agency producers pick, **for each episode**, which **program (show)** it belongs
to and whether it is **Original Content** or **Advertorial (AD)**.

1. **Per-episode program dropdown** (`src/app/_components/booking/BookingWizard.tsx`)
   - Each episode row gained a program `<select>` listing the real show
     programs of the selected outlet (the 3-char codes from `src/lib/data.ts`,
     e.g. `MNW · Morning Wealth`). The L/S/A/T Episode-Type aliases are filtered
     out (`code.length > 1`); the step-1 "Episode Type" picker is unchanged.
   - The plain `epTitles: string[]` state became
     `epRows: { programCode, title, contentType }[]`. Outlet change clears each
     row's program (options are outlet-specific) but keeps titles/types.

2. **Original / AD toggle per episode**
   - A two-button segmented control on each row. Defaults to Original Content.
     The step-1 booking-level **Category** field is intentionally kept as-is
     (booking-level default); the per-episode tag is additive.

3. **Stored as data only — Production ID is unchanged**
   (`src/app/api/bookings/route.ts`)
   - The per-episode program + Original/AD pick is recorded purely as data
     (so a booking carries "what does this queue shoot"): each episode's chosen
     program is upserted and linked as `Episode.programId`, and the tag is saved
     as `Episode.contentType`. The Production ID keeps its legacy shape
     `[OUT]-[YYMMDD]-[EpisodeType]-[NN]` from the step-1 Episode Type (L/S/A/T),
     sequenced per outlet+date+type exactly as before — it does NOT change.
   - New payload field `episodes: [{ programCode, title, contentType }]`. The
     legacy flat `episodeTitles` array is still accepted as a fallback (mapped
     onto the booking-level program + category) so nothing breaks mid-deploy.

4. **Schema** (`prisma/schema.prisma`)
   - `Episode.contentType Category?` — nullable, reuses the existing `Category`
     enum (only `ORIGINAL_CONTENT` / `ADVERTORIAL` used). Additive column;
     applied automatically by `start.sh` → `prisma db push` on deploy, so no
     manual migration is needed. Null for legacy rows and CA episodes.

Verified: `tsc --noEmit` and `next lint` both clean.

---

## [1.36.1] — 2026-06-03

### Fixed — two status/label bugs found during the full-feature test sweep

1. **Producer Dashboard showed "⏳ รอแอดมิน assign" for CANCELLED/COMPLETED
   bookings** (`src/app/producer/ProducerDashboard.tsx`)
   - The inline assignment hint was a bare binary (`assigned ? … : "รอแอดมิน
     assign"`) that ignored `booking.status`. A cancelled (or completed-but-
     unassigned) booking therefore displayed the pre-assignment "waiting for
     admin to assign" nudge while its status pill correctly read "Cancelled" —
     a contradiction. Same class of bug as the v1.35.15 admin-detail fix.
   - Now terminal states (CANCELLED, COMPLETED) suppress the pending-assign
     nudge and let the status pill speak; only pre-assign bookings show it.

2. **Upload page path hint was stale** (`src/app/_components/booking/UploadSection.tsx`)
   - The "จะ upload ตรงเข้า…" hint still showed `<outlet>/<bookingCode>/<camera>/`,
     not the v1.36.0 layout. Updated to
     `[outlet]/<Production ID> - [ชื่องาน]/<camera>/` so it matches where files
     actually land.

Found via a recorded end-to-end UI test sweep on the live v1.36.0 deploy
(auth, calendar, bookings, dashboard, new-booking wizard, admin detail,
upload→Drive+booking-info.txt, OT, permissions, exports, health — all
otherwise green).

---

## [1.36.0] — 2026-06-02

### Changed — Upload lands in the team's existing Drive folders + drops a booking-info.txt

Footage now uploads into the real "VIDEO 2026" outlet folders the producers
already maintain, instead of a fresh duplicate. Three parts:

1. **Reuse existing numbered outlet folders** (`src/lib/outlet-folders.ts`,
   `src/lib/google-drive.ts`)
   - The Shared Drive lays outlets out with an ordering prefix the team
     renumbers over time: `1.NEWS · 2.POP · 3.PODCAST · 4.KND ·
     5.THE SECRET SAUCE · 6.WEALTH · 7.LIFE · 8.SPORT · 9.ADVERTORIAL`.
   - Outlet folder mapping now stores the canonical suffix; the Drive layer
     (`ensureChildFolderByCanonicalName`) matches an existing child folder by
     that suffix after stripping the `N.` prefix, preferring the numbered
     folder so a stray un-numbered duplicate never wins. No more new
     "Advertorial" folder next to "9.ADVERTORIAL".

2. **Booking folder named by Production ID + job name**
   (`buildBookingFolderName`)
   - `<root>/<outlet>/AGN-260529-STD-01 - PTTPLC ปตท./<camera>/<file>` —
     the producer's project/episode title is appended so editors recognise
     the folder. Wasabi keys stay the stable bare-`bookingCode` form.

3. **`booking-info.txt` written into each booking folder**
   (`src/lib/booking-info.ts`)
   - A readable summary (Production ID, project, schedule, crew, **all
     episodes**, notes) is upserted at the booking-folder level so anyone
     opening the folder — editor, archivist — has the shoot's context
     without the app. Refreshed on each upload; best-effort (never blocks
     the footage upload).

### Fixed — Drive read auth used an unauthorized DWD scope (`src/lib/google-drive.ts`)

`getDriveReadAuth()` requested `drive.readonly`, but the service account's
Domain-Wide Delegation grant only authorizes `calendar` + `drive` (DWD
matches scopes exactly, not hierarchically), so every read failed with
`unauthorized_client` — silently breaking the footage worker + the inspect
script. Read now uses the authorized full `drive` scope (a superset of read).

---

## [1.35.20] — 2026-06-02

### Fixed — Upload to Google Drive + Wasabi now works (`src/lib/google-drive.ts`)

Two root-cause fixes required to unblock the footage upload feature:

1. **DWD scope** — Added `https://www.googleapis.com/auth/drive` to the
   service account's Domain-wide Delegation in Google Workspace Admin.
   Previously only `calendar` scope was authorized; Drive upload (write ops)
   requires the full `drive` scope via the same DWD path.

2. **Drive API enabled** — Enabled `drive.googleapis.com` in the GCP project
   (`production-booking-494605`). The API had never been used in this project,
   so all Drive SDK calls failed with "API has not been used in project… or
   it is disabled." Enabled via GCP Console → APIs & Services → Library.

After both fixes, `POST /api/upload/init` returns 200 with a Drive resumable
session URL + Wasabi multipart presigned URLs — upload flow works end-to-end.

---

## [1.35.19] — 2026-06-01

### Fixed — Bookings tab rows patched by Production ID, not stored index (`src/lib/google-sheets.ts`, 4 route files)

`updateBookingRow` previously used `booking.sheetRowIndex` (a stored integer) to locate the target row.
Manual insert / delete / sort in the Bookings tab would silently shift rows and cause the wrong booking
to be patched. Now `updateBookingRow` accepts a `bookingCode: string`, scans column A live, and computes
the real row index at write-time — immune to any sheet edits. All four callers updated.
Authored by Panu-PookenZ (PR #2).

---

## [1.35.18] — 2026-06-01

### Added — Main Videographer propagated to Producer Dashboard Bookings tab (`src/lib/google-sheets.ts`, `src/app/api/admin/[id]/assign/route.ts`)

`Booking.mainVideographerEmail` was already stored in Postgres but never written to the Bookings tab.
Now written as column 30 ("Main Videographer") on every assign and on new-booking append.
Downstream PMC sync (Airtable Service Job → Main Videographer) can now read the value from the sheet.
Authored by Panu-PookenZ (PR #1).

### Removed — Dead in-app Episode ID minting (`src/lib/dashboard-episodes.ts`)

`generateProjectEpisodeIds()` and all its helpers (~192 lines: `pad2`, `lookupProject`, `maxSeqInPDTab`,
`escapeRegex`, `tabRef`, `cleanDirectorName`) were removed — no live callers existed.
Episode creation stays in the Dashboard UI where it belongs.
Authored by Panu-PookenZ (PR #1).

---

## [1.35.17] — 2026-06-01

### Changed — Permissions page redesign (`src/app/admin/permissions/page.tsx`)

Rebuilt `/admin/permissions` with:
- **Search** — filter by email, thaiName, employeeId, or position
- **Sort** — by name (Thai locale), role (Admin first), or created date
- **Show Disabled** toggle — hidden by default, checkbox to reveal disabled accounts
- **OT Approver badge** — derived inline: shown when `role=ADMIN` or `position` contains "manager"
- **Inline position edit** — hover pencil icon on any row → edit position in place (Enter to save, Esc to cancel)
- **Stat chips** in header — live count of active Admins and OT Approvers
- **Compact table** — thaiName + email + employeeId stacked in one cell; action buttons tighter
- **Add-user form** — collapsible, auto-focuses email input
- **Legend** at bottom explaining how Admin / OT Approver / canUpload are derived

No schema or API changes — purely a UI improvement.

---

## [1.35.16] — 2026-06-01

### Fixed — `/upload?bookingId=` crashes: "Cannot read properties of undefined (reading 'code')" (`src/app/upload/page.tsx`)

Single-booking mode fetches `/api/bookings/[id]` which returns `{ booking: { ... } }`.
The effect did `setBookings([d])` — storing the wrapper object, not the booking.
All subsequent accesses (`single.outlet.code`, `single.program.name`, etc.) read
`undefined` and the page crashed.

Fixed by unwrapping: `setBookings([d.booking ?? d])`. The `?? d` fallback preserves
backward-compatibility if a future API ever flattens the response.

---

## [1.35.15] — 2026-06-01

### Fixed — Admin booking detail page: wrong status badge for COMPLETED / CANCELLED bookings (`src/app/admin/[id]/page.tsx`)

The status badge ternary chain in the admin booking detail page had no cases
for `COMPLETED` or `CANCELLED` — both statuses fell through to the default
`bg-red-100 text-red-700 [REQUESTED]` badge. Admins viewing a completed or
cancelled booking saw a misleading red "[REQUESTED]" chip instead of the correct
label. Fixed by adding explicit branches:

- `COMPLETED` → blue badge `✓ COMPLETED`
- `CANCELLED` → gray badge `CANCELLED`

The `isConfirmed` branch (covers `CONFIRMED` + its `approved` alias) and the
`ASSIGNED` branch are unchanged.

---

## [1.35.14] — 2026-05-31

### Fixed — Three bugs found during codebase audit

#### 1. `GET /api/upload` crashes with BigInt serialization error (`src/app/api/upload/route.ts`)

`Upload.fileSize` is stored as `BigInt?` in Prisma. The admin-only legacy
GET endpoint returned `NextResponse.json({ uploads })` directly — once any
v1.35.x upload existed, the response threw `TypeError: Do not know how to
serialize a BigInt` and returned a 500 to the caller. Fixed by mapping
`fileSize` to `Number` before serialization (same pattern already used in
`/api/upload/list`).

#### 2. Admin sees empty crew view briefly on `/upload` list (race condition) (`src/app/upload/page.tsx`)

The list-mode `useEffect` fired before `/api/me` resolved. With `me === null`
the scope defaulted to `mine` (crew view) and fetched `?scope=mine`. When
`/api/me` settled, the effect re-fired with the correct admin scope — causing
a flash of the wrong (empty) list. Fixed by introducing a `meLoaded` boolean
state: the me-fetch effect always calls `setMeLoaded(true)` in `.finally()`;
the list-mode branch returns early until `meLoaded` is true. The spinner
that was already showing from `loading: true` (initial state) covers the wait
with no visible flicker.

#### 3. `Switcher` and `Atem` missing from upload camera list (`src/app/_components/booking/UploadSection.tsx`)

The footage-sync `CAMERA_TOKEN_RE` in `src/lib/footage-sync.ts` recognises
`Switcher` and `Atem` as valid camera tokens. The upload form `CAMERAS` array
only had `['Cam1', 'Cam2', 'Cam3', 'Cam4', 'Sound', 'Drone', 'BTS']` — so
a crew member uploading switcher or ATEM output had to pick a wrong camera
label, breaking the footage log's camera column. Added both tokens to align
the UI with the parser.

---

## [1.35.13] — 2026-05-29

### Fixed — Wasabi + footage env vars never reached the container (compose bug)

**Root cause.** `/api/admin/upload-config` reported every `WASABI_*`,
`DRIVE_FOOTAGE_ROOT`, and `FOOTAGE_LOG_SHEET_ID` as `MISSING` on the
running container — even though they were pasted into the Portainer stack
env. The pre-existing Google/SMTP/calendar vars worked fine.

The bug was in `docker-compose.portainer.yml`: every feature from v1.34.x
(footage matcher) and v1.35.x (dual-cloud upload) was shipped **without
adding the new vars to the `app` service's `environment:` block**.

In Docker Compose, Portainer's "stack environment variables" only feed
`${VAR}` **substitution** inside the compose file — they are NOT
auto-injected into the container. A variable the container actually reads
must appear on an `environment:` line (e.g. `WASABI_BUCKET: ${WASABI_BUCKET:-}`).
The Google vars were listed there from earlier work, so they reached the
container; the 14 new vars were never wired, so they evaporated at deploy.

This is why "ผมใส่ไปหมดแล้ว" was true and the diagnostic still showed
MISSING — nothing was wrong on the Portainer side.

#### Added to the `app` service `environment:` block

Footage matcher (v1.34.x):
`FOOTAGE_LOG_SHEET_ID`, `FOOTAGE_LOG_TAB`, `DRIVE_FOOTAGE_ROOT`,
`FOOTAGE_WORKER_ENABLED`, `FOOTAGE_WORKER_INTERVAL_MS`,
`FOOTAGE_SYNC_SECRET` (defaults to `NEXTAUTH_SECRET`).

Wasabi dual-cloud upload (v1.35.x):
`WASABI_ENDPOINT`, `WASABI_REGION`, `WASABI_BUCKET`, `WASABI_KEY_PREFIX`,
`WASABI_ACCESS_KEY`, `WASABI_SECRET_KEY`, `WASABI_VERIFY_ON_COMPLETE`.

Each uses `${VAR:-default}` so the value comes from the Portainer stack env
at deploy time — no secret value is written into git.

#### Operator action required

Redeploy the stack so the new compose takes effect, then re-run
`/api/admin/upload-config` and confirm `wasabiPing.ok = true`. The values
already pasted into the stack env will now flow through. (No re-paste
needed — only the compose file changed.)

---

## [1.35.12] — 2026-05-29

### Changed — Actionable config errors in `/api/upload/init`

Symptom: a real upload showed `Wasabi is required for this outlet but
WASABI_* env vars are not set` — accurate but the admin then has to
guess which env vars are missing and where to set them.

#### `WASABI_NOT_CONFIGURED` now returns:

```json
{
  "error": "Wasabi is required for outlet \"AGN\" (storagePolicy=DUAL_WRITE) but is not configured. Admin: set the following env vars in the Portainer stack and redeploy — WASABI_BUCKET, WASABI_ACCESS_KEY, WASABI_SECRET_KEY. Diagnose at /api/admin/upload-config.",
  "code": "WASABI_NOT_CONFIGURED",
  "missingEnvVars": ["WASABI_BUCKET", "WASABI_ACCESS_KEY", "WASABI_SECRET_KEY"],
  "outletPolicy": "DUAL_WRITE",
  "adminAction": "Set WASABI_* env vars in Portainer stack → Pull and redeploy. Verify via /api/admin/upload-config (wasabiPing.ok = true)."
}
```

Each of the five env vars is checked individually so the message names
exactly which ones to fill in. The `missingEnvVars` array is structured
so future UI surfaces can render a checklist.

#### `DRIVE_NOT_CONFIGURED` (new code)

Same treatment for the Drive case: if `DRIVE_FOOTAGE_ROOT` isn't set
the error now spells out the expected folder id
(`0APhGxxryY4pzUk9PVA` for current prod) so the admin doesn't have to
hunt for it in `.env.portainer.example`.

#### Behavior preserved

- HTTP status stays `503` (server-side misconfiguration, not a client
  error — same semantics as before)
- The UploadSection in the browser already renders the response
  `error` field verbatim, so the new actionable message shows up
  inside the upload queue card with no UI change needed

#### Not changed

- The system still refuses to upload to a DUAL_WRITE outlet with
  Wasabi missing. No silent downgrade to Drive-only — that would
  break the outlet's storage policy contract. Admin must either fix
  the Wasabi config or change the outlet's `storagePolicy` in DB.

#### Rollback

Trivial — message change only. Bump `IMAGE_TAG` back to `sha-0a36b5b`
(v1.35.11). Real fix is server-side env config in Portainer
regardless of which version is deployed.

---

## [1.35.11] — 2026-05-29

### Changed — Upload moves to its own dedicated page (`/upload?bookingId=…`)

Per ops feedback: the inline Upload section on `/admin/[id]` mixed
upload UI into the same screen as the admin's booking-edit controls.
Crew opening the upload link saw the full admin internals; admins
uploading saw a noisy screen. Splitting the surfaces fixes both.

#### What moved

- The inline `UploadSection` is **removed** from `/admin/[id]`. The
  page now stays focused on booking metadata + crew assignment +
  calendar sync + Mark-as-Done review.
- The Upload UI is now reachable **only** at `/upload?bookingId=<id>`
  — which already existed for crew (since v1.35.3). Admins use the
  same page now.

#### Links updated

| Surface | Before | After |
|---|---|---|
| `/admin` booking card "📹 Upload" | `/admin/[id]#upload` (inline) | `/upload?bookingId=<id>` (dedicated page) |
| `/admin/[id]` page | inline `UploadSection` rendered | New shortcut link card: "📹 Open the dedicated upload page →" |
| `/my-bookings` row "📹 Upload" | `/upload?bookingId=<id>` (already this) | unchanged |

#### What stays on `/admin/[id]`

- All existing booking-detail editing (admin-only)
- Calendar status / re-sync card
- **Mark-as-Done card** — admin-only review action, not an upload
  action. Lives where the admin reviews booking completion.

#### Bonus cleanup

- Removed dead `meCanUpload` / `meEmail` state + `/api/me` fetch on
  `/admin/[id]` — they only existed to gate the now-removed inline
  UploadSection.
- Removed the `UploadSection` import line; no longer referenced from
  this page.

#### Behavior preserved

- Crew (video/sound role) can still upload via `/upload?bookingId=<id>`
  exactly as before
- Admin clicks "Upload" on a card → lands directly on the upload page
  (one fewer click vs. v1.35.10's scroll-to-anchor)
- Defense-in-depth gates (`canUploadToBooking`, booking status check,
  outlet folder mapping) all live on the API side and continue to
  apply regardless of which page the request originates from

#### Rollback

UI-only refactor. Bump `IMAGE_TAG` back to `sha-db2dbbb` (v1.35.10)
to revert; the inline UploadSection returns.

---

## [1.35.10] — 2026-05-29

### Fixed — `/admin/[id]` crash after Re-sync / Mark-as-Done

**Symptom (user-visible):**
```
TypeError: Cannot read properties of undefined (reading 'name')
  at /admin/[id]/page-...js
```

Crashed the booking detail page right after the admin clicked any
action that triggered a fresh fetch (Re-sync calendar, Mark Upload
Done, etc.).

**Root cause:**

`/api/bookings/[id]` returns `{ booking: {...} }` (the booking is
wrapped). The page's initial-load handler unwraps it correctly:

```ts
fetch('/api/bookings/' + id).then(r => r.json()).then(d => setBooking(d.booking))
```

But TWO callback paths used `setBooking(d)` (passing the wrapper
object):

1. `BookingConfirmedCard.onResynced` — pre-existing bug from v1.32.2
2. `MarkUploadDoneCard.onDone` — new in v1.35.5

After either action fired, `booking` state became `{ booking: {...} }`.
Any subsequent render reading `booking.outlet.name` (UploadSection,
MarkUploadDoneCard subhead, etc) blew up.

**Fix:**

1. Both callbacks now correctly unwrap: `if (d?.booking) setBooking(d.booking)`.
2. **Defense in depth** — `UploadSection` now guards its first render
   on `booking?.outlet?.name`. If absent, renders a clear "booking
   outlet data missing — refresh" card instead of crashing. The
   ErrorBoundary above would have caught the crash anyway, but the
   friendly card keeps the rest of the page interactive.

#### Impact

- Re-sync calendar from `/admin/[id]` ✓ no longer crashes
- Mark Upload as Done from `/admin/[id]` ✓ no longer crashes
- UploadSection rendered from `/upload?bookingId=…` ✓ unaffected
  (that route already passed unwrapped booking)

#### Rollback

Single-file UI fix. Bump `IMAGE_TAG` back to `sha-1ea99e8`
(v1.35.9) — the crash returns but no other behavior changes.

---

## [1.35.9] — 2026-05-29

### Security + correctness audit findings

Deeper code-audit pass on the v1.35.x upload + footage + calendar
surfaces. Four fixes:

#### 🔒 (HIGH) `GET /api/upload` leaked every upload row site-wide

The pre-v1.35 local-disk endpoint at `/api/upload/route.ts` had **zero
auth**. Anyone with a session cookie (and even unauthenticated GET in
the original code) could `GET /api/upload?bookingId=X` and dump the
Upload table — filenames, uploaders, Drive ids, file sizes — for any
booking. The per-booking `/api/upload/list` (which IS properly gated)
made this look fine in code review, but the legacy endpoint sat
underneath unattended.

**Fix:** GET is admin-only; POST applies the same
`canUploadToBooking` gate as `/api/upload/init`. POST also forces
`uploadedBy = session.email` instead of trusting the form field, so
a logged-in user can no longer attribute uploads to a different
crew member.

The legacy endpoint will be removed entirely in v1.35.10 once the
deploy confirms no client still hits it (the rewritten `/upload` page
uses `/api/upload/{init,complete}` exclusively).

#### 🔒 (HIGH) Filename validation allowed path-traversal tokens

The init endpoint's regex allowed `.`, `()`, `[]` etc but didn't
explicitly reject `..`, leading dots, or trailing dots/whitespace.
A POST with `filename: "..(harmless).mp4"` would be accepted, then
flow into Wasabi key building + Drive display name + legacy disk
path joins. Drive uses ids not paths so was safe; Wasabi could
produce confusing keys; the legacy `/api/upload` (now fixed
separately above) would write the file outside the target dir on
Windows in extreme cases.

**Fix:** New `isSafeFilename()` helper rejects:

- Path separators (`/`, `\`)
- Leading dot (hidden files)
- `..` anywhere (parent traversal in any position)
- Trailing dot or space (Windows reserves these)
- Anything longer than 255 chars

Plus the existing positive class (alphanum + Thai + safe punctuation).

#### 🐛 (MEDIUM) Drive resumable rewind on suspicious Range header

`uploadToDrive` in `src/lib/upload-client.ts` honored Drive's
`Range: bytes=0-<n>` reply to update the cursor for the next chunk.
The pre-v1.35.9 code naively trusted `n+1` without bounds-checking:

- If `n+1 > total` (malformed reply / proxy quirk): cursor would
  jump past the end, terminating the upload with bytes missing.
- If `n+1 > cursor` (impossible — Drive claims to have received
  bytes we haven't sent yet): code would skip bytes we did send.

**Fix:** Three explicit cases:

1. `drivesNextByte < cursor` → Drive received less than we sent;
   rewind cursor to re-cover the gap. Logs a warning so the
   reason for the slowdown is visible.
2. `drivesNextByte === cursor` → expected case; no change.
3. `drivesNextByte > cursor` or out-of-bounds → ignore the header
   (trusting it would skip bytes).

#### 🧹 (LOW) Calendar debug cleanup sends cancellation when `inviteSelf=1`

If `/api/admin/calendar-debug?inviteSelf=1` sent an invite email to
the impersonate subject, the cleanup deleted the event with
`sendUpdates: 'none'` — meaning the user got an invite but no
cancellation. They'd see the invite + later notice the event is
gone with no explanation.

**Fix:** Cleanup mirrors `inviteSelf` — sends the cancellation when
an invite was sent.

#### Audited and verified working (no fix needed)

- `listFilesRecursive` already has a 5000-file `maxFiles` cap — not
  unbounded as the audit suggested.
- Footage scanner sheet-write failure tally is intentionally 0 for
  `matched` (rows weren't actually written this tick; next tick
  retries via the v1.35.8 recovery path).
- `/api/upload/complete` idempotency check on COMPLETE is correct
  for typical usage. Concurrent double-completion is a theoretical
  race not seen in production traffic; deferred unless real reports
  emerge.

#### Rollback

Pure additive/refinement — no schema change. Bump `IMAGE_TAG` back
to `sha-fe5ba07` (v1.35.8) if the legacy `/api/upload` auth tightening
breaks any client. All other fixes are silent (better defaults,
unchanged happy path).

---

## [1.35.8] — 2026-05-29

### Fixed — Two upload-pipeline edge cases (silent data loss + Drive orphan)

Code-audit pass found two latent bugs in the v1.35.x upload pipeline.
Both shipped invisible: the system kept working "well enough" until a
specific failure path was hit, at which point data was lost or
storage leaked.

#### Bug A — sheet rows lost when `/api/upload/complete`'s sheet write fails

**Path:** Upload reaches both clouds OK. `/complete` then appends a
row to the footage-log sheet. If that append throws (Sheets API
rate limit, transient 503, sheet permission revoked), the catch
swallows the error and returns `ok: true`. The COMPLETE Upload row
exists, the FootageLog row has `sheetRowWritten=false`, and the file
is in both clouds — but **never appears in the user's footage log
sheet**.

The v1.34.x footage-sync scanner *would* have caught this on its
next tick, but v1.35.1 added a "skip files owned by Upload rows"
rule to prevent the scanner from double-writing rows for files the
app uploaded. That rule was too aggressive — it also skipped
recovery cases.

**Fix:** scanner now classifies each Upload-owned file:

- `status != COMPLETE` → skip (in-flight or known FAILED; let
  `/complete` or `/cancel` handle it)
- `status === COMPLETE` AND `FootageLog.sheetRowWritten === true`
  → skip (done)
- `status === COMPLETE` AND `FootageLog.sheetRowWritten === false`
  → **process** (recovery — `/complete` failed to write sheet row;
  scanner now writes it on the next 10-min tick)

Files where `/complete` failed silently will start appearing in the
footage log sheet within ~10 minutes of the next worker run after
this deploy.

#### Bug B — Drive file slot orphaned when Wasabi init fails after Drive succeeds

**Path:** `/api/upload/init` for a DUAL_WRITE outlet:

1. Reserves Drive file slot + opens resumable session ✓
2. Updates Upload row with `driveFileId` ✓
3. Pre-creates FootageLog row ✓
4. **Wasabi `CreateMultipartUpload` throws** (bad creds, rate limit,
   transient 5xx)
5. Catch block marks Upload `FAILED` and returns 502 ✓
6. **Drive empty file slot stays in the Shared Drive forever** ✗

Over time this leaves visible-but-empty 0-byte files under
`<outlet>/<bookingCode>/<camera>/` named after files that never
uploaded — confusing to crew browsing the folder.

**Fix:** the Wasabi-init failure path now calls `deleteDriveFile`
on the reserved slot + removes the FootageLog row before returning
the 502. Best-effort; if the cleanup itself fails, the Upload row's
`failureReason` records both errors so triage isn't blind:

```
Wasabi init: CreateMultipartUpload failed: NoSuchBucket: …
  · drive slot rolled back
```

or

```
Wasabi init: CreateMultipartUpload failed: …
  · drive cleanup failed: insufficient permissions
```

#### Sanity audit (no fix needed — verified working)

- `/api/upload/cancel` correctly aborts Wasabi multipart + deletes
  Drive slot + clears FootageLog
- `/api/upload/complete` idempotent on COMPLETE
- `mark-upload-done` idempotent on COMPLETED
- `canUploadToBooking` correctly bypasses assignment for admins
- UploadSection drag/drop handler preventDefaults to avoid browser
  opening the file in a tab
- v1.35.7 calendar readback verify catches silent-drop without
  changing happy-path behavior

#### Rollback

Pure logic refinement — no schema change. Bump `IMAGE_TAG` back to
`sha-b765014` (v1.35.7) to revert; the two bugs return latent.

---

## [1.35.7] — 2026-05-29

### Fixed — Calendar guest "silent drop" — diagnostic + readback verification

User report: "calendar ไม่ยิง guest" — assigned crew aren't being added
as event attendees. Without access to the live audit_logs to diagnose
directly, this release ships two things: a controlled diagnostic
endpoint to isolate the cause, and a readback verification in the
production create/patch paths so the most common silent-failure mode
gets caught + alerted instead of being lost.

#### Most likely root cause (per Google's behavior)

When the DWD-impersonated user (e.g. `narasit.k@thestandard.co`) has
**read-only access** to the shared Production Bookings calendar
instead of "Make changes to events", the Calendar API:

- Returns `200 OK` on `events.insert` / `events.patch` with the
  attendees echoed in the response
- **Silently drops the attendees** when persisting

The pre-v1.35.7 code trusted the 200 and assumed the attendees were
attached. They weren't. No alert fired because the API returned
success.

#### `/api/admin/calendar-debug` (new diagnostic endpoint)

```
GET /api/admin/calendar-debug
GET /api/admin/calendar-debug?inviteSelf=1   ← actually emails the
                                               impersonate subject
```

Walks the full guest-attach path against a throwaway event:

1. Read env: service account + impersonate subject + calendar id
2. Authenticate (forces DWD JWT exchange via `calendars.get`)
3. `events.insert` with `[impersonateSubject]` as the sole attendee
4. **`events.get` to read the persisted attendees count**
5. `events.delete` to clean up

Returns a structured report with `summary` mapped to a known cause:

| `summary` | Meaning + recommended fix |
|---|---|
| `OK — attendees attached + persisted` | Pipe is healthy. If real bookings still show empty, audit `audit_logs WHERE action LIKE 'calendar.%_failed'` |
| `ATTENDEES_SILENTLY_DROPPED` | The silent-drop case above. Open Calendar settings → share → grant impersonated user "Make changes to events" |
| `DWD_NOT_GRANTED` | Workspace Admin → Security → API controls → Domain-Wide Delegation → add SA client id with `https://www.googleapis.com/auth/calendar` |
| `INSUFFICIENT_PERMISSIONS` | DWD works but user lacks calendar visibility. Share the calendar with them first |
| `NO_IMPERSONATE_SUBJECT` | Set `GOOGLE_IMPERSONATE_SUBJECT` in Portainer stack env |
| `NO_SERVICE_ACCOUNT` | Set `GOOGLE_SERVICE_ACCOUNT_*` in Portainer stack env |

Admin-only. Side effect: creates + immediately deletes one event 24h
in the future. With `inviteSelf=0` (default), no email is sent.

#### Production fix — readback verification

`createCalendarEvent` and `updateCalendarEventAttendees` now do a
`calendar.events.get` after a successful insert/patch when there are
attendees in the request. If the persisted count is less than what
was sent:

- Logs a warning with the specific likely cause
- Fires `notifyCalendarAlert` (writes `AuditLog` + emails the calendar
  alert recipient — same channel the existing failure path uses)
- For `updateCalendarEventAttendees`: returns `false` so the assign
  route correctly surfaces a failure to the admin UI (currently
  shown as "⚠ guests NOT added" toast)

Cost: one extra `events.get` per insert/patch with attendees (~150ms).
Worth it — silent data loss is hard to detect after the fact.

#### How to use this release

1. Deploy `sha-<new>` via Portainer.
2. As admin, browse to **`/api/admin/calendar-debug`** in your browser.
3. Read the `summary` field at the top of the JSON.
4. Follow the matching row in the table above.
5. After fixing the root cause, re-run the endpoint to confirm
   `summary: 'OK'`.
6. Then push a new assign action on a real booking to verify the
   readback no longer fires the alert.

#### Rollback

Pure additive — new endpoint + extra readback in the existing helpers.
No schema change. Bump `IMAGE_TAG` back to `sha-d3d7592` (v1.35.6) to
revert; the silent-drop bug returns unalerted but no other behavior
changes.

---

## [1.35.6] — 2026-05-29

### Hardened — Resilient uploads (chunked Drive + per-chunk retry + drag/drop)

The v1.35.2 upload UI worked but assumed friendly network conditions —
a single Drive PUT for the whole file, no retry on chunk failures. For
real footage (4–50GB on apartment wifi) one disconnect would restart
the whole upload. v1.35.6 fixes that.

#### New: `src/lib/upload-client.ts`

Extracted out of `UploadSection` so the chunking + retry logic is
testable and reusable. Exposes:

```ts
uploadToDrive(sessionUrl, file, { onProgress, onRetry? })
uploadToWasabi(file, parts, chunkSize, { onProgress, onRetry? })
```

#### Drive — chunked Content-Range PUTs

Replaces the single-PUT-of-the-whole-file approach with 8MB chunks
sent via `Content-Range: bytes <start>-<end>/<total>`. Drive returns
**308 Resume Incomplete** between chunks and **200/201** on the last.

A network drop now costs at most one 8MB chunk to retry, not the
whole file. The session URL stays valid (~1 week per Drive's spec) so
the retry hits the same upload slot — no duplicate file on success.

#### Per-chunk retry with exponential backoff

Both Drive chunks and Wasabi parts wrap their `XMLHttpRequest.PUT` in
a retry loop:

- 4 attempts max
- Delay: 1.5s × 2^(n-1), capped at 20s, with ±400ms jitter
- 4xx (non-408/429) responses fail fast — they're not transient
- User-initiated cancel propagates immediately, no retry

When a retry is in flight, the UI shows it:

```
Drive  [██████████░░░░░] 67%  ↻ retry 2/4
       └── amber bar instead of purple to flag the recovery
```

The retry hint clears the moment the chunk succeeds — no false
"stuck retrying" left over.

#### `RetryStatus` surfaced through the callback

```ts
interface RetryStatus {
  attempt: number       // 1..maxAttempts
  maxAttempts: number
  lastError: string | null
  active: boolean       // false on success
}
```

`UploadSection` stores the latest status per file × per cloud and
renders the amber retry hint inline with the progress bar. Hovering
the retry chip shows the last error message (e.g. "Drive chunk HTTP
503") for diagnostic clarity.

#### Drag/drop file picker

Wrapped the file `<input>` in a dashed-border drop zone. Behavior:

- Drag a file in → border turns purple, background lightens, label
  changes to "⬇ ปล่อยไฟล์ที่นี่"
- Drop → files enter the upload queue immediately (same handler as
  the file picker)
- Drag away without dropping → state resets

The file picker click still works exactly as before, so non-mouse
users (keyboard / touch) aren't penalized.

#### Footnote in the upload pane

```
จะ upload ตรงเข้า Drive ที่ <outlet>/<bookingCode>/<camera>/
· chunked + auto-retry (network drop ปลอดภัย)
```

So the operator knows what the system is doing when they see the
retry chip flash during a wifi blip.

#### What's still deferred (would land in v1.35.7+)

- **Cross-reload resume** — File objects don't survive a page reload;
  recovering requires the user to re-pick the file. We could
  fingerprint by name+size+lastModified and resume the same Drive
  session URL — but the architectural cost is bigger than the
  benefit until we see real reload-mid-upload pain.
- **Stall detection** — if no `xhr.upload.progress` event for 30s,
  proactively abort + retry. The retry loop handles eventual failure
  but doesn't notice a frozen connection until the OS times out.
- **SHA-256 verify** — browser computes hash via Web Crypto streaming,
  server verifies after upload, mismatch → mark FAILED.

#### Rollback

Pure UI + client-lib change. Bump `IMAGE_TAG` back to `sha-a76bfae`
(v1.35.5) — uploads revert to single-PUT Drive + no retries. The
review queue + Mark-as-Done flow stay intact.

---

## [1.35.5] — 2026-05-29

### Added — Upload review queue + Mark-as-Done flow (closes the loop)

After crew uploads video + sound, a booking now enters an admin review
queue. Admin looks over the upload log, confirms the work is complete,
and flips the booking's status from CONFIRMED → COMPLETED — which
removes it from every active queue. Closes the production lifecycle.

#### Completeness rule (`src/lib/upload-completeness.ts`)

A booking enters the review queue when **all** hold:

1. Status is `CONFIRMED` (already approved by Producer)
2. At least one `Upload` row with status `COMPLETE` and a video
   camera (Cam1–4, Drone, BTS, etc — anything other than 'Sound')
3. At least one `Upload` row with status `COMPLETE` and camera
   exactly `'Sound'` (case-insensitive; also accepts 'Audio'/'Mic')

PENDING / UPLOADING / DRIVE_OK / WASABI_OK / FAILED / ORPHANED uploads
don't count toward coverage — crew can't claim "video uploaded" with a
half-finished file.

#### New endpoints

- **`GET /api/admin/upload-review`** — returns two arrays:
  - `ready[]` — CONFIRMED bookings that pass the rule above (video +
    sound both present). Each row includes `videoCount`, `soundCount`,
    `inFlightCount`, `failedCount`, `totalBytes`, `uploaders[]`,
    `lastUploadAt`.
  - `inProgress[]` — CONFIRMED bookings with at least one upload but
    missing video or sound. Visibility into "what's pending" without
    polluting the action queue.

- **`POST /api/admin/[id]/mark-upload-done`** body `{ note? }` —
  re-checks completeness server-side (race-safe), flips
  `BookingStatus` `CONFIRMED → COMPLETED`, writes an `AuditLog` row:
  ```
  action:        booking.mark_upload_done
  fromStatus:    CONFIRMED
  toStatus:      COMPLETED
  changes:       { videoCount, soundCount, inFlightCount,
                   failedCount, totalBytes, note }
  ```
  Idempotent on COMPLETED (returns 200 `idempotent: true` for double-
  click safety). Returns `400 INCOMPLETE_UPLOAD` if the rule no longer
  holds (file deleted between list + confirm — gate sticks).

#### New page `/admin/upload-review`

Two-section layout:

```
[Summary strip]  พร้อมยืนยัน N  ·  รอ crew อัพเพิ่ม M

[พร้อมยืนยัน Done]
  📂 AGN-260423-EVT-01 · [AGN] Key Message
     Thu 23 Apr 26 13:00–18:00 · PD: Producer
     ✓ Video 4  ✓ Sound 1  📦 24.7 GB  🕐 23/4 14:32
     อัพโดย: cam.a@…, sound.b@…       [✓ Mark as Done]

[รอ crew อัพเพิ่ม]
  📂 TSS-260424-EXE-02 · [TSS] The Secret Sauce
     ✓ Video 2  ⚪ Sound 0  ...          [ขาด Sound]
```

Click row → opens `/admin/[id]` for full detail. "Mark as Done" opens
a confirm modal with the upload counts, an optional note field, and
the bytes-uploaded summary.

#### `/admin/[id]` — inline Mark-as-Done card

Below the existing UploadSection, CONFIRMED bookings now render a
`MarkUploadDoneCard` that pulls `/api/upload/list` to compute the
same completeness report client-side. Shows:

- Per-channel coverage chips (Video N, Sound N)
- Total bytes
- In-flight / failed counts when relevant
- "✓ Mark as Done" button — disabled until both channels have ≥1
  COMPLETE upload

Confirming flips the status and reloads the booking. The card
disappears (COMPLETED bookings don't render it).

#### Nav

New admin-only link **"Upload Review"** under the More dropdown,
between "Upload" and the existing utilities. Crew don't see it.

#### Edge cases handled

- **Empty review queue**: shows friendly "ไม่มี booking ที่พร้อมรีวิว"
  empty state.
- **In-flight uploads at confirm time**: the modal shows a yellow
  warning "ยังมี N ไฟล์ที่กำลัง upload" so admin can pause + wait if
  they want. Doesn't block — admin's call.
- **FAILED uploads**: shown as red counts so admin sees "5 attempts
  but only 4 completed, the 5th was a re-take" type situations.
- **Booking re-opens after Done**: COMPLETED bookings can still
  receive uploads (per v1.35.3) — useful for adding late B-roll, but
  the booking doesn't re-enter the review queue. The mark-as-done
  is a one-way transition by design; if footage is wrong, admin
  manually flips via SQL / future endpoint.

#### What this closes

This is the final piece of the v1.35 upload line. The loop is now:

```
PRODUCER books → ADMIN approves (CONFIRMED) → CREW uploads video + sound
              → ADMIN reviews log → ADMIN confirms (COMPLETED) → out of queue
```

No more "is everything in?" Slack threads — the queue + log are the
source of truth.

#### Rollback

Pure additive: new endpoints, new page, new UI card. No schema
change. Rollback by bumping `IMAGE_TAG` back to `sha-f57da79`
(v1.35.4). Any bookings already flipped to COMPLETED stay COMPLETED;
they just won't have the review-queue page available.

---

## [1.35.4] — 2026-05-28

### Fixed — `/upload` strictly limits to CONFIRMED + COMPLETED everywhere

Two leaks in v1.35.3 closed:

#### 1. Admin's list view missed COMPLETED rows

The admin path fetched `/api/bookings?status=CONFIRMED` only — the
underlying API accepts a single status param at a time, so a single
fetch silently dropped every COMPLETED booking from the admin's
upload list. They had to know the URL or use `/my-bookings` to reach
those.

Fix: admin path now fires **two parallel fetches** (`status=CONFIRMED`
and `status=COMPLETED`), dedupes by id, and sorts by `shootDate` desc.
Crew path (`?scope=mine&limit=200`) was already correct — it fetches
all of the crew's assignments and filters client-side, which already
caught both statuses.

#### 2. Single-booking deep-link didn't warn on bad status upfront

If a user pasted `/upload?bookingId=X` where X happened to be
REQUESTED / ASSIGNED / CANCELLED, the page used to render the full
`UploadSection` and only show the failure when they tried to upload
(403 BAD_STATUS from `/api/upload/init`).

Fix: page now shows the booking's status badge in the header and, if
status is anything other than CONFIRMED / COMPLETED, replaces
UploadSection with a clear advisory:

```
Booking นี้สถานะ REQUESTED — upload ทำได้เฉพาะ CONFIRMED หรือ COMPLETED เท่านั้น
รอ Admin approve booking ก่อน — แจ้ง Producer
[← เลือก booking อื่น]
```

Server gate unchanged — `/api/upload/init` still 403s; this is a UX
fix so the user sees the reason without first composing files.

#### Rollback

Pure UI / fetch logic change in `/upload/page.tsx`. Bump
`IMAGE_TAG` back to `sha-8b7a2bb` (v1.35.3) to revert; the API gate
stays correct either way.

---

## [1.35.3] — 2026-05-28

### Fixed — Crew can actually reach the upload UI + assignment gate

v1.35.2 placed the Upload section on `/admin/[id]`, but `/admin` is
ADMIN-only via layout — so the video/sound crew the feature was built
for couldn't actually get there. This release opens up `/upload` (was
admin-only "under development") as the proper crew-facing entry point
and adds the per-booking assignment check the user asked for:

> "User คนนั้นจะสามารถเลือกได้แค่งานที่ตัวเองถูก assign และงานที่
> จะอัพได้ต้อง [CONFIRMED/COMPLETED]"

#### `/upload` rewrite (was the legacy admin-only stub)

- **Layout gate** flipped from "ADMIN only" to "anyone with upload
  access" (`getUploadAccess` = ADMIN or active TeamMember with role
  in `{video, sound}`). The under-development banner is gone.
- **Page** has two modes driven by `?bookingId=X`:
  - With param → renders the same `UploadSection` component used on
    `/admin/[id]`, with the booking context loaded from the URL.
    Server enforces the per-booking gate (see below) so a non-assigned
    user navigating directly to `/upload?bookingId=X` gets a 403.
  - Without param → shows a searchable list of the bookings the user
    can act on. Admins see all CONFIRMED/COMPLETED; crew sees only
    `?scope=mine` results (their own assignments).

#### `canUploadToBooking(email, bookingOrId)` — new helper in `src/lib/session.ts`

Single source of truth combining all three gates:

```ts
{
  ok: boolean,
  reason?: 'NO_UPLOAD_ROLE' | 'NOT_ASSIGNED' | 'BAD_STATUS' | 'BOOKING_NOT_FOUND',
  isAdmin?: boolean,
}
```

Rules:
- Inactive `User` → `NO_UPLOAD_ROLE`
- Non-admin without `TeamMember` role `video`/`sound` → `NO_UPLOAD_ROLE`
- Booking status not in `{CONFIRMED, COMPLETED}` → `BAD_STATUS`
- **Non-admin not listed in `Booking.assignedEmails`** → `NOT_ASSIGNED`
- ADMIN bypasses the assignment check (ops needs to upload on behalf
  of crew, fix wrong filings, etc.)

#### Server enforcement

- `POST /api/upload/init` — runs `canUploadToBooking` after parsing the
  body, returns `403` with the specific `code` so the UI can show a
  friendly message ("you're not assigned to this booking", etc.). The
  v1.35.2 `getUploadAccess` + `BAD_BOOKING_STATUS` checks fold into the
  single new helper — same coverage, less duplication.
- `GET /api/upload/list?bookingId=…` — same gate. Listing the upload
  history of a booking you can't act on leaks who's been on a shoot,
  so visibility ties to upload permission.

#### Discovery surfaces

- **Nav** — "Upload" link in More dropdown now uses `canUpload` flag
  (was `isAdmin`). Crew see the link; users without upload access
  don't.
- **`/my-bookings`** — CONFIRMED + COMPLETED rows get a primary
  "📹 Upload" button that links to `/upload?bookingId=<id>`. Only
  rendered when `me.canUpload === true`. Crew's natural home page now
  surfaces the action they need.
- **`/admin`** — the v1.35.2 Upload button on booking cards is
  unchanged (admin-only path stays as a power-user shortcut).

#### What the crew sees end-to-end (v1.35.3)

1. Videographer / sound op signs in → lands on `/`
2. Goes to **My Bookings** in the nav (or **Upload** for a direct
   booking picker)
3. Sees their assigned bookings; CONFIRMED/COMPLETED ones have
   "📹 Upload"
4. Clicks → `/upload?bookingId=X` → UploadSection prefilled, no way
   to misclick into a different booking
5. Drops files; per-cloud progress bars run; history table refreshes
6. Done

#### Rollback

Pure additive on the server (one new helper); UI changes affect
`/upload`, `/my-bookings`, Nav. Rollback by bumping `IMAGE_TAG` back
to `sha-7e3ed84` (v1.35.2). The `/upload` page reverts to its
admin-only stub; `/admin/[id]#upload` still works for admins exactly
as it did in v1.35.2.

---

## [1.35.2] — 2026-05-28

### Added — Upload UI on `/admin/[id]` (crew-only, status-gated, booking-prefilled)

Frontend for the v1.35.1 backend. Crew now upload footage directly
from the booking detail page — booking + outlet context come from the
URL, so there's no dropdown to misclick and the upload always lands in
the right Drive/Wasabi folder.

#### Visibility rules

The Upload section renders only when **both** conditions hold:

1. **User has upload access** — checked via `/api/me.canUpload`:
   - any `User.role === 'ADMIN'`, OR
   - `TeamMember.role` is `video` or `sound` (active members only)
2. **Booking is CONFIRMED or COMPLETED** — REQUESTED / ASSIGNED /
   CANCELLED bookings don't get the section at all

This means: a Producer / Director / Photographer can still see the
booking detail page, but the Upload section is hidden. The server
enforces the same rule via `getUploadAccess()` in `src/lib/session.ts`
+ a `BAD_BOOKING_STATUS` check in `/api/upload/init`, so a
hand-crafted POST would still fail.

#### `UploadSection` component (`src/app/_components/booking/UploadSection.tsx`)

- **Camera dropdown** — defaults to `Cam1`. Supported: Cam1–4, Sound,
  Drone, BTS.
- **Wasabi checkbox** — auto-checked + locked for DUAL_WRITE outlets
  (AGN, TSS, NWS). DRIVE_ONLY outlets get an optional opt-in toggle.
- **Multi-file file picker** — drops files into a queue; each file
  runs the full `init → parallel cloud PUTs → complete` cycle one at
  a time (parallel chunks within a file via 4-concurrent presigned
  PUTs; sequential between files to not saturate the uplink).
- **Per-file progress bars** — separate Drive + Wasabi tracks so the
  user sees which cloud is the bottleneck. Driven by
  `XHR.upload.onprogress` for both clouds.
- **Cancel button** — calls `POST /api/upload/[id]/cancel` to abort
  multipart + delete the reserved Drive slot.
- **History table** — pulls `GET /api/upload/list?bookingId=...` and
  shows previously-uploaded files for this booking with Drive link +
  status chip + uploader email.

#### Booking cards (`/admin`)

CONFIRMED + COMPLETED rows now show a primary **📹 Upload** button
that links to `/admin/[id]#upload`. The anchor scrolls the page to the
upload section so the crew lands on the right control with one click.

```
[CONFIRMED]   [📹 Upload] [EDIT] [Cancel] [✓ Approved]
[COMPLETED]   [📹 Upload] [View] [✓ Completed]
```

Visible only to users where `/api/me.canUpload === true`.

#### Server changes

- `src/lib/session.ts` — `getUploadAccess(email)`: returns true for
  ADMIN or active TeamMember with role in `{video, sound}`.
- `/api/me` — exposes `canUpload: boolean`.
- `/api/upload/init` — new gates:
  - `getUploadAccess` (403 `NO_UPLOAD_ACCESS`)
  - booking status must be CONFIRMED or COMPLETED (400 `BAD_BOOKING_STATUS`)
- `/api/upload/list?bookingId=...` (new) — returns Upload rows for a
  booking, newest first. Same auth gate.

#### What the user sees end-to-end

1. Crew opens `/admin` → sees a CONFIRMED booking they're working on
2. Clicks **📹 Upload** on the card → lands on `/admin/[id]#upload`
3. Upload section is pre-scrolled into view, booking already shown
4. Picks camera (Cam1 default), drags files in
5. Two progress bars per file (Drive + Wasabi if DUAL_WRITE)
6. Files finish → history table refreshes, Drive link clickable

No way to upload to the wrong booking — the context is in the URL.

#### Out of scope (deferred)

- SHA-256 browser-side integrity check (v1.35.4)
- Resume after browser close / tab crash (v1.35.4 reconciler will
  surface ORPHANED uploads for manual cleanup)
- Drag-and-drop UX polish (file picker works; drag-drop is convenience)
- Removal of legacy `/upload` page (v1.35.5)

---

## [1.35.1] — 2026-05-27

### Added — Wasabi + Drive write libs + `/api/upload/{init,complete,cancel}`

Backend half of the browser-direct dual-cloud upload flow. The browser
now has 3 endpoints to drive an end-to-end upload without server bytes
ever touching the wire. UI lands in v1.35.2.

#### New deps

```
@aws-sdk/client-s3 ^3.1055.0
@aws-sdk/s3-request-presigner ^3.1055.0
```

Both `--legacy-peer-deps` (next-auth pins nodemailer at v6 which conflicts
with the AWS SDK's transitive resolution, same pattern as pdf-lib).

#### `src/lib/outlet-folders.ts` (new)

Single source of truth mapping `Outlet.code` → folder name used by both
Drive and Wasabi. Confirmed mappings (matching the team's actual Drive
layout):

```
AGN → Advertorial          (NOT Outlet.name "Content Agency")
TSS → the Secret Sauce     (lowercase 'the' on purpose)
POP → THE STANDARD POP
NWS → News
WLT → Wealth
SPT → Sport
POD → Podcast
KND → KND
LIF → LIFE
```

`buildStoragePath(outlet, bookingCode, camera, filename)` returns the
segment array used by both clouds:
`[outletFolder, bookingCode, camera, filename]`. Single function — if we
ever change the layout it changes here only.

#### `src/lib/wasabi.ts` (new)

S3 client + presign helpers via `@aws-sdk/client-s3`:

- `isWasabiConfigured()` — env-var sanity check; callers check before use
- `createMultipart(key, mime)` — initiate multipart, returns `uploadId`
- `presignParts(key, uploadId, partCount)` — N presigned PUT URLs,
  1-hour TTL
- `completeMultipart(key, uploadId, parts)` — finalize after browser
  pushes all chunks
- `abortMultipart(key, uploadId)` — release storage on cancel/fail
- `verifyUpload(key, expectedSize)` — server-side HEAD to confirm
  size matches (controlled by `WASABI_VERIFY_ON_COMPLETE=1`)
- `chooseChunkSize(fileSize)` — picks a part size that keeps the part
  count ≤ 10000 (S3 hard limit) while staying ≥ 5MB (S3 min). Rounded
  to whole MB so progress bars look sensible.

#### `src/lib/google-drive.ts` — write helpers added

- `getDriveWriteAuth()` — JWT with full `drive` scope, DWD-impersonated
  through the same Workspace user that powers Calendar (single source
  of truth)
- `ensureFolderPath(rootId, segments)` — walk a path of folder names,
  create any missing segments. Race-tolerant (list-then-create with
  exists check; concurrent calls might both create one folder, accepted
  cost since Drive has no locks)
- `createResumableUploadSession({ parentId, filename, mimeType, size })`
  — reserves a file id via `files.create`, then PATCH to the resumable
  endpoint to get a `Location` session URL. Browser PUTs bytes straight
  to that URL.
- `deleteDriveFile(id)` — cleanup for cancel/fail
- `getDriveFile(id)` — read size + webViewLink for /complete verification

#### Schema

One column added to `Upload`:

```
wasabiMultipartId  String?  // S3 UploadId between init+complete
```

So `/complete` and `/cancel` can find the in-flight multipart without
hacky reuse of other columns. `prisma db push --accept-data-loss` adds
it on the next boot — pure additive, nullable, rollback-safe.

#### Endpoints

- **`POST /api/upload/init`** — validates booking + outlet + filename,
  decides Wasabi-or-Drive-or-both based on `Outlet.storagePolicy` and
  optional operator `includeWasabi`, ensures the Drive folder path
  exists, reserves a Drive file slot + resumable session, creates the
  Wasabi multipart upload + N presigned part URLs, and returns
  everything the browser needs:

  ```json
  {
    "uploadId": "cl…",
    "bookingCode": "AGN-260423-EVT-01",
    "outletFolder": "Advertorial",
    "targets": {
      "drive":  { "fileId": "…", "sessionUrl": "…" },
      "wasabi": {
        "uploadId": "…", "bucket": "video2026hires",
        "key": "VIDEO2026/Advertorial/AGN-…/Cam1/001.mp4",
        "parts": [{ "partNumber": 1, "url": "…" }, …],
        "chunkSize": 5242880
      }
    }
  }
  ```

- **`POST /api/upload/complete`** — browser sends back Drive file
  confirmation + Wasabi part ETags. We call `CompleteMultipartUpload`,
  verify both objects via HEAD, flip `Upload.status` to `COMPLETE`
  (or `DRIVE_OK` / `WASABI_OK` / `FAILED` for partial), and write the
  footage sheet row + flip `FootageLog.sheetRowWritten=true`.

- **`POST /api/upload/[id]/cancel`** — best-effort abort. Calls
  `AbortMultipartUpload` (Wasabi) + `files.delete` (Drive) + clears the
  `FootageLog` row. Idempotent — re-calling on COMPLETE/FAILED is a 200
  with `idempotent: true`.

#### Footage scanner (`src/lib/footage-sync.ts`) — race fix

The v1.34.2 scanner walks Drive and writes sheet rows. With browser
uploads also writing sheet rows via `/api/upload/complete`, they'd
race and produce duplicates. The scanner now skips files where any
`Upload` row has the matching `driveFileId` — the app handles its own
uploads end-to-end, the scanner only handles files that arrived
outside the app (NAS transfer, direct Drive upload).

#### Security note

Wasabi access + secret keys go directly into Portainer stack env. Per
deployment runbook: never paste them in chat, never commit them to
git, never put them in `.env.portainer.example`. The example file only
lists the variable names.

#### Out of scope (next versions)

- Upload UI on `/admin/[id]` — v1.35.2 (browser progress, chunk PUTs,
  parallel uploads, cancel button)
- Reconciler worker (ORPHANED cleanup) — v1.35.4
- SHA-256 integrity verify both clouds — v1.35.4
- Remove legacy `/upload` page — v1.35.5

---

## [1.35.0] — 2026-05-27

### Added — Schema foundation for dual-cloud (Drive + Wasabi) booking uploads

Opens the v1.35 line: replace the old local-disk `/upload` flow with
browser-direct uploads from `/admin/[id]` that fan out to both Google
Drive (working copy) and Wasabi S3 (archive). This release is
schema-only — no upload UI, no Wasabi SDK code yet. v1.35.1+ ship the
library + presign endpoints + UI.

Pure additive. Rollback is safe: nullable columns + enum extensions
only. Bump `IMAGE_TAG` back to `sha-b80e07e` (v1.34.5) and previous
behavior returns. The new columns sit unused — no data corruption.

#### Schema

```prisma
enum StoragePolicy {
  DRIVE_ONLY   // Drive only — operator may opt-in to Wasabi per file
  DUAL_WRITE   // Both clouds required, upload fails unless both succeed
}

model Outlet {
  …existing
  storagePolicy StoragePolicy @default(DRIVE_ONLY)
}

enum UploadStatus {
  PENDING, UPLOADING,
  DRIVE_OK,   // v1.35 — Drive done, Wasabi pending
  WASABI_OK,  // v1.35 — Wasabi done, Drive pending
  COMPLETE, FAILED,
  ORPHANED    // v1.35 — partial >24h, reconciler must inspect
}

model Upload {
  …existing
  sha256        String?
  driveFileId   String?  @unique
  driveUrl      String?
  wasabiBucket  String?
  wasabiKey     String?  // <bookingCode>/<camera>/<filename>
  wasabiEtag    String?
  initiatedAt   DateTime @default(now())
  completedAt   DateTime?
  failureReason String?

  @@index([status])
}
```

#### Migration (`start.sh`)

Two new blocks, both idempotent:

1. **Pre-push** — `ALTER TYPE "UploadStatus" ADD VALUE` for `DRIVE_OK`,
   `WASABI_OK`, `ORPHANED`. Guarded so re-runs are no-ops.
2. **Post-push** — flip `Outlet.storagePolicy = 'DUAL_WRITE'` for the
   three outlets that require both clouds:

   ```
   AGN  Content Agency      DUAL_WRITE
   TSS  THE STANDARD Studio DUAL_WRITE
   NWS  News                DUAL_WRITE
   ```

   Other outlets stay on the schema default `DRIVE_ONLY`. The `UPDATE`
   only flips rows still on the default — once an admin changes a
   policy via the future UI, this seed leaves their choice alone.

#### New env vars (`.env.portainer.example`)

| Var | Notes |
|---|---|
| `WASABI_ENDPOINT` | e.g. `https://s3.ap-southeast-1.wasabisys.com` |
| `WASABI_REGION` | e.g. `ap-southeast-1` |
| `WASABI_BUCKET` | bucket name (must be created in Wasabi console first) |
| `WASABI_ACCESS_KEY` | IAM access key with `s3:PutObject` + `s3:AbortMultipartUpload` + `s3:ListBucket` scoped to the bucket |
| `WASABI_SECRET_KEY` | matching secret |
| `WASABI_VERIFY_ON_COMPLETE` | default `1`; turns on server-side HEAD check after browser upload |

All unset by default — the upload flow that will read these doesn't
exist yet in v1.35.0, so a missing config doesn't break anything.

#### Out of scope (next versions)

- `src/lib/wasabi.ts` (S3 client + presign helpers) — v1.35.1
- `/api/upload/init` + `/complete` endpoints — v1.35.1
- Browser-direct upload UI on `/admin/[id]` — v1.35.2
- Multipart + progress + retry — v1.35.3
- SHA-256 integrity check + reconciler worker — v1.35.4
- Removal of legacy `/upload` page — v1.35.5

---

## [1.34.5] — 2026-05-27

### Changed — `/ot/admin` defaults to "qualifying-OT-only" view

The approver landing now hides any user whose monthly summary has
`totalDays === 0` — i.e. nobody whose recorded time hit the OT
threshold (weekday > 9h, or any weekend / declared holiday). Cuts
visual noise so the manager sees only people they actually need to
act on.

#### UI

- New checkbox **"เฉพาะที่ต้อง approve (เข้าเกณฑ์ OT)"** in the month
  picker row, **default ON**. Toggle off to reveal the full roster
  (useful when an admin is hunting for a user who hasn't hit threshold
  yet, or doing general profile maintenance).
- Roster header reflects the filtered count: `Roster (N คน ที่เข้า
  เกณฑ์ OT · ซ่อน M)` instead of the raw total.
- Empty-state row inside the table when the filter hides everyone:
  *"ไม่มีคนเข้าเกณฑ์ OT ในเดือนนี้ — เอาเครื่องหมายถูก…ออกเพื่อดู
  roster ทั้งหมด"*.

#### What stays unchanged on purpose

- **Inbox banner** at the top still reads the **full** `summary` —
  `อนุมัติทุกคนในเดือนนี้` still acts on every SUBMITTED record in the
  month even if their owner is currently filtered out of the table.
  The button's contract is "approve everything pending", not
  "approve everything visible".
- **Sticky bulk-select footer** acts on whatever's selected. If a
  user was checked while filter was off and the filter then hid them,
  the approve still applies — selections persist across toggle.
- **Totals strip** (4 cards: count / Hol days / WD>9h / THB) is
  unaffected — rows that get hidden by the filter contribute 0 to
  every total anyway (they have no qualifying days), so the numbers
  stay numerically identical.

No schema, API, or env change. Pure client-side filter.

---

## [1.34.4] — 2026-05-27

### Hardened — Defensive footage matching (accidents + out-of-rule inputs)

Closes the v1.34 hardening pass. No behavior change for the well-formed
inputs from v1.34.3 — every change here protects against accident /
typo / scale edge cases that would have silently produced wrong rows
or missed files.

Rollback is safe: no schema change. Bump `IMAGE_TAG` back to
`sha-1d21d9f` (v1.34.3) in Portainer and the previous behavior returns.

#### 1. Regex word-boundary protection (`src/lib/episode-id.ts`)

```diff
- EPISODE_ID_RE_LOOSE = /([A-Z]{2,4}-\d{6}-[A-Z0-9]{1,4}-\d{2})/
+ EPISODE_ID_RE_LOOSE = /(?<![A-Za-z0-9])([A-Z]{2,4}-\d{6}-[A-Z0-9]{1,4}-\d{2})(?!\d)/
```

Stops two classes of false matches:

- `XAGN-260423-EVT-01` no longer extracts `AGN-260423-EVT-01` (a letter
  butting against the ID is now treated as "not a match").
- `AGN-260423-EVT-100` no longer extracts `AGN-260423-EVT-10` (the
  trailing 3rd digit invalidates the match — format is 2-digit seq).

Acceptable boundaries (still match): space, `_`, `-`, `(`, `[`, `/`,
Thai chars, start/end of string. So real folders like
`[Final] AGN-260423-EVT-01 master` or
`งานวันแม่_AGN-260423-EVT-01_เสร็จแล้ว` continue to work.

#### 2. Dash + whitespace normalization (`src/lib/production-id.ts`)

```ts
normalizeForMatch(text)
  = text.replace(/[–—‑]/g, '-').trim()
```

Folders accidentally named with macOS-autocorrected en/em dashes
(`AGN–260423–EVT–01`) or non-breaking hyphens now match. Trim absorbs
trailing whitespace that copy-paste sometimes introduces.

#### 3. Look-alike (lowercase / near-miss) warning (`src/lib/production-id.ts`)

New helper `looksLikeProductionId(text)` detects strings that would
have matched if the case had been uppercase — `agn-260423-evt-01`,
`Agn-260423-Evt-01`. The sync worker collects these per tick and emits

```
[footage-sync] folder "agn-260423-evt-01" looks like a Production ID —
strict format requires "AGN-260423-EVT-01". Check for case/separator typo.
```

once per unique folder to the container log. Strict parsing still
returns null for these (they don't match the booking DB which stores
uppercase), so they land in `unparsed` — but the operator now has a
breadcrumb to fix the folder name.

#### 4. Skip Drive shortcuts + Google-native non-media files (`src/lib/google-drive.ts`)

`listFilesRecursive` now filters out:

```
application/vnd.google-apps.shortcut       — would double-count targets
application/vnd.google-apps.document       — notes, not footage
application/vnd.google-apps.spreadsheet
application/vnd.google-apps.presentation
application/vnd.google-apps.form
application/vnd.google-apps.drawing
application/vnd.google-apps.site
application/vnd.google-apps.script
application/vnd.google-apps.fusiontable
application/vnd.google-apps.jam
```

A user dropping a Google Doc with shot notes into the production
folder no longer creates a `FootageLog` row + sheet append for the
non-media file.

#### 5. Batched booking lookup — N+1 → 1 query (`src/lib/booking-lookup.ts`)

```ts
findBookingsByProductionIds(codes: string[])
  → Map<bookingCode, Booking>
```

Replaces N sequential `findUnique` calls with one `findMany({ where:
{ bookingCode: { in: codes } } })`. Matters when the first sync after
`FOOTAGE_WORKER_ENABLED=1` flips discovers thousands of pre-existing
files — DB stays responsive instead of going head-down for ~5s on
1000 sequential lookups.

#### 6. Sheet append chunking — max 1000 rows per request (`src/lib/footage-sheet.ts`)

```ts
const APPEND_CHUNK_SIZE = 1000
for (let i = 0; i < rows.length; i += APPEND_CHUNK_SIZE) {
  const chunk = rows.slice(i, i + APPEND_CHUNK_SIZE).map(rowToCells)
  await sheets.spreadsheets.values.append(...)
}
```

Prevents the Sheets API request-size limit from breaking the FIRST
sync after enablement (when the worker might find 5000+ matched
files at once). Each chunk is its own request; earlier chunks commit
even if a later one fails (worker retries unwritten via the
`FootageLog.sheetRowWritten=false` flag on the next tick).

#### Known limitations (deferred — flag in CHANGELOG, not fixed)

- **File moved between folders post-match**: if a file is logged with
  Production ID A, then someone moves it into a folder with Production
  ID B, the sheet row stays at A. The `FootageLog` upsert updates the
  ledger's `productionId` to B but `sheetRowWritten=true` blocks the
  re-append. Fix would be a "force-resync" admin endpoint — not built.
- **Multiple Production IDs in one path** (e.g.
  `AGN-…-01/something/TSS-…-02/file`): closest-wins picks `TSS-…-02`,
  but the inner-most match might not be the operator's intent. The
  warning loop in (3) does NOT flag this case because both folders
  parse strictly — only typos/case-misses get logged.

---

## [1.34.3] — 2026-05-27

### Fixed — Footage matcher reads Production ID from FOLDER name, not filename

v1.34.1/v1.34.2 parsed the Production ID from the filename itself —
that's the wrong convention. `src/lib/episode-id.ts` line 6 already
states the rule: **"Folder-only policy (ID on folder name, not
individual files)"**. The team's real Drive layout matches that:

```
DRIVE_FOOTAGE_ROOT/
└── AGN-260423-EVT-01/        ← Production ID here
    ├── Cam1_001.mp4
    ├── Cam1_002.mp4
    └── Sound/
        └── audio.wav
```

Filename-based parsing would miss the `AGN-260423-EVT-01` here because
the actual file is named `Cam1_001.mp4` with no ID embedded.

#### Changes

- **`src/lib/google-drive.ts`** — `listFilesRecursive` now tracks
  ancestor folder names as it walks. Each returned `DriveFile` carries a
  `folderPath: string[]` (root → leaf, root itself excluded). The walk
  queue now propagates `{ folderId, path }` instead of just an ID so
  every file knows the full chain of folders it lives under.
- **`src/lib/production-id.ts`** — new helper
  `findProductionIdInPath(folderPath)` that walks the array
  **leaf → root** and returns the closest match. Handles real-world
  nesting like `2026-04/AGN-260423-EVT-01/Cam1/001.mp4` — the file's
  immediate parent ("Cam1") doesn't match, the next level
  ("AGN-260423-EVT-01") does → that's what we return.
- **`src/lib/footage-sync.ts`** — replaces `parseProductionId(file.name)`
  with `findProductionIdInPath(file.folderPath)`. Files that live
  directly in the scan root (no production folder above them) now
  correctly land in `parseStatus = 'unparsed'`.
- **Camera derivation also goes folder-first** — `Cam1` in a folder
  name (`AGN-…/Cam1/001.mp4`) wins over a `Cam1_` token in a filename.
  Filename token stays as the fallback for the
  `AGN-260423-EVT-01/Cam1_001.mp4` layout (flat camera in the
  filename).

#### Behavior change for `parseStatus`

Files whose folder structure doesn't contain a Production ID — but
whose **filename** happens to include one — are now `unparsed` instead
of `matched`. This is the correct strict reading of the convention; if
the user wants those rescued, they'd move the file into a properly-
named folder. The `FootageLog` row carries the filename + folder path
context so triage is straightforward:

```sql
SELECT filename, "parseStatus" FROM footage_log
 WHERE "parseStatus" = 'unparsed'
 ORDER BY "createdAt" DESC;
```

No schema change. No env-var change. Worker still defaults off
(`FOOTAGE_WORKER_ENABLED=0`) — flip when ready per v1.34.2 rollout.

---

## [1.34.2] — 2026-05-25

### Added — Footage sheet sync worker (supervised, off by default)

Closes the v1.34 footage line: a supervised worker now scans the
configured Shared Drive root every 10 min, parses each new filename for
a Production ID, looks up the matching Booking, and appends a row to
the user's footage-log sheet (`FOOTAGE_LOG_SHEET_ID`) using the
adaptive writer from v1.34.1.

#### New files

| Path | Purpose |
|---|---|
| `src/lib/footage-sync.ts` | `runFootageSync({ dryRun? })` — pure-logic core. Drive walk → classify (`matched` / `parsed_no_booking` / `unparsed`) → upsert `FootageLog` ledger → batch-append matched rows to sheet → patch `sheetRowWritten=true`. Crash-safe: log row is written BEFORE the sheet append so a half-completed run retries on the next tick without double-rows. |
| `src/app/api/internal/footage/sync/route.ts` | GET endpoint poked by the worker. Auth mirrors `/api/internal/calendar/reconcile`: shared secret header (`x-footage-sync-secret`) or admin session. `?dryRun=1` for safe inspection. |
| `scripts/footage-sheet-sync-worker.js` | Polling loop. Reads `FOOTAGE_WORKER_ENABLED` (default off — stays dormant when unset/`0`/`false`). When on, hits the internal endpoint every `FOOTAGE_WORKER_INTERVAL_MS`. SIGTERM/SIGINT handlers. |

#### `start.sh` change

Adds a supervised loop alongside the existing calendar-reconcile
supervisor (around line 245-251). Both workers share the same restart
pattern: 5s back-off, foreground `exec npm start` reaps them when the
container stops.

```sh
echo "==> Starting footage sheet sync worker (supervised)..."
(
  while true; do
    node scripts/footage-sheet-sync-worker.js
    echo "[footage-sync] supervisor: worker exited, restarting in 5s"
    sleep 5
  done
) &
```

#### Behavior contract

The worker is **off by default** — `FOOTAGE_WORKER_ENABLED` is unset
or `0`. In that state the script logs once and sleeps 30s before
exiting, the supervisor loops, and nothing else happens. The route
itself still works (admins can hit `?dryRun=1` to inspect classification
output without flipping the env var on).

When on, the worker:

1. `listFilesRecursive(DRIVE_FOOTAGE_ROOT)` — walks the Shared Drive
2. Loads existing `FootageLog` rows for those `driveFileId`s in one query
3. Skips files where `sheetRowWritten=true` (true dedupe)
4. Classifies the rest, upserts `FootageLog` with the new state
5. For `matched` files, batches them into one `appendFootageRows` call
6. Patches `sheetRowWritten=true` on success

Files with status `parsed_no_booking` or `unparsed` are recorded but
never written to the sheet — the sheet is the **matched** footage log,
not the raw Drive inventory. Query
`SELECT * FROM footage_log WHERE "parseStatus" != 'matched'` to triage
filename-format misses.

Camera column is best-effort derived from the filename via a
conventional `_<token>_` segment match (Cam1, Sound, Drone, BTS, Atem,
Switcher, Multi, Master, Proxy). Falls back to blank if no recognized
token — no guessing.

#### Rollout

1. Deploy v1.34.2 — schema unchanged from v1.34.1; only new files +
   `start.sh` change. Worker stays dormant.
2. User runs `npx tsx scripts/inspect-footage-sheet.ts` against prod
   env. Confirm canonical-key map covers all of the user's columns.
3. User sets in Portainer stack env:
   - `FOOTAGE_LOG_SHEET_ID=1KMmbPjbRnd6Deb-ct253YMmoINuLgTDnS4Id2lPA5VI`
   - `FOOTAGE_LOG_TAB=<the tab name from inspect step>`
   - `DRIVE_FOOTAGE_ROOT=<Shared Drive folder id>`
   - `FOOTAGE_WORKER_ENABLED=1`
4. Pull and redeploy. Container logs should show
   `[footage-sync] worker started; interval=600000ms; baseUrl=http://127.0.0.1:3000; secret=set`.
5. Drop a test file `AGN-260423-EVT-01_Cam1_test.mp4` into the Shared
   Drive folder. Within ~10 min the worker logs
   `[footage-sync] scanned=N matched=1 …` and a row appears in the sheet.

#### Out of scope (deferred)

- Modified-time incremental scanning — `listFilesRecursive` accepts a
  `modifiedAfter` option (v1.34.1) but the worker currently does a full
  walk every tick. Fine for thousands of files; revisit if we hit
  Drive rate limits.
- /upload page Drive push — the worker covers files that arrive via
  NAS-to-Drive transfer or direct Drive upload. The current `/upload`
  flow (local disk + Upload model) stays untouched.
- UI surface showing FootageLog rows — managers query the sheet
  directly. A future admin page could expose `parse_status != matched`
  for filename-format triage.

---

## [1.34.1] — 2026-05-25

### Added — Footage matcher library scaffold (no behavior change yet)

Lays the groundwork for the Drive footage → sheet auto-matcher that
ships fully in v1.34.2. This release adds the library code, the
`FootageLog` ledger table, and a diagnostic script — nothing scans or
writes to the user's sheet until `FOOTAGE_WORKER_ENABLED=1` flips in
Portainer env (default `0` so this release is a pure no-op).

#### New files

| Path | Purpose |
|---|---|
| `src/lib/production-id.ts` | `parseProductionId(filename)` — pulls a Production ID out of a filename. Tolerates path prefixes, camera suffixes, extensions. Returns `null` on no match. |
| `src/lib/booking-lookup.ts` | `findBookingByProductionId(code)` — single Prisma `findUnique` against the existing `bookingCode @unique` index. Returns booking + outlet + program + producer + assigned crew (sheet writer enrichment). |
| `src/lib/google-drive.ts` | `getDriveReadAuth()` + `listFilesRecursive(rootFolderId, opts?)`. DWD-impersonated (reuses `getCalendarImpersonateSubject()` — single source of truth for the impersonated user). Scope: `drive.readonly`. `supportsAllDrives + includeItemsFromAllDrives` so Shared Drives work. Soft cap at 5,000 files per run to protect worker memory. |
| `src/lib/footage-sheet.ts` | `probeSheet()` + `appendFootageRows(rows)`. Adaptive writer — reads row 1, normalizes each header (lowercase, strip non-alnum), maps to canonical keys via an alias table (`'productionid'`, `'bookingid'`, `'bookingcode'`, etc. all collapse to the same logical column). Sparse-row strategy means user-owned extra columns stay untouched and missing canonical columns silently skip. Module-level cache with 5-min TTL keeps API pressure low. |
| `scripts/inspect-footage-sheet.ts` | Run-once diagnostic. Prints sheet id (masked), tab name, raw headers, canonical-key map, unrecognized headers. Run via `npx tsx scripts/inspect-footage-sheet.ts` **before** flipping the worker on. |

#### Schema

```prisma
model FootageLog {
  id              String   @id @default(cuid())
  driveFileId     String   @unique
  productionId    String?
  bookingId       String?
  filename        String
  driveUrl        String?
  parseStatus     String   @db.VarChar(32) // 'matched' | 'parsed_no_booking' | 'unparsed'
  sheetRowWritten Boolean  @default(false)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([productionId])
  @@index([parseStatus])
  @@map("footage_log")
}
```

Applied via `prisma db push --accept-data-loss` per project convention.
Pure additive — no existing data touched.

The worker (v1.34.2) uses this as a dedupe ledger: before appending a
row to the footage sheet, it checks `findUnique({where: {driveFileId}})`.
Files that didn't parse or didn't match are still recorded (with
`parseStatus = 'unparsed'` / `'parsed_no_booking'`) so we can triage
filename-format misses without re-walking Drive.

#### Reused utilities

- `EPISODE_ID_RE` + `EPISODE_ID_RE_LOOSE` exported from `src/lib/episode-id.ts` — the anchored regex powers `parseEpisodeId`; the loose regex powers the new `parseProductionId`. Single source of truth, no drift.
- `getSheetsWriteAuth()` from `src/lib/google-sheets.ts` — same SA auth model used by the existing Producer Dashboard write path.
- `getCalendarImpersonateSubject()` from `src/lib/google-calendar.ts` — Drive read auth impersonates the same Workspace user that already powers Calendar attendee invites.
- `maskSheetId()` from `src/lib/google-config.ts` — used by the inspect script's output.

#### New env vars (`.env.portainer.example`)

| Var | Default | Notes |
|---|---|---|
| `FOOTAGE_LOG_SHEET_ID` | (unset) | The user's footage-log sheet id. Worker is a no-op when unset. |
| `FOOTAGE_LOG_TAB` | `Sheet1` | Tab name inside the sheet. |
| `DRIVE_FOOTAGE_ROOT` | (unset) | Shared Drive folder id the worker scans. |
| `FOOTAGE_WORKER_ENABLED` | `0` | Master switch. Stays `0` for v1.34.1 ship. |
| `FOOTAGE_WORKER_INTERVAL_MS` | `600000` | 10 min, matches the calendar reconcile worker. |

#### Rollout sequence (next step is v1.34.2)

1. **Now (v1.34.1):** Schema migrates, library code deploys, worker stays dormant.
2. **User runs** `npx tsx scripts/inspect-footage-sheet.ts` against the prod env to confirm column mapping.
3. **User sets** `DRIVE_FOOTAGE_ROOT` + `FOOTAGE_LOG_TAB` in the Portainer stack env.
4. **v1.34.2** ships the worker + `start.sh` supervisor entry. Flip `FOOTAGE_WORKER_ENABLED=1` and redeploy.

---

## [1.34.0] — 2026-05-25

### Changed — Renamed "Booking ID" → "Production ID" in all user-facing surfaces

Aligns the app's terminology with the team's spoken convention: the
human-readable code (`AGN-260423-EVT-01` etc.) is the **Production
ID**. The internal Prisma column `Booking.bookingCode` is intentionally
**not** renamed — 71 references, no functional gain, high migration
risk. This release is label-only and ships in one shot because nothing
runtime-coupled changes.

#### Label updates

| Surface | Before | After |
|---|---|---|
| Producer Dashboard sheet, row 1 col A | `Booking ID` | `Production ID` |
| `/admin/[id]` booking detail header chip | `Booking ID` | `Production ID` |
| `/dashboard` team workload CSV | `Booking IDs` | `Production IDs` |
| `/dashboard` bookings CSV | `Booking ID` | `Production ID` |
| `/api/bookings/export` CSV | `Production / Booking ID` | `Production ID` |
| Google Calendar event description | `Booking ID: ${booking.id}` | `Production ID: ${booking.bookingCode \|\| booking.id}` |

The Calendar description change is a **2-part fix**:

1. Label rename (consistent with the rest of v1.34.0).
2. Value flip from the internal CUID (`clxxxxxxxxx…`) to the
   human-readable code. The previous body printed
   `"Booking ID: clxxxxxxx…"` which was confusing — the label
   suggested the readable code but the value was the database row id.
   Pre-`bookingCode` bookings fall back to the CUID to keep history
   safe.

#### How the live Producer Dashboard sheet updates without a manual migration

`ensureSheetTab` in `src/lib/google-sheets.ts` rewrites the entire row
1 of the Bookings tab on **every** container boot (see line 121-139).
So the moment v1.34.0 boots, the live sheet's first cell flips from
"Booking ID" to "Production ID" — no batch UPDATE call needed, no
data orphaning (column position unchanged, only the cell text). Any
downstream Airtable sync that keys off the column header will see the
new name on the next sync after deploy.

#### Out of scope (explicitly)

- `Booking.bookingCode` Prisma field rename — kept as-is per user
  decision. 71 references including audit, calendar reconcile, csv,
  google-sheets writers and admin/producer routes.
- `bookingId` API/form param names — internal contract, no user
  visibility.
- Email subjects, notification copy — grep confirms none currently
  emit "Booking ID" string.

---

## [1.33.6] — 2026-05-25

### Changed — Backfill legacy bookings: crewRequired MUA → Virtual Production

Follow-on to v1.33.5, which only swapped the wizard option list. This
release adds a one-shot data backfill in `start.sh` that rewrites
`bookings.crewRequired` arrays containing `"MUA"` to `"Virtual
Production"`, so existing booking detail views display the new label
instead of mixing both terms.

```sql
UPDATE bookings
   SET "crewRequired" = array_replace("crewRequired", 'MUA', 'Virtual Production')
 WHERE 'MUA' = ANY("crewRequired");
```

Idempotent: `array_replace` is a no-op when MUA isn't present, and the
WHERE clause limits scanning to rows that still contain MUA. Re-runs on
every container start are safe and free after the first pass.

No schema change — `crewRequired` was already a free-form `String[]`.

---

## [1.33.5] — 2026-05-25

### Changed — Booking wizard "Crew Required": MUA → Virtual Production

`CREW_OPTIONS` in `src/lib/data.ts` replaces `'MUA'` with
`'Virtual Production'` so the New Booking wizard's "Crew Required"
checkbox group reflects the actual crew categories used by THE
STANDARD's production team.

```
Before: ['Videographer', 'Sound', 'DIT', 'Lighting', 'MUA', 'Art Director']
After:  ['Videographer', 'Sound', 'DIT', 'Lighting', 'Virtual Production', 'Art Director']
```

`Booking.crewRequired` is a free-form `String[]` — no schema change.
Existing bookings whose `crewRequired` array still contains
`"MUA"` are unaffected by this change (the string is preserved as-is
on the booking detail view). The booking wizard simply no longer
offers MUA as a tickable option for new bookings.

No backfill applied — historical bookings with MUA stay as MUA so
audit + reporting against past data remains accurate.

---

## [1.33.4] — 2026-05-25

### Added — OT Approver role (Manager scope, no schema change)

Introduces a position-based **OT Approver** gate so a designated Manager
can approve/reject OT and see the cover-sheet overview without being
granted the full ADMIN role (which also grants `/admin` booking console,
user roster CRUD, GHA + sheet config, dashboard, upload — all of which
the Manager doesn't need).

#### `getOTApproverAccess(email)` + `requireOTApprover()` — new in `src/lib/session.ts`

Returns true when the user is:

1. `role === 'ADMIN'`, **or**
2. their `User.position` field (case-insensitive) contains `"manager"`

Mirrors the existing `getProducerAccess` pattern so the gate is set by
filling in the person's profile, not by toggling a separate flag. The
gate also rejects `active === false` users.

Today this picks up:

- `narasit.k@thestandard.co` — `role=ADMIN` (set by `INITIAL_ADMINS` in
  `src/lib/auth.ts` + seed). Full access, unchanged.
- `chonlathorn.j@thestandard.co` — `position='Video Production Manager'`
  (already in `TEAM_PROFILES` and re-asserted on every seed run). Gains
  OT approver access; no other role changes.

Anyone else whose position is later set to include "manager" (e.g. "OT
Manager", "Production Manager") automatically picks up the same gate
without a code change.

#### Routes flipped from `requireAdmin()` → `requireOTApprover()`

- `GET  /api/ot/summary`         — admin cover sheet data
- `POST /api/ot/admin/approve`   — bulk approve (all 3 modes)
- `POST /api/ot/admin/reject`    — reject with note
- `GET  /api/ot/export`          — CSV export
- `GET  /api/ot/export/pdf`      — PDF cover sheet (bulk mode)
  - single-person mode (`&email=...`) now also accepts the owner OR any
    OT approver

`GET /api/ot` was updated so `?email=` and `?all=1` queries also work
for managers, not just admins — required for the manager's review page
to load other users' records.

#### UI surfaces

- `Nav` → adds "OT · Approve" link in the More dropdown for anyone who
  passes `canApproveOT`. ADMIN-only `/admin` link is unchanged.
- `/ot` (user page) → the right-hand admin shortcut is now visible to
  any approver, labelled "→ Approve / Cover Sheet" for managers and
  "→ Admin / Cover Sheet" for admins.
- `/ot/admin` (cover sheet) → still loads identically, but for non-
  ADMIN approvers the **Add user**, **Edit user**, **Toggle role**,
  and **Toggle active** controls are hidden. A small "Manager view —
  read-only roster" tag in the Roster header explains why. Approve /
  reject / review / PDF / CSV all work as before.
- `/ot/admin/review/[email]?month=…` → no UI change; the page was
  already gated by the underlying API, which now accepts approvers.
- `/api/me` now ships `canApproveOT: boolean` so client pages can
  conditionally render approver-only UI without a second round-trip.

#### What's intentionally *not* extended to the Manager role

- `/admin` (booking admin console) — still ADMIN-only.
- `/dashboard` — still ADMIN-only.
- `/api/admin/users` (user roster CRUD) — still ADMIN-only on the
  server. Frontend now hides the buttons that hit it, so a Manager
  doesn't get a 403 in the face.
- `/upload` — still ADMIN-only.

#### Deploy + rollout notes

- Pure additive change. No schema migration. `start.sh` already seeds
  `chonlathorn.j`'s `position='Video Production Manager'` from
  `TEAM_PROFILES` on every restart via `prisma/seed.ts upsert`, so the
  gate flips on at first deploy of v1.33.4 without manual DB work.
- Rollback to v1.33.3 simply re-narrows the gate to ADMIN-only — no
  data fix needed.

---

## [1.33.3] — 2026-05-25

### Added — OT signature workflow (Phase 4: PDF export with embedded signatures)

Closes the v1.33 line. The OT cover sheet now renders as a real signed
artifact suitable for HR/finance hand-off — one A4 page per person,
table of OT entries, totals, and both signatures (requester + manager)
embedded as actual PNG images at the bottom of the page.

#### `GET /api/ot/export/pdf?month=YYYY-MM[&email=...]` (new)

- `month=YYYY-MM` (admin-only) → multi-page PDF, one page per user
  who has records in the month.
- `month=YYYY-MM&email=...` → single-person, single-page PDF;
  accessible to the owner of `email` or any admin.

Each page contains:

- Header row with company label + month
- Person info block (ชื่อ-นามสกุล / รหัสพนักงาน / ตำแหน่ง / email)
- Table: date / day-type / time-range / job task / status / THB,
  with a small "เหตุผล: …" line under each row when present.
- Totals strip (วันหยุด/Hol days · วันธรรมดา days · รวม THB).
- Two signature boxes at the bottom:
  - **ผู้ขอ (Requester)** — embeds the most recent
    `requesterSignaturePng` snapshot from the user's records, with
    their printed name and submission date.
  - **ผู้อนุมัติ (Manager)** — embeds the most recent
    `approverSignaturePng` snapshot, with the approver's email and
    approve date. Falls back to "(รออนุมัติ)" when not yet signed.

Signatures are taken from the per-row snapshots stamped in Phases 2–3
so the PDF is internally consistent with the database state — a user
or manager updating their saved signature later does not change PDFs
that were exported under the old signature.

#### Thai rendering — embedded Sarabun font (OFL)

`pdf-lib`'s built-in fonts have no Thai glyphs, so the API embeds
Sarabun Regular + Bold (SIL Open Font License, by Cadson Demak) with
glyph subsetting enabled. Per-PDF font payload is ~5–10KB; total
typical export size is 15–25KB for a single-person sheet.

- `public/fonts/Sarabun-Regular.ttf` (~88KB)
- `public/fonts/Sarabun-Bold.ttf` (~88KB)
- `public/fonts/SARABUN-OFL.txt` — license attribution

New runtime deps: `pdf-lib ^1.17.1`, `@pdf-lib/fontkit ^1.1.1`.

#### UI surfaces

- `/ot/admin` — primary "Cover Sheet PDF (พร้อมลายเซ็น)" button next
  to the existing CSV exports.
- `/ot/admin/review/[email]?month=…` — header "PDF" button generates
  the single-person sheet for the currently-viewed person + month.
- `/ot` — when the user has any records for the visible month, a
  small "PDF" button in their profile strip downloads their own
  signed cover sheet without involving an admin.

#### Verification

`scripts/test-ot-pdf.ts` is a one-shot smoke test that generates a
PDF for a synthetic person (mix of APPROVED/SUBMITTED/REJECTED rows,
both signature snapshots present) — useful for manual inspection
when iterating on the PDF layout. Run via
`npx tsx scripts/test-ot-pdf.ts`.

This commit closes the v1.33 signature workflow line. The full
feature branch `feat/ot-signature` is now ready to merge to `main`.

---

## [1.33.2] — 2026-05-25

### Added — OT signature workflow (Phase 3: manager bulk approve + review page)

Gives the manager the tools to actually work through the SUBMITTED queue
v1.33.1 fills up: bulk-approve multiple people at once, drill into a
single person's report for per-row decisions, and push individual rows
back to the user with a reason.

#### `/api/ot/admin/approve` — extended to three modes

The existing `{email, month}` shape is preserved; two new shapes are
added so the same endpoint serves all approve flows:

- `{ recordIds: string[] }` — approve a hand-picked set of rows. Used
  by the bulk-select footer on `/ot/admin` and per-row approve on the
  review page.
- `{ month, allSubmitted: true }` — month-wide "approve every
  SUBMITTED row across all users". Powers the one-click Inbox banner
  on `/ot/admin`.
- `{ email, month }` — legacy mode for one user × one month.

Modes are mutually exclusive — `recordIds` takes precedence, then
`allSubmitted`, then the legacy `{email, month}`. All three only flip
rows currently in SUBMITTED (idempotent re-clicks; DRAFT/REJECTED rows
never silently jump past the user). The approver's saved signature is
snapshotted onto every approved row in every mode.

#### `/api/ot/admin/reject` (new)

`POST { recordId, note }` — flips one SUBMITTED row to REJECTED with
the manager's note attached. Non-SUBMITTED rows are no-ops (returns
`rejected: 0`), so managers don't accidentally re-reject rows the user
has already updated. `note` is required, non-empty, ≤500 chars —
silent rejects don't give the user enough to act on.

#### `/ot/admin` — Inbox + bulk select + sticky footer

- **Inbox banner** at the top: `N รายการรออนุมัติจาก M คน` with a
  primary one-click "อนุมัติทุกคนในเดือนนี้" button. When the queue is
  empty, shows a green "ไม่มีคำขอ OT รออนุมัติ" confirmation instead.
- **Per-row checkbox** (only enabled when the row has SUBMITTED
  records); header checkbox toggles all selectable rows.
- **Per-row "Review N" link** replaces the old direct "Approve N"
  action — manager goes through the review page rather than blind-
  approving. The old direct approve is still reachable from the
  review page's "อนุมัติทั้งหมด + เซ็น" footer button.
- **Rejected count badge** on rows where the manager has pushed
  records back; clarifies why the SUBMITTED count is lower than the
  total in-flight count.
- **Sticky bottom bar** appears whenever any checkbox is selected,
  with "อนุมัติที่เลือก (N)" — fires `{email, month}` approves in
  parallel across selected users (idempotent endpoint, partial
  failures leave clean state).
- Clicking a person's name links to the review page.

#### `/ot/admin/review/[email]?month=YYYY-MM` (new)

Per-person, per-month review surface for managers who want to act at
row granularity rather than bulk-approve the whole report.

- Per-row Approve / Reject buttons (only on SUBMITTED rows).
- Reject opens a modal asking for a note (≤500 chars); user sees this
  back on `/ot` and resubmits via Phase 2's flow.
- Approved rows show a lock icon + the approver email + timestamp.
- The user's submitted signature is rendered at the top so the
  manager can sanity-check it against past sign-offs.
- Sticky footer mirrors the admin page pattern: "อนุมัติทั้งหมด +
  เซ็น" for one-click approve of every still-SUBMITTED row for this
  person.

#### Backward-compat note

`/api/ot/summary` continues to ship the `pendingRecords` field; the
v1.33.0 admin UI consumers can still read it. The new admin page reads
`submittedRecords` and `rejectedRecords` directly to surface the
correct counts in the new badges.

---

## [1.33.1] — 2026-05-25

### Added — OT signature workflow (Phase 2: user submit flow)

Closes the v1.33.0 "Known gap": new OT records now have a path out of
`DRAFT` and into the manager's approval queue, plus a recovery path for
records the manager pushes back.

#### `/api/ot/submit` (new)

`POST { month: "YYYY-MM" }` — flips every `DRAFT` or `REJECTED` record
owned by the signed-in user in the given month to `SUBMITTED`, stamping
`submittedAt = now()` and snapshotting `User.signaturePng` onto each
record's `requesterSignaturePng`. Previous `rejectionNote`s are cleared
so the manager sees a clean queue on the resubmit. `APPROVED` and
already-`SUBMITTED` rows are untouched (idempotent re-clicks).

The endpoint blocks submission if the user has no saved signature
(returns `400` with `code: 'NO_SIGNATURE'`) — the signature is the
legal sign-off, so submitting without one is rejected at the API level.

#### `/api/ot/[id]` PATCH/DELETE — status-aware gates

- `APPROVED` rows are locked for the owner. Admins can still edit/delete
  (correction path — preserves existing override behavior).
- Owner edits on a `SUBMITTED` row silently revert the row to `DRAFT`
  and clear `submittedAt + requesterSignaturePng`, forcing a re-sign +
  re-submit. The manager is never asked to approve content they haven't
  seen.
- `DRAFT` and `REJECTED` rows are fully editable / deletable by the
  owner.

#### `/ot` page — status visibility + submit modal

- **Status strip** at the top of the records list shows per-month counts
  (`Draft N · Submitted N · Approved N · Rejected N`) plus a primary
  action button that becomes "ส่งให้ approve (N)" when there are draft
  records, or "แก้แล้วส่งใหม่ (N)" when the user has rejected records to
  re-submit. Disabled when there's nothing to send.
- **Rejection banner** (only when rejected records exist) lists each
  rejected row with the manager's note so the user doesn't have to scan
  the day list to find what needs fixing.
- **Per-row badge** on every record card showing its current status,
  plus the submit/approve date when applicable.
- **Submit confirm modal** previews the signature that will be
  snapshotted onto each row. If the user has no signature, the modal
  surfaces a deep link to `/profile/signature` instead of letting the
  user submit without one.
- **APPROVED rows hide the delete button** for the owner and show a
  small lock icon, with a tooltip "ติดต่อ admin หากต้องการแก้".

#### Behavioural change worth flagging

`POST /api/ot` (create record) now creates records in `DRAFT` (via the
schema default change from Phase 1). The v1.32 behavior of "every new
entry immediately enters the manager queue" is gone — users explicitly
opt in by clicking the submit button on `/ot`. This is the intended
two-step "fill, then sign and send" workflow.

---

## [1.33.0] — 2026-05-25

### Added — OT signature workflow (Phase 1: schema + signature profile)

Opens the v1.33 line that replaces the two-state OT approval flow
(`PENDING → APPROVED`) with a four-state workflow that captures both the
requester's and the manager's e-signature on every record. Phase 1 lays
the schema and lets every user set their saved signature; Phases 2–4
follow with the user submit flow, the manager bulk-approve UI, and the
PDF export.

#### Schema (`prisma/schema.prisma`) — additive, with one enum migration

```
model User {
  …existing fields…
  signaturePng        String?   @db.Text   // base64 PNG data URL
  signatureUpdatedAt  DateTime?
}

enum OTApprovalStatus {
  DRAFT      // user is still filling out — not visible to managers
  SUBMITTED  // user signed; awaiting manager sign-off (was: PENDING)
  APPROVED   // manager signed off
  REJECTED   // manager pushed back with rejectionNote; user can resubmit
}

model OTRecord {
  …existing fields…
  approvalStatus         OTApprovalStatus @default(DRAFT)  // was: PENDING
  submittedAt            DateTime?
  requesterSignaturePng  String? @db.Text
  approverSignaturePng   String? @db.Text
  rejectionNote          String?
}
```

**Migration (`start.sh`, runs before `prisma db push`):**

1. `ALTER TYPE "OTApprovalStatus" ADD VALUE` for `DRAFT`, `SUBMITTED`,
   `REJECTED` — idempotent via `IF NOT EXISTS` guards.
2. `UPDATE ot_records SET "approvalStatus" = 'SUBMITTED' WHERE
   "approvalStatus" = 'PENDING'` so the old label has no rows referencing
   it.
3. `prisma db push --accept-data-loss` then reconciles the enum (drops
   the unused `PENDING` label) and adds the new columns as additive
   nullable fields.

No existing approved/pending data is lost: previously-PENDING records
land in the new `SUBMITTED` state (awaiting manager sign-off), and
previously-APPROVED records stay APPROVED. New columns
(`submittedAt`, `requesterSignaturePng`, `approverSignaturePng`,
`rejectionNote`) start NULL and only fill in as users submit/reject
through the new flow.

#### Signature snapshots — historical immutability

`OTRecord.requesterSignaturePng` and `approverSignaturePng` are
**snapshots** taken from `User.signaturePng` at submit/approve time. A
user updating their signature later does not retroactively change any
historical OT report.

#### `/api/me/signature` (new)

- `GET` → `{ signaturePng, signatureUpdatedAt }` — the signed-in user's
  saved signature data URL (or `null`).
- `POST { png }` — saves or replaces the signature. Validates the value
  is `data:image/png;base64,…` with a base64 payload, caps storage at
  200KB raw base64 (~150KB binary). `POST { png: null }` clears it.

#### `/api/me` — extended

Adds `hasSignature: boolean` and `signatureUpdatedAt: string | null` to
the existing response so client code can detect "user hasn't set a
signature yet" without pulling the full image.

#### `/api/ot/summary` — extended status counts

The summary endpoint that powers `/ot/admin` now returns
`draftRecords`, `submittedRecords`, `approvedRecords`, `rejectedRecords`
per person. `pendingRecords` is preserved as a backward-compat alias
that sums `submitted + rejected` ("anything in flight, not yet
approved"), so the v1.32 admin UI keeps working unchanged in Phase 1.

#### `/api/ot/admin/approve` — now snapshots approver signature

The existing `{email, month}` bulk-approve endpoint now reads the
approver's `User.signaturePng` and writes it into every record's
`approverSignaturePng` at approval time. Approvers with no saved
signature can still approve — `approverSignaturePng` will be NULL and
the future PDF export will fall back to a typed name.

The endpoint also now filters on `approvalStatus: 'SUBMITTED'` rather
than the old `'PENDING'`. Phases 2–3 will extend it with two new modes
(`{recordIds: []}` and `{month, allSubmitted: true}`).

#### `/profile/signature` (new page)

Reachable from the `More → ลายเซ็น` nav entry. Mobile-friendly
canvas-based signature pad (mouse + touch) with smoothed strokes, plus a
PNG upload alternative. Save persists to the user's account; "ลบออกจาก
บัญชี" clears it. The `SignaturePad` component
(`src/app/_components/SignaturePad.tsx`) is reusable — Phase 2 will use
it inside the submit modal.

#### Known gap until Phase 2 lands

With the default now `DRAFT`, newly-created OT records do not appear in
the manager's approval queue until the user clicks "ส่งให้ approve"
(Phase 2). The feature branch `feat/ot-signature` bundles all four
phases before merging to `main`, so production is unaffected until the
full flow ships together.

---

## [1.32.2] — 2026-05-24

### Added — `calendarSyncStatus` field + guest-list verification on booking detail + impersonate fallback warning

Bundles the remaining 3 Codex-review fixes (issues #3, #2, #4) into a
single release because the UI changes share the same components.

#### Issue #3 — async calendar sync visibility (schema change, additive)

Approve sets `status='CONFIRMED'` instantly, then fires calendar create
in a background IIFE. Pre-v1.32: if calendar failed, booking showed
CONFIRMED but `calendarEventId` was null and error was only in container
logs. No DB field tracked the failure.

**Schema (`prisma/schema.prisma`) — all nullable adds, no data loss:**

```
enum CalendarSyncStatus { PENDING, OK, FAILED }

model Booking {
  …existing fields…
  calendarSyncStatus    CalendarSyncStatus?
  calendarSyncError     String?
  calendarLastSyncedAt  DateTime?
}
```

Applied via existing `prisma db push --accept-data-loss` in `start.sh`.
New table column writes never touch existing data.

**State writers:**

- `src/app/api/admin/[id]/approve/route.ts` — sets `PENDING` synchronously
  before kicking off the background create; the IIFE writes `OK` on
  success or `FAILED` (with `calendarSyncError`) on caught error. Adds
  a `calendar.approve_failed` audit row on failure.
- `src/lib/calendar-reconcile.ts` `processBooking()` — every successful
  patch / create writes `OK + lastSyncedAt + clears error`; the catch
  writes `FAILED + error`. The "already in sync" path also refreshes
  the OK timestamp.
- `src/lib/calendar-reconcile.ts` reconciler WHERE clause — extended
  to also pick up rows orphaned by a mid-task container restart:
  `(status=CONFIRMED AND assigned non-empty) OR (status=PENDING AND
  lastSyncedAt < now - 5 min)`.
- `src/app/api/admin/[id]/assign/route.ts` — both the patch-existing
  path and the auto-recover create path write `OK`/`FAILED` based on
  outcome.
- `start.sh` — one-time backfill for legacy CONFIRMED bookings:
  `OK` if `calendarEventId IS NOT NULL`, `FAILED` otherwise. Guarded
  by `WHERE calendarSyncStatus IS NULL` so it's idempotent.

**UI:**

- `src/app/admin/page.tsx` `<CalendarStatus>` — primary chip now driven
  by the new status field, not just the existence of `calendarEventId`.
  Three explicit states (PENDING gray spinner / OK no-chip + green link
  / FAILED red + tooltip error). Last-checked timestamp shown as a
  small relative-time hint. Legacy bookings (NULL status) fall through
  to the old "infer from eventId" path.
- `src/app/admin/[id]/page.tsx` — Confirmed card replaced with a new
  `<BookingConfirmedCard>` (see Issue #2 below) that shows the sync
  status badge + last-synced timestamp + error inline + Open in
  Calendar link.

#### Issue #2 — guest-list verification on booking detail

`/admin/[id]` Confirmed card previously showed only "Calendar event
created · ID: …" — never verified the assigned crew were actually on
the event. Easy to silently miss missing guests.

**Endpoint — `GET /api/admin/[id]/calendar-resync?dryRun=1`:**

- Reuses existing `reconcileSingleBooking()` with `dryRun: true`.
  Returns the same `ReconcileItem` shape (assignedEmails,
  calendarAttendees, htmlLink, action) without modifying anything.
- POST behavior unchanged (still writes). GET without `?dryRun` also
  still writes for backwards compat.

**UI — new `<BookingConfirmedCard>` in `/admin/[id]/page.tsx`:**

- On mount (when booking is CONFIRMED), fetches dry-run verification.
- Renders: assigned crew list vs calendar guests list with counts.
- If `missing.length > 0`: red box "⚠ Missing N guests on calendar:
  alice@, bob@" so the admin sees the problem immediately.
- If `extra.length > 0`: amber box flags guests on the event that
  aren't in the assigned list.
- If all in sync: green "✓ All N crew are on the calendar".
- "Re-sync calendar guests" button always available; on success it
  re-runs the dry-run so the diff updates without a page reload.

#### Issue #4 — visible warning when impersonate falls back to hardcoded default

The v1.29.4 hardcoded `narasit.k@thestandard.co` fallback (added after
Portainer dropped the env var) creates an invisible single-person
dependency. v1.32.4 makes it visible:

- `src/app/admin/health/page.tsx` — under the Google Calendar section,
  when `impersonateSource === 'hardcoded-fallback'`, render an amber
  warning explaining: "If `narasit.k@thestandard.co` leaves the company
  or loses Workspace access, calendar invites will break. To swap: set
  `GOOGLE_IMPERSONATE_SUBJECT` in Portainer stack env and redeploy.
  See `docs/runbook-impersonate-swap.md`."
- `src/lib/google-calendar.ts` `getCalendarImpersonateSubject()` — the
  existing once-per-process `console.warn` now also writes a one-time
  `AuditLog` row (action `calendar.impersonate_fallback_in_use`) so
  the audit-email alert path (v1.26.5) picks up the fallback usage
  durably, not just in transient logs.
- New `docs/runbook-impersonate-swap.md` — step-by-step swap procedure
  (when, how, what survives, troubleshooting, rollback, long-term
  multi-fallback list option).

### Verification

- `tsc --noEmit` clean.
- `next build` passes — all routes + page sizes within expected range.
- `prisma db push --accept-data-loss` in dev creates the new column +
  enum without touching existing data.
- After deploy:
  1. `/admin` Confirmed cards show PENDING immediately after approve,
     flip to OK in 1-3 seconds, or FAILED with red chip + error
     tooltip if calendar fails.
  2. `/admin/[id]` for CONFIRMED bookings shows the new
     `<BookingConfirmedCard>` with calendar sync status badge + live
     guest verification + Re-sync button.
  3. `/admin/health` shows amber warning under Google Calendar
     section if `GOOGLE_IMPERSONATE_SUBJECT` env unset.
  4. `start.sh` log shows one-time backfill of legacy CONFIRMED rows.

### Risk

- Medium — adds DB writes on every approve/reconcile/assign success
  and failure. All conditional updates on existing rows, no new
  indexes. Stale-PENDING reconciler clause prevents rows getting stuck.
- The `BookingConfirmedCard` adds 1 Google Calendar API call per
  `/admin/[id]` page load. Admin-only, ~200-500ms. Acceptable.
- Auto-recover paths in assign route now also write status — slight
  performance cost on assign (~5-10ms extra DB write). Negligible.

---

## [1.32.1] — 2026-05-24

### Fixed — `/api/health` now exercises the same auth models production uses

Codex production review (booking `AGN-260527-STD-01`) found that
`/admin/health` was reporting `unauthorized_client` failures on both
the Google Calendar and Producer Dashboard sheet checks **even though
real booking flows were working**. Root cause: the health endpoint
hand-rolled its own JWT auth with scopes/impersonate that didn't match
what `src/lib/google-calendar.ts` and `src/lib/google-sheets.ts`
actually use.

**Mismatch (before):**

| Path | Real prod code | Health was testing |
|------|----------------|--------------------|
| Calendar | `calendar` (full) + DWD impersonate | `calendar.readonly` + impersonate |
| Sheets WRITE | `spreadsheets` (full) + NO impersonate | `spreadsheets.readonly` + impersonate |
| Sheets READ | `spreadsheets.readonly` + NO impersonate | (not tested) |

The DWD grant in Workspace is scoped to **calendar only** — impersonating
on a sheets call returns `unauthorized_client`. The health endpoint was
asking Google "can you impersonate this user for sheets?" — and Google
correctly said no. But that's not what production code does; sheets
goes service-account-direct, which IS authorized.

**Fix:**

- `src/lib/google-calendar.ts` — exported new helper `getCalendarAuth()`.
  Existing internal `getAuth` renamed to a private alias of it. Callsites
  unchanged.
- `src/lib/google-sheets.ts` — exported new helpers `getSheetsWriteAuth()`
  (full scope, no impersonate — used by `appendBookingRow` /
  `updateBookingRow`) and `getSheetsReadAuth()` (readonly scope, no
  impersonate — same model used by `projects.ts`, `people.ts`,
  `dashboard-episodes.ts`).
- `src/app/api/health/route.ts` — replaced 3 inline `new google.auth.JWT(...)`
  blocks with calls to those helpers. Now produces 3 distinct check
  results matching the 3 distinct auth models in the code.
- `src/app/admin/health/page.tsx` — relabeled rows to make the auth
  model visible in each check name. Added a one-line legend above the
  Live Checks list. Response shape change: `googleCalendar` →
  `googleCalendarDwd`; `producerDashboardSheet` →
  `producerDashboardSheetWrite` + new `producerDashboardSheetRead`.

### Verification

- `tsc --noEmit` clean.
- After deploy, `/admin/health` should show 4 green checks (DB +
  Calendar DWD + Sheets WRITE + Sheets READ) — they all match what
  the booking flows actually exercise.
- If a check fails, the row label tells you exactly which auth model
  broke, so the fix is unambiguous.

### Risk

Low. Widens health scopes from `.readonly` to write — service account
already has the broader grants because production code uses them. The
two new exported helpers are referenced only by `/api/health`; existing
production callsites still go through the same code paths via the
private alias `const getAuth = getCalendarAuth/getSheetsWriteAuth`.

---

## [1.32.0] — 2026-05-24

### Added — proposed GHA post-build smoke test (paste manually — token scope blocks auto-apply)

Until v1.31, the GHA workflow only verified that `next build` passed.
A commit could break startup (`start.sh` typo, prisma migration
failure, runtime JS error in a server component, env var reads that
explode without a fallback) and still get pushed to GHCR + tagged
`latest`. Operator would only discover the breakage when redeploying
in Portainer.

**Proposed `smoke-test` job** (added to `docs/gha-smoke-test.yml.proposed`
because the agent's PAT lacks `workflow` scope — see "How to apply"
below):

1. Spins up Postgres 16 as a GHA service container.
2. Pulls the just-built `sha-<commit>` image from GHCR.
3. Runs the image with `DATABASE_URL` pointing at the service Postgres
   + minimal NextAuth env (real Google creds intentionally omitted —
   we're not testing the Sheets/Calendar integration here, just
   startup).
4. Polls `GET /login` every 5 seconds for up to 180 seconds, waiting
   for a 200/302/307.
5. Fetches `/login` content + greps for the expected "Production
   Booking" title to verify the page actually rendered.
6. Surfaces the container log on both success and failure (with extra
   container state inspection on failure).

**What this catches** (once applied):

- `start.sh` failures (DB readiness wait, schema sync, seed errors).
- Prisma client mismatches (forgot to regenerate after schema change).
- Server-side errors that build-time `tsc` + `next build` miss.
- Container env contract drift (renamed env var with no fallback).

**What this does NOT catch** (out of scope for smoke):

- DWD / Google Calendar issues (no real creds in the smoke env).
- Specific booking creation / approval / assign flows.
- UI rendering issues past the login page.

**Does not gate deploy** (by design): the job runs *after* the image
is already pushed to GHCR. A failed smoke test marks the commit with
a red ✗ in GitHub but does not delete the image. Operator sees the
red status before pulling in Portainer. Future iteration: split into
`build → smoke → tag-as-latest` so smoke gates `latest` specifically.

### How to apply (manual one-time step)

The agent's GitHub Personal Access Token does not have `workflow`
scope, so it cannot modify `.github/workflows/*.yml`. Two options for
the human:

**Option A (easiest — via the web UI):**

1. Open `docs/gha-smoke-test.yml.proposed` in the repo on GitHub.
2. Copy the YAML below the comment header (starts with
   `# v1.32+ — boots the just-built image...`).
3. Open `.github/workflows/docker-build.yml` in the GitHub web UI →
   click the pencil (Edit) icon.
4. Paste the copied YAML as a second job in the `jobs:` block —
   directly after the `build-and-push:` job.
5. Commit directly to the branch via the web UI. (Web-UI commits use
   your personal session, not the PAT, so they have `workflow` scope.)

**Option B (give the PAT `workflow` scope):**

1. Go to https://github.com/settings/tokens
2. Find the PAT used for local pushes, click Edit.
3. Tick the `workflow` scope checkbox, save.
4. Re-run the push that adds the workflow file.

Once applied, every push to `main` or
`fix/assign-email-real-results` will produce two GHA jobs instead of
one. Operator can glance at the smoke-test status before pulling in
Portainer.

### Verification

- `docs/gha-smoke-test.yml.proposed` is valid YAML (verified
  syntactically — no parsing test possible without applying).
- Existing `build-and-push` job is unchanged on disk.
- Once user applies the file, the very first smoke run on a fresh
  commit will be the real verification.

---

## [1.31.1] — 2026-05-24

### Added / cleanup — ESLint config, docs, legacy redirect

Hygiene pass. No app behavior change.

**`.eslintrc.json` (new):**

- Extends `next/core-web-vitals`. Disables two noisy rules
  (`react/no-unescaped-entities`, `@next/next/no-img-element`) that
  fight our existing markup.
- `npm run lint` now works without prompting for setup. Current
  baseline: 0 errors, 2 warnings (both pre-existing: custom font in
  `app/layout.tsx`, useEffect dep in `ot/admin/page.tsx`).

**`docs/architecture.md` (new):**

- One-page mental model for new developers. Stack, data sources,
  booking lifecycle diagram, code map, background workers, auth
  model, deploy flow, diagnostic checklist, roadmap of what's
  deliberately not done yet. Read this first.

**`docs/runbook-backup.md` (new):**

- DB backup + restore procedure. **Currently the PLAN, not the
  reality** — there's no automated backup running yet. Includes the
  manual `pg_dump` commands, retention policy proposal, restore
  procedure with safety steps, quarterly verification drill, and an
  "in an actual emergency" section listing recovery paths if you have
  no backup (replay from PD Sheet, scrape Google Calendar, audit_logs).
- Action items list at the bottom — needs a target (S3 / GDrive /
  USB), cron schedule, and credentials setup.

**`src/app/booking/[outlet]/page.tsx` (rewrite — 400 lines → 10):**

- Was the legacy pre-wizard per-outlet form. v1.28 replaced it with
  the 5-step wizard at `/new` but kept the old page in the codebase.
  No internal href referenced it, but external bookmarks (`/booking/AGN`,
  `/booking/NWS`, etc.) may still exist in someone's notes/emails.
- Now a thin redirect: `redirect('/new')`. Old bookmarks land
  smoothly on the wizard instead of 404.

### Verification

- `next lint` runs clean (no errors).
- `tsc --noEmit` clean.
- `next build` passes — `/booking/[outlet]` still in the route table,
  size dropped from 6.3 kB → ~140 B (just the redirect).

---

## [1.31.0] — 2026-05-24

### Added — `team_members` DB table + `/admin/team` CRUD (decouple crew roster from code)

Crew assignment roster used to be a hardcoded `TEAM` constant inside
`src/app/admin/[id]/page.tsx` — adding/removing a crew member required a
code change + redeploy. v1.31 moves the roster to a Prisma table and
gives admins a CRUD UI.

**Schema — `TeamMember` model:**

```
model TeamMember {
  id        String   @id @default(cuid())
  email     String   @unique         // canonical id (matches assignedEmails)
  name      String                   // display name in assign checkboxes
  role      String                   // producer|video|director|sound|photo|switcher|virtualProduction
  active    Boolean  @default(true)  // false = hide from assign UI (history preserved)
  sort      Int      @default(0)     // tie-breaker within role group
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@map("team_members")
  @@index([role, active, sort])
}
```

`prisma db push --accept-data-loss` (in `start.sh`) creates the table
on next container start. No data loss because the table is new.

**Seed — `prisma/seed.ts`:**

- Imports `INITIAL_TEAM_ROSTER` from the new
  `src/lib/team-roster.ts` and **inserts only members missing from the
  DB**. Edits made later via `/admin/team` survive subsequent seeds.

**New module — `src/lib/team-roster.ts`:**

- Centralized `RosterRole` type, `ROLE_ORDER`, `ROLE_LABEL` map,
  `INITIAL_TEAM_ROSTER` seed data, and `groupByRole()` helper. Used by:
  - `prisma/seed.ts` (seed insert)
  - `src/app/api/admin/team/route.ts` (role validation)
  - `src/app/admin/team/page.tsx` (UI labels + dropdowns)
  - `src/app/admin/[id]/page.tsx` (fallback when API fails)

**API — `/api/admin/team` (new):**

- `GET` — list all members (active + inactive), sorted by ROLE_ORDER →
  sort → name. Admin-only.
- `POST` — create. Validates role against `ROLE_ORDER`; email must be
  unique (409 on dup).
- `PATCH /api/admin/team/[id]` — update `name`/`role`/`sort`/`active`
  (email is immutable — it's the canonical id used by
  `booking.assignedEmails`).
- `DELETE /api/admin/team/[id]` — soft-delete (`active: false`).
  Never hard-delete — historical bookings reference these emails.

**UI — `/admin/team` (new page):**

- Grouped by role with section headers (Producer / Coordinator,
  Videographer, …). Counts shown per group.
- Inline edit for each row (name + role). Email is read-only.
- Add-member form at the top (email + name + role dropdown).
- Soft-delete button (Trash icon) → confirmation → `active=false`.
  Re-activate button (Rotate icon) on inactive rows.
- "Show inactive" toggle so deactivated members can still be seen +
  re-activated.
- Linked from `/admin` header next to Permissions and Health.

**`/admin/[id]` change:**

- Removed the 40-line hardcoded `TEAM` constant.
- Added `team` state populated via `/api/admin/team` on mount; falls
  back to `groupByRole(INITIAL_TEAM_ROSTER)` if the API errors so the
  assign UI is **never blank** (defensive — same pattern as
  v1.29.4's calendar impersonate fallback).
- Section list (`teamSection label="Videographer" members={team.video}`)
  unchanged.

### Verification

- `tsc --noEmit` clean.
- `next build` passes — 3 new routes registered (`/admin/team`,
  `/api/admin/team`, `/api/admin/team/[id]`).
- `start.sh` runs `prisma db push` → table created. Then `tsx
  prisma/seed.ts` → 26 initial team members inserted on first run.
- After deploy, `/admin/team` shows the seeded list grouped by role.
  Editing a member's name reflects on `/admin/[id]` assign UI
  immediately (after page refresh).

### Tradeoffs / follow-ups

- The fallback (hardcoded `INITIAL_TEAM_ROSTER`) means if an admin
  deactivates a member at `/admin/team` AND the API fetch happens to
  fail on `/admin/[id]`, that member could still appear in the assign
  UI. Acceptable trade — the alternative is an empty assign UI on
  transient errors, which is worse for the assignment workflow.
- Adding a brand-new role beyond the seven defined in `ROLE_ORDER`
  still requires a one-line code change (add to `ROLE_ORDER` +
  `ROLE_LABEL` + a `<TeamSection>` in `admin/[id]`). Worth doing only
  if multiple new roles need to be supported.

---

## [1.30.0] — 2026-05-24

### Added — single-source Producer Dashboard sheet config + `/admin/health` diagnostic page

Long-running setup: production deploys will eventually point at a real
Producer Dashboard sheet (separate from today's sandbox). Two changes
to make that swap safe + verifiable:

**1. `src/lib/google-config.ts` (new) — single source of truth for
sheet config:**

- `SANDBOX_PRODUCER_DASHBOARD_SHEET_ID` constant + `getProducerDashboardSheetId()`
  helper. Reads `PRODUCER_DASHBOARD_SHEET_ID` env first; falls back to
  the sandbox id.
- `isUsingSandboxSheet()` + `maskSheetId()` for safe display
  ("10TnR0…pSzL4").
- Inlined consumers: `google-sheets.ts`, `projects.ts`, `people.ts`,
  `dashboard-episodes.ts` — all dropped their private 4-way duplicated
  `DEFAULT_DASHBOARD_SHEET_ID = '10TnR0…'` constant and now `import {
  getProducerDashboardSheetId } from './google-config'`. Future swaps
  touch one file.

**2. `GET /api/health` (new, admin-only):**

Returns runtime config + live checks in one response:

- **Config (masked):** version, NODE_ENV, sheet id (masked) +
  source (`env` vs `hardcoded-fallback`) + sandbox flag, calendar id
  (masked), impersonate subject + source, NextAuth + reconcile worker
  secrets (set/missing booleans, never the values themselves), SMTP
  config presence.
- **Live checks (each timed):**
  - DB — `prisma.booking.count()` round-trip.
  - Google Calendar — DWD JWT → `calendars.get` on the configured
    calendar id.
  - Producer Dashboard sheet — DWD JWT → `spreadsheets.get` on the
    configured sheet id; returns the sheet title + tab list.
- Returns 200 if every check passes, 503 otherwise.

**3. `/admin/health` (new page):**

Pretty wrapper around `/api/health`. Shows:

- Top-line "All systems operational" / "One or more checks failed"
  banner.
- **Amber SANDBOX warning** when the sheet env is unset / matches the
  sandbox id — admins immediately see they're on the dev sheet, with
  exact instructions for the production swap.
- Live check results with latency + error details for failing checks.
- Source badges (`env` green vs `hardcoded fallback` amber) so it's
  obvious which knobs are explicitly configured vs. relying on a
  safety-net default.
- Linked from `/admin` header next to Permissions.

**4. `docs/runbook-sheet-swap.md` (new):**

Step-by-step procedure for swapping the Producer Dashboard sheet
(sandbox → production) with a verification checklist + rollback steps.
Covers the failure modes (service account access, wrong id, forgetting
to redeploy) and notes the 5-min cache TTL.

### Verification

- `tsc --noEmit` clean.
- `next build` passes — new route `/api/health` registered.
- No behavior changes to the booking / approve / assign / calendar
  flows. This release adds infrastructure (config consolidation +
  observability), not user-visible features.

### Tradeoffs / follow-ups

- `/admin/health` does live network calls (DB + Calendar + Sheets) per
  page load. Cheap (~50–500ms) but don't auto-poll it; the Re-check
  button is manual on purpose.
- The Calendar / Sheet checks reuse the same DWD JWT used by the
  worker, so a healthy /admin/health implies the worker can talk to
  Google too.
- `GOOGLE_SHEETS_ID` env var present in the Portainer stack is not
  consumed by any code (verified). Documented in
  `runbook-sheet-swap.md` notes; safe to leave or remove.

---

## [1.29.4] — 2026-05-24

### Fixed — hardcoded fallback for the impersonated Workspace user

Confirmed root cause of the long-running "calendar guests not added" issue
via live Portainer inspection on 2026-05-24:

- Service account creds: ✓ set
- Google Admin DWD: ✓ granted (client id `106117530552798836735`, scope
  `https://www.googleapis.com/auth/calendar` — full read/write)
- Shared calendar "THE STANDARD Production Bookings": ✓ shared with
  `narasit.k@thestandard.co` with "Make changes and manage sharing"
- Portainer stack env editor: shows `GOOGLE_IMPERSONATE_SUBJECT=
  narasit.k@thestandard.co` (51 chars, no whitespace)
- **Running container env vars: GOOGLE_IMPERSONATE_SUBJECT is MISSING**

The Portainer stack is Repository-mode (deploys from
`docker-compose.portainer.yml` in git). That compose has the default
`${GOOGLE_IMPERSONATE_SUBJECT:-narasit.k@thestandard.co}` since v1.26.4,
which should set the env var either way. But git fetch has been failing
intermittently (saw `Failed to fetch latest commit id` and `Failed to
pull images of the stack` toasts) and Portainer kept using a stale
cached compose file that pre-dates the default — so the var never made
it into the container.

**Fix:** hardcode the same fallback at the application layer in
`src/lib/google-calendar.ts`:

- `DEFAULT_IMPERSONATE_SUBJECT = 'narasit.k@thestandard.co'`.
- `getCalendarImpersonateSubject()` returns the env value when set
  (trimmed); otherwise returns the default and logs a one-time warning
  to the container log so the misconfig is still discoverable.

Net effect: calendar guest sync now works whatever shape the Portainer
stack is in, as long as DWD itself is healthy. The env var still wins
when set (so multi-Workspace deploys or different impersonators can
override).

### Verification

- `tsc --noEmit` clean.
- `next build` passes.
- After deploying `sha-<this-commit>`, Re-sync on the affected bookings
  (PP-26-001-L01, PP-26-006-L01) must turn the chip green:
  `✓ event created with N guests` — and the events appear on Google
  Calendar "THE STANDARD Production Bookings" with the assigned crew
  as guests.

### Follow-up

- Portainer's stale-compose issue should still be fixed for hygiene:
  either fix the box's DNS/git connectivity so `Failed to fetch latest
  commit id` stops happening, or detach the stack from Git and re-add
  it. The code fix is defensive — it doesn't address the underlying
  Portainer/git plumbing.

---

## [1.29.3] — 2026-05-23

### Fixed — surface the real reason `createCalendarEvent` failed (was: silently returning null)

Direct follow-up to v1.29.2: when ops clicked **Re-sync** on two
CONFIRMED bookings, both came back with the unhelpful chip
`⚠ createCalendarEvent returned null`. That message was the wrapper
saying "the underlying call gave me nothing" — the *actual* Google
Calendar error was being eaten by `createCalendarEvent`'s broad
`catch → return null` and a few defensive `return null`s on known
failure modes (no credentials, DWD off, attendees rejected). The
upstream reason only showed up in container logs / `AuditLog`, which
defeats the whole point of the v1.29.2 admin Re-sync button.

**Fix — `src/lib/google-calendar.ts` `createCalendarEvent`:**

Every `return null` on a known failure path is now a `throw Error(...)`
with a human-readable, action-oriented message:

- **No service account credentials** →
  `Google service account not configured — set GOOGLE_SERVICE_ACCOUNT_JSON …`
- **`requireAttendees: true` + DWD off** →
  `GOOGLE_IMPERSONATE_SUBJECT not set … set GOOGLE_IMPERSONATE_SUBJECT to a Workspace user (e.g. narasit.k@thestandard.co) … and redeploy.`
- **`requireAttendees: true` + Google rejected the attendees array** →
  `Google Calendar rejected event create with attendees: <upstream message>`
  (the actual API error from Google, e.g. "Service accounts cannot
  invite attendees without Domain-Wide Delegation of authority", or
  "Calendar usage limits exceeded", etc.)

The outer `catch` no longer swallows — it re-throws (wraps non-Error
values with a `Calendar event create failed:` prefix). All known
callers (`approve/route.ts`, `assign/route.ts`,
`calendar-reconcile.ts → createVerifiedCalendarEvent`) already wrap
the call in try/catch, so this is non-breaking for them — the
difference is that the caught error now carries the real reason.

**Fix — `src/lib/calendar-reconcile.ts`:**

`createVerifiedCalendarEvent` kept the defensive
`if (!eventId) throw new Error('createCalendarEvent returned null')`
fallback as belt-and-suspenders for the unlikely case Google returns
an event without an id. Replaced that generic message with a
direction to retry / check AuditLog. The common configuration cases
now bubble up specific messages instead.

### Net effect on the admin Re-sync UX

Before this fix:
```
⚠ createCalendarEvent returned null
```

After this fix (the same DWD-off booking):
```
⚠ GOOGLE_IMPERSONATE_SUBJECT not set (or env value is empty after trim)
  — Domain-Wide Delegation is required to add calendar guests …
```

— and the admin knows exactly which Portainer env var to fix.

### Verification

- `tsc --noEmit` clean.
- `next build` passes.
- No public API change — `createCalendarEvent` still returns
  `Promise<string | null>` (the residual `null` is for the unexpected
  Google-response-with-no-id case). The change is purely error-message
  quality.

---

## [1.29.2] — 2026-05-23

### Added — calendar link on admin booking cards + on-demand Re-sync button

Ops report: a CONFIRMED booking (Content Agency · Long Form (project),
1 assigned crew member) showed no Google Calendar event, and the admin
had no way to see *why* without SSH'ing into the container to read logs.
This release surfaces the calendar state directly on each booking card.

**New: `<CalendarStatus>` on `/admin` cards** (CONFIRMED + COMPLETED):

- **Has `calendarEventId`** → blue chip "📅 Open in Calendar" linking to
  the public event URL (or "📅 Calendar event linked" tooltip with the
  event id when the htmlLink isn't cached yet — first Re-sync click
  fetches it).
- **No `calendarEventId`** → red chip "⚠ No calendar event" so the
  failure mode is impossible to miss.
- **Always present** → "Re-sync" button. Triggers an immediate
  per-booking reconcile (no waiting for the 10-minute worker tick).
  Inline result chip after the call: `✓ event created with N guests`,
  `✓ guests updated (N)`, `✓ already in sync`, or `⚠ <reason>`.

The button is deliberately shown even when the event link is green, so
an admin who hears "I didn't get the calendar invite" from crew can
force a guest patch immediately without chasing logs.

**New endpoint: `POST /api/admin/[id]/calendar-resync`**

- Admin-auth only (`requireAdmin`).
- Calls `reconcileSingleBooking(bookingId)` — same code path as the
  background worker, just scoped to one booking.
- Returns the full `ReconcileItem`: `{ ok, action, eventId, htmlLink,
  assignedEmails, calendarAttendees, error? }`. Action is one of
  `ok | patched | created | failed | skipped`.
- `GET` alias provided for ad-hoc browser testing while signed in.

**Refactor: `src/lib/calendar-reconcile.ts`**

- Extracted the per-booking work into a private `processBooking()` that
  takes a fully-included booking record and the reconcile options
  (`actorEmail`, `dryRun`). The bulk worker
  (`reconcileCalendarGuests`) now loops over `processBooking`; the new
  single-booking entry point (`reconcileSingleBooking`) fetches one
  booking and calls the same function. Same AuditLog rows
  (`calendar.reconcile_created/_patched/_recreated/_failed`), same
  verification semantics, same DB writes — but now reusable.
- `reconcileSingleBooking` rejects non-CONFIRMED bookings with a
  human-readable `skipped` reason instead of silently doing nothing.
- `ReconcileItem` now exposes `htmlLink?: string | null` so the admin
  UI can display the Google Calendar URL the moment a reconcile
  completes.

### Diagnosing the user-reported case

After deploy, on the affected CONFIRMED booking:

1. Click **Re-sync** on the card.
2. Read the inline result chip:
   - `✓ event created with 1 guest` → root cause was the approve
     background create silently failing (DWD blip, network); the new
     event is correct.
   - `✓ guests updated (1)` → event existed but didn't have the
     assigned email yet; just patched.
   - `⚠ GOOGLE_IMPERSONATE_SUBJECT not set …` → DWD config issue. Set
     the env var (or fix its value) in the Portainer stack and
     redeploy.
   - `⚠ <google api error message>` → likely Workspace-side: DWD scope
     drift, impersonated user lost calendar access, or the calendar id
     was changed. Cross-reference `AuditLog action='calendar.invite_*'`
     for the same booking.

### Verification

- `tsc --noEmit` clean.
- `next build` passes — `/api/admin/[id]/calendar-resync` appears in
  the route table.
- No behavior changes to the background worker, approve, or assign
  paths; this release adds a manual escape hatch + visibility, doesn't
  touch the automated flow.

---

## [1.29.1] — 2026-05-23

### Fixed / hardened — reconcile worker resilience + Docker build hygiene

Quick dev-audit pass on top of v1.29.0. No application-logic change; purely
operational reliability + repo hygiene. Found by reading the freshly-shipped
reconciler with a "what breaks at 3am" lens.

**Reconcile worker (`scripts/calendar-reconcile-worker.js`):**

- `parsePositiveInt()` helper guards the interval env var. Previously
  `Number(process.env.CALENDAR_RECONCILE_INTERVAL_MS || 600000)` returned
  `NaN` when the env value was a non-numeric string, and `setInterval(fn,
  NaN)` is silently clamped to ~1ms — a runaway loop that would hammer
  the internal endpoint, the DB, and Google Calendar. Now any non-finite
  or non-positive value falls back to the 10-minute default.
- Loud-fail when no secret is configured. The internal endpoint also
  accepts admin sessions, but the worker is headless — without a secret
  it 401s every request forever in silence. New startup warn line
  surfaces that immediately so it shows up in `docker logs`.
- Startup log now reports the resolved `baseUrl` and `secret=set/MISSING`
  so a misconfiguration is obvious from line one of the container log.
- SIGTERM / SIGINT handlers clear the timer and exit 0. Container stop
  no longer waits for the SIGKILL grace period to take the worker out.

**Supervisor wrapper (`start.sh`):**

- Wraps the worker in `while true; do node …; sleep 5; done &` so a
  crashed worker auto-restarts after 5 seconds instead of staying dead
  for the rest of the container's lifetime. The 5-second back-off
  prevents a hot loop if the script throws on require.

**Docker build hygiene:**

- `.dockerignore` (new — committed). Codex had created this locally but
  never committed it, so every `docker build` was tarballing
  `node_modules`, `.next`, `backups/`, and `.git` into the daemon
  context. The committed file is more conservative than Codex's draft:
  - **`CHANGELOG.md` is NOT excluded** — `src/app/changelog/page.tsx`
    does `fs.readFileSync(cwd+'/CHANGELOG.md')` at runtime. Codex's
    draft excluded it, which would have made `/changelog` show
    "Changelog not found" in production.
  - `USER_MANUAL_TH.md` also stays for the same reason
    (`src/app/manual/page.tsx`).
  - Inline comment explains the runtime-read invariant so future edits
    don't regress this.
- `.gitignore` now ignores `/backups`, `*.sql`, `*.dump`. The repo
  already had a local `backups/` directory containing a real DB dump
  (`production_booking_20260523_142436.sql`). That's user data — must
  never get committed by accident.

**Compose parity (`docker-compose*.yml`):**

- Both composes now show `CALENDAR_RECONCILE_URL` as a commented-out
  override. Default `http://127.0.0.1:3000` works for the standard
  container layout; the override is needed only if `PORT` is changed.
  Discoverable via comment instead of having to read the worker source.

### Verification

- `tsc --noEmit` clean.
- `next build` passes — no new routes (this was a hygiene pass).
- No application-logic changes. Reconciler behavior unchanged; only its
  resilience and discoverability improved.

---

## [1.29.0] — 2026-05-23

### Added — calendar guest auto-reconciler + strict "no event without guests" path

Layered on top of v1.28.2's synchronous-assign fix. After v1.28.2 went out,
ops observed that the underlying Google Calendar invite path can still fail
transiently (DWD impersonation token blip, network hiccup, attendees patch
rejected mid-flight). Those events would heal only on the next manual
re-assign. This release adds an **automated reconciliation loop** that
detects and repairs guest drift on its own, plus a stricter create path so
a missing-guest event is no longer treated as success.

**New module — `src/lib/calendar-reconcile.ts`:**

- `reconcileCalendarGuests({ limit, actorEmail, dryRun? })` pulls
  CONFIRMED bookings that have `assignedEmails`, fetches each booking's
  Google Calendar event, and reconciles drift:
  - No `calendarEventId` on the booking → create event with guests baked
    in, **verify the guests landed by re-fetching the event**, persist
    `calendarEventId`. If the verification fails, delete the half-created
    event and surface the error.
  - Event exists but disappeared on Google's side (404) → same recreate +
    verify path; old `calendarEventId` logged into the audit row.
  - Event exists, guest list differs → `updateCalendarEventAttendees`
    patch; if patch fails, fall back to delete + recreate so the result
    matches `assignedEmails` exactly.
  - Event exists and guests match → no-op (logged as `ok`).
- Every action emits a typed `AuditLog` row:
  `calendar.reconcile_created`, `calendar.reconcile_recreated`,
  `calendar.reconcile_patched`, `calendar.reconcile_failed`. Actor is
  `calendar-reconcile` (worker) or the admin's email (manual run).

**New internal endpoint — `src/app/api/internal/calendar/reconcile/route.ts`:**

- `GET /api/internal/calendar/reconcile?limit=N&dryRun=0` (and `POST`
  alias) runs the reconciler.
- Two auth modes:
  1. **Worker auth** — `x-reconcile-secret: <secret>` or `Authorization:
     Bearer <secret>`. Secret resolves to `CALENDAR_RECONCILE_SECRET` →
     `NEXTAUTH_SECRET` → `AUTH_SECRET`.
  2. **Admin auth** — signed-in admin session can hit the endpoint
     directly from a browser to trigger a manual run.

**New worker — `scripts/calendar-reconcile-worker.js`:**

- Plain Node script, no framework. Spawned from `start.sh` as
  `node scripts/calendar-reconcile-worker.js &` after the Next.js server
  is up. Calls the internal endpoint every `CALENDAR_RECONCILE_INTERVAL_MS`
  (default 600000 = 10 min), first run delayed 30s to let the server warm.
- Re-entrant guard (`running` flag) so a slow run can't pile up.
- Only logs when something actually changed (patched/created/failed > 0)
  to keep container logs quiet.

**`src/lib/google-calendar.ts` (+131 -24):**

- `createCalendarEvent(booking, options)` now accepts
  `{ requireAttendees?: boolean }`. When set, the function refuses to
  create a guest-less event under any of:
  - `GOOGLE_IMPERSONATE_SUBJECT` not configured (DWD off)
  - Google rejects the attendees array (DWD scope drift, impersonation
    user lost calendar access)
  In strict mode the function returns `null` after writing a
  `calendar.invite_failed` audit row with `fallbackCreated: false`, so
  the caller can react instead of pretending the booking has a calendar
  entry. Default behavior (unset) keeps the v1.26.5 fallback: create
  guest-less event + alert.
- `notifyCalendarAlert` gained a `fallbackCreated` flag so the alert
  email distinguishes "we wrote an event but couldn't add guests" from
  "we aborted; nothing was created".
- New `getCalendarEventAttendees(eventId)` returns
  `{ exists, attendees[], htmlLink? }`. Used by the reconciler to
  diff what Google actually has against what the DB thinks.
- `parseTime` replaced by `parseBangkokDateTime` + `addHoursInBangkok`.
  Uses explicit `+07:00` strings in the dateTime field instead of
  `.toISOString()` (which is UTC). The previous form was timezone-correct
  if the server was in Asia/Bangkok but drifted on UTC containers — the
  Portainer image runs UTC. This was a quiet bug hiding behind the
  `timeZone: 'Asia/Bangkok'` hint on the event.
- `getCalendarImpersonateSubject()` (used everywhere DWD is checked) now
  trims the env var. Trailing newlines/spaces from Portainer's env
  editor were silently disabling DWD.
- `deleteCalendarEvent` adds `sendUpdates: 'none'` (don't email guests
  about a recreate) and treats 404 as success (idempotent).

**`src/app/api/admin/[id]/approve/route.ts`:**

- Passes `requireAttendees: booking.assignedEmails.length > 0` when
  calling `createCalendarEvent`. If admin approves a booking that
  already has crew but DWD is broken, approve no longer silently
  creates a guest-less event.

**`src/app/api/admin/[id]/assign/route.ts`:**

- Same `requireAttendees` flag passed to the auto-recover
  `createCalendarEvent` branch.
- Switched `process.env.GOOGLE_IMPERSONATE_SUBJECT` reads to
  `getCalendarImpersonateSubject()` so the trimming applies here too.

**`start.sh`:**

- Spawns the reconcile worker after migrations + seed, before the Next.js
  exec. Worker runs as a detached background process inside the
  container; killing the container kills it.

**`docker-compose.portainer.yml`:**

- New env vars: `CALENDAR_RECONCILE_SECRET` (defaults to
  `NEXTAUTH_SECRET`) and `CALENDAR_RECONCILE_INTERVAL_MS` (default 10
  minutes).

**`docker-compose.yml` (dev):**

- Parity with the Portainer compose: added the two reconcile vars + the
  `GOOGLE_IMPERSONATE_SUBJECT` / `CALENDAR_ALERT_EMAIL` defaults that
  were already in the Portainer compose. Local dev now exercises the
  same worker path as production.

### Verification

- `tsc --noEmit` clean.
- `next build` passes — `/api/internal/calendar/reconcile` appears in the
  route table.
- Codex's image build on this branch went green (`sha-452857f`).
- **Manual QA still pending** for the full reconcile loop end-to-end on
  the live Portainer stack. The plan in `docs/ops-log.md` for this
  release lists the steps.

### Tradeoffs / follow-ups

- Reconcile worker is a separate process inside the container — if it
  crashes it doesn't take the web server with it, but it also won't
  restart on its own. Acceptable for v1; if needed, wrap with a tiny
  supervisor (`while true; do node …; sleep 5; done`) later.
- Worker auths against `localhost:3000`. If a future deploy changes the
  internal port, set `CALENDAR_RECONCILE_URL`. Currently undocumented in
  the compose file — add when actually needed.
- `requireAttendees` is opt-in per call. Both server-side callers
  (approve, assign) use it; the reconciler always uses it. The
  legacy/external callers (if any) keep the old fallback behavior. A
  future pass could make `requireAttendees: true` the default.
- No automated tests for the reconciler. The Codex commits did not add
  any; we're relying on AuditLog rows + manual verification. A small
  Vitest suite for `reconcileCalendarGuests` (using fakes for Google +
  Prisma) is the natural next step but out of scope for an emergency
  reliability fix.

---

## [1.28.2] — 2026-05-23

### Fixed — calendar guests now sync synchronously on Assign (regression)

**Symptom (reported by ops):** assigning crew on `/admin/[id]` did not add
those people as guests on the Google Calendar event for the booking. The
booking still showed the assigned list in the app and emails went out, but
the calendar event stayed empty (or kept the previous guest list on
re-assign). v1.26.x had fixed this once via Domain-Wide Delegation;
something silently regressed.

**Root causes (two, fixed together):**

1. **Race condition on the approve → assign sequence.** Approve creates
   the calendar event in a background task. If admin clicked Assign before
   that background task finished, `booking.calendarEventId` was still
   `NULL`, so the `if (booking.calendarEventId)` guard in the assign route
   skipped the attendee update entirely. The event was created later
   *without* guests, and nothing reconciled them.
2. **Fire-and-forget attendee patch.** The assign route called
   `updateCalendarEventAttendees(...).catch(...)` (no `await`). Failures
   (DWD off, Google API rejection, expired impersonation) were logged
   server-side but the response said "✓ Saved & sent N emails" regardless,
   so admins assumed guests went out.

**Fix (`src/app/api/admin/[id]/assign/route.ts`):**

- Attendee update is now `await`ed. Result is captured into a typed
  `calendarSync: { ok, eventId, action, error? }` object.
- **Auto-recover branch added:** if the booking is `CONFIRMED` but has no
  `calendarEventId` (race or earlier create failure), the assign route
  creates the calendar event right then, with the just-assigned crew baked
  in as guests, and saves the new `calendarEventId` to the DB.
- Branch (3) — booking still in `REQUESTED`/`ASSIGNED` (not yet approved)
  — stays a no-op; the existing approve route already bakes
  `assignedEmails` into the event it creates, so guests will appear the
  moment admin approves.

**Admin UI (`src/app/admin/[id]/page.tsx`):**

- The Assign toast now reports calendar guest sync status, e.g.
  - `✓ Saved & sent 3 emails · calendar guests updated (3)`
  - `✓ Saved & sent 3 emails · calendar event auto-created with 3 guests`
  - `⚠ Saved · sent 3/3 · calendar guests NOT added (Google Calendar API
    rejected the attendees update — see AuditLog calendar.attendees_update_failed)`
- A failed calendar sync downgrades the toast tone to `warning` even when
  email + DB save succeeded, so admins notice immediately instead of
  finding out from crew that they didn't get invites.

**Behavior preserved:**

- Approve's background calendar create kept (don't block approve UX).
- Email send loop unchanged.
- `calendar.attendees_update_failed` / `calendar.invite_failed` AuditLog
  rows + alert emails (from v1.26.5) still fire — now the UI also
  reports them inline so admins don't have to query AuditLog to discover
  silent failures.
- `updateBookingRow` to the Producer Dashboard sheet still happens.

### Verification

- `tsc --noEmit` clean.
- `next build` passes (only pre-existing dynamic-server warnings on OT/audit
  routes).
- Manual QA (after deploy):
  1. Submit a booking → approve immediately → assign 2 crew within 5s →
     toast should read `calendar event auto-created with 2 guests` (the
     race window). Calendar event in Google Calendar must show the 2
     guests.
  2. Submit + approve + wait 30s + assign → toast should read
     `calendar guests updated (N)`. Event must have N guests.
  3. Re-assign on an already-CONFIRMED booking with crew → swap one
     member → toast `calendar guests updated`; calendar event reflects
     the swap and removed crew gets a cancellation.
  4. If toast warns `calendar guests NOT added` → query `AuditLog`
     `action='calendar.attendees_update_failed'` for the diagnostic.

---

## [1.28.1] — 2026-05-23

### Changed — booking wizard step 4 field order

In the People & Crew step (CA flow), the field order now reads top-to-bottom
as the actual cascade chain: **Producer → Project ID → Episodes → Director →
Crew → Notes**. Previously Director sat between Producer and Project, which
made the "pick Producer first so the Project list filters" relationship
harder to spot.

No data-model, validation, or POST-payload changes — purely a JSX reorder
in `src/app/_components/booking/BookingWizard.tsx`. Director is still
required for CA bookings.

---

## [1.28.0] — 2026-05-23

### Changed — operations-console UI redesign (Home, 5-step booking wizard, Calendar drawer, inbox-style My Bookings)

A full visual + IA pass to move the app away from a "Google-Form-on-a-page"
look toward a modern, dense, internal-operations console. **No API, schema,
or POST-payload changes** — same `/api/bookings` POST body, same calendar
event behavior, same email triggers, same Producer Dashboard sync.

**Design system (`tailwind.config.ts`, `src/app/globals.css`):**

- New cool-neutral app background (`#F6F7F9`) replacing the legacy
  `#F0EBF8` light-purple — quieter surface that lets content lead.
- **Canonical status palette** added to the Tailwind theme
  (`status-{requested|assigned|confirmed|completed|cancelled}-{50|500|700}`)
  and exposed through a new `<StatusPill>` shared component so every
  page renders status identically (dot, soft fill, border, label).
- New `.ops-*` primitive classes (card, input, label, button, tab, choice,
  table, empty) — 8px radius across the board, no nested cards. **Legacy
  `.gf-*` classes preserved** for pages still using the Google-Form look
  (login, manual, changelog, admin detail, booking success, OT).
- Font defaults to Google Sans then Inter (was Inter only).

**Information architecture:**

- `/` is no longer the booking form. New home is an **Overview** page with:
  3 KPI cards (Today / This week / Needs attention), Today's schedule,
  My upcoming, Needs attention (REQUESTED bookings — the operator's main
  queue). Cards link through to their detail pages.
- The booking form moved to **`/new`** and is reachable from a persistent
  `+ New Booking` CTA in the nav.
- Nav reorganized: Overview · Calendar · My Bookings · Producer (gated) ·
  Dashboard (admin) · Admin (admin). Secondary links (OT, Manual,
  Changelog, Upload) now sit in a "More" dropdown on desktop. Compact
  brand mark replaces the long "THE STANDARD · Production" wordmark.
  Active route gets a filled dark chip rather than an underline.

**Booking wizard (`src/app/_components/booking/BookingWizard.tsx`, new):**

- Long form replaced by a **5-step wizard**: Project → Schedule →
  Location → People & Crew → Review. Each step is a single card with a
  clear heading + per-step validation; only the Review step's "Confirm &
  Submit" actually POSTs.
- **Desktop layout: two columns** — form on the left, **sticky live
  summary on the right** (auto-fills as the user types; dot turns green
  per group once filled).
- **Mobile layout: single column** with a **fixed bottom action bar**
  (Back · Step counter · Next/Submit) and a tap-to-expand summary above
  it. Form fields stack and inputs have larger tap targets.
- Stepper at the top shows completion ticks per step and is **clickable**
  for jumping between visited steps.
- Per-step error display preserved (inline `AlertCircle` under the field,
  `aria-invalid`, top-of-form summary banner).
- All cascade logic preserved (Outlet change clears Episode Type /
  Project / Producer / Director / Episode picks + amber warning banner;
  CA Producer change clears Project ID; CA Project change clears Episode
  picks).
- Submission payload bit-for-bit identical to v1.27.

**Calendar (`src/app/calendar/page.tsx`):**

- **View toggle**: Month (desktop default) vs **Agenda** (mobile default,
  auto-detected). Agenda is a 30-day list grouped by day with a "Today"
  badge — much easier to scan on a phone than the dense month grid.
- **Detail drawer** replaces the hover tooltip + selected-day list. Click
  any event chip or row → a side-sheet slides in (right on desktop,
  bottom on mobile) with status, schedule, location, people, episode
  list, and an "Open detail →" CTA to the existing detail page. Closes
  on Escape and scrim click.
- Day cells: event chips use neutral borders + a single status-color
  dot (rather than full-color tinted backgrounds) — denser and reads
  better when a day has 3+ bookings.

**My Bookings (`src/app/my-bookings/page.tsx`):**

- Inbox-style **6 tabs**: Upcoming · Requested · Assigned · Confirmed ·
  Completed · Cancelled. Each tab shows a count chip. Upcoming sorts
  ascending (soonest first); status tabs use API order.
- Full-text search across episode ID, program, producer, location.
- One fetch (`scope=mine`, limit 200), client-side bucketing — no
  separate request per tab.
- Empty state per tab points the right way (Upcoming → "create one").

**Dashboard (`src/app/dashboard/page.tsx`):**

- Status palette colors aligned with the rest of the app (status-token
  values); donut now includes ASSIGNED.
- All cards/tables converted to the `.ops-card` / `.ops-table` look —
  consistent with Overview, Calendar, My Bookings.
- Status column uses `<StatusPill>`.
- Charts and filtering behavior unchanged.

**Shared (`src/app/_components/StatusPill.tsx`, new):**

- Single source of truth for status visuals. Used by Overview, Calendar
  (legend + drawer), My Bookings, Dashboard.

### Changed — `package.json`

Version bump 1.27.0 → 1.28.0.

### Verification

- `tsc --noEmit` clean.
- `next build` passes (33 routes built; only pre-existing dynamic-server
  warnings on `/api/ot/export` and `/api/ot/summary` — unrelated to this
  PR, they use `headers()` for session).
- No automated tests added — project has no test runner configured.
  Manual verification path documented in `docs/ops-log.md` for this
  release.

### Tradeoffs / follow-ups

- The wizard's per-step validation is duplicated from the legacy
  whole-form `validate()`; consolidating into a typed Zod schema is a
  natural next step but out of scope for a UI-only PR.
- Calendar still uses a hand-rolled grid + date-fns rather than a calendar
  library — view-toggle + drawer were added without changing that
  foundation. Week view is not implemented yet (spec mentioned it as
  optional for desktop); the agenda view + month view cover the
  scan-by-day use case for now.
- The Overview page assumes "Needs attention" === REQUESTED bookings the
  current user can see. Admins see org-wide REQUESTED; non-admins see
  only their own + confirmed-everywhere (existing API behavior). If we
  want admins-only items here, we'd add a server-side `attention=true`
  flag — flagged for a follow-up.
- The legacy `/booking/[outlet]/page.tsx` (outlet-scoped form) was not
  touched and still uses the old `.gf-*` styling. Removal candidate
  if it's unused — verify before deleting.

---

## [1.27.0] — 2026-05-23

### Changed — booking flow UX overhaul (form sections, Review step, inline errors)

A workflow-focused pass on the user-facing surfaces. No data-model, API, or
submission-behavior changes — same fields, same POST payload, same downstream
effects (calendar event, sheet write, OT sync). Internal QA only: typecheck +
`next build` pass; no automated tests were added because the project has no
test runner configured (deliberately deferred — see Tradeoffs below).

**Booking form (`src/app/page.tsx`):**

- Restructured the long single form into **6 numbered sections**: Project,
  Schedule, Location, Production Details, People / Crew, Notes — each with a
  short hint under the heading. Dense card layout preserved (no marketing
  hero, no decorative spacing inflation).
- **Review step before Submit.** Clicking the primary button now shows a
  read-only summary of every field (Outlet, Episode Type, dates, times, room,
  Producer/Director, Project ID, Episodes, crew, notes) split into the same 6
  sections. The user can `← Back to edit` or `Confirm & Submit`. **No POST
  fires until Confirm.** A two-dot step indicator (Fill → Review) lives in
  the header so the user always knows where they are.
- **Per-field error display.** Replaced the single top-of-form error string
  with a `fieldErrors: Record<string, string>` map. Each invalid field shows
  its own message with an `AlertCircle` icon right under the input, plus an
  `aria-invalid` attribute for assistive tech. The top-of-form message becomes
  a summary pointing the user to the highlighted fields.
- **Date/time validation** is sharper: end-date error now sits on the end-date
  field; estimated-wrap-before-call-time is caught when the shoot is a single
  day.
- **Outlet-change warning banner.** When Outlet changes and dependent fields
  (Episode Type, Producer, Director, Project ID, Episode picks) get cleared,
  a transient amber banner names exactly which fields were wiped and which
  flow the user just switched into (Content Agency vs standard) — so silent
  data loss is gone.
- **Helper text on confusing fields:** Episode Type (L/S/A/T meaning),
  Category (when to use each), Estimated Wrap (workload calc, optional),
  Crew Required (videographer count guidance), Project ID (sheet source +
  Producer filter), Shoot Type vs Location/Room (independence). Existing
  Thai-only labels (แขก / Subject) preserved.

**Calendar (`src/app/calendar/page.tsx`):**

- Event chips now read `10:00 · AGN · Talk Show` (truncated full program
  name) instead of the cryptic `10:00 AGN·T`. Time and outlet stay full;
  program name takes the remaining width with truncation. Status color
  coding preserved. The hover preview (already present) was left untouched —
  it already shows program, time, producer, location, status, episode IDs.

**Navigation (`src/app/_components/Nav.tsx`):**

- **Persistent `+ New Booking` primary CTA** on every page (mobile and
  desktop), styled with `.gf-submit` so it pops without being marketing-y.
- Reordered primary links to match daily workflow: Calendar · My Bookings ·
  Producer · Dashboard · Admin.
- Pushed secondary items (OT, คู่มือ, อัปเดต, Upload [DEV]) behind a vertical
  divider with smaller/greyer styling so they don't compete with daily-use
  links. Same items, less visual weight.

**Dashboard role clarity (`src/app/dashboard/page.tsx`):**

- Renamed to **Admin Dashboard**, subtitle clarifies it's org-wide and points
  Producer-role users to `/producer` for their personal view.
- Three numbered sections with hints under each: **Booking Overview**
  (charts), **Team Workload** (range + workload bar + table), **All Bookings**
  (filters + table). Same content; clearer signposting.
- Nav still gates this page to admins; producers continue to land on
  `/producer` and everyone has `/my-bookings`.

### Tradeoffs / deferred for a later phase

- **No automated tests added.** The project has no Jest/Vitest/Playwright
  setup; adding one purely to cover the new Review step and field validation
  would have ballooned this change. Manual QA matrix recommended: validation
  paths for both CA and non-CA flows, Outlet-change cascade, Review →
  Back-to-edit → Confirm round trip, calendar chip readability across statuses.
- **Conflict detection (room/crew/time overlap) was scoped OUT.** It needs
  a backend overlap query against existing bookings and a client warning
  surface; deferred to a follow-up. The current Outlet-change banner pattern
  is the right home for it once the API endpoint exists.
- **No 2-mode landing page (New Booking vs View Schedule).** The user
  explicitly chose to keep `/` as the dense booking form, with the persistent
  `+ New Booking` CTA + Calendar link in the nav serving the same need
  without a hero-style landing.
- Producer dashboard (`/producer`) was left structurally as-is — it already
  filters to the producer's own bookings with status badges and history, which
  is exactly the "my workload / my bookings" view the spec asked for.

---

## [1.26.5] — 2026-05-23

### Added — monitoring + email alert when calendar guests fail to attach

Calendar guests now work (v1.26.4), but the failure path is still silent: if
DWD ever gets revoked, the impersonate user loses access, or the Workspace
account is disabled, `createCalendarEvent` falls back to creating the event
**without guests** and only logs a `console.warn`. Operators wouldn't notice
until crew started missing invites. This change makes failures observable:

- New helper `notifyCalendarAlert` in `src/lib/google-calendar.ts` —
  fire-and-forget; never throws.
  - Writes an `AuditLog` row with `action = "calendar.invite_failed"` (insert
    fallback) or `"calendar.attendees_update_failed"` (patch failure), with
    full context: `eventId`, attendee list, error message, current
    `GOOGLE_IMPERSONATE_SUBJECT`.
  - Emails a human-readable alert to `CALENDAR_ALERT_EMAIL` (new optional env
    var); falls back to `GOOGLE_IMPERSONATE_SUBJECT` if unset. No-op when no
    email provider is configured.
- `createCalendarEvent` input now accepts an optional `bookingCode` so alerts
  show the readable booking code, not just the CUID.
- `updateCalendarEventAttendees(eventId, emails, meta?)` gained an optional
  `meta` arg `{ bookingId, bookingCode }` so failed patches alert with the
  same context.
- Callers (`/api/admin/[id]/approve`, `/api/admin/[id]/assign`) now pass
  `bookingCode` through.

No schema changes, no new packages. Alerts piggyback on the existing AuditLog
table (90-day retention) and `sendEmail` infra.

---

## [1.26.4] — 2026-05-23

### Fixed — calendar guests now work out of the box (impersonate subject defaulted in compose)

Approved bookings appeared on the shared calendar but the assigned crew were
never added as **guests**: `GOOGLE_IMPERSONATE_SUBJECT` (the Workspace user the
service account impersonates for Domain-Wide Delegation) was never reaching the
container, so `createCalendarEvent` / `updateCalendarEventAttendees` silently
skipped attendees. Confirmed with a live DWD probe — a bare service account hits
`403 forbiddenForServiceAccounts`, while impersonating `narasit.k@thestandard.co`
succeeds. So DWD was already granted in Workspace; only the env var was missing,
and the compose file sourced it from an easily-missed *stack-level* env var.

- `docker-compose.portainer.yml`: `GOOGLE_IMPERSONATE_SUBJECT` now **defaults to
  `narasit.k@thestandard.co`** (`${GOOGLE_IMPERSONATE_SUBJECT:-narasit.k@thestandard.co}`).
  Guests work after a redeploy with no stack env var needed; still overridable.
- Retroactively backfilled guests onto the 5 existing confirmed bookings that
  had assigned crew but no attendees (added silently — `sendUpdates:'none'` — so
  no invite blast).

No app code changed.

---

## [1.26.3] — 2026-05-22

### Added — Booking ID shown on the admin booking detail (all outlets)

The admin booking detail page now shows the **Booking ID** (`bookingCode` — the
Production ID for Content Agency, or the first Episode ID for other outlets)
as a badge under the title, so it's easy to reference when working with a
booking — regardless of outlet. `src/app/admin/[id]/page.tsx`.

---

## [1.26.2] — 2026-05-22

### Fixed — re-assigning crew keeps the calendar guests in sync

Previously the calendar event's guests were set only at approve time; changing
the crew afterward updated the DB + sent new assignment emails but left the
event's guests stale. New `updateCalendarEventAttendees()` in
`src/lib/google-calendar.ts` is now called from the assign route whenever the
booking already has a `calendarEventId` — it replaces the event's attendees with
the current crew (added crew get an invite, removed crew a cancellation) via
`events.patch` + `sendUpdates: 'all'`. No-op without Domain-Wide Delegation (same
as the create path), so it's safe regardless.

---

## [1.26.1] — 2026-05-22

### Fixed — Producer Dashboard email match is case-insensitive

The producer-scoped views matched `producerEmail` against the (lowercased)
session email with a case-sensitive query — so a producer whose stored
`producerEmail` had different casing would see **zero** bookings. Now
case-insensitive in: `GET /api/bookings?scope=producer`,
`GET /api/bookings/export?scope=producer`, and the producer-message
authorization check.

---

## [1.26.0] — 2026-05-22

### Added — assigned crew added as Google Calendar guests (attendees)

The calendar event for a booking now adds the **assigned crew**
(`assignedEmails`) as event **guests** — Google sends them a real invite they
can accept/decline — instead of only listing them in the description.

- `src/lib/google-calendar.ts`: `getAuth()` impersonates
  `GOOGLE_IMPERSONATE_SUBJECT` (Domain-Wide Delegation); `createCalendarEvent`
  adds `attendees` + `sendUpdates: 'all'` when that env is set.
- **Graceful fallback**: if attendees are rejected (DWD not granted) or the env
  is unset, the event is created **without guests** (the "Assigned:" line stays
  in the description) — booking creation never breaks.

### Requires (ops) — to actually invite guests

A bare service account cannot invite attendees, so this needs **Domain-Wide
Delegation**:
1. Workspace Admin → Security → API controls → Domain-wide delegation → add the
   service account's Client ID with scope
   `https://www.googleapis.com/auth/calendar`.
2. Set `GOOGLE_IMPERSONATE_SUBJECT` (Portainer stack) to a `@thestandard.co`
   user who can manage the shared calendar.
3. Redeploy. Without these, crew stay in the description only (no error).

---

## [1.25.0] — 2026-05-22

### Added — Producer Dashboard (role-gated)

New **`/producer`** page for Producers / Co-Producers. Access is gated by the
user's `position` (an admin sets it on the Permissions page) — anyone whose
position contains "producer", plus admins. The **Producer** menu link appears
only for them (`canSeeProducer` computed in `layout.tsx`, mirroring `canSeeOT`).

Features:
- Lists the user's shoots — bookings where they are the **Producer**
  (`producerEmail`) — with status, an **"assigned yet?"** indicator, project,
  shoot date/time and episode IDs.
- Per booking: view the **audit history**; **send an update + email the admins**;
  **request a time change + email the admins** (admins apply the change via the
  normal edit flow — the request is recorded in the audit log, the booking is
  not auto-edited).
- **Export** the user's bookings as CSV (for reports).

Implementation — reuses existing pieces (audit log, history endpoint, `csv.ts`,
`sendEmail`):
- `getProducerAccess()` in `src/lib/session.ts`; gate wired through
  `layout.tsx` → `Nav.tsx`.
- `GET /api/bookings?scope=producer` (own producer shoots),
  `GET /api/bookings/export?scope=producer` (CSV),
  `POST /api/bookings/[id]/producer-message` (`type: update | time_change` →
  audit log + email active admins).
- `src/app/producer/page.tsx` (gate) + `ProducerDashboard.tsx` (client UI).

No schema change — gating reads the existing `User.position`.

---

## [1.24.1] — 2026-05-22

### Fixed — Bookings tab "Booking ID" shows the readable code

The "Booking ID" column in the Producer Dashboard **Bookings** tab now writes
`booking.bookingCode` (the human-readable code shown in the app — e.g. the
Production ID `AGN-260522-EVT-01`) instead of the internal CUID
(`clxyz…`). `src/lib/google-sheets.ts` — `BookingRow` gains `bookingCode`, and
`appendBookingRow` writes `bookingCode || id`.

Note: only affects rows appended from now on; existing rows keep their old CUID
value unless re-written.

---

## [1.24.0] — 2026-05-22

### Changed — booking = a Production that SELECTS existing episodes (3-level ID model)

Reworked the Content Agency flow around a 3-level ID hierarchy:

| Level | Example | Where it's created |
|---|---|---|
| Project | `PP-26-023` | "All Projects" tab (humans) |
| Episode | `PP-26-023-S01` | "_EPs" tab — producers create in the sheet |
| **Production** | `AGN-260423-EVT-01` | **this booking** |

The booking **no longer generates Episode IDs**. It now:

- Loads the chosen project's **existing** episodes from the "_EPs" tab,
  **excluding Published** ones — `GET /api/projects/:id/episodes` +
  `listProjectEpisodes()` in `src/lib/dashboard-episodes.ts`.
- Lets the user **multi-select** which episodes the shoot covers (form section
  after PROJECT ID, replacing the title inputs for Content Agency).
- Mints a **Production ID** `OUT-YYMMDD-SHOOTTYPE-NN` (e.g. `AGN-260423-EVT-01`;
  `EVT`/`STD`/`LOC`/`REM` from the shoot type) as the booking's `bookingCode`.
- Records the Production in the **DB + Bookings tab only** — it does **not**
  write back to the `_EPs` / `PD` / `Dir` episode rows.

Other outlets (non-AGN) keep the legacy flow: enter titles → local
`OUT-YYMMDD-PROG-NN` Episode IDs, `bookingCode` = first episode.

### Schema

- `Episode.episodeId` is **no longer `@unique`** — the same episode can be shot
  across multiple Productions. Applied via `prisma db push` on boot.

### Files

`src/app/page.tsx` (episode multi-select + fetch on project select),
`src/app/api/bookings/route.ts` (select + Production ID),
`src/app/api/projects/[id]/episodes/route.ts` (new),
`src/lib/dashboard-episodes.ts` (`listProjectEpisodes`), `prisma/schema.prisma`.

---

## [1.23.0] — 2026-05-22

### Added — in-app Changelog page

- New page **`/changelog`** ("อัปเดต" in the nav, next to "คู่มือ") renders this
  CHANGELOG.md with `react-markdown`, so anyone can see what changed in each
  version on the website. Single source of truth — the page reads the same
  CHANGELOG.md that's committed to the repo (`src/app/changelog/page.tsx`,
  mirroring the `/manual` pattern). Nav link added in
  `src/app/_components/Nav.tsx`.

---

## [1.22.2] — 2026-05-22

### Changed — "Agency Ref" → "Product code" (mapped to the sheet), PROJECT ID moved

- The **AGENCY REFERENCE** field is relabelled **PRODUCT CODE** on the booking
  form. Its value is now written to the "PD &lt;producer&gt;" tab's **Product
  Code column (F)** for each episode (previously left blank). Stored internally
  as `agencyRef` still — no schema change. `generateProjectEpisodeIds` takes a
  `productCode` arg (`src/lib/dashboard-episodes.ts`); `route.ts` passes
  `agencyRef` into it.
- **PROJECT ID** field moved to sit **right after Director** on the form
  (`src/app/page.tsx`); still required when the project list loads.

---

## [1.22.1] — 2026-05-22

### Fixed — Drive folder path + Director column

- **Drive / NAS folder path** now uses the booking's first Episode ID (e.g.
  `Production/2026/05/PP-26-006-T02/`) instead of the `OUT-YYMMDD-PROG` code
  (`AGN-260522-T`), so it matches the real Episode IDs. Updated in all three
  places: `src/app/booking/success/page.tsx`, `src/app/dashboard/[id]/page.tsx`,
  and the calendar packet in `src/lib/utils.ts`.
- **Director value** written to the "PD &lt;producer&gt;" column and used for the
  "Dir. &lt;director&gt;" tab name is now cleaned to the bare nickname. The
  "All Projects" Director cell can hold a composite like `PP-26-006-L01 — ท็อป`;
  `cleanDirectorName()` (in `src/lib/dashboard-episodes.ts`) keeps the segment
  after the last em-dash of the last line, so the sheet shows just `ท็อป`. A
  clean name passes through unchanged.

---

## [1.22.0] — 2026-05-22

### Changed — project Episode IDs minted in-app (Apps Script Web App removed)

The Apps Script Web App that minted `PP-YY-NNN-{type}NN` IDs was operationally
fragile — the deployment URL kept dying and the env vars kept getting lost
across redeploys. It's gone. The app now mints those IDs itself and writes the
Producer Dashboard tabs via the **same Google service account** it already uses
to read "All Projects" / "_Users" and write the "Bookings" tab.

- **New `src/lib/dashboard-episodes.ts`** — `generateProjectEpisodeIds()`:
  - looks up the project in "All Projects" (producer, director, project name);
  - numbers from the max `{projectId}-{type}NN` in the producer's
    "PD &lt;producer&gt;" tab (col C) — the complete record, so old projects
    continue correctly with no migration;
  - appends each episode to "PD &lt;producer&gt;" and (idempotently) to
    "Dir. &lt;director&gt;", mirroring the exact column layout the Apps Script used.
- `src/app/api/bookings/route.ts` — the project path calls
  `generateProjectEpisodeIds` instead of the Web App. Still **fails loud** (503)
  if the sheet can't be resolved — never a silent local ID.
- **Removed** `src/lib/booking-episode-api.ts` and the
  `BOOKING_EPISODE_WEBAPP_URL` / `_SECRET` env (compose + example).

### Requires (ops)

- The Google service account must have **edit** access to the Dashboard sheet
  (it already does — it writes the Bookings tab).
- **Turn OFF the sheet's onEdit episode auto-gen** so the app is the single
  numbering authority (booking is app-only now). Otherwise the sheet's `EP_SEQ`
  counter and the app's PD-tab numbering can diverge → duplicate numbers.
- The Apps Script project `booking-episode-endpoint.gs` can be retired.

---

## [1.21.0] — 2026-05-22

### Changed — simplified Episode-ID generation (removed over-engineering)

After review: the Apps Script Web App is **necessary** — the Producer Dashboard
sheet auto-generates Episode IDs via its own onEdit trigger, and the Web App
keeps booking-created IDs in that same shared `EP_SEQ` sequence (plus writes the
PD/Dir tabs). What was over-built was the resilience scaffolding around the
*local* path. Trimmed:

- **Removed `src/lib/episode-sequence.ts`** (`pg_advisory_xact_lock` +
  `withSequenceRetry`). Local (non-project) Episode IDs now use a plain
  `findFirst(max sequence) + 1`. A single booking is one transaction, so the
  "20 EPs at once" case never needed a lock; the `@unique` constraint still
  guards the rare concurrent-same-slot case.
- **Removed the redundant `prisma.$transaction` wrapper** — the nested
  `booking.create({ episodes: { create } })` is atomic on its own.
- **Removed the silent local-ID fallback for project bookings.** Previously, if
  the Web App was unreachable a project booking silently got a local `AGN-…` ID
  (wrong format, breaks the shared sequence — the source of recent confusion).
  It now returns a clear `503` ("ออก Project ID ไม่ได้ตอนนี้ … ลองใหม่อีกครั้ง")
  so the booking is retried rather than mis-numbered.
- **Kept** the Web App call's hard timeout (still prevents the POST hanging →
  NPM 502).

Net: fewer moving parts; a project Episode ID is now always either correct
(`PP-…`) or a clear error — never a silent wrong-format ID.

`src/app/api/bookings/route.ts`, removed `src/lib/episode-sequence.ts`.

---

## [1.20.0] — 2026-05-21

### Fixed — booking POST could hang → NPM 502 ("Unexpected token '<'")

Root cause: a project-linked Content Agency booking calls the Apps Script Web
App for Episode IDs. If that call wedged (the Docker host has documented
IPv6-egress issues with Google hosts, and `AbortController` does not reliably
interrupt a socket stuck in DNS/TCP connect), the `await` never resolved → the
POST never responded → Nginx Proxy Manager returned an HTML 502 page → the form
showed "Unexpected token '<'". The app itself never crashed or logged an error
(consistent with a silent hang).

**Two-part fix:**

1. **Bulletproof timeout** (`src/lib/booking-episode-api.ts`) — `requestEpisodeIds`
   now races the fetch against a hard 12s timer (`Promise.race`). Even if the
   underlying socket never settles, the function returns within 12s. Previously
   only an `AbortController` guarded it, which a wedged socket can ignore.

2. **Fallback instead of failure** (`src/app/api/bookings/route.ts`) — if the
   Web App is unreachable/slow/misconfigured, the booking no longer returns 502.
   It falls back to **local Episode ID generation** (the advisory-lock path) so
   the booking always succeeds. `projectId` / `projectName` are still saved, so
   the project link is preserved; only the Episode-ID format differs
   (`AGN-YYMMDD-T-NN` instead of `PP-YY-NNN-TNN`) for bookings created during a
   Web App outage. A server-side `console.warn` records each fallback.

Net effect: the booking queue stays up even when the Producer Dashboard Web App
is down. Combined with 1.19.1 (no-project escape) and 1.19.2 (clear non-JSON
error), a Dashboard/sheet outage can no longer block Content Agency bookings.

### Note

- This intentionally reverses the earlier "fail loud if the Web App is down"
  stance (booking-episode-api.ts header) in favour of availability. If strict
  ID-format consistency is required, watch the `console.warn` lines and re-issue
  affected episodes once the Web App is healthy.

---

## [1.19.2] — 2026-05-21

### Fixed — clearer error when the booking POST returns non-JSON

The form showed a cryptic `Unexpected token '<', "<!DOCTYPE "... is not valid
JSON` whenever `POST /api/bookings` replied with HTML instead of JSON (proxy
502/503/504 while the container restarts after a deploy, or any upstream error
page). The client now checks the response content-type first and shows the HTTP
status with guidance ("แอปอาจกำลังรีสตาร์ทหลัง deploy ลองใหม่ใน ~1 นาที").

### Hardened — Apps Script Web App call (Episode IDs)

- 15s `AbortController` timeout so a hanging Web App can't keep the booking POST
  open long enough to trigger an upstream proxy timeout (which is what produces
  the HTML 504 the client choked on).
- Parses the response via `text()` + `JSON.parse` so a 200-with-HTML answer
  (Apps Script login/error page) returns a clean error string instead of
  throwing.

`src/app/page.tsx`, `src/lib/booking-episode-api.ts`.

---

## [1.19.1] — 2026-05-21

### Fixed — PROJECT ID no longer hard-blocks Content Agency when the sheet is down

A sheet outage previously made every Content Agency booking impossible: the
PROJECT ID dropdown had no options to pick, yet it was `required`, so the form
could never submit. Now PROJECT ID is a **graceful-degradation** field:

- Required **only** when the Producer Dashboard sheet returned selectable
  projects (`visibleProjects.length > 0`). When the sheet is unreachable, or the
  selected producer has no projects, the field becomes optional.
- An amber notice explains the degraded mode and that booking can proceed
  without a Project ID.
- With no Project ID, the backend already falls back to a local `AGN-YYMMDD-…`
  Episode ID (the project-linked Web App path is skipped), so the queue keeps
  working through the outage. The project can be linked later.

`src/app/page.tsx` — added `projectSelectable` / `projectsUnavailable` flags;
label `*`, `<select required>`, and submit validation are now gated on
`projectSelectable`.

---

## [1.19.0] — 2026-05-21

### Added — Video Type field on the booking form

A new **Video Type** classification, independent of the existing business
`Category`. Added as a new field (Category is unchanged).

- New column `Booking.videoType` (`String?`, nullable). Stored verbatim as the
  selected label to mirror the Producer Dashboard sheet values. Additive —
  `prisma db push` adds a nullable column, existing bookings keep `null`.
- Booking form (`src/app/page.tsx`) — new required **VIDEO TYPE** radio group
  with 7 options: Teaser / Highlight, Vlog / On Location, Report (Host +
  Insert), Interview, Documentary, Commercial, Others. Submit validation
  rejects an empty value ("Please select a Video Type.").
- `POST /api/bookings` persists `videoType`.
- Google Sheets sync — appends a **Video Type** column to the right of
  "Updated At" (col 29), keeping the hardcoded `COL` partial-update indices
  valid.
- Booking detail (`/dashboard/[id]`) shows the Video Type next to Category.

### Changed — AGENCY REFERENCE always visible

- The AGENCY REFERENCE field is now shown on every booking (previously only
  when Category = Advertorial) and is **optional**. Removed the now-unused
  `isAdvertorial` gate.

### Notes

- `videoType` is a plain string, not an enum — no enum migration, and the
  option list can change without a schema change.
- Sheet column is appended rightmost; if the Dashboard sheet already has a
  Video Type column elsewhere, tell me and I'll map to that position instead.

---

## [1.18.1] — 2026-05-21

### Changed — PROJECT ID field is now Content-Agency-only and required

On the main booking form (`src/app/page.tsx`):

- The **PROJECT ID** dropdown now renders **only when the outlet is Content
  Agency** (`outletCode === 'AGN'`). Other outlets never see it.
- For Content Agency it is now **required** (was "optional but recommended").
  Label shows the red `*`; the `<select>` has `required`; submit validation
  rejects an empty Project ID with "Please select a Project ID."
- `projectId` / `projectName` are now sent as `null` for any non-Content-Agency
  booking, so switching outlets after picking a project can't leak a stale
  Project ID into the payload.

No schema or backend change — `projectId` remains nullable on `Booking` for
non-Content-Agency outlets. Backend does not hard-require it (the form is the
only entry point for project-linked bookings).

---

## [1.18.0] — 2026-05-21

### Added — Booking code + atomic episode sequence + audit log

The booking ↔ episode pair now shares one ID format, and every booking change
leaves a 90-day audit trail.

**Booking code**

- New field `Booking.bookingCode` (`String?` `@unique`) — set on create to
  `episodes[0].episodeId`, so a booking is identified by the same
  `[OUT]-[YYMMDD]-[PROG]-[EE]` (or `PP-YY-NNN-LNN`) string as its first
  episode. Immutable once set; never recomputed.
- Backfilled at startup for pre-existing bookings (see ops-log).

**Atomic episode sequence (local-generation path)**

- New `src/lib/episode-sequence.ts` — `allocateEpisodeSequence(tx, …)` takes a
  PostgreSQL `pg_advisory_xact_lock` on the `(outlet, date, program)` tuple
  inside the booking transaction, so concurrent bookings on the same slot can
  no longer read the same `max(sequence)`. The lock auto-releases on
  commit/rollback.
- `withSequenceRetry(fn, 3)` — defense-in-depth retry on `P2002` if the lock
  somehow fails to engage. Logs a console warning when a retry fires so any
  Layer-1 regression surfaces in prod logs.
- Project-linked bookings (`projectId` + `episodeType`) remain unchanged —
  the Producer Dashboard Web App still owns the `EP_SEQ_` counter and is
  collision-free by construction.

**Audit log**

- New model `AuditLog` (id, at, actorEmail, action, entityType, entityId,
  bookingCode, fromStatus, toStatus, changes JSON). Indexed on `at`,
  `bookingCode`, `(entityType, entityId)`, and `action`.
- Logged actions (fire-and-forget, written outside the booking transaction so
  audit failure never blocks a save):
  - `booking.create` — full episode-IDs + slot context
  - `booking.update` — field-level diff over the editable-field whitelist
  - `booking.status_change` — separate row, with `fromStatus` / `toStatus`
  - `booking.delete` — soft-delete (status → CANCELLED) row
  - `audit.auto_email_sent` / `audit.purge_run` — meta-rows used for throttle
    and post-incident analysis
- New whitelist `src/lib/booking-status.ts` — rejects illegal transitions
  (e.g. `COMPLETED → REQUESTED`) with HTTP 400.

**Retention + CSV reminder (90-day rolling window)**

- New `src/lib/audit-retention.ts` — policy constants (`RETENTION_DAYS=90`,
  `WARNING_DAYS=14`, `AUTO_EMAIL_THROTTLE_HOURS=24`) and helpers
  (`getPurgeWarning`, `canSendAutoEmail`, `iterateAuditLogs`).
- `start.sh` runs `DELETE FROM audit_logs WHERE at < now() - INTERVAL '90 days'`
  on every boot (non-fatal).
- New endpoint `GET /api/audit/purge-warning` — admin-only; returns banner
  data and fires the auto-email helper.
- New endpoint `GET /api/audit/export` — admin-only; streams a UTF-8 CSV
  (BOM-prefixed for Excel/Thai support), paginates 500 rows at a time so
  memory stays flat.
- New endpoint `POST /api/audit/purge` — admin-only manual purge trigger.
- New endpoint `GET /api/bookings/:id/history` — per-booking audit trail.
- New `src/lib/audit-auto-email.ts` + `src/app/_components/AdminAuditBanner.tsx`
  — yellow banner on every admin page during the warning window, and a
  throttled (≤1 per 24 h) auto-email to every active admin with the CSV link.

### Files changed

- `prisma/schema.prisma` — `Booking.bookingCode`, model `AuditLog`
- `start.sh` — backfill `bookingCode`, purge `audit_logs`
- `src/lib/episode-sequence.ts`, `src/lib/audit.ts`, `src/lib/booking-status.ts`,
  `src/lib/csv.ts`, `src/lib/audit-retention.ts`, `src/lib/audit-auto-email.ts`
- `src/app/api/bookings/route.ts`, `src/app/api/bookings/[id]/route.ts`
- `src/app/api/bookings/[id]/history/route.ts`,
  `src/app/api/audit/purge-warning/route.ts`,
  `src/app/api/audit/export/route.ts`, `src/app/api/audit/purge/route.ts`
- `src/app/_components/AdminAuditBanner.tsx`, `src/app/admin/layout.tsx`

### Notes

- Audit writes are best-effort. In a crash between booking commit and audit
  write a row may be lost; the booking record remains authoritative.
- Booking POST now hard-caps at **20 episodes per request** (was unbounded);
  matches the operational ceiling.
- `shootDate` is validated (`isNaN(parsedDate.getTime())`) before any DB work.

---

## [1.17.0] — 2026-05-20

### Changed — Booking Category renamed

Renamed the `Category` enum on bookings to better reflect how the team
classifies shoots:

| Old              | New                |
|------------------|--------------------|
| Recurring        | Original Content   |
| Agency Job       | Advertorial        |
| Service Job      | Event              |
| Internal         | Internal (unchanged) |

- `prisma/schema.prisma` — `Category` enum values updated: `ORIGINAL_CONTENT`,
  `ADVERTORIAL`, `EVENT`, `INTERNAL`
- `start.sh` — added idempotent pre-migration step (`ALTER TYPE ... RENAME VALUE`)
  that runs before `prisma db push`, so existing rows keep their data and the
  column doesn't get dropped/recreated. Safe to re-run.
- UI: `src/app/page.tsx`, `src/app/booking/[outlet]/page.tsx`, `src/lib/data.ts`,
  `src/lib/utils.ts` — all option lists, label maps, default-state strings,
  and conditional logic (`isAgency → isAdvertorial`) updated.

### Migration notes

- The `ALTER TYPE ... RENAME VALUE` in `start.sh` is in-place — no data loss.
- The Agency Reference field (formerly shown for "Agency Job") now shows for
  "Advertorial" with the same label.

---

## [1.16.0] — 2026-05-09

### Added — Project ID layer (per memo from ปุ๊ก, 2026-05-08)

Production Booking now consumes the **Project ID** dropdown owned by the Producer
Dashboard ("All Projects" tab), so every booking can be tagged with the upstream
`PP-YY-NNN` identifier instead of free-text project names.

- New columns `projectId`, `projectName` on `Booking` (nullable, immutable once set)
- New module `src/lib/projects.ts` — fetches the dropdown list from
  `Producer Dashboard!All Projects!A2:D` via service-account read-only auth.
  Strict gate: only rows matching `^PP-\d{2}-\d{3}$` are accepted.
  Cached server-side for 5 min.
- New endpoint `GET /api/projects[?refresh=1]` — returns the cached list
- Booking form — adds Project ID dropdown that auto-fills Project Name + Producer
- Booking POST persists `projectId` + `projectName`
- Google Sheets sync — appends two new columns ("Project ID", "Project Name")
  on the right (cols U, V) so existing column indices in `updateBookingRow`
  stay valid
- Booking success page + admin booking detail render the Project ID

### Configurable env vars (optional)

- `PRODUCER_DASHBOARD_SHEET_ID` — defaults to the Producer Dashboard sheet
  ID from the memo
- `PRODUCER_DASHBOARD_TAB` — defaults to `All Projects`

The existing `GOOGLE_SERVICE_ACCOUNT_JSON` (or `GOOGLE_SERVICE_ACCOUNT_EMAIL` +
`GOOGLE_PRIVATE_KEY`) must have read access to the Producer Dashboard sheet.

### Notes

- `projectId` is **optional** — existing bookings remain valid; new bookings
  can be submitted without it (form falls back gracefully if the sheet is
  unreachable)
- Migration is non-destructive — `prisma db push` adds two nullable columns
  on next boot

---

## [1.15.2] — 2026-05-09

### Fixed — Email send fails after ~1 hour of session age

Root cause: `getToken()` from `next-auth/jwt` only **decodes** the JWT cookie;
it does NOT trigger the `jwt` callback that contains the access-token refresh
logic. Result: any assignment / test-email call >1h after sign-in hit Gmail
with a stale access token and got 401.

- New `src/lib/google-token.ts` exports `getValidGoogleAccessToken(token)`
  that refreshes against `oauth2.googleapis.com/token` on demand
- Both assign and test-email routes now go through this helper
- Assign route is no longer fire-and-forget — emails are awaited and the
  response includes per-recipient `{ requested, sent, failed[{email,error,hint}] }`
- Admin UI surfaces real per-recipient errors with actionable hints

### Added — Portainer deployment alternative

- `docker-compose.portainer.yml` — Portainer-ready stack (Repository deploy)
- `.env.portainer.example` — env template
- `PORTAINER_DEPLOY.md` — step-by-step guide

---

## [1.5.0] — 2026-04-27

### Changed
- **Authentication: Google OAuth (NextAuth.js)** replaces email-only login
  - Google provider with `hd=thestandard.co` (Google Workspace hosted-domain hint)
  - Server-side `signIn` callback rejects any non-`@thestandard.co` email
  - JWT-based session strategy, 7-day expiry
  - Sign-in page: single "Sign in with Google" button
- **User auto-provisioning**: first sign-in creates a `User` row; `narasit.k@thestandard.co` is auto-promoted to ADMIN
- Disabled accounts (`User.active = false`) blocked from sign-in
- Middleware switched to `next-auth/jwt`'s `getToken`
- All custom auth API routes (`/api/auth/login`, `/logout`, `/me`) replaced by `/api/auth/[...nextauth]`
- `LogoutButton` now uses NextAuth's `signOut`

### Required env vars (new)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — OAuth 2.0 web client from Google Cloud Console
- `NEXTAUTH_SECRET` — random 48+ char string
- `NEXTAUTH_URL` — `https://production-booking-app.onrender.com`

### Dependencies
- `next-auth ^4.24.7`

---

## [1.4.0] — 2026-04-27

### Added
- **Authentication system** — email-based login with signed cookie session (HMAC-SHA256, 7-day expiry); only `@thestandard.co` accounts allowed
- **Role-based access control**: `USER` and `ADMIN` roles in DB
- **Initial admin bootstrap**: `narasit.k@thestandard.co` auto-promoted on first login
- **Admin-only routes**: `/dashboard` and `/admin` now require `ADMIN` role (server-side guard)
- **`/my-bookings`** — per-user view: bookings they requested or are assigned to + all CONFIRMED bookings, with tabs
- **`/admin/permissions`** — list users, promote/demote between USER/ADMIN, enable/disable accounts, add users by email; self-demotion lockout protection
- **Login page** at `/login` with `next=` redirect param
- **Layout**: shows logged-in email + Sign out button; admin-only nav links hidden for non-admins
- **Booking ownership**: `Booking.createdByEmail` captured from session; users see their own + assigned + confirmed
- API: `POST/PATCH/GET /api/admin/users`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- Edge middleware redirects unauthenticated requests to `/login`

### Fixed
- **Dashboard detail page crash** — replaced legacy `card`/`btn-primary`/`text-brand-*` classes (removed in v1.2.0) with current `gf-*` design system
- **BigInt JSON serialization** — `Upload.fileSize` now serialized as string in `GET /api/bookings/[id]` (Next.js `JSON.stringify` cannot serialize BigInt)
- **Dashboard list status filter** — replaced obsolete `PENDING` option with `REQUESTED` / `ASSIGNED` (matches new BookingStatus enum)

### Schema
- New `User` model + `UserRole` enum
- `Booking.createdByEmail String?` (new)

### Dependencies
- No new packages — auth uses Node's built-in `crypto.createHmac`

---

## [1.3.1] — 2026-04-27

### Added
- Admin assign panel: full team list (videographers, directors, sound, photographer, switcher) loaded from THE STANDARD employee directory
- Freelance section: name + contract no. + optional email, supports unlimited freelancers per booking; saved into Admin Notes

---

## [1.3.0] — 2026-04-27

### Added
- **Admin Console** (`/admin`) — tab-filtered view of all bookings by status (REQUESTED / ASSIGNED / CONFIRMED / CANCELLED / COMPLETED)
- **Admin Edit page** (`/admin/[id]`) — assign team members (videographers) by email with preset checkboxes + custom email input; admin notes; "Save & Send Email" sends Nodemailer assignment notifications
- **Approve action** — creates a Google Calendar event (Bangkok timezone) and confirms the booking; event ID stored back to DB
- **Google Sheets logging** — every new booking is appended to the master sheet (20 columns: IDs, dates, crew, status, calendar event ID); row index stored for later status updates
- **Google Calendar embedding** (`/calendar`) — full-width iframe of the production calendar (Asia/Bangkok)
- **Email notifications** — assignment email to crew + approval notification to producer via SMTP
- **New booking status flow**: REQUESTED → ASSIGNED → CONFIRMED (CANCELLED / COMPLETED also supported)
- Navigation links: Calendar, Dashboard, Upload, Admin added to top nav

### Changed
- Bookings now created with `status: REQUESTED` (was implicitly undefined)
- `statusLabel()` and `statusColor()` updated for all 5 statuses

### Dependencies added
- `googleapis ^140.0.1` — Google Sheets + Calendar API
- `nodemailer ^6.9.14` — SMTP email

---

## [1.2.0] — 2026-04-27

### Changed
- **UI redesign**: replaced outlet-card grid with a single Google Form-style booking page
- Outlet and Program are now cascade dropdowns on one page (no more per-outlet subpages)
- Removed Episode ID explainer section from homepage
- Dashboard re-styled to match Google Form aesthetic (clean white tables)
- Navigation simplified to top bar with Dashboard + Upload Footage links

### Removed
- Multi-card outlet selection landing page
- Step-by-step Episode ID decoder block
- Heavy brand-color card grid

---

## [1.1.0] — 2026-04-27

### Fixed
- Dockerfile: switched from multi-stage standalone to single-stage build (`npm install` instead of `npm ci --frozen-lockfile`) — resolves build failure due to missing `package-lock.json`
- Removed `output: 'standalone'` from `next.config.js` — simplifies server startup
- Removed Thai locale import from `date-fns` — resolves build-time module error
- `start.sh`: use `prisma db push` + `tsx seed` before `npm start`

### Added
- `start.sh`: auto-runs DB schema sync + seed on every container boot (idempotent)
- Dockerfile copies Prisma CLI + tsx into image for runtime migrations

---

## [1.0.0] — 2026-04-27

### Added
- Initial release: THE STANDARD Production Booking Platform
- **Menu page** with 9 outlet cards (NWS, WLT, SPT, POP, POD, KND, LIF, TSS, AGN)
- **Booking form** — 16 fields, conditional logic (location if not studio, agency ref if agency job)
- **Episode ID auto-generation** — format `[OUT]-[YYMMDD]-[PROG]-[EE]`, immutable, folder-only policy
- **Confirmation page** with Calendar Packet copy-paste ready for Production Coordinator (พี่ตุ้ย)
- **Dashboard** — list all bookings, filter by outlet/status, search by Episode ID
- **Booking detail** — status management (Pending → Confirmed → Completed), calendar packet, Drive folder path
- **Upload platform MVP** — footage logging by Episode ID + camera slot (Cam1–Cam4, Sound, Drone, BTS)
- **PostgreSQL + Prisma** schema: Outlet, Program, Booking, Episode, Upload models
- **Seed data**: 9 outlets × 56 programs from master spreadsheet
- **Docker + docker-compose**: app + PostgreSQL + Nginx reverse proxy, Portainer-ready
- **Render deployment**: web service + PostgreSQL, Singapore region, auto-deploy from GitHub
