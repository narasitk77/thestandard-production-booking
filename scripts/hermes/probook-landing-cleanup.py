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
import socket
import subprocess
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


OUTBOX_MAX_LINES = 60


def _ob_rounds(saved):
    """ไฟล์ OUTBOX → รอบที่ยังค้าง [{runAt, text}] · รูปเดิม {runAt, text} (ก่อน 17 พ.ย. 2569) = หนึ่งรอบ"""
    if isinstance(saved, dict) and isinstance(saved.get("rounds"), list):
        return [r for r in saved["rounds"] if isinstance(r, dict) and r.get("text")]
    if isinstance(saved, dict) and saved.get("text"):
        return [{"runAt": saved.get("runAt", "ก่อนหน้า"), "text": str(saved["text"])}]
    return []


def undelivered(job_name, outbox):
    """-> {"rounds": [...], "dropped": n} รอบที่ Hermes ยังส่งไม่ถึง · rounds ว่าง = ไม่มีอะไรค้าง
    (รอบก่อนส่งถึงแล้ว = ล้างไฟล์ทิ้งที่นี่) · ค้าง = last_delivery_error มีค่า *หรือ* ไฟล์มีธง "undelivered"
    (hold_outbox จดไว้ตอนรอบที่ไม่ได้ทำงานเพราะแมคยังหลับ — Hermes เขียน last_delivery_error ทับเป็น None ไปแล้ว)"""
    saved = _ob_read(outbox)
    rounds = _ob_rounds(saved)
    held = isinstance(saved, dict) and saved.get("undelivered") is True
    if not rounds or not (_delivery_error(job_name) or held):
        if os.path.exists(outbox):
            try:
                os.remove(outbox)   # ถึงมือแล้ว (หรือไม่มีอะไรให้ส่งซ้ำ)
            except Exception:
                pass
        return {"rounds": [], "dropped": 0}
    dropped = saved.get("dropped") if isinstance(saved, dict) else 0
    return {"rounds": rounds, "dropped": dropped if isinstance(dropped, int) else 0}


def hold_outbox(job_name, outbox):
    """รอบที่ไม่ทำงานเพราะแมคยังหลับ (await_full_wake() คืน False): ออกเงียบ แต่ Hermes จะเขียน last_delivery_error
    ทับเป็น None ทั้งที่รอบก่อนยังส่งไม่ถึง → จดธง "undelivered" ไว้ในไฟล์เอง ให้ undelivered() รอบหน้ายังส่งซ้ำ"""
    if not _delivery_error(job_name):
        return
    saved = _ob_read(outbox)
    if isinstance(saved, dict) and _ob_rounds(saved) and saved.get("undelivered") is not True:
        _ob_write(outbox, {**saved, "undelivered": True})


def resend_lines(carried):
    """บรรทัดส่งซ้ำ — รอบละหนึ่งบล็อก เก่าไปใหม่ ไม่ซ้อนกัน · รอบที่ถูกตัดทิ้ง = บอกจำนวนและที่อ่านฉบับเต็ม"""
    out = []
    if carried["rounds"] and carried.get("dropped"):
        out.append(f"📮 รายงานเก่าที่ส่งไม่ออกอีก {carried['dropped']} รอบถูกตัดทิ้ง (เพดาน {OUTBOX_MAX_LINES} บรรทัด) — "
                   "ฉบับเต็มอยู่ใน ~/.hermes/cron/output/")
    for r in carried["rounds"]:
        out += [f"📮 ส่งซ้ำ — รายงานรอบ {r.get('runAt', 'ก่อนหน้า')} ส่งไม่ออก", *str(r["text"]).splitlines(),
                "— จบรายงานที่ส่งซ้ำ —", ""]
    return out


def remember_report(outbox, carried, text):
    """เก็บ *เนื้อรายงานของรอบนี้เอง* ต่อท้ายรอบที่ยังค้าง (carried) เผื่อรอบนี้ส่งไม่ออกอีก
    ห้ามเก็บ payload ทั้งก้อน: payload มีบล็อกส่งซ้ำ + บรรทัด ‼️ อยู่แล้ว → รอบถัดไปห่อซ้ำเป็นชั้น ๆ
    (14–17 พ.ย. 2569 episode-drift ส่งรายงาน 3 คืนซ้อนกัน 3 ชั้น) · heartbeat ไม่ต้องเก็บ (ผู้เรียกส่ง "" มา):
    heartbeat ที่หายไปแก้ตัวเองรอบหน้า แต่ *คำเตือน* ที่หายคือความเสียหายจริง
    เกิน OUTBOX_MAX_LINES = ทิ้งรอบเก่าสุดก่อน (นับไว้ บอกตอนส่งซ้ำ) · เหลือรอบเดียวที่ยาวเกิน = ตัดท้ายพร้อมบอก"""
    rounds = list(carried["rounds"]) + ([{"runAt": time.strftime("%Y-%m-%d %H:%M"), "text": text}] if text else [])
    if not rounds:
        return
    dropped = carried.get("dropped") or 0
    while len(rounds) > 1 and sum(len(str(r["text"]).splitlines()) for r in rounds) > OUTBOX_MAX_LINES:
        rounds.pop(0)
        dropped += 1
    lines = str(rounds[0]["text"]).splitlines()
    if len(rounds) == 1 and len(lines) > OUTBOX_MAX_LINES:
        rounds[0] = {**rounds[0], "text": "\n".join(
            lines[:OUTBOX_MAX_LINES] + [f"… ตัดอีก {len(lines) - OUTBOX_MAX_LINES} บรรทัด (ฉบับเต็มอยู่ใน ~/.hermes/cron/output/)"])}
    _ob_write(outbox, {"rounds": rounds, "dropped": dropped})


# ── DARKWAKE: รอแมคตื่นจริงก่อนทำงาน (ซ้ำทุกสคริปต์ Hermes โดยเจตนา — README scripts/hermes ข้อ 8) ──
# 14–17 พ.ย. 2569: แมคบุ๊กหลับ (ใช้แบต) แต่ตื่นแบบ DarkWake ทุก ~15 นาที ครั้งละ 2–20 วิ (pmset -g log) · Hermes ได้ CPU
# ช่วงนั้นแล้วยิงงานที่ถึงเวลาทันทีทั้งที่ Wi-Fi/DNS ยังไม่มา → episode-drift 'nodename nor servname' 3 คืนติด ·
# rental-sheet 'read operation timed out' · relay TimeoutError · trash-watch ค้างกลางคำขอ 12 ชม. (นาฬิกา monotonic
# ไม่เดินตอนหลับ timeout ของ socket และของ Hermes จึงไม่ทำงาน) → รอจน Graphics กลับมา (ตื่นจริง) แล้วค่อยทำ
# รอ ไม่ข้ามเงียบ: Hermes เขียน last_delivery_error ทับทุกรอบ รอบที่ไม่มีอะไรส่งจะลบร่องรอยว่ารอบก่อนส่งไม่ออก ·
# ข้อยกเว้นเดียว (20 พ.ย.): หลับครบเพดานและไม่มีเน็ต = ไม่ทำรอบนี้ โดย hold_outbox() จดธง "undelivered" ในไฟล์แทน ·
# ไม่แน่ใจ (ไม่มี pmset / อ่านไม่ออก) = ถือว่าตื่น ทำงานตามปกติ ห้ามเงียบเพราะเดา
def dark_wake(out=None):
    """True เฉพาะเมื่อ `pmset -g systemstate` บอกชัดว่ามี CPU แต่ไม่มี Graphics (= DarkWake)"""
    if out is None:
        try:
            out = subprocess.run(["/usr/bin/pmset", "-g", "systemstate"], capture_output=True, text=True, timeout=10).stdout
        except Exception:
            return False
    m = re.search(r"Capabilities are:([^\n]*)", out or "")
    caps = m.group(1).split() if m else []
    return "CPU" in caps and "Graphics" not in caps


def await_full_wake(cap_s=1800, dns_s=600, _dark=None, _sleep=time.sleep, _now=time.monotonic, _resolve=socket.getaddrinfo):
    """-> True = ทำงานได้ · False = ยังหลับครบเพดานและไม่มีเน็ต (ไม่ทำรอบนี้ — ผู้เรียก hold_outbox() แล้วออกเงียบ)
    บล็อกจนแมคตื่นจริง แล้วรอ DNS อีกไม่เกิน dns_s วิ · เพดาน cap_s นับ monotonic = นาฬิกาเดียวกับ timeout 3600 วิ
    ของ Hermes (ไม่เดินตอนหลับ) · _dark/_sleep/_now/_resolve = ของปลอมใน self-test
    18 พ.ย. 2569: หลับ 15.6 ชม. มี DarkWake 90 ครั้งรวม 2,012 วิ → เพดาน 1800 หมดตอน 08:2x แล้วเดิมปล่อยรันตอนหลับ
    (relay/rental/trash ล้มเน็ตล่ม) → ครบเพดาน: มีเน็ต (Power Nap เสียบไฟ) = ทำ · ไม่มี = ไม่ทำรอบนี้ Hermes ยิงรอบหน้าเอง
    19 พ.ย. 2569: ตื่นจริง 09:50 (เสียบ USB-C) แต่เน็ตมา ~10:00 → DNS 60 วิไม่พอ idfirst/rental/trash ล้ม → รอ 10 นาที
    ตื่นจริงแล้วเน็ตไม่มาเกิน dns_s = ทำงานต่อ (True) ให้ทางเน็ตล่มของสคริปต์บอกเอง — เครื่องตื่นแต่ออฟไลน์จริงต้องรู้"""
    dark = _dark or dark_wake

    def online():
        try:
            _resolve("google.com", 443)
            return True
        except OSError:
            return False
    t0 = _now()
    while dark():
        if _now() - t0 >= cap_s:
            return online()
        _sleep(3)
    t1 = _now()
    while not online():
        if _now() - t1 >= dns_s:
            return True
        _sleep(5)
    return True


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
    """-> (stdout ที่จะพิมพ์, exit code) — ที่เดียวที่ตัดสิน exit code ของรอบ (OUTBOX เก็บแค่เนื้อรายงานของรอบ — ไม่ใช่สิ่งที่คืนจากที่นี่)"""
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
    carried = undelivered(JOB_NAME, OUTBOX)
    payload, code = exit_plan("\n".join(resend_lines(carried) + ([report] if report else [])))
    remember_report(OUTBOX, carried, report)   # เนื้อรอบนี้เท่านั้น — ไม่ใช่ payload (ซ้อนชั้น 14–17 พ.ย.)
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

    def run(status, err="", down=False, delivery_err=None, data=None):
        _SELF_FAIL.clear()
        _ob_write(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": delivery_err}]})

        def fake_call(dry, token, timeout):
            assert dry, "self-test ต้องไม่ถึงขั้น apply"
            return status, data, err
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

    # ── OUTBOX ไม่ซ้อนชั้น (14–17 พ.ย. 2569: 3 คืนส่งไม่ออก → รายงานห่อกันเป็นชั้น ๆ 3 ชั้น) ──
    real_main = main
    os.remove(OUTBOX)
    for _ in range(4):                   # พังทุกรอบ และทุกรอบ Hermes ส่งไม่ออก
        out, code = run(200, delivery_err="DNS")
    saved = _ob_read(OUTBOX)
    assert len(saved["rounds"]) == 4 and not any("📮" in r["text"] or "‼️" in r["text"] for r in saved["rounds"]), saved
    assert out.count("📮 ส่งซ้ำ") == 3 and out.count("พังกลางคัน") == 4 and out.count("‼️") == 1, out
    out, code = run(200)                 # รอบก่อนส่งถึง → ไม่ส่งซ้ำ เหลือแค่ของรอบนี้
    assert "📮" not in out and len(_ob_read(OUTBOX)["rounds"]) == 1, out
    # รูปไฟล์เดิม (ก่อน 17 พ.ย.) ยังส่งซ้ำได้หนึ่งครั้ง ไม่หาย
    _ob_write(OUTBOX, {"runAt": "2026-11-16 12:16", "text": "⚠️ OLD-FORMAT"})
    out, code = run(200, delivery_err="DNS")
    assert out.count("📮 ส่งซ้ำ — รายงานรอบ 2026-11-16 12:16") == 1 and "⚠️ OLD-FORMAT" in out, out
    # รอบนี้เงียบ (ไม่มีอะไรต้องเคลียร์ — ทางจริงของ main) แต่ยังมีรอบค้าง → ไฟล์ต้องเก็บรอบค้างไว้ครบ
    # เพราะการส่งซ้ำของรอบนี้ก็อาจส่งไม่ออกอีก · ส่งถึงแล้ว = ล้างไฟล์ เงียบตามปกติ
    g["secret"] = lambda: "selftest"
    before = _ob_read(OUTBOX)["rounds"]
    assert len(before) == 2, before
    for _ in range(2):
        out, code = run(200, delivery_err="DNS", data={"trashed": 0, "errors": 0})
        assert code == 0 and out.count("📮 ส่งซ้ำ") == 2 and "⚠️ OLD-FORMAT" in out, (code, out)
        assert _ob_read(OUTBOX) == {"rounds": before, "dropped": 0}, _ob_read(OUTBOX)
    out, code = run(200, data={"trashed": 0, "errors": 0})
    assert out == "" and code == 0 and not os.path.exists(OUTBOX), (code, out)
    # เพดาน 60 บรรทัด: ทิ้งรอบเก่าสุดแล้ว *บอก* · รอบเดียวยาวเกิน = ตัดท้ายพร้อมบอก
    g["main"] = lambda: print("\n".join(f"บรรทัด {i}" for i in range(25)))
    for _ in range(3):
        run(200, delivery_err="DNS")
    saved = _ob_read(OUTBOX)
    assert len(saved["rounds"]) == 2 and saved["dropped"] == 1, saved
    out, code = run(200, delivery_err="DNS")
    assert "อีก 1 รอบถูกตัดทิ้ง" in out and out.count("📮 ส่งซ้ำ") == 2, out
    os.remove(OUTBOX)
    g["main"] = lambda: print("\n".join(f"บรรทัด {i}" for i in range(80)))
    run(200, delivery_err="DNS")
    (only,) = _ob_read(OUTBOX)["rounds"]
    assert only["text"].count("\n") == OUTBOX_MAX_LINES and "ตัดอีก 20 บรรทัด" in only["text"], only
    g["main"] = real_main

    # ── DARKWAKE ──
    assert dark_wake("Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4\n") is False
    assert dark_wake("Current System Capabilities are: CPU Network \nCurrent Power State: 4\n") is True
    assert dark_wake("Current System Capabilities are: CPU \n") is True
    for junk in ("", "pmset: command not found", "Current System Capabilities are: \n", "Graphics CPU"):
        assert dark_wake(junk) is False, junk   # ไม่แน่ใจ = ตื่น (ห้ามเงียบเพราะเดา)
    clock, hits = [0.0], []

    def tick(s):
        clock[0] += s
    states = iter([True, True, True, False])
    ok = await_full_wake(_dark=lambda: next(states), _sleep=tick, _now=lambda: clock[0], _resolve=lambda h, p: hits.append(h))
    assert ok is True and clock[0] == 9 and hits == ["google.com"], (ok, clock, hits)   # รอข้าม 3 DarkWake แล้วทำงาน
    clock[0], tries = 0.0, [0]

    def flaky(h, p):
        tries[0] += 1
        if tries[0] < 3:
            raise OSError("nodename nor servname provided")
    ok = await_full_wake(_dark=lambda: False, _sleep=tick, _now=lambda: clock[0], _resolve=flaky)
    assert ok is True and tries[0] == 3 and clock[0] == 10, (ok, tries, clock)   # ตื่นแล้วแต่ DNS ยังไม่มา = รอ
    clock[0] = 0.0

    def dead(h, p):
        raise OSError("down")
    ok = await_full_wake(cap_s=30, dns_s=10, _dark=lambda: True, _sleep=tick, _now=lambda: clock[0], _resolve=dead)
    assert ok is False and clock[0] == 30, (ok, clock)              # หลับครบเพดาน + ไม่มีเน็ต = ไม่ทำรอบนี้ (18 พ.ย. ล้ม 3 ตัว)
    clock[0] = 0.0
    ok = await_full_wake(cap_s=30, _dark=lambda: True, _sleep=tick, _now=lambda: clock[0], _resolve=lambda h, p: None)
    assert ok is True and clock[0] == 30, (ok, clock)               # หลับครบเพดานแต่มีเน็ต (Power Nap เสียบไฟ) = ทำ
    clock[0] = 0.0
    ok = await_full_wake(dns_s=12, _dark=lambda: False, _sleep=tick, _now=lambda: clock[0], _resolve=dead)
    assert ok is True and 12 <= clock[0] <= 17, (ok, clock)         # ตื่นจริงแต่ออฟไลน์เกิน dns_s = ทำต่อ ให้ทางเน็ตล่มบอกเอง
    assert await_full_wake.__defaults__[:2] == (1800, 600), await_full_wake.__defaults__   # 19 พ.ย.: เน็ตมาหลังตื่น ~10 นาที
    # คอมเมนต์ใน __main__ มีคำว่า run_once() อยู่แล้ว → ตรวจกับบรรทัดเรียกจริง ไม่ใช่คำแรกที่เจอ
    entry = open(__file__, encoding="utf-8").read().split('if __name__ == "__main__":')[-1]
    assert 0 <= entry.find("await_full_wake()") < entry.find("out, code = run_once()"), "ทางจริงต้องรอแมคตื่นก่อน run_once()"
    assert entry.find("await_full_wake()") > entry.find("sys.exit(0)"), "self-test ต้องไม่รอ pmset/DNS"
    # ทางจริงเรียก await_full_wake() *ครั้งเดียว* ในบล็อก __main__ เท่านั้น — ไม่ใช่คอมเมนต์ (ตรวจข้อความหลุด)
    # และไม่อยู่ในฟังก์ชันที่ self-test เรียก (เทสต์ต้องไม่แตะ pmset/DNS จริง) · ตัวปลอมในเทสต์ส่ง keyword เสมอ
    import ast
    _tree = ast.parse(open(__file__, encoding="utf-8").read())
    _real = [n for n in ast.walk(_tree) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "await_full_wake"
             and not n.args and not n.keywords]
    _entry = [n for n in _tree.body if isinstance(n, ast.If) and "__main__" in ast.dump(n.test)]
    assert len(_entry) == 1 and len(_real) == 1 and any(n is _real[0] for n in ast.walk(_entry[0])), \
        "await_full_wake() ต้องถูกเรียกครั้งเดียวบนทางจริงในบล็อก __main__"
    # และผลของมันต้องถูกใช้: `if not await_full_wake(): hold_outbox(...); sys.exit(0)` — ไม่ทำงานตอนหลับครบเพดาน
    _guard = [n for n in ast.walk(_entry[0]) if isinstance(n, ast.If) and isinstance(n.test, ast.UnaryOp)
              and isinstance(n.test.op, ast.Not) and n.test.operand is _real[0]]
    _gcalls = {getattr(c.func, "id", None) or getattr(c.func, "attr", None) for g_ in _guard for b in g_.body
               for c in ast.walk(b) if isinstance(c, ast.Call)}
    assert len(_guard) == 1 and {"hold_outbox", "exit"} <= _gcalls, ("ต้อง hold_outbox แล้ว exit เมื่อยังหลับ", _gcalls)
    # ── hold_outbox: รอบที่ไม่ทำงานเพราะยังหลับ ห้ามทำให้ของค้างส่งหาย (Hermes เขียน last_delivery_error ทับเป็น None) ──
    _ob_write(OUTBOX, {"rounds": [{"runAt": "2026-11-18 13:21", "text": "⚠️ HELD-REPORT"}], "dropped": 0})
    _ob_write(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": "DNS"}]})
    hold_outbox(JOB_NAME, OUTBOX)
    assert _ob_read(OUTBOX).get("undelivered") is True, _ob_read(OUTBOX)
    _ob_write(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": None}]})   # รอบที่ hold: Hermes ล้างเป็น None
    hold_outbox(JOB_NAME, OUTBOX)                         # hold ซ้ำตอน error ว่าง = ไม่แตะธง
    _c = undelivered(JOB_NAME, OUTBOX)
    assert [r["text"] for r in _c["rounds"]] == ["⚠️ HELD-REPORT"], _c
    out, code = run(200, data={"trashed": 0, "errors": 0})   # รอบถัดไปที่ทำงานจริง (เงียบ): ส่งซ้ำ + เขียนไฟล์ใหม่ไม่มีธง
    assert "⚠️ HELD-REPORT" in out and "undelivered" not in (_ob_read(OUTBOX) or {}), (out, _ob_read(OUTBOX))
    assert undelivered(JOB_NAME, OUTBOX)["rounds"] == [] and not os.path.exists(OUTBOX)   # ส่งถึง → ล้าง
    _ob_write(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": "DNS"}]})
    hold_outbox(JOB_NAME, OUTBOX)
    assert not os.path.exists(OUTBOX), "ไม่มีของค้าง = hold ห้ามสร้างไฟล์"
    _ob_write(OUTBOX, {"rounds": [], "undelivered": True})
    assert undelivered(JOB_NAME, OUTBOX)["rounds"] == [] and not os.path.exists(OUTBOX), "ธงลอย ๆ ไม่มีรอบ = ล้างทิ้ง"
    # เพดาน OUTBOX ทิ้ง *รอบเก่าสุด* ก่อน (ไม่ใช่ใหม่สุด) และนับรวมกับที่เคยทิ้ง
    import tempfile as _tf
    _p, _h = os.path.join(_tf.mkdtemp(prefix="ob-cap-"), "ob.json"), OUTBOX_MAX_LINES // 2
    remember_report(_p, {"rounds": [{"runAt": "r1", "text": "\n".join(["OLD"] * _h)},
                                    {"runAt": "r2", "text": "\n".join(["MID"] * _h)}], "dropped": 2}, "\n".join(["NEW"] * _h))
    _s = _ob_read(_p)
    assert [r["runAt"] for r in _s["rounds"]][0] == "r2" and _s["rounds"][-1]["text"].startswith("NEW") and _s["dropped"] == 3, _s
    # รูปของรอบที่ข้ามต้องเป๊ะ (รีวิว 20 พ.ย.): hold_outbox(JOB_NAME, OUTBOX) ก่อน แล้ว sys.exit(0) — ลำดับถูก exit 0 ไม่พิมพ์ ไม่ทำอย่างอื่น
    import ast as _ast
    _t = _ast.parse(open(__file__, encoding="utf-8").read())
    _m = [n for n in _t.body if isinstance(n, _ast.If) and "__main__" in _ast.dump(n.test)][0]
    _g = [n for n in _ast.walk(_m) if isinstance(n, _ast.If) and _ast.unparse(n.test) == "not await_full_wake()"]
    assert len(_g) == 1 and [_ast.unparse(b) for b in _g[0].body] == ["hold_outbox(JOB_NAME, OUTBOX)", "sys.exit(0)"], \
        ([_ast.unparse(b) for b in _g[0].body] if _g else "ไม่พบ if not await_full_wake()")
    # hold_outbox ห้ามติดธงเมื่อรอบก่อนส่งถึงแล้ว (last_delivery_error ว่าง) — ไม่งั้นรายงานที่ถึงแล้วถูกส่งซ้ำ (รีวิว 20 พ.ย.)
    import tempfile as _tf3
    _gl, _d = globals(), _tf3.mkdtemp(prefix="hold-gate-")
    _jobs_saved = _gl["HERMES_JOBS"]
    _gl["HERMES_JOBS"] = os.path.join(_d, "jobs.json")
    _ob_write(_gl["HERMES_JOBS"], {"jobs": [{"name": JOB_NAME, "last_delivery_error": None}]})
    _obp = os.path.join(_d, "ob.json")
    _ob_write(_obp, {"rounds": [{"runAt": "x", "text": "DELIVERED"}], "dropped": 0})
    hold_outbox(JOB_NAME, _obp)
    assert "undelivered" not in _ob_read(_obp), _ob_read(_obp)
    _gl["HERMES_JOBS"] = _jobs_saved
    print("self-test ok")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
        sys.exit(0)
    if not await_full_wake():   # Hermes ยิงงานตอน DarkWake ได้ — รอเครื่องตื่นจริงก่อน (ดูบล็อก DARKWAKE)
        hold_outbox(JOB_NAME, OUTBOX)   # หลับครบเพดานและไม่มีเน็ต: ไม่ทำรอบนี้ · จดว่ารอบก่อนยังค้างส่ง
        sys.exit(0)
    # ห่อ main() ด้วย run_once() เพื่อให้บล็อก OUTBOX + exit_plan ครอบ *ทุกทางออก* ของ main()
    # (สคริปต์นี้ return ออกกลางทางหลายจุด) โดยไม่ต้องไปแก้ print ทีละที่
    out, code = run_once()
    if out:
        print(out)
    sys.exit(code)
