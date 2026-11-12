#!/usr/bin/env python3
"""SUPERSEDED 2026-09-10 — งานนี้ย้ายเข้าคอนเทนเนอร์แล้ว (probook v1.220)

รอบเที่ยงตอนนี้เป็น timer ที่สองใน scripts/landing-worker.js (LANDING_PRUNE_HOUR,
ค่าเริ่ม 12:00 BKK) ซึ่ง resolve secret จาก process env เดียวกับรอบ 19:00 จึง drift
ไม่ได้ และไม่ขึ้นกับว่าโน้ตบุ๊กเครื่องนี้ตื่นอยู่ไหม. job `probook-landing-cleanup`
ถูก pause ไว้ (ไม่ได้ลบ) เผื่ออยากใช้เป็น fallback — `hermes cron resume 782fb5f1baed`
เหตุที่ย้าย: prod หมุน NEXTAUTH_SECRET วันที่ 2026-08-25 แต่ probook.env ถือค่าเก่า
→ 401 ติดกัน 13 รอบ (26 ส.ค.–8 ก.ย.) โดยไม่มีใครลงมือ
นอกจากนี้ past-only guard ที่เคยอยู่ใน future_targets() ของไฟล์นี้ ตอนนี้ย้ายไปอยู่
ฝั่ง server แล้ว (pruneLandingToToday → landingMayBeTrashed)

probook landing drop-folder cleanup — ported from the Claude Code routine
`probook-landing-cleanup` (2026-08-18). Runs headless: the endpoint accepts the
shared secret in a header, so no browser / admin session / LLM is needed.

What it does: `GET /api/internal/landing/manage?prune=today` keeps ONLY today's
(Bangkok) shoot folders in the Production Team landing drive, trashes NON-today
folders **only when empty** (= footage already delivered into the box), and keeps
+ reports any folder that still holds footage as well as manual (no-Production-ID)
folders. Trash goes to Shared-Drive trash, recoverable ~30 days.

Flow: dry-run → apply only if it would trash something → verify with a dry-run.

HARD CONSTRAINTS (do not loosen):
  * only ever `prune=today` — never any other dryRun=0 mutation on this route,
    never the shoot-marker reconcile with dryRun=0
  * fire the apply EXACTLY ONCE. Long Drive endpoints 504 at the proxy while the
    work still completes server-side; re-firing risks races/dupes. On timeout we
    wait and verify instead of re-firing.
  * never empty the trash, never redeploy/restart the stack

Difference from the Claude Code version: it stays SILENT when there was nothing to
clear (Hermes --no-agent delivers stdout, so silence = no message). It speaks up
when it trashed something, or when anything failed.

The in-container landing worker still runs nightly at 19:00 BKK with a grace
window; this noon pass only clears delivered-footage folders sooner. Both only
ever trash empties, so they cannot fight. Since v1.172 `prune=today` deliberately
does NOT record a worker heartbeat — do not "fix" that; it keeps this run from
masking a dead 19:00 worker.

Self-check without network/prod (never reaches the apply step): python3 probook-landing-cleanup.py --self-test
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

PATH = "/api/internal/landing/manage?prune=today&dryRun="
ENV_FILE = os.path.expanduser("~/.hermes/scripts/probook.env")
DRY_TIMEOUT = 180
APPLY_TIMEOUT = 280
SETTLE_SEC = 60  # รอหลัง apply ที่ 504/timeout ก่อนไป verify
DRY_RETRY_DELAYS = (20, 60, 120)  # dry-run อ่านอย่างเดียว retry ได้ปลอดภัย


def env_val(key):
    """อ่านจาก env ก่อน ถ้าไม่มีค่อยอ่านจาก probook.env (chmod 600) — Hermes ไม่โหลดไฟล์นี้ให้"""
    v = os.environ.get(key)
    if v:
        return v.strip()
    try:
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return ""


def secret():
    return env_val("PROBOOK_LANDING_SECRET")


# 2026-10-02: probook.xtec9.xyz ตอบ 404 แล้ว (ย้ายโดเมน 30 ก.ย.) · ย้ายอีกรอบ = แก้ PROBOOK_BASE ใน probook.env
BASE = (env_val("PROBOOK_BASE") or "https://probook.thestandard.co").rstrip("/")


def call(dry, token, timeout):
    """-> (status, data|None, err). status 0 = ไม่มีคำตอบ (timeout/504-ที่ proxy ตัด)"""
    req = urllib.request.Request(
        BASE + PATH + ("1" if dry else "0"),
        headers={"x-reconcile-secret": token, "User-Agent": "hermes-probook-landing"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace")), None
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:200]
        return e.code, None, body
    except Exception as e:
        return 0, None, str(e)


def net_down():
    """เน็ต/DNS ของเครื่องนี้พังเอง ≠ prod ล่ม — ต้องแยกให้ออก (DNS ล่มจริง 11:03–12:00 วันที่ 19 ส.ค.)"""
    import socket
    for host in ("cloudflare.com", "google.com", "github.com"):
        try:
            socket.getaddrinfo(host, 443)
            return False
        except Exception:
            continue
    return True


def bangkok_today():
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() + 7 * 3600))


def future_targets(actions):
    """โฟลเดอร์ที่ prune จะลบ แต่เป็นคิวถ่าย 'วันหลัง' — ต้องไม่แตะเด็ดขาด.

    ทำไมต้องมี: prune=today เก็บแค่ของ 'วันนี้' ส่วน landing worker สร้างของ
    'วันพรุ่งนี้' ไว้ตอน 19:00 BKK. ถ้ารอบเที่ยงถูกเลื่อนไปรันหลัง 19:00
    (เครื่องหลับ / เปิดแอปทีหลัง / รันมือ) มันจะลบโฟลเดอร์ของวันพรุ่งนี้ทิ้ง
    ทั้งที่ทีมยังไม่ได้ดัมป์ฟุตเทจลงไป — เคยเกิดจริงตอนพอร์ตงานนี้ 2026-08-18.
    """
    today = bangkok_today()
    out = []
    for a in actions or []:
        if not a.startswith("trash "):
            continue
        m = re.search(r"shoot (\d{4}-\d{2}-\d{2})", a)
        if m and m.group(1) > today:
            out.append((m.group(1), a[len("trash "):].strip()))
    return out


def names_from(actions, limit=8):
    out = [a for a in (actions or []) if a.startswith("trash ")]
    short = [a[len("trash "):].strip() for a in out[:limit]]
    if len(out) > limit:
        short.append(f"…อีก {len(out) - limit} รายการ")
    return short


# ── OUTBOX: ส่งซ้ำรายงานที่ Hermes ส่งไม่ออก ────────────────────────────────
# บล็อกนี้ถูกคัดลอกไว้เหมือนกันทั้ง 3 สคริปต์ *โดยเจตนา* — deploy คือการก๊อปไฟล์
# ด้วยมือไป ~/.hermes/scripts/ ดังนั้น module ร่วมที่ลืมก๊อป = ImportError = job
# ตายทั้งตัว ซึ่งแย่กว่าโค้ดซ้ำ 40 บรรทัด. แก้ที่ไหนให้แก้ให้ครบสามที่.
#
# ปัญหาที่มันแก้ (เหตุจริง 2026-08-19 21:26): RETRY_DELAYS ในสคริปต์กันได้แค่
# **ขาไปหา probook** แต่การส่ง Discord เป็นขั้นของ **Hermes ที่เกิดหลังสคริปต์จบ**
# และ Hermes ไม่ retry — DNS ล่มตอนนั้นรายงานจึงหายไปเลย ไม่มีใครรู้
#
# วิธี: เก็บรายงานของรอบนี้ลง outbox แล้ว *รอบถัดไป* อ่าน last_delivery_error ของ
# job ตัวเองจาก ~/.hermes/cron/jobs.json — ค้างอยู่ = รอบก่อนไม่ถึงคนอ่าน จึงพิมพ์
# ซ้ำนำหน้า · ไม่ค้าง = ถึงแล้ว ล้าง outbox. ทนเน็ตล่มนานเท่าไรก็ได้ ต่างจาก retry
# ที่ยอมรอได้แค่ ~200 วินาที
HERMES_JOBS = os.path.expanduser("~/.hermes/cron/jobs.json")


def _ob_read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _ob_write(path, data):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass


def _delivery_error(job_name):
    """last_delivery_error ของ job นี้ (None = รอบก่อนส่งถึงแล้ว หรืออ่านไฟล์ไม่ได้)"""
    raw = _ob_read(HERMES_JOBS)
    if raw is None:
        return None
    jobs = raw if isinstance(raw, list) else raw.get("jobs", raw)
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    if not isinstance(jobs, list):
        return None
    for j in jobs:
        if isinstance(j, dict) and j.get("name") == job_name:
            return j.get("last_delivery_error")
    return None


def undelivered_lines(job_name, outbox):
    """บรรทัดที่ต้องพิมพ์ซ้ำเพราะรอบก่อนส่งไม่ออก (ลิสต์ว่าง = ไม่มีอะไรค้าง)"""
    if not _delivery_error(job_name):
        if os.path.exists(outbox):
            try:
                os.remove(outbox)   # ถึงมือแล้ว
            except Exception:
                pass
        return []
    saved = _ob_read(outbox)
    if not isinstance(saved, dict) or not saved.get("text"):
        return []
    return [
        f"📮 ส่งซ้ำ — รายงานรอบ {saved.get('runAt', 'ก่อนหน้า')} ส่งไม่ออก",
        *str(saved["text"]).splitlines(),
        "— จบรายงานที่ส่งซ้ำ —",
        "",
    ]


def remember_report(outbox, text):
    """เก็บรายงานรอบนี้เผื่อส่งไม่ออก · heartbeat ไม่ต้องเก็บ (ดู hb ที่ผู้เรียก):
    heartbeat ที่หายไปแก้ตัวเองรอบหน้า แต่ *คำเตือน* ที่หายคือความเสียหายจริง"""
    if text:
        _ob_write(outbox, {"runAt": time.strftime("%Y-%m-%d %H:%M"), "text": text})


# ── SELF-FAILURE vs FINDING ───────────────────────────────────────────────────
# 2026-09-10: ทั้งสามสคริปต์เคย `exit 0` ทุกกรณี แม้ตอนที่ตัวเองทำงานไม่สำเร็จ.
# ผลคือ Hermes บันทึก last_status "ok" / failure_streak 0 ตลอด และกลไกเตือนซ้ำ
# ของมันเอง (_failure_streak_nudge, threshold 3) ไม่เคยทำงาน — รอบเที่ยงของ
# landing จึงตอบ 401 ติดกัน 13 วันโดยไม่มีใครลงมือ
#
# แยกให้ชัด: `self_fail()` = *เราเอง* ทำงานไม่สำเร็จ (401 / เน็ตล่ม / พังกลางคัน)
# → exit 1 เพื่อให้ Hermes นับ streak. ส่วน "เจอปัญหาที่ prod" (worker ค้าง,
# fallback พุ่ง) คือสคริปต์ทำงาน *สำเร็จ* → exit 0 ไม่งั้น streak จะเตือนผิดตัว
#
# ⚠️ แก้ 11 พ.ย. 2569 — ความเชื่อเดิมตรงนี้ ("scheduler.py:3660 ยัง append stdout … คนอ่านได้เนื้อรายงานครบ") ผิด
# (ตรวจกับ ~/.hermes/hermes-agent/cron/scheduler.py ที่ติดตั้งอยู่): 3660 แค่ประกอบ error ภายใน ส่วนตอนส่ง (~6420)
# รอบที่ exit ≠ 0 ได้ _summarize_cron_failure_for_delivery() แทน stdout — "Script exited with code 1 stdout: …"
# ยุบช่องว่าง/ขึ้นบรรทัดเหลือช่องเดียว เกิน 180 ตัวตัดเหลือ 177 + "..." (มี stderr = มาก่อน stdout กินที่อีก)
# ฉบับเต็มอยู่แค่ ~/.hermes/cron/output/<job-id>/ · ข้อความสั้นนั้นส่งถึง → last_delivery_error ว่าง → OUTBOX ล้าง
# ทิ้งรอบหน้า → ส่วนที่ถูกตัดหายถาวร (เกิดจริง: landing 4 ต.ค. รายงานส่งซ้ำ + dry-run ล้ม ถึงห้องแค่ต้นบรรทัดแรก)
# กฎ (exit_plan): exit 1 เฉพาะเมื่อ stdout *ทั้งก้อน* รอดการตัด (ที่ว่างให้ stdout ~146 ตัว) · ยาวกว่านั้น = exit 0
# + บรรทัด ‼️ นำหน้า ให้รายงานถึงครบ (แลกกับที่รอบนั้น Hermes ไม่นับ failure_streak) · ข้อความ self_fail เดี่ยว ๆ
# จึงต้องสั้นพอ (ตัด detail) — --self-test ล็อกไว้ · ซ้ำทุกสคริปต์โดยเจตนา (เหตุผลเดียวกับบล็อก OUTBOX)
def hermes_fail_view(stdout):
    """-> (ข้อความที่ห้อง Discord ได้จริงถ้ารอบนี้ exit 1, ได้ครบทั้งก้อนไหม) · จำลองตอน stderr ว่าง"""
    s = " ".join(f"Script exited with code 1\nstdout:\n{stdout}".split())
    return (s, True) if len(s) <= 180 else (s[:177].rstrip() + "...", False)


def exit_plan(payload):
    """-> (stdout ที่จะพิมพ์, exit code) — ที่เดียวที่ตัดสิน exit code ของรอบ (OUTBOX เก็บสิ่งที่คืนจากที่นี่)"""
    if not _SELF_FAIL:
        return payload, 0
    if hermes_fail_view(payload)[1]:
        return payload, 1
    why = ", ".join(dict.fromkeys(_SELF_FAIL))
    return f"‼️ {JOB_NAME} ทำงานไม่สำเร็จรอบนี้ ({why}) — รายงานเต็มข้างล่าง\n{payload}", 0


_SELF_FAIL = []


def self_fail(reason=""):
    """ทำเครื่องหมายว่ารอบนี้ 'เราทำงานไม่สำเร็จ' — exit_plan() ตัดสิน exit code (1 = ข้อความสั้นพอ)"""
    _SELF_FAIL.append(reason or "self-failure")

OUTBOX = os.path.expanduser("~/.hermes/state/probook/outbox-landing.json")
JOB_NAME = "probook-landing-cleanup"


def main():
    token = secret()
    if not token:
        print("⚠️ landing-cleanup ไม่ได้รัน — ไม่พบ PROBOOK_LANDING_SECRET")
        print(f"   ใส่ค่าไว้ที่ {ENV_FILE} (บรรทัด PROBOOK_LANDING_SECRET=…)")
        return

    # 1) DRY-RUN (read-only → retry ได้ปลอดภัย; เน็ตเครื่องนี้เคยล่มยาวเป็นชั่วโมงคาบรอบเที่ยง)
    status, data, err = call(True, token, DRY_TIMEOUT)
    for delay in DRY_RETRY_DELAYS:
        if status not in (0, 502, 503, 504):
            break
        time.sleep(delay)
        status, data, err = call(True, token, DRY_TIMEOUT)
    if status == 0 and net_down():
        self_fail("net down")
        print("⚠️ landing cleanup: ข้ามรอบนี้ — เน็ต/DNS ของเครื่องนี้ล่ม (ไม่ใช่ prod)")
        print("   ไม่มีการลบอะไร · worker 19:00 ในคอนเทนเนอร์ยังเคลียร์ให้ตามปกติ")
        return

    if status == 401:
        self_fail("401")
        # สั้นพอให้ exit 1 ส่งครบ (exit_plan)
        print("⚠️ landing-cleanup: prod ตอบ 401 — secret ไม่ตรงแล้ว (prod หมุน NEXTAUTH_SECRET?) · "
              f"แก้ PROBOOK_LANDING_SECRET ใน {ENV_FILE.replace(os.path.expanduser('~'), '~')}")
        return
    if status != 200 or not isinstance(data, dict):
        self_fail(f"dry-run http {status}")
        print(f"⚠️ landing-cleanup: dry-run ไม่สำเร็จ (http={status}) {str(err)[:60]}")   # [:60] = exit 1 ส่งครบ
        return
    if data.get("skipped"):
        print(f"⚠️ landing-cleanup: endpoint ข้ามงาน — {data.get('reason', 'ไม่ระบุเหตุผล')}")
        return

    would = int(data.get("trashed", 0))
    if would == 0:
        if int(data.get("errors", 0)):
            print(f"⚠️ landing-cleanup: ไม่มีอะไรต้องเคลียร์ แต่ dry-run มี error {data['errors']} รายการ")
            for a in (data.get("actions") or [])[:5]:
                print(f"   {a[:160]}")
        return  # ปกติ = เงียบ

    planned = names_from(data.get("actions"))

    # 1b) GUARD — ห้าม apply ถ้าจะโดนโฟลเดอร์ของคิวถ่ายวันหลัง (ดู future_targets)
    future = future_targets(data.get("actions"))
    if future and "--force" not in sys.argv:
        print(f"⏸ landing cleanup: ข้ามรอบนี้ — prune จะลบโฟลเดอร์ของคิวถ่ายวันหลัง {len(future)} รายการ")
        for d, n in future[:6]:
            print(f"   • {d} · {n[:110]}")
        print(f"   (วันนี้ที่ BKK = {bangkok_today()}) รอบเที่ยงปกติจะไม่เจอเคสนี้ — เจอเมื่อรันหลัง 19:00")
        print("   ถ้าต้องการลบจริง ให้รันมือด้วย --force")
        return

    # 2) APPLY — ยิงครั้งเดียว ห้ามยิงซ้ำเด็ดขาด
    astatus, adata, aerr = call(False, token, APPLY_TIMEOUT)
    if astatus == 409:
        # รอบอื่น (worker 19:00 หรือรอบที่ค้าง) กำลังเดินอยู่ — ปล่อยให้มันทำ อย่ายิงซ้ำ
        print("ℹ️ landing cleanup: มีรอบอื่นกำลังทำงาน (409) — ข้ามรอบนี้ ไม่ยิงซ้ำ")
        return
    cut_by_proxy = astatus in (0, 502, 503, 504)
    if cut_by_proxy:
        time.sleep(SETTLE_SEC)

    # 3) VERIFY ด้วย dry-run อีกครั้ง
    vstatus, vdata, verr = call(True, token, DRY_TIMEOUT)

    lines = []
    if astatus == 200 and isinstance(adata, dict):
        trashed = int(adata.get("trashed", 0))
        kept_today = int(adata.get("keptToday", 0))
        with_files = adata.get("keptWithFiles") or []
        manual = adata.get("keptManual") or []
        errs = int(adata.get("errors", 0))
        lines.append(f"🧹 landing cleanup: ลบโฟลเดอร์ว่าง {trashed} รายการ · เก็บของวันนี้ {kept_today}")
        for n in names_from(adata.get("actions")):
            lines.append(f"   • {n[:120]}")
        lines.append(f"   ไม่แตะโฟลเดอร์ที่ยังมีฟุตเทจ {len(with_files)} · manual {len(manual)}")
        if errs:
            lines.append(f"   ⚠️ error {errs} รายการ")
    elif cut_by_proxy:
        lines.append(f"🧹 landing cleanup: ยิง apply แล้ว (proxy ตัดสาย — ไม่ยิงซ้ำ) วางแผนลบ {would} รายการ")
        for n in planned:
            lines.append(f"   • {n[:120]}")
    else:
        lines.append(f"⚠️ landing cleanup: apply ไม่สำเร็จ (http={astatus}) {str(aerr)[:120]}")

    if vstatus == 200 and isinstance(vdata, dict):
        left = int(vdata.get("trashed", 0))
        lines.append(
            f"   verify: เหลือรอลบ {left} · เก็บของวันนี้ {int(vdata.get('keptToday', 0))}"
            + ("" if left == 0 else " ⚠️ ยังไม่เกลี้ยง")
        )
    else:
        lines.append(f"   verify ไม่สำเร็จ (http={vstatus}) — เช็กเองที่ /admin/footage-tools")

    print("\n".join(lines[:12]))


def run_once():
    """main() + epilogue (OUTBOX + exit_plan) -> (stdout, exit code) · __main__ และ --self-test ใช้ตัวเดียวกัน"""
    import contextlib
    import io

    buf, crash = io.StringIO(), None
    try:
        with contextlib.redirect_stdout(buf):
            main()
    except SystemExit:
        pass
    except Exception as e:  # พังกลางคัน = แจ้งคน ไม่ใช่หายไปใน stderr · [:70] = สั้นพอให้ exit 1 ส่งครบ
        self_fail("crash")
        crash = f"⚠️ {JOB_NAME} พังกลางคัน: {type(e).__name__}: {str(e)[:70]}"
    report = buf.getvalue().rstrip("\n")
    if crash:
        report = (report + "\n" + crash).strip()

    # ลำดับสำคัญ: อ่าน+ล้าง outbox ของรอบก่อนให้เสร็จ แล้วจึงเขียนของรอบนี้ทับ
    resend = undelivered_lines(JOB_NAME, OUTBOX)
    payload, code = exit_plan("\n".join(resend + ([report] if report else [])))
    remember_report(OUTBOX, "\n".join(payload.splitlines()[:60]))
    return payload, code


def self_test():
    """ทางจริง main()+run_once() ด้วยของปลอม ไม่แตะเน็ต/prod และไม่มีวันถึงขั้น apply
    — ล็อกว่ารอบ exit 1 ส่งข้อความสำคัญถึงห้องครบ (exit_plan)"""
    import tempfile
    g, tmp = globals(), tempfile.mkdtemp(prefix="landing-selftest-")
    g.update(OUTBOX=os.path.join(tmp, "ob.json"), HERMES_JOBS=os.path.join(tmp, "jobs.json"),
             DRY_RETRY_DELAYS=(), secret=lambda: "selftest")

    def must_reach(essential, out, code):   # exit 1 = ห้องได้แค่ hermes_fail_view() → ทั้งก้อนต้องรอด
        view, whole = hermes_fail_view(out)
        assert code == 1 and whole and all(e in view for e in essential), (code, view)

    def reaches(essential, out, code):      # สิ่งที่ห้องได้จริง: exit 1 = hermes_fail_view() · exit 0 = ทั้งก้อน
        got = hermes_fail_view(out)[0] if code else out
        assert all(e in got for e in essential), (code, got)

    def run(status, err="", down=False, delivery_err=None):
        _SELF_FAIL.clear()
        _ob_write(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": delivery_err}]})

        def fake_call(dry, token, timeout):
            assert dry, "self-test ต้องไม่ถึงขั้น apply"
            return status, None, err
        g.update(call=fake_call, net_down=lambda: down)
        return run_once()

    must_reach(["ข้ามรอบนี้", "เน็ต/DNS", "ไม่มีการลบอะไร"], *run(0, "timed out", down=True))
    must_reach(["401", "secret ไม่ตรง", "PROBOOK_LANDING_SECRET"], *run(401))
    must_reach(["dry-run ไม่สำเร็จ", "http=500"], *run(500, "Internal Server Error " + "x" * 300))
    # รายงานรอบก่อนส่งไม่ออก + รอบนี้ 401 → ห้าม exit 1 (เคสจริง 4 ต.ค.: ห้องได้แค่ต้นบรรทัดแรกของรายงานที่ส่งซ้ำ)
    _ob_write(OUTBOX, {"runAt": "2026-10-03 12:16", "text": "🧹 OLD-" + "z" * 200})
    out, code = run(401, delivery_err="DNS")
    assert code == 0 and out.startswith("‼️ probook-landing-cleanup") and "🧹 OLD-" + "z" * 200 in out and "401" in out, (code, out)
    g["secret"] = lambda: {}["k" * 300]
    must_reach(["พังกลางคัน", "KeyError"], *run(200))
    print("self-test ok")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
        sys.exit(0)
    # ห่อ main() ด้วย run_once() เพื่อให้บล็อก OUTBOX + exit_plan ครอบ *ทุกทางออก* ของ main()
    # (สคริปต์นี้ return ออกกลางทางหลายจุด) โดยไม่ต้องไปแก้ print ทีละที่
    out, code = run_once()
    if out:
        print(out)
    sys.exit(code)
