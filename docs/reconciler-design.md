# Reconciler Design — รวม Drive worker sweeps เป็น pass เดียว (Improvement Plan Item 4)

_v2 · 2026-07-31 · design เท่านั้น ยังไม่ implement · ผ่าน adversarial review 13 ข้อ (รายละเอียดใน git history ของไฟล์นี้) · เจ้าของ: Production Booking_

เอกสารนี้ออกแบบการยุบ supervised workers ~10 ตัว (start.sh:304-442) ที่ต่างคน sweep Google Drive/DB ตาม schedule ของตัวเอง ให้เหลือ **reconciler ตัวเดียว** ที่เดิน per-booking phase pipeline โดยแชร์ resolution + Drive listing ชุดเดียวต่อ booking ต่อรอบ ปูทางด้วยของที่มีแล้ว: id-first migration เสร็จ (v1.157), FakeDrive harness (`src/lib/__tests__/helpers/fake-drive.ts`), staging stack (APP_ENV=staging, v1.159) และ folder-integrity worker (v1.151-153) ซึ่งจะกลายเป็น "กระดูกสันหลัง" ของ reconciler

---

## 0. สัญญาความปลอดภัย — กฎสูงสุด (คำสั่ง operator 2026-07-31: "อย่าให้มันลบอะไรเกินกว่าต้นแบบ และไม่ทำให้การทำงานเราพัง")

ทุก section ถัดจากนี้อยู่ใต้สัญญา 2 ข้อนี้ — ข้อขัดแย้งใด ๆ ให้ถือสัญญานี้ชนะเสมอ:

### 0.1 Deletion parity — reconciler ห้ามลบเกินต้นแบบ

ระบบเดิม (baseline) ลบได้แค่ **4 กรณี** เท่านั้น และ reconciler จะลบได้แค่ 4 กรณีเดิม
ด้วยเงื่อนไข**เท่าเดิมหรือเข้มกว่า** — เจอกรณีนอกเหนือ = ห้ามแตะ, รายงานใน digest แทน:

| # | กรณี | ต้นแบบ | เงื่อนไข reconciler (เข้มขึ้นตรงไหน) |
|---|---|---|---|
| 1 | box twin ว่างเปล่า (เปิดทาง whole-move fast path) | video-merge v1.127 | + fresh-read ก่อนลบ (§5 ข้อ 4) + อยู่ใต้ per-booking lease |
| 2 | landing folder **วันที่ผ่านแล้ว** + ว่าง | landing-lifecycle | prune = **past-only** (เดิม non-today — เข้มขึ้น: ของพรุ่งนี้รอดทุกกรณี §3.1) |
| 3 | landing folder ซ้ำที่ว่าง | landing-dedup | + fresh-read + probe-first |
| 4 | `_SHOOT` marker ซ้ำ/ตกค้าง (ไฟล์ stub เล็ก regenerable) | shoot-marker-reconcile | เข้า prod ที่ stage **4d เท่านั้น** (ท้ายสุดของ rollout §6) |

กติกาบังคับทุกการลบ: (a) `trashDriveItem` เท่านั้น — ลงถังขยะ Shared Drive กู้ได้ ~30 วัน,
**ไม่มีการลบถาวรใน codebase นี้และจะไม่มี**; (b) fresh-read เป้าหมายสด ๆ ก่อนลงมือทุกครั้ง
(ห้ามเชื่อ DriveView); (c) มีเพดานจำนวนลบต่อรอบ; (d) ทุกชิ้นที่ลบต้องโผล่ในรายงาน/digest;
(e) โฟลเดอร์ drop ของ**วันนี้และพรุ่งนี้** = เขตห้ามลบเด็ดขาด (บทเรียน 2026-07-22)

**ด่านตรวจบน staging**: parallel-run ใดที่ reconciler วางแผนจะลบสิ่งที่ legacy ไม่ลบ =
สอบตกอัตโนมัติ ห้าม promote ขึ้น stage ถัดไป (เพิ่มเข้า convergence gate §6)

### 0.2 งานทีมห้ามสะดุด

- ทุก stage มี kill-switch ตัวเดียว (`RECONCILER_ENABLED=0` + เปิด legacy flags กลับ) =
  ถอยเป็นระบบเดิมสมบูรณ์ใน 1 redeploy — legacy workers **ห้ามลบ**จนกว่า cutover นิ่ง 2 สัปดาห์
- ความสามารถ**ลบ**เปิด**ท้ายสุด**ของ rollout (stage 4d) — สร้าง/ย้าย/เปลี่ยนชื่อต้องพิสูจน์ตัวเองก่อน
- ปุ่ม per-booking ของ crew/admin ใช้ได้ตลอดทุก stage (ชนกับ pass = 409 พร้อมข้อความไทย ไม่ใช่พัง)

---

## 1. Scope decision — worker ไหนรวม / ตัวไหนตั้งใจแยกไว้

### 1.1 รวมเข้า reconciler (Drive-tree workers ทั้งหมด)

| Worker เดิม | Logic ที่ย้าย | เหตุผล |
|---|---|---|
| **prep-folders** (hourly, `scripts/prep-folders-worker.js`, `src/lib/prep-folders.ts`) | box/staging/photo pre-create + marker fill | ทำงานซ้ำกับ folder-integrity ทั้ง `ensureShootCameraFolders` และ `rememberDriveLinks({box})` (prep-folders.ts:222, 242 vs folder-integrity.ts:330, 342) และจ่าย quota แพงสุด: `findFoldersByCode` แบบ global ต่อ booking ทุกชั่วโมง (prep-folders.ts:124-132) |
| **folder-integrity** (hourly, `src/lib/folder-integrity.ts`) | check+repair ทั้งหมด → กลายเป็น phase `ensure` | เป็น worker ที่ design ดีที่สุด (budget `spend()`, rotation cursor, timestamp guard, digest idiom) — reconciler สร้างบนโครงนี้ ไม่ใช่เขียนใหม่ |
| **landing lifecycle** (nightly 19:00, `src/lib/landing-lifecycle.ts`) | create-next-day + cleanup past-empty | แชร์ tree เดียวกับ folder-integrity/video-merge; ปัญหา fire-once-no-catch-up (พลาด 19:00 = ไม่มี folder พรุ่งนี้เลย) แก้ได้ก็ต่อเมื่อมันเป็น phase ใน pass ที่วนซ้ำได้ |
| **landing prune** (`pruneLandingToToday`, ปัจจุบันเป็น scheduled task ~12:00 บนเครื่อง operator) | ยุบเป็น run-level sub-pass ของ tick 12:00 — **predicate เปลี่ยนเป็น past-only** (§2.6) | คู่สัญญาของกฎ today-only ใน folder-integrity.ts:161-164 ควรอยู่ใน process เดียวกัน ไม่ใช่ external cron; local task เลิกใช้ที่ Stage 4c (§6.5) |
| **landing-dedup** (`src/lib/landing-dedup.ts` — มี route แต่**ไม่มีใคร schedule**) | ยุบเป็น run-level sub-pass | มันคือ cleanup ของ race ที่ reconciler ตัวเดียวจะกำจัดทิ้งอยู่แล้ว (landing-dedup/run/route.ts:17-19); logic `codeFromFolderName`/`hasRealFiles` ซ้ำกับ landing-lifecycle คำต่อคำ |
| **video-merge** (hourly/NAS-gated, `src/lib/video-merge.ts`) | phase `merge-video` | ตัว MOVE หลัก; ทุก race ที่เจ็บมา (empty-skeleton swallow, EP split, box-twin trash) เกิดจากการที่มันวิ่งขนานกับ worker อื่นบน tree เดียวกัน — **fast path v1.127 (ย้าย folder ทั้งก้อน) ต้องรอดใน pipeline** (§2.2) |
| **sound-merge** (hourly, `src/lib/sound-merge.ts`) | phase `fold-sound` | TOCTOU กับ video-merge (sound สร้าง AUDIO ใน EP ที่ video กำลัง trash — map ระบุชัด) หายทันทีเมื่อสอง phase วิ่ง sequential ต่อ booking แบบเดียวกับ `runBookingMerge` (booking-merge.ts:49-59) ที่พิสูจน์แล้วว่า order นี้ปลอดภัย |
| **shoot-marker-reconcile** (nightly 03:00, `src/lib/shoot-marker-reconcile.ts`) | phase `markers` (**light hourly = fill-missing เท่านั้น** + deep nightly) | prep เติม marker ที่หาย, shoot-marker audit เนื้อหา — สองมือเขียนไฟล์เดียวกันผ่าน `upsertTextFile` ที่ non-atomic (google-drive.ts:1189-1224); รวมเป็น phase เดียว**ตีบ** race นี้ให้แคบลงมาก (ปิดสนิทเมื่อ route ฝั่ง UI ใช้ per-booking lease ด้วย — §4.4) |
| **footage-ready** (30-min, `src/lib/footage-ready.ts`, ปัจจุบัน OFF ใน prod) | phase `notify` (hook ท้าย pipeline) | เป็น read-only + send-once stamp; **quota win ของ phase นี้คือ shared resolution เท่านั้น** — tree walk ยังเป็น capped recursive walk เดิม (`FOOTAGE_READY_MAX_PER_RUN=5` คงไว้) เพราะ fast path ของ merge ย้าย folder ทั้งก้อนโดยไม่ enumerate ไฟล์ จึงไม่มี counts "ฟรี" ให้ notify (§2.2 P6) |

### 1.2 ตั้งใจแยกไว้ (ไม่รวม)

| Worker | เหตุผลที่แยก |
|---|---|
| **calendar-reconcile** (10-min, `src/lib/calendar-reconcile.ts`) | คนละ domain (Google Calendar API ไม่ใช่ Drive), cadence 10 นาทีเร็วกว่า pass hourly, มี concurrency model ของตัวเองที่ดีอยู่แล้ว (CAS updateMany + delete-duplicate, :267-285) และเป็น host ของ dead-man check (`maybeAlertStaleWorkers`, calendar/reconcile/route.ts:49) — ห้ามแตะจนกว่า dead-man จะย้ายบ้าน (ดู §6.6) |
| **backup** (daily, `/api/internal/backup/run`) | DB dump ล้วน ไม่แตะ Drive tree ไม่มี overlap กับใคร |
| **reminders** (daily, `src/lib/reminders.ts`) | โดย design **ไม่มี send-once** — ตั้งใจ nag ซ้ำทุกรอบ (reminders.ts:6-12) ถ้ายัดเข้า pass hourly อัตราส่ง digest คูณ 24 ทันที; เป็น DB-only detectors ไม่มี Drive read เลย ไม่มี quota win |
| **footage-sheet-sync** (10-min, FOOTAGE_WORKER_ENABLED=0 dormant) | Google Sheets domain; dormant อยู่แล้ว ไม่คุ้ม risk |
| **nas-manifest** (`/api/internal/nas-manifest`) | ไม่ใช่ worker — เป็น passive receiver ของ launchd agent บน Mac (scripts/nas-manifest-agent.sh) |
| **agn-restructure / rename-folders** (admin one-off) | เครื่องมือ manual ไม่ใช่ sweep — แต่ต้องเคารพ lease ของ reconciler (ดู §4.4) เพราะ agn-restructure ไม่มี reentrancy guard เลย (agn-restructure route.ts:17-33) และซ้ำ logic กับ marker pass เกือบบรรทัดต่อบรรทัด |

**ผลลัพธ์**: reconciler ดูดซับ supervised loop **7 ตัว** (prep-folders, folder-integrity, landing-lifecycle, video-merge, sound-merge, shoot-marker, footage-ready) + งาน external 2 ชิ้น (landing prune บนเครื่อง operator, landing-dedup ที่ไม่มี scheduler) — start.sh เหลือ 5 loops: `reconciler`, `calendar-reconcile`, `backup`, `reminders`, `footage-sheet-sync` (dormant)

---

## 2. โครงสร้าง reconcile pass — per-booking phase pipeline

### 2.1 Module layout ใหม่

```
src/lib/reconciler/
  index.ts        — runReconcilePass(opts) + schedule context (hourly | nightly19 | nightly03)
  resolve.ts      — resolveBookingDrive(b): resolution เดียวต่อ booking (§2.3)
  drive-view.ts   — DriveView: memoized Drive listing cache ต่อ run (§2.5)
  lease.ts        — DB lease rows: pass-level + per-booking (§4.1-4.3)
  guards.ts       — predicate/invariant รวมศูนย์ (§5)
  phases/
    ensure.ts     — จาก folder-integrity + prep-folders
    merge-video.ts— จาก video-merge (mirrorMove + fast path ใช้ซ้ำตรง ๆ)
    fold-sound.ts — จาก sound-merge
    markers.ts    — จาก shoot-marker-reconcile + prep's ensureMarkerFile
    landing.ts    — จาก landing-lifecycle + landing-dedup (per-booking + run-level)
    notify.ts     — จาก footage-ready
src/app/api/internal/reconcile/run/route.ts
scripts/reconciler-worker.js
```

### 2.2 ลำดับ phase ต่อ booking (ตายตัว — order คือ safety mechanism)

```
P0 resolve          → resolveBookingDrive(b)  (ครั้งเดียว ทุก phase ใช้ร่วม)
P1 ensure structure → box/EP/CAM/AUDIO/staging/photo + landing top-up (today-only)
P2 merge video      → landing → box  (MOVE: whole-folder fast path ก่อน, slow per-file mirror เมื่อจำเป็น)
P3 fold sound       → _SOUND-STAGING → box AUDIO  (COPY)
P4 markers          → hourly-light: fill-missing เท่านั้น (create-never-overwrite) · nightly-03: dedupe/normalize/content audit
P5 landing hooks    → บันทึกสถานะ empty/delivered ของ landing folder booking นี้ ไว้ให้ run-level cleanup (19:00 tick)
P6 notify hooks     → footage-ready settle evaluation (capped recursive walk เดิม)
```

เหตุผลของ order:

- **P1 ก่อน P2 + กติกา `createdThisRun` แบบ "consumable"** (แก้จาก v1 ตาม review R1): fast path v1.127 ของ video-merge (video-merge.ts:102-113 — ย้าย landing folder **ทั้งก้อน** เมื่อ box twin ไม่มี หรือเป็น empty twin ที่ trash ได้) คือ quota win หลักของ merge — ทั้ง shoot = 1 write ปัญหาที่ review ชี้: ถ้า P1 ensure box skeleton ก่อนเสมอ twin จะไม่ว่างทุกครั้ง → บังคับ slow per-file mirror ทุก booking ทุกชั่วโมง (antagonism เดิมของ folder-integrity vs video-merge กลายเป็น deterministic) **ทางออก: P2 ได้รับอนุญาตอย่างชัดแจ้งให้ consume — trash แล้ว whole-move ทับ — box/EP skeleton ที่อยู่ใน `createdThisRun`** เหตุผลที่ปลอดภัย:
  1. skeleton ใน `createdThisRun` ถูกสร้างโดย process นี้เอง ไม่กี่วินาทีก่อน และถูกสร้างแบบ empty เสมอ (`ensure*` create-only)
  2. per-booking lease (§4.2) กันผู้เขียนรายอื่นระหว่าง pass ของ booking นี้
  3. ก่อน trash ทุกครั้งยังต้อง re-read fresh ตาม §5 ข้อ 4 — ถ้ามีไฟล์โผล่เข้ามา (มือที่สามนอก lease) → abort fast path, fallback slow mirror

  หมายเหตุประวัติศาสตร์: incident 2026-07-22 คือการ**กลืน landing skeleton** (กันด้วย `isLandingShell`) — ไม่ใช่การ trash empty box twin; การ trash empty twin เพื่อเปิดทาง whole-move คือกลไก fast path โดยตั้งใจ ไม่ใช่ bug ทางเลือก (a) "ให้ P1 เว้น skeleton เมื่อ landing มี footage ค้าง" ถูกปัดตก เพราะทำให้ P1 ไม่ deterministic และไม่ครอบกรณี footage มาถึงระหว่าง P1 กับ P2
- **P2 ก่อน P3**: ปิด TOCTOU sound-สร้าง-AUDIO-ใน-EP-ที่-video-กำลัง-trash — sequential ต่อ booking เหมือน `runBookingMerge` (booking-merge.ts:52-53) ที่ทำแบบนี้อยู่แล้ว
- **P4 หลัง merge**: marker audit เห็น tree สุดท้ายของรอบ ไม่ audit ของที่กำลังจะย้าย — และ **hourly-light จำกัดที่ fill-missing เท่านั้น** (สร้างเมื่อไม่มี, ไม่ overwrite, ไม่ trash — semantics เดียวกับ `ensureMarkerFile` ของ prep) เพราะ dedupe/normalize มี `trashDriveItem` ซึ่งเป็น net-new prod behavior (SHOOT_MARKER_WORKER ไม่เคย enable ใน prod) จึงถูกกันไว้ที่ nightly-03 เท่านั้น (review R7); **scope ของ hourly P4 = booking ที่ span ครอบวันนี้เท่านั้น** (Tier A, §3.3) — prep เดิมก็ probe marker เฉพาะ today ไม่ใช่ทั้ง window −14..+30 ซึ่งจะเป็น `listFilesInFolder` quota เพิ่มโดยไม่จำเป็น; **delivered-booking marker repair (`ensureShootMarkerExists`) preserve ไว้ใน P4** — เป็น fill-missing โดยธรรมชาติ จึงอยู่ใน hourly-light ได้เลย
- **P6 ท้ายสุด**: อ่าน tree ที่นิ่งแล้วหลัง P2/P3 ของรอบนี้ — แต่ **ไม่ได้ counts ฟรีจาก merge**: fast path ย้าย folder ทั้งก้อนโดยไม่ enumerate ไฟล์ P6 จึงยังทำ recursive walk ของตัวเองแบบ capped (`FOOTAGE_READY_MAX_PER_RUN=5` คงไว้ + walk ผ่าน budget §3.2) — quota win ที่แท้จริงของ notify คือไม่ต้อง resolve booking ซ้ำ (`refresh:true` เดิมที่ footage-ready.ts:205-208 หายไปเพราะใช้ P0 resolution ร่วม) ไม่ใช่การเลิก walk (review R11)

### 2.3 P0 resolve — resolution เดียว แทนที่ 4 ชุด

`resolveBookingDrive(b)` คืน `{ box, landing, staging, photo, epFolders, resolvedViaSubfolder }` โดย:

1. **id-first ก่อนเสมอ**: `getDriveLink(b.driveFolders, key)` → `isFolderAlive(id)` (google-drive.ts:1048-1056) — order เดียวกับที่ 4 worker ทำอยู่แล้ว (video-merge.ts:221-228, sound-merge.ts:131-136, folder-integrity.ts:275-276, shoot-marker-reconcile.ts:524-530)
2. **AGN guards ครบทั้งสองตัว** จาก folder-integrity.ts:266-296 และ :302-310 — ห้ามเก็บ shared project-box id เป็น `box` เด็ดขาด (§5 ข้อ 7)
3. **name fallback** (findEpisodeFolderUrls / folderNameMatchesCode) ยังคงไว้ระหว่าง parallel-run และทุกครั้งเรียก `noteResolve('reconciler', slot, code, viaStored)` (id-first-metrics.ts) — gauge เดิมใช้วัดต่อจนกว่า fallback≈0 แล้วค่อยลบตาม improvement-plan step สุดท้าย
4. heal ลิงก์ผ่าน `rememberDriveLinks` ที่จุดเดียว — รวมศูนย์ผู้เขียนฝั่ง sweep ทั้งหมด (prep :168/180/242, folder-integrity :298/342/535, video :269/368, sound :174/285, landing :126/220, shoot-marker :285/565) — จบปัญหา "box key last-writer-wins" ระหว่าง video/sound **หมายเหตุขอบเขต**: ทั้งระบบมีผู้เขียน `driveFolders` **9+ ราย** — approve, rename-folders, agn-restructure, regenerate-booking-id ยังเขียนนอก `resolveBookingDrive` ต่อไป (สองตัว admin โดน pass-lease ที่ §4.4, approve เป็นความเสี่ยงที่ยอมรับ §8)

**Quota win ที่วัดได้**: วันนี้ booking วันนี้ 1 ตัวโดน resolve อย่างน้อย 4 ครั้ง/ชั่วโมง (prep + folder-integrity + video + sound) และ prep ยิง global `name contains` query ทุกครั้ง (google-drive.ts:954-976) — เหลือ 1 ครั้ง และ global query ยิงเฉพาะเมื่อ stored id ตาย

### 2.4 การ map sweep เดิม → phase

| Phase | ยกมาจาก | ฟังก์ชันที่ reuse ตรง ๆ |
|---|---|---|
| P1 ensure | `runFolderIntegrity` ทั้ง box create/rename fence (:329-379), EP (:384-439), CAM canonicalize (:449-466), landing today top-up (:469-540) + prep's staging (`ensureSoundStagingFolder`) + photo branch — **พร้อม skip ladder ของ prep ยกมา verbatim ทุกขั้น**: `camerasToPreCreate` ว่าง (block shot) → ไม่สร้าง CAM folders, photo-album booking → early return branch ของมันเอง, outlet ไม่อยู่ใน mapping → skip พร้อม log — พลาดขั้นเดียว P1 จะสร้าง CAM folders ให้ block shoot ซึ่งเป็น regression ที่ user มองเห็นทันที | `ensureShootCameraFolders`, `ensureFolderPath`, `renameDriveItem`, `ensureFlatShootFolders`, `isAppShapedName`, `groupEpisodeFoldersByLead`, `landingWindow`, `spend()` |
| P2 merge-video | `mergeBookingVideo` / core ของ `runVideoMerge` — **รวม whole-folder fast path** (twin ไม่มี/empty-consumable → ย้ายทั้งก้อน) และ slow per-file mirror | `mirrorMove` + `isLandingShell` + `findTwinFolder` (video-merge.ts:100, 136-145) ยกทั้งก้อน — มี test อยู่แล้ว (video-merge-mirror.test.ts) |
| P3 fold-sound | `mergeBookingSound` / core ของ sound-merge | `resolveAudioTarget` (sound-merge.ts:60-90), `bookingNeedsSound` (outlet-folders.ts:320), `copyFileToFolder` — **แก้ bug แถม**: dedupe `toCopy` กับตัวเองก่อน copy (ปิด same-name-siblings, map ระบุ) และเพิ่ม per-booking `err` field ที่ interface ขาด |
| P4 markers | hourly-light: `ensureMarkerFile` ของ prep + `ensureShootMarkerExists` (delivered repair) — **fill-missing เท่านั้น**; nightly-03: `reconcileGenericMarkers` (per-booking dedupe/normalize/audit); ส่วน AGN project pass (`reconcileShootMarkers` — project-scoped ไม่ใช่ booking-scoped) เป็น **run-level** ของ nightly-03 เท่านั้น | `dedupeShootInfoFiles` (nightly เท่านั้น), `resolveMarkerCode`, `markerDateHasBuddhistYear`, `renderBookingInfo`, `upsertTextFile` |
| P5 landing hooks | per-booking ส่วนของ `manageLandingFolders` cleanup: บันทึก `{code, lastShootDay, folderId, empty}` ลง run context — **consume โดย run-level cleanup ของ tick 19:00 เท่านั้น** (§2.6) | `hasRealFiles`, `codeFromFolderName` → ย้ายเข้า guards.ts; **อัปเกรดเป็น id-first**: ตรวจ `driveFolders.landing` ก่อน parse ชื่อ (ปิดช่อง "hand-renamed folder มองไม่เห็นตลอดกาล" ที่ map ระบุ) |
| P6 notify | `runFootageReadyScan` per-booking ส่วน — คง capped walk + `FOOTAGE_READY_MAX_PER_RUN=5` | `evaluateSettle`, `parseReadySnapshot`, `sendFootageReadyNotification`, CAS stamp เดิมทุกอย่าง + 3 gates เดิมครบ (§5 ข้อ 13) |

### 2.5 DriveView — listing เดียวต่อ folder ต่อ run

`drive-view.ts` ห่อ `listChildFolders` / `listFilesInFolder` / `listFilesRecursive` ด้วย memo `Map<folderId, …>` ต่อ run และ **อัปเดต cache เมื่อ phase เขียน** (create/move/trash mutate view เหมือนที่ FakeDrive ทำ — สังเกตว่า FakeDrive คือ reference implementation ของ semantics นี้อยู่แล้ว):

- landing root (`PRODUCTION_TEAM_ROOT`) list **ครั้งเดียวต่อ run** — วันนี้ video-merge ทำแบบนี้แล้ว (video-merge.ts:194) แต่ landing-lifecycle (:144), landing-dedup, folder-integrity ต่าง list เอง
- `createdThisRun: Set<folderId>` — ของที่ P1 เพิ่งสร้างในรอบนี้ = **known-empty + consumable โดย P2 fast path** (§2.2) — ไม่ใช่ "ห้าม trash" แบบ v1 ซึ่ง review ชี้ว่า guard กลับด้านและฆ่า fast path
- invalidation แบบ conservative: การเขียนที่ไม่รู้ผลชัด (เช่น `ensureFolderPath` ผ่าน spend) → evict key นั้นทิ้ง
- **ขอบเขตแข็งของ DriveView: ใช้เพื่อ read + planning เท่านั้น** — ห้ามใช้เป็นหลักฐานตัดสินใจ trash (ดูกฎ fresh-read §5 ข้อ 4) เพราะ cache อายุทั้ง pass (นานได้หลายนาที) จะขยาย TOCTOU ของ destructive op จากวินาทีเป็นทั้ง pass: crew ที่ upload footage ช้าเข้า folder วันเก่า (เคสเดียวกับเหตุผล lookback −45d) ระหว่าง pass ต้องไม่โดน trash เพราะ cache บอกว่า empty (review R9)

### 2.6 Run-level operations (ไม่ผูก booking)

Run-level landing operations **ไม่ได้วิ่งทุกรอบ** — ผูกกับ tick ตาม §3.1 ชัด ๆ (แก้ contradiction §2.6-vs-§3.1 ของ v1 ที่ implementer ต้องเดา):

| Operation | Tick ที่วิ่ง | Predicate |
|---|---|---|
| landing **cleanup** (จาก P5 hooks) | **19:00 เท่านั้น** | past-cutoff (`LANDING_KEEP_PAST_DAYS`, ageing จาก `shootEndDate ?? shootDate`) AND empty (`hasRealFiles` false) — กติกาเดิมเป๊ะ (§5 ข้อ 2) |
| landing **prune** | **12:00 เท่านั้น** (absorb งาน scheduled task บนเครื่อง operator; local task เลิกที่ Stage 4c) | **past-only: `lastShootDay < today` AND empty — ห้ามใช้ "non-today" เด็ดขาด** (§5 ข้อ 3) |
| landing **create NEXT-day** | 19:00 — **หลัง cleanup+prune เสมอ** (ordering pinned §3.1) | next-day-only (§5 ข้อ 1) |
| landing-**dedup** (twins collapse) | 19:00 (nightly พอ) | กติกาเดิมของ landing-dedup |
| AGN project-box marker pass | nightly-03 เท่านั้น | query ไม่มี date bound, แพง (shoot-marker-reconcile.ts:193-212) — ดู open question §9 |
| digest + audit + heartbeat + id-first gauge | ทุก tick | idiom ของ folder-integrity ทั้งชุด (§3.4) |

**ทำไม prune ต้อง past-only**: `pruneLandingToToday` เดิม trash empty **non-today** folder — ซึ่งรวม folder ของ*พรุ่งนี้*ที่เพิ่งสร้างตอน 19:00 ด้วย ทุกวันนี้ปลอดภัยเพราะ*บังเอิญ*ลำดับเวลา (prune ~12:00 < create 19:00) เท่านั้น ถ้า schedule ขยับ (หรือมีใครรัน prune ถี่ขึ้น) drop zone ของพรุ่งนี้โดนลบทุกคืน (review R6) — v2 จึงนิยาม prune ของ reconciler ใหม่เป็น past-only ซึ่ง (a) ให้ผลเหมือนเดิมที่ 12:00 (สิ่งเดียวที่ non-today-but-not-past คือ folder อนาคต ซึ่งไม่ควรโดน prune อยู่แล้ว) และ (b) ปลอดภัยต่อการรันเวลาไหนก็ได้ — ความถี่ไม่ใช่เงื่อนไขความปลอดภัยอีกต่อไป

---

## 3. Scheduling model

### 3.1 หนึ่ง worker script, ตาราง schedule เดียว

`scripts/reconciler-worker.js` แทน **7 supervised loops** (+2 งาน external) ด้วย schedule table ใน process เดียว:

| Tick | เวลา | Phases | แทน worker เดิม |
|---|---|---|---|
| **hourly light** | ทุก 60 นาที (RECONCILER_INTERVAL_MS, floor 5 นาที) | P0-P6 + landing top-up today-only (P4 = fill-missing, Tier A เท่านั้น) | prep-folders, folder-integrity, video-merge (plain), sound-merge, footage-ready |
| **midday prune 12:00 BKK** | RECONCILER_PRUNE_HOUR=12 | hourly ทั้งหมด + run-level prune (**past-only**, §2.6) | scheduled task ~12:00 บนเครื่อง operator (เลิกที่ Stage 4c) |
| **nightly deep 19:00 BKK** | RECONCILER_LANDING_HOUR=19 | hourly ทั้งหมด + run-level: cleanup past-empty → prune past-only → **แล้วจึง** create NEXT-day → landing-dedup (ลำดับนี้ pinned — สร้างของพรุ่งนี้เป็นขั้นสุดท้ายเสมอ ไม่มีทางโดน trash ในรอบเดียวกัน) | landing-worker |
| **nightly deep 03:00 BKK** | RECONCILER_MARKER_HOUR=3 | hourly ทั้งหมด + P4-deep ทั้ง window (dedupe/normalize/content audit) + AGN project marker pass | shoot-marker-worker (dormant — absorb แทนการ enable ของเดิม) |
| **NAS-gated nudge** | event: DSM syncing→uptodate | P2+P3 เท่านั้น (`phases=merge`) | video-merge GATED mode |

**Tick collision rule (ระบุชัด — implementer ห้ามเดา)**: nightly/midday tick **subsume** hourly tick ของชั่วโมงนั้น — scheduler ยิง run เดียวต่อชั่วโมงเสมอ (nightly = superset ของ hourly ตามตาราง) ไม่มีการยิงสองครั้งแล้วให้ตัวหลัง 409; DSM nudge ที่ชนกับ tick ที่กำลังวิ่งจะแพ้ lease แล้วหายไปจนรอบชั่วโมงถัดไป (ความเสี่ยงที่ยอมรับ §8)

รายละเอียด implementation:
- **แก้ timer drift**: ยกเลิก pattern `setTimeout(wait) → setInterval(24h)` ของ landing/shoot-marker worker (drift สะสม) — หลังจบแต่ละ nightly run คำนวณ `msUntilNextRun()` ใหม่ทุกครั้ง (re-anchor); BKK = fixed UTC+7 เหมือนเดิม (ไม่มี DST) และรวม `bangkokTodayRange` / `bangkokDayRange` / `bkkDayKey` สามสำเนาให้เหลือ implementation เดียวใน guards.ts
- **DSM gate ยกมาทั้งก้อน** จาก scripts/video-merge-worker.js:110-172 (poll SYNO.CloudSync `list_conn`, minGap, fallback) — แค่เปลี่ยน endpoint เป็น `/api/internal/reconcile/run?phases=merge&dryRun=0`
- worker เป็น thin HTTP poller เหมือนเดิม (127.0.0.1:3000, `x-reconcile-secret`, chain `RECONCILER_SECRET || PREP_FOLDERS_SECRET || NEXTAUTH_SECRET || AUTH_SECRET` — คง PREP_FOLDERS_SECRET ไว้ใน chain เพื่อไม่ต้องหมุน secret ตอน cutover)
- **Fetch timeout + no-re-fire (review R10)**: worker ตั้ง fetch timeout `RECONCILER_FETCH_TIMEOUT_MS` (default 320000 — ยาวกว่า route `maxDuration=300`) และเมื่อเจอ **timeout หรือ 504 ต้องไม่ re-fire เด็ดขาด** — proxy 504 ไม่ได้แปลว่า pass ตาย (pass ยังวิ่งต่อฝั่ง server และ lease ยัง renew อยู่) แค่ log แล้วรอ tick ถัดไป + ตรวจผลจาก digest/audit rows ตาม "504-then-check-digest" pattern ที่เป็น ops footgun ที่บันทึกไว้แล้ว; lease (§4.1) เป็นตัวกันไม่ให้ tick ถัดไปซ้อนกับ pass ที่ยังวิ่งอยู่จริง

### 3.2 Budget + rotation

**Budget (แก้จาก v1 ตาม review R5)** — `spend(label, fn)` (folder-integrity.ts:205-215) กลายเป็นของทั้ง pass พร้อม 429 retry เดิม แต่แบ่ง sub-budget แบบไม่รัดคอ merge:

| Sub-budget | Env | Default | เหตุผล |
|---|---|---|---|
| ensure | RECONCILER_ENSURE_MAX_WRITES | 60 | สอดคล้อง maxWrites เดิมของ folder-integrity + บทเรียน quota exhaustion 2026-07-21 |
| **merge (P2+P3)** | RECONCILER_MERGE_MAX_WRITES | **400** | slow path จ่าย 1 write/ไฟล์ — 40 แบบ v1 คือ cap แค่ shoot เล็ก 1 งาน ทั้งที่ video/sound-merge เดิม**ไม่มี budget เลย** (map: "no Drive-quota cap in either"); **whole-folder move นับเป็น 1 write** ดังนั้นวันปกติที่ fast path ทำงาน budget นี้แทบไม่ถูกแตะ — 400 คือเพดานสำหรับวัน slow-path หนัก ๆ ไม่ใช่ throughput ปกติ |
| markers | RECONCILER_MARKER_MAX_WRITES | 20 | fill-missing hourly เบามาก; nightly deep ใช้ก้อนเดียวกัน |
| landing/notify | RECONCILER_LANDING_MAX_WRITES | 40 | create next-day + cleanup + dedup |

- **Budget exhaustion ต้องมองเห็น**: phase ที่ชน cap emit action `{verb:'deferred', code, phase, reason:'budget'}` ลง audit row + digest — backlog โผล่ใน digest แทนที่จะเงียบหาย (booking ที่ deferred ถูกหยิบก่อนในรอบถัดไป)
- **Plan-generation mode ไม่ cap** (review R8): เมื่อ `dryRun=1` + `plan=1` spend() นับแต่ไม่ตัด — plan ต้องเห็นความต่างทั้งหมด ไม่ใช่ truncated ที่ทำให้ diff ปลอม (ใช้ใน Stage 1/3)

**Two-tier candidates + rotation (แก้จาก v1 ตาม review R4)** — cursor พังคุณสมบัติสำคัญของ prep (today's shoots ได้ folder *ทุกชั่วโมง*) และ throughput ของ merge ถ้าใช้ pass-wide:

- **Tier A — today/imminent**: booking ที่ span (`shootDate..shootEndDate ?? shootDate`) ครอบวันนี้ หรือเริ่มพรุ่งนี้ → **process ทุก tick แบบ unconditional** — ไม่ผ่าน cursor ไม่ผ่าน limit ทุก phase (คุณสมบัติ prep-parity: กล้องออกกองวันนี้ต้องมี folder ภายในชั่วโมง)
- **Tier B — back/forward window**: ที่เหลือใน window (§3.3) → rotation cursor (folder-integrity.ts:58-67) + `limit` ใช้กับ **P1/P4-deep เท่านั้น**; **P2/P3 exempt จาก rotation** — เดิน merge candidates ทั้ง window ทุก tick เหมือน video-merge เดิมที่ไม่มี take-limit (ส่วนใหญ่เป็น no-op ราคาถูก: landing folder ไม่มี/ว่าง → skip ไม่มี write)
- cursor แก้ 2 จุดจาก map: (1) bug undercount — booking ที่โดน skip (photo-album/unmapped) ต้องนับเข้า cursor advance ด้วย (:249 vs :252), (2) persist cursor ลง `SystemHeartbeat` row key `cursor:reconciler` (note เก็บ index) เพื่อไม่ reset เป็น 0 ทุก deploy — table นี้ upsert per-key อยู่แล้ว (heartbeat.ts:47-59)

### 3.3 Candidate query เดียว

Query เดียวต่อรอบ ครอบ **window กว้างสุดที่ phase ใดต้องใช้** แล้วให้ phase filter ในหน่วยความจำ — **DB round-trip 1 ครั้ง/รอบ แทน 5**:

```
status IN (CONFIRMED, COMPLETED) AND deletedAt IS NULL AND bookingCode IS NOT NULL
AND <span-overlap window: now − 45d .. now + 30d>
```

- **Merge lookback −45d คงไว้ตั้งแต่วันแรก** (แก้จาก v1 ตาม review R3 — v1 default −14d จะทำให้ booking ที่ footage มาช้ากว่า 14 วันหลัง shoot ซึ่งเป็นเคส late-NAS ที่บันทึกไว้ **เลิก auto-merge เงียบ ๆ**): P2/P3 ใช้ window เต็ม −45d..now; P1/P4 filter เหลือ −14..+30 ในหน่วยความจำ (ตาม folder-integrity เดิม); P6 filter เหลือ −3d (ตาม footage-ready เดิม); P5/landing ใช้ `landingWindow`
- **Span-aware OR ต้องเขียนแบบนี้** (Prisma — implementer จะพลาดถ้า filter `shootDate` อย่างเดียว เพราะวัน 2/3 ของ multi-day shoot หลุด window):

```ts
where: {
  AND: [
    { shootDate: { lte: windowEnd } },
    { OR: [
        { shootEndDate: { gte: windowStart } },
        { AND: [ { shootEndDate: null }, { shootDate: { gte: windowStart } } ] },
    ]},
  ],
}
```

  (นิยาม: booking span ทับ window เมื่อ `shootDate ≤ windowEnd` และ `(shootEndDate ?? shootDate) ≥ windowStart`) — semantics เดียวกับ `landingWindow` (folder-integrity.ts:167-172) ที่ v1.146 ใช้แก้ multi-day asymmetry
- Phase filter เพิ่มเติมในหน่วยความจำ: P3 เฉพาะ `bookingNeedsSound`, P6 เฉพาะ `readyNotifiedAt IS NULL` + 3 gates (§5 ข้อ 13)

### 3.4 Reporting — idiom เดิมของ folder-integrity ยกทั้งชุด

- audit row `drive.reconciler` (แบบ `drive.folder_integrity` :551-572, cap actions 40/warnings 20 — cap เฉพาะ audit row; plan mode ไม่ cap ตาม §3.2)
- per-run email เมื่อ newsworthy (digestKey dedupe + 12h heartbeat, route.ts:93-98)
- daily Discord digest จาก audit rows (ไม่ใช่ in-memory เพราะ redeploy บ่อย) + `SystemHeartbeat` throttle 20h key `digest:reconciler` (folder-integrity.ts:659-705)
- **id-first gauge: reconciler เป็นเจ้าของตั้งแต่ Stage 4a** (แก้จาก v1 ตาม review R12) — `snapshotIdFirst` + เขียน `drive.id_first_gauge` row + daily digest ย้ายมาวิ่งใน reconcile route/pass เพราะที่เดิม (folder-integrity route) **หยุดวิ่งตั้งแต่ 4a**; สัญญาณ "watch digest fallback≈0 then remove fallbacks" คือ endgame ของ improvement plan — ห้ามให้มัน orphan ระหว่าง cutover (ระบุใน cutover table §6.5 ด้วย)

---

## 4. Concurrency + idempotency

### 4.1 Route เดียว + pass-level DB lease

`GET/POST /api/internal/reconcile/run` params: `dryRun` (**default TRUE** — เลิกความสับสน default-apply ของ footage-sync/calendar), `phases=ensure,merge,sound,markers,landing,notify`, `code=<ProductionID>`, `limit`, `maxWrites`, `report=1`, `plan=1`, `deep=landing|markers`; `maxDuration=300`

**Mutual exclusion = DB lease row (แทน advisory lock ของ v1 — review R2)**: ใช้ row สไตล์ `SystemHeartbeat` (table เดิม upsert per-key ได้อยู่แล้ว — heartbeat.ts:47-59):

- **Lease row**: key `lease:reconciler:pass` เก็บ `{owner: runId, renewedAt}` (runId = uuid ต่อ run; owner เก็บใน note)
- **Claim = CAS**: `updateMany({ where: { key, renewedAt: { lt: now − LEASE_TTL } }, data: { note: runId, renewedAt: now } })` → `count === 1` = ได้ lease; `count === 0` = มี run อื่นถืออยู่ → log + skip รอบ (non-blocking try เสมอ) — row แรกสร้างด้วย `create` + catch unique-violation (บทเรียน upsert-race จาก v1.146 hardening)
- **Renewal (review R10)**: pass **renew lease ระหว่าง booking ทุกตัว** (floor ทุก 60 วินาที): `updateMany({ where: { key, note: runId }, data: { renewedAt: now } })` — ถ้า count 0 = lease ถูกแย่ง (นานผิดปกติจน TTL ขาด) → pass abort อย่างสุภาพ ไม่เขียนต่อ
- **Staleness เป็น renewal-interval-based ไม่ใช่ total-duration-based**: `LEASE_TTL` = 5 นาที (≈5× renewal interval) — pass ที่วิ่งถูกต้องนาน 20+ นาที (รวมงาน 7 workers + 429 retry) ถือ lease ได้เรื่อย ๆ ผ่าน renewal; guard 15-min-expiry แบบ v1 ใช้ไม่ได้เพราะ pass จริงยาวกว่านั้นได้ → overlap race กลับมา (review R10)
- **Crash-release ได้ฟรี**: process ตาย → renewal หยุด → TTL ขาดใน 5 นาที → tick ถัดไป claim ได้เอง — ไม่มี lock ค้างข้าม restart
- `reconcilerRunningSince` module timestamp คงไว้เป็น in-process short-circuit ราคาถูกชั้นแรกเท่านั้น (armed เฉพาะ `!dryRun`); lease คือ authority

Lease ตัวเดียวแทน route guard เดิม **8 ตัว** (boolean 6 + timestamp 2 ฝั่ง Drive-tree; boolean ของ footage-sync อยู่นอก scope จึงรอด) เพราะทุก phase แตะ tree ชุดเดียวกันจึง**ควร** serialize กันอยู่แล้ว นี่คือแก่นของ item 4: mutual exclusion เกิดจากการอยู่ใน pass เดียว ไม่ใช่จาก guard ที่มองไม่เห็นกัน

### 4.2 Per-booking merge button (UI) อยู่ร่วมกับ pass

ปัจจุบัน `startMergeJob` (booking-merge.ts:88-100) bypass ทุก guard — ช่องโหว่คมสุดตาม map ปิดด้วย:
1. refactor `runBookingMerge` ให้เรียก **phase runner เดียวกัน**: `reconcileBooking(bookingId, {phases:['merge','sound'], dryRun})` — โค้ดเดินทางเดียว ผล deterministic เท่ากันไม่ว่ากดปุ่มหรือรอ pass
2. **Per-booking lease**: key `lease:booking:<bookingCode>` semantics เดียวกับ §4.1 (CAS claim, renew ระหว่างทำงาน, TTL 5 นาที, crash-release ผ่าน TTL) — ปุ่ม UI claim ก่อนเริ่ม job; pass ใช้ try-claim ต่อ booking — ถ้าไม่ได้ = booking นั้น emit `deferred` (reason `lease`) รอรอบหน้า ไม่ block ทั้ง pass
3. **UX contract เมื่อปุ่มแพ้ lease** (เดิม underspecified): route ตอบ **HTTP 409** + body error ภาษาไทย **"ระบบกำลังกวาดงานนี้อยู่ ลองอีกครั้งใน 1-2 นาที"** — ปุ่มแสดงข้อความนี้ตรง ๆ ไม่ retry อัตโนมัติ
4. `mergeJobs` Map เดิมคงไว้เป็น UX layer (สถานะปุ่ม) เท่านั้น

### 4.3 ทำไม DB lease ไม่ใช่ advisory lock (บันทึกกันคนหยิบกลับมาใช้)

v1 เสนอ `pg_try_advisory_xact_lock` ผ่าน `prisma.$executeRaw` — review ชี้ว่าเป็น **no-op ทั้งคู่**: xact-scoped lock ปล่อยเมื่อ transaction ของ statement นั้น commit ซึ่งกับ `$executeRaw` นอก explicit transaction คือ**ทันที** และ pooled connection ของ Prisma ทำให้ `pg_advisory_unlock` ภายหลังอาจวิ่งบน connection คนละตัว — pattern v1.146 ในหน่วยความจำใช้กับ critical section สั้น ๆ **ใน** transaction ไม่ใช่ pass ที่ทำ Drive I/O หลายนาที ทางเลือก session-level lock บน dedicated non-pooled connection ทำได้แต่เพิ่ม connection management ทั้งก้อน — **DB lease row ให้ทุกอย่างที่ต้องการในราคา 1 query ต่อ claim/renewal**: cross-process จริง (กัน blue/green deploy overlap, staging ชี้ drive ผิด, admin tools ใน process อื่น), crash-release ผ่าน TTL, ไม่มี dependency ใหม่ และ test ได้ตรง ๆ ด้วย Prisma ปกติ

### 4.4 Manual admin tools + marker-writing routes (review R13)

- `agn-restructure` และ `rename-folders`: try-claim **pass-level lease** ก่อน apply (dry-run ไม่ต้อง) — ถ้า reconciler กำลังวิ่ง คืน 409 พร้อมข้อความไทยแบบ §4.2 ปิดช่อง double-move marker ที่ map ระบุ
- **Marker writers ฝั่ง UI ต้องถือ per-booking lease**: `refreshShootMarker` จาก booking-edit (bookings/[id]/route.ts:371), producer-edit (:139), regenerate-booking-id (:445) — ทั้งสามเป็น fire-and-forget อยู่แล้ว จึงเปลี่ยนเป็น **try-claim per-booking lease ก่อนเขียน**: ได้ → เขียนแล้วปล่อย; ไม่ได้ (P4 กำลังจับ booking นี้) → **skip เงียบ ๆ** — marker ที่ไม่ได้เขียนจะถูก P4 เติม/แก้ให้เองรอบถัดไปเพราะ content มาจาก DB state เดียวกัน
- **Approve route ไม่บังคับ lease** (ยอมรับ — §8): บังคับให้ approve รอ pass = delay งาน approve หลายนาที ไม่คุ้ม ดังนั้น claim ของ design นี้ต่อ marker race คือ **"ตีบลงมาก ไม่ใช่ปิดสนิท"** — residual race (approve vs P4) self-heal ผ่าน nightly dedupe ของ P4-deep ซึ่ง converge ที่ content ล่าสุดจาก DB เสมอ

### 4.5 Idempotency

ทุก phase idempotent อยู่แล้วโดย construction: `ensure*` find-or-create + `dedupeEnsure` + `oldestChildFolder` (google-drive.ts:319-342, 886-895), `upsertTextFile`, CAS `readyNotifiedAt`, dup-rule leave-in-landing กติกาเพิ่มเดียว: **dryRun ต้อง faithful** — แก้ 3 จุดที่ dry-run โกหก (video fast-path movedFolders=0 + นับ moved ผิดเมื่อ twin หาย, sound AGN dedup mis-scope, prep delivered-check bypass) เพราะ parallel-run verification (§7.2) ต้องเชื่อ plan ได้ และ plan mode ต้องไม่โดน budget ตัด (§3.2)

---

## 5. Guard consolidation — invariants ที่ต้องรอด verbatim

รวมเป็น `src/lib/reconciler/guards.ts` (predicate ล้วน, unit-testable) + checklist ที่ reviewer ต้องไล่ตอน migrate แต่ละ phase:

1. **Landing next-day-only create** (landing-lifecycle.ts:9-11, docs/landing-folder-policy.md) — booking ที่ confirm ล่วงหน้าหลายสัปดาห์ **ไม่มี** drop folder จนคืนก่อน shoot; `?offset` clamp ≥0; `ensureLandingForBooking` เป็นทางเดียวสร้างย้อนหลัง
2. **Landing cleanup = past-cutoff AND empty** (`hasRealFiles` regex `/^_SHOOT\b.*\.txt$/i`, landing-lifecycle.ts:37, 52-55) — folder มี footage = `keptRecent` ห้าม trash เด็ดขาด
3. **Landing prune = past-only** (ใหม่ v2, review R6) — predicate คือ `lastShootDay < today` AND empty **เท่านั้น ห้ามใช้ "non-today"** เพราะ non-today รวม folder ของพรุ่งนี้ที่สร้างตอน 19:00; past-only ทำให้ prune ปลอดภัยไม่ว่ารันเวลาไหน/ถี่แค่ไหน (§2.6)
4. **Fresh-read-before-trash** (ใหม่ v2, review R9) — **ทุก call site ของ `trashDriveItem` ใน reconciler ต้อง re-read target สด ๆ (bypass DriveView) ทันทีก่อนลงมือ**: landing cleanup re-check `hasRealFiles` สด, empty-twin consume re-list children สด, marker dedupe re-read file list สด — DriveView เป็น cache สำหรับ read/planning เท่านั้น (§2.5); ถ้า fresh read ขัดกับ plan → abort action นั้น + log `abortedStale`
5. **Ageing จาก `shootEndDate ?? shootDate`** + span-today semantics (v1.146 multi-day fix, :133-142, :259-271) + span-aware candidate query (§3.3)
6. **`isAppShapedName` rename gate** (folder-integrity.ts:111-116 + fence 4 ชั้น :350-379: resolvedViaSubfolder, shape, renameEnabled, parent-in-tree + sibling collision scan) — และ**รวม** `appShapedEp` (:432) เข้าเป็น `isAppShapedEpName` ใน guards.ts — จบปัญหา 2 predicate สำหรับ safety property เดียว
7. **AGN box-poisoning refusal ทั้งคู่** (folder-integrity.ts:266-296, 302-310) — ห้ามเก็บ shared project-box id เป็น booking box; `folderNameMatchesCode` re-validation; consequence คือ video-merge จะ interleave footage หลาย booking — นี่คือ near-miss ที่จับได้ก่อน deploy v1.151
8. **`isLandingShell`** (video-merge.ts:100, 152-160) — ห้าม relocate empty landing subtree (regression 2026-07-22); **`createdThisRun` semantics (v2)**: box/EP skeleton ที่ P1 สร้างในรอบนี้ = known-empty + **consumable โดย P2 fast path** (trash-then-whole-move — §2.2) ภายใต้ข้อ 4 (fresh-read ก่อน trash) — ไม่ใช่ "ห้าม trash" แบบ v1
9. **`findTwinFolder` immutable-lead matching** (video-merge.ts:136-145) — refuse fuzzy-match ชื่อไม่มี ' · ' (POP-PIV-260722-01 EP-split)
10. **Dup = leave-in-landing** (video-merge.ts:71-76) — `name|size` ชนกัน ไม่ overwrite ไม่ trash รอ manual review
11. **`resolveMarkerCode` raw-before-normalize** (shoot-marker-reconcile.ts:69-73) — 4 collision-pair bookings ใช้ legacy [TYPE] code; normalize ก่อน = trash marker จริงเป็น stale (v1.146 fix + tests)
12. **`markerDateHasBuddhistYear` line-anchored** + no-rewrite-เมื่อ-render-ยัง-Buddhist (:96-110, :413-414) — กัน rewrite loop รายคืน
13. **Send-once stamps + notify gates ครบสามตัว** (เพิ่มจาก v1 ตาม review R3): `readyNotifiedAt` CAS updateMany-where-null stamp หลัง delivered เท่านั้น (footage-ready.ts:234-243); branch no-producer-email **ตั้งใจ** consume stamp (:302-308); `deliveredAt` non-null suppress; ปุ่ม 📣 manual stamp field เดียวกัน — **และ gates ก่อน evaluate ทุกครั้ง (footage-ready.ts:164-176): (a) `cancelRequestedAt IS NULL`, (b) suppress เมื่อมี Upload PENDING/UPLOADING อายุ <24h, (c) `latestNasState()` gating** — ตัด gate ใดออกจะ notify บน booking ที่ขอยกเลิก/กำลัง upload กลางคัน
14. **Staging isolation**: `assertStagingDriveIsolation` (app-env.ts:77-85) fail-closed — **ปรับปรุง**: เรียกครั้งเดียวต้น pass ให้เป็น clean skip แทนที่จะระเบิดเป็น per-booking error กลาง sweep (map ระบุ quirk นี้)
15. **Fail-closed footage probe**: `classifyFootageTreeFolder` = 'unknown' → treat as footage-exists, ห้ามสร้าง box (folder-integrity.ts:313-328) — 429 storm ต้องไม่อ่านเป็น "safe to create"
16. **Landing renames report-only ตลอดกาล** (folder-integrity.ts:481-487) — drive mirror ไป NAS ทาง SMB, mid-sync rename = "(1)" duplicates (v1.111); `landingRenamed` dead counter ลบทิ้ง
17. **Sub-budgets + 429 retry + `deferred` visibility** (§3.2) — exhaustion ต้องโผล่ใน digest
18. **ห้าม act บน name-search result จากที่อื่นใน drive** — เฉพาะ id ที่ resolve เพื่อ booking นี้ (folder-integrity.ts:25-27) + `oldestChildFolder` deterministic selection
19. **ops intent outranks canonical tidiness** (folder-integrity.ts:28-30) — folder ที่ crew ตั้งชื่อเอง report ไม่แก้

Predicate ซ้ำซ้อนที่ต้อง unify ใน guards.ts: marker regex 4 สำเนา (shoot-marker-reconcile.ts:53-54, shoot-marker.ts:31/135, prep-folders.ts:32, folder-integrity.ts:55, agn-restructure.ts:41-43), `hasRealFiles`/`codeFromFolderName` 2 สำเนา (landing-lifecycle vs landing-dedup), `isShootInfo`/`isAudio` polarity คู่ (video-merge.ts:47 vs sound-merge.ts:40), BKK-day helpers 3 สำเนา (§3.1), fail-closed probe 2 สำเนา (folder-integrity.ts:313-328 vs :514-520)

---

## 6. Rollout plan

### 6.1 Stage 0 — prerequisite: ทำ kill-switch เดิมให้ใช้ได้จริงก่อน

**Blocking fact จาก map**: prep-folders / sound-merge / video-merge **ไม่มี kill-switch ที่ทำงานใน prod** — compose ไม่ pass env เหล่านั้นเข้า container เลย (docker-compose.portainer.yml ไม่มี PREP_FOLDERS_*/SOUND_MERGE_*/VIDEO_MERGE_* และไม่มี env_file) ต้องแก้ก่อน parallel-run เพราะ promotion step อาศัยการปิด legacy ทีละตัว:
- เพิ่ม `PREP_FOLDERS_WORKER_ENABLED`, `SOUND_MERGE_WORKER_ENABLED`, `VIDEO_MERGE_WORKER_ENABLED`, `VIDEO_MERGE_POLL_MS/MIN_GAP_MS/FALLBACK_MS` เข้า docker-compose.portainer.yml **และ** docker-compose.staging.yml (staging มีช่องโหว่เดียวกัน)
- เพิ่ม `RECONCILER_ENABLED` (default 0), `RECONCILER_APPLY` (default 0), `RECONCILER_RENAME` (default 0), sub-budget vars (§3.2), hour vars — สองชั้นแบบ folder-integrity (apply แยก rename) ซึ่งพิสูจน์แล้วว่า rollout ปลอดภัย
- deploy + ยืนยัน toggle ทำงาน (ปิด/เปิด 1 ตัว ดู log)

### 6.2 Stage 1 — staging parallel-run (state-convergence gate)

v1 เสนอ diff action-list ของ reconciler กับ audit rows ของ legacy — **ใช้ไม่ได้จริง** (review R8): legacy prep/video/sound **ไม่เขียน audit row เลย**, folder-integrity บน prod เป็น report-only จึงไม่เขียนเช่นกัน (audit เฉพาะ `!dryRun && changed`), landing เขียนเฉพาะ counts>0 — ข้อมูลฝั่ง legacy ไม่มีให้ diff และ timer boot-relative ทำให้ "ชั่วโมงเดียวกัน" fuzzy จน noise ท่วม gate

**Gate ใหม่ = end-of-hour Drive-state convergence**:
- staging: legacy workers วิ่งตามปกติ; **หลัง** legacy sweep ของชั่วโมงนั้นจบ reconciler วิ่ง `dryRun=1&plan=1` (spend ไม่ cap — §3.2) บน state ที่ legacy เพิ่ง converge แล้วเขียน plan เป็น audit row `drive.reconciler_plan` (canonical action list — §7.2)
- **เกณฑ์ผ่าน: plan ต้องว่าง** (reconciler เห็นด้วยว่า state ที่ legacy ทิ้งไว้ถูกต้องแล้ว — ไม่มี action ค้างอยากทำ) ต่อเนื่อง ≥ 5 วันทำการ ยกเว้น divergence ที่ whitelist เป็นลายลักษณ์อักษร (เช่น การแก้ dry-run infidelity, multi-day window ที่กว้างขึ้น, marker fill ที่ prep พลาดเพราะ today-only) — นี่คือ snapshot-convergence ไม่ใช่ action-equality จึงไม่ไวต่อ ordering/timing ของ legacy
- **ทางเลือกเสริม (ไม่ block)**: instrument legacy workers ให้ emit canonical action list (PR เล็ก) — ทำเมื่ออยากได้ diff ละเอียดระดับ action เพิ่มจาก convergence gate; ถ้า convergence gate ผ่านสม่ำเสมอ ไม่จำเป็น
- FOOTAGE_READY_AUDIENCE=admin บน staging อยู่แล้ว (docker-compose.staging.yml:134) — phase notify ทดสอบได้โดยไม่ email producer จริง

### 6.3 Stage 2 — staging apply

`RECONCILER_ENABLED=1` + `RECONCILER_APPLY=1` บน staging, ปิด legacy Drive-tree workers ทั้งหมดบน staging — วิ่ง 1 สัปดาห์ ดู digest + folder-complaint playbook

### 6.4 Stage 3 — prod shadow

reconciler `dryRun=1&plan=1` บน prod (ไม่เขียนอะไร), legacy ทำงานตามปกติ — ใช้ convergence gate แบบ §6.2 (plan-on-converged-state ต้องว่าง); email digest เมื่อ plan ไม่ว่าง; อย่างน้อย 3 วัน

### 6.5 Stage 4 — prod cutover ทีละกลุ่ม phase (แต่ละ step: เปิด flag → redeploy → ดู digest 48h → step ถัดไป)

| Step | เปิดใน reconciler | ปิด legacy | หมายเหตุ |
|---|---|---|---|
| 4a | phases=ensure,markers-light (**fill-missing เท่านั้น — ไม่มี trash ใด ๆ ใน step นี้**) + **reconciler เป็นเจ้าของ `snapshotIdFirst` + `drive.id_first_gauge` + daily Discord digest ตั้งแต่ step นี้** (route folder-integrity เดิมหยุดวิ่งแล้ว — R12) | PREP_FOLDERS_WORKER_ENABLED=0, FOLDER_INTEGRITY_WORKER_ENABLED=0 | เสี่ยงต่ำสุด — create/rename only จริง ๆ (dedupe/normalize/trash ของ markers ถูกกันไว้ที่ 4d) |
| 4b | + merge,sound (+ DSM gate) — fast path + budget ใหญ่ตาม §3.2 | VIDEO_MERGE_WORKER_ENABLED=0, SOUND_MERGE_WORKER_ENABLED=0 | ระวัง 504-then-check-digest pattern — อย่า re-fire (§3.1) |
| 4c | + landing (19:00 + prune 12:00 past-only) | LANDING_WORKER_ENABLED=0 + **เลิก scheduled task ~12:00 บนเครื่อง operator ที่ step นี้เท่านั้น** (ก่อนหน้านี้ external prune ยังวิ่งตามปกติ) | คืนแรกเฝ้าดู 19:00 tick: ลำดับ cleanup→prune→create ต้องตรง §3.1 |
| 4d | + markers-deep (03:00 — dedupe/normalize/content audit เริ่มที่นี่) | SHOOT_MARKER_WORKER_ENABLED คง 0 (dormant อยู่แล้ว — reconciler absorb แทนการ enable ของเดิม) | pre-enable checks ผ่านแล้ว 2026-07-16; นี่คือคืนแรกที่ marker trash operations ขึ้น prod — ดู digest ใกล้ชิด |
| 4e | + notify | (footage-ready OFF ใน prod อยู่แล้ว) | ตาม staged rollout v1.147 เดิม: audience=admin ก่อน แล้วค่อย producer |

### 6.6 Kill-switch + monitoring

- **Kill-switch**: `RECONCILER_ENABLED=0` + เปิด legacy flags กลับ = revert สมบูรณ์ภายใน 1 redeploy — **ห้ามลบ** legacy worker scripts/routes จนกว่า cutover ครบ + นิ่ง 2 สัปดาห์ จากนั้นค่อยลบเป็น PR แยก (ข้อยกเว้น: id-first gauge ownership ไม่ revert — reconciler ถือไว้ตั้งแต่ 4a และ folder-integrity route ยัง snapshot ได้ถ้าถูกเปิดกลับ)
- **Heartbeat**: เพิ่ม `reconciler` เข้า `workerSpecs()` (heartbeat.ts:22-45) — ได้ผลพลอยได้ทันที: prep/folder-integrity/shoot-marker/landing ที่วันนี้**ไม่มี heartbeat เลย** (map ระบุ) จะถูก monitor ผ่าน reconciler ตั้งแต่วันแรก; route เรียก `recordHeartbeat('reconciler')` แบบมี `.catch(()=>{})` (บทเรียน sound-merge un-catch)
- **Dead-man SPOF**: `maybeAlertStaleWorkers` อยู่ใน calendar-reconcile route ที่เดียว (calendar/reconcile/route.ts:49) — เพิ่มจุดเรียกที่สองใน reconcile route เพื่อ redundancy (throttle 6h ผ่าน SystemHeartbeat กันส่งซ้ำอยู่แล้ว)
- **Disabled-worker respawn loop**: ตอนลบ legacy loops ออกจาก start.sh จะกำจัด spawn-every-35s ของ worker ที่ปิดไว้ ~6 ตัวไปด้วย

---

## 7. Test plan

### 7.1 ขยาย FakeDrive + per-phase scenario suites

FakeDrive ปัจจุบัน (fake-drive.ts:51-90) มี surface ของ mirrorMove แล้ว — เพิ่ม: `listFilesRecursive`, `findChildFolderByCode`, `findFoldersByCode` (scoped), `renameDriveItem`, `upsertTextFile`/`readDriveTextFile`, `copyFileToFolder`, `getFileName`, `getDriveParentFolderId`, `classifyFootageTreeFolder` (คำนวณจาก parent walk ใน fake tree จริง) และ error-injection (`failNext('move')` จำลอง 429/hang)

Scenario ต่อ phase ใน `src/lib/__tests__/reconciler/` — replay ทุก incident ที่ map บันทึก:
- **ensure**: rename fence 4 ชั้น, AGN poisoning ทั้ง 2 guard (near-miss v1.151), fail-closed 'unknown' probe, budget exhaustion กลาง run → `deferred` โผล่ใน result, rotation cursor ครอบทุก Tier-B booking ใน N รอบ (รวม fix undercount), **Tier A processed ทุก tick แม้ cursor อยู่ที่อื่น**, EP01-ไม่กลืน-EP010, **skip ladder ของ prep ครบ**: block shot ไม่ได้ CAM folders, photo-album early return, unmapped outlet skip
- **merge-video**: empty-skeleton swallow (2026-07-22), EP-split (POP-PIV-260722-01), dup-leave-in-landing sticky, twin-trash-then-move, **fast-path-through-`createdThisRun`**: P1 สร้าง skeleton → P2 consume (trash+whole-move) → ผลลัพธ์ = 1 write ไม่ใช่ per-file, **fresh-read abort**: inject ไฟล์เข้า skeleton หลัง P1 ก่อน P2 → fast path abort ไป slow mirror ไม่มีไฟล์หาย
- **fold-sound**: AUDIO target ladder 4 ขั้น, dedupe ข้าม AUDIO ทุกตำแหน่ง, same-name-sibling fix, sequential-after-video ปิด TOCTOU
- **markers**: collision-pair raw-code (v1.146), Buddhist-year no-loop, legacy rename-before-audit order (v1.150), box-level stale/duplicate/move triage, **hourly-light ไม่ trash/overwrite เด็ดขาด** (fill-missing เท่านั้น — assert ไม่มี trash call), delivered-marker repair ใน hourly
- **landing**: next-day-only, cleanup past+empty-only, **prune past-only: folder พรุ่งนี้รอด prune ทุกเวลา** (รวม case รัน prune หลัง 19:00), ลำดับ cleanup→prune→create ใน tick 19:00, span-today multi-day, keptManual, ghost-loop 2026-07-02 (probe-first ไม่ resurrect), id-first prune ตาม `driveFolders.landing`, **fresh-read ก่อน trash: upload กลาง pass → abort**
- **notify**: settle window aging (ไม่ refresh `at`), CAS stamp, no-producer-email consumes stamp, **3 gates ครบ (cancel/upload<24h/nasState)**, `MAX_PER_RUN=5` cap ยังทำงาน
- **pass-level**: dryRun plan === apply actions บน fixture เดียวกัน (dry-run fidelity หลังแก้ 3 จุด), **lease lifecycle: claim/renew/TTL-expiry/steal-after-crash**, per-booking lease defer + merge-button 409, **plan mode ไม่โดน budget ตัด**, nightly tick subsume hourly (ยิง run เดียว)

### 7.2 Golden + convergence verification

Normalize output เป็น canonical action list: `[{verb: create|rename|move|copy|trash|link|stamp|deferred, targetPath, reason}]`
1. **Offline golden**: fixture FakeDrive ชุดเดียว → รัน legacy sweep functions (`runFolderIntegrity`, `mergeBookingVideo`, `manageLandingFolders`, …) และ reconciler pass → diff ต้องว่าง (modulo whitelist) — เป็น CI gate ถาวรจน legacy ถูกลบ (ที่นี่ action-equality ใช้ได้เพราะทั้งคู่วิ่งบน fixture เดียวกันใน process เดียว ไม่มีปัญหา timing แบบ online)
2. **Online staging/prod-shadow**: state-convergence gate ตาม §6.2/§6.4 — plan-on-converged-state ต้องว่าง (แทน action-diff ของ v1 ที่ไม่มีข้อมูลฝั่ง legacy ให้เทียบ)

### 7.3 Coverage ที่ต้องอุดก่อน migrate

map ชี้ว่า landing-lifecycle **ไม่มี test file เลย** และ pure-helper tests อย่างเดียวในทุก worker — กติกา: phase ใดยังไม่มี FakeDrive suite ครอบ invariant ใน §5 ของมัน = ห้ามเข้า Stage 2

---

## 8. ความเสี่ยงที่ยอมรับ (ตั้งใจไม่แก้ — บันทึกไว้ให้คนอ่านทีหลังไม่ต้องเดา)

1. **Transition races ช่วง 4a-4c**: ระหว่าง cutover reconciler วิ่งเคียง legacy workers ที่ยังเปิดอยู่ ซึ่ง guard ของฝั่ง legacy มองไม่เห็น lease — สถานะเทียบเท่า status quo (workers พวกนี้ race กันเองแบบเดียวกันอยู่ทุกวันนี้) จึงยอมรับได้ตลอดช่วง cutover
2. **Approve route เป็น fire-and-forget ต่อไป** serialized แค่ in-process `dedupeEnsure` — บังคับรอ pass lease = delay approve หลายนาที ไม่คุ้ม; ผลคือ marker race กับ P4 "ตีบ ไม่ปิดสนิท" (§4.4) และ approve ยังเขียน `driveFolders` นอก `resolveBookingDrive` (§2.3)
3. **Heartbeat key เดียวซ่อน sub-schedule ตาย**: 19:00 tick พังแต่ hourly ยังวิ่ง = heartbeat สดตลอด มองไม่เห็น — แนะนำ per-tick keys (`reconciler:nightly19` ฯลฯ) เป็น follow-up ไม่ blocking เพราะวันนี้ landing ไม่มี heartbeat เลยด้วยซ้ำ
4. **Reconciler ไม่ถูก monitor ช่วง Stage 1-3**: heartbeat ข้ามเมื่อ dryRun ตาม idiom เดิม — ช่วง shadow จึงไม่มี dead-man; ยอมรับเพราะ legacy ยังวิ่งครบ
5. **notify latency ×2** (30-min → hourly) — use case นี้รับได้
6. **Cursor เก็บใน `SystemHeartbeat.note`** — hacky แต่ table รองรับ (upsert per-key) ไม่คุ้มสร้าง table ใหม่
7. **DSM nudge ชน tick ที่กำลังวิ่ง → แพ้ lease → nudge หายจนรอบชั่วโมงถัดไป** — ยอมรับ (merge เดิมก็ hourly fallback อยู่แล้ว)
8. **box-key last-writer-wins แก้บางส่วน**: ผู้เขียน `driveFolders` มี 9+ ราย — sweep ทั้งหมดรวมศูนย์ที่ `resolveBookingDrive` แล้ว, admin สองตัว (rename-folders, agn-restructure) โดน pass-lease, regenerate โดน per-booking lease — **เหลือ approve** ที่เขียนอิสระ (ข้อ 2) ยอมรับ

---

## 9. Open questions สำหรับ operator

**ตัดสินใจแล้วใน v2 (เดิมเป็น open question ใน v1)** — บันทึกไว้กัน re-litigate: prune absorb เป็น tick 12:00 predicate past-only + เลิก local task ที่ 4c (§2.6, §6.5); merge lookback −45d คงตั้งแต่วันแรก (§3.3); advisory lock ถูกแทนด้วย DB lease ซึ่ง cross-process อยู่แล้ว — คำถาม blue/green จึงไม่มีผลต่อ design (§4.3); cursor persist ลง SystemHeartbeat ทำเลย (§3.2, ความเสี่ยงข้อ 6)

**ปิดครบแล้ว 2026-08-06 (operator ตัดสิน + หลักฐานจาก stack 125)** — ห้าม re-litigate:

1. **reminders / footage-sheet-sync** → reminders **แยกไว้ตามเดิม** (ไม่ใช่ Drive-tree); footage-sheet-sync **ลบทิ้ง** (worker + respawn loop + route). หลักฐาน: `FOOTAGE_LOG_SHEET_ID` ไม่เคยตั้งบน prod = ไม่เคยทำงานจริง และมันเป็น logger ราย**ไฟล์** ไม่เกี่ยวกับชีทราย**โฟลเดอร์**ของปุ๊ก (ซึ่ง `delivery-tick` v1.162 ดูแลอยู่แล้ว) — ลบแล้วชีทปุ๊กไม่กระทบ
2. **notify cutover (4e)** → **คง staged rollout v1.147 แยกจนจบก่อน** (ตอนนี้ `FOOTAGE_READY_AUDIENCE=admin` — ต้องขยายเป็นทีมและนิ่งก่อน) แล้วค่อยโอนเจ้าของให้ reconciler ที่ Stage 4 · เหตุผล: ถ้าพังจะแยกไม่ออกว่าเพราะ rollout หรือ refactor
3. **NAS DSM gate** → **ตัดทิ้ง ไม่ port เข้า reconciler** ใช้ hourly ล้วน. หลักฐาน: `NAS_DSM_URL` ตั้งไว้แต่ `NAS_DSM_USER/PASS` ไม่มี = event-driven merge ไม่เคยทำงานจริง และ hourly ทำงานได้มาตลอด — ตัด dependency กับ creds NAS ออกทั้งชุด
4. **`VIDEO_MERGE_TRASH_LANDING`** → **ลบ `cleanupLandingShell` ทิ้ง**. หลักฐาน: env ไม่ได้ตั้งบน prod (ปิดตั้งแต่ v1.137) + ขัด `docs/landing-folder-policy.md` — การตัด code path ที่ลบโฟลเดอร์ได้ออก สอดคล้องกับกฎสูงสุด §0 โดยตรง
5. **Landing rename report-only** → **invariant 16 ถาวร**. หลักฐาน: `NAS_MANIFEST_SECRET` ตั้งอยู่บน stack + `scripts/nas-manifest-agent.sh` ยัง POST manifest = SMB mirror ยังทำงาน ชื่อโฟลเดอร์ฝั่ง NAS เปลี่ยนตาม Drive ไม่ได้
6. **Name-fallback removal** → **ตัด*ก่อน* cutover** (กลับดีไซน์ v2 ที่เสนอให้ตัดทีหลัง). เหตุผล: parallel-run เอาไว้เทียบว่า reconciler ให้ผลเท่าต้นแบบ ถ้าต้นแบบยังมี resolution สองทางอยู่ ความต่างที่เจอจะแยกไม่ออกว่ามาจาก refactor หรือมาจาก fallback — ตัดให้เหลือทางเดียวก่อน แล้วค่อยเทียบ · gate เดิมยังใช้: รอ gauge fallback ≈ 0 ติดกัน 3 วัน (ล่าสุด 6755 hit / 1 fallback)
7. **Compose passthrough (Stage 0)** → **แนบไปกับ deploy รอบถัดไป** ไม่ต้องจัดคืน deploy แยก (แก้ env passthrough อย่างเดียว ความเสี่ยงต่ำ)
8. **AGN project marker pass** → **จำกัดที่ project ที่มี booking ใน −90 วัน** (เดิมเดินทุก project ทุกคืน)

---

## ภาคผนวก ก — สิ่งที่หายไปโดยตั้งใจหลัง cutover สมบูรณ์

- supervised loops **7 ตัว** (prep, folder-integrity, landing, video, sound, shoot-marker, footage-ready) + respawn loop ของ worker ที่ปิด + scheduled task ~12:00 บนเครื่อง operator
- route guards **8 → 1** (boolean 6 + timestamp 2 ฝั่ง Drive-tree → pass lease เดียว; boolean guard ของ footage-sync อยู่นอก scope — คงเดิม), secret headers 6 ชื่อ → `x-reconcile-secret` (ชื่ออื่นยังรับได้ช่วง transition)
- **`notify=1` Discord ping ของ video-merge — ตัดโดยตั้งใจ**: per-run ping ย้ายไปเป็นรายการใน daily digest ของ reconciler แทน (สัญญาณเดิมไม่หาย แค่รวม channel — ใครอยากได้ per-merge realtime ต้อง raise ก่อน Stage 4b)
- `prodTeamErrors` dead counter (prep-folders.ts:110), `landingRenamed` dead counter (folder-integrity.ts:133), landing-dedup route เดี่ยว ๆ
- dry-run infidelity 3 จุด, sound per-booking `err` ที่หาย, heartbeat gap 4 workers
- ความไม่ consistent ของ dryRun default (default-apply ของ footage-sync/calendar อยู่นอก scope — คงเดิม)

**สิ่งที่จงใจ*ไม่*หาย**: whole-folder fast path v1.127 (§2.2), `FOOTAGE_READY_MAX_PER_RUN=5` cap (§2.2 P6), merge lookback −45d (§3.3), skip ladder ของ prep ทุกขั้น (§2.4), delivered-marker repair (§2.2), id-first gauge + digest (§3.4)

**ไฟล์อ้างอิงหลัก**: `Production Booking/src/lib/folder-integrity.ts` (โครง backbone), `src/lib/video-merge.ts` + `src/lib/__tests__/video-merge-mirror.test.ts` (mirrorMove + fast path reuse), `src/lib/booking-merge.ts` (per-booking runner ที่จะ refactor), `src/lib/__tests__/helpers/fake-drive.ts` (harness ที่จะขยาย), `docs/landing-folder-policy.md` (policy ที่ phase landing ต้อง preserve), `start.sh:304-442` (loops ที่จะยุบ), `docker-compose.portainer.yml` + `docker-compose.staging.yml` (env passthrough ที่ต้องแก้ก่อนใน Stage 0)
