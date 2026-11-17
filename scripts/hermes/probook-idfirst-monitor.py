#!/usr/bin/env python3
"""probook id-first fallback monitor — ported from the Claude Code routine
`idfirst-fallback-monitor` (2026-08-18). Read-only. Prints NOTHING when normal,
so Hermes `--no-agent` delivery stays silent unless a threshold trips.

CONTEXT THAT MUST NOT BE LOST: this task used to exist to decide when to cut the
name fallback ("step c"). That plan was CANCELLED on 2026-08-06 — the contract is
now **id-first, name-repair, never name-authoritative** (docs/reconciler-design.md
§9 item 6). Never propose cutting the fallback again unless Narasit asks.

State (history continues from the Claude Code file, same schema):
  ~/.hermes/state/probook/idfirst-state.json

Self-check without network/prod: python3 probook-idfirst-monitor.py --self-test
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

ENV_FILE = os.path.expanduser("~/.hermes/scripts/probook.env")


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


# 2026-10-02: probook.xtec9.xyz ตอบ 404 แล้ว (ย้ายโดเมน 30 ก.ย.) · ย้ายอีกรอบ = แก้ PROBOOK_BASE ใน probook.env
BASE = (env_val("PROBOOK_BASE") or "https://probook.thestandard.co").rstrip("/")
URL = BASE + "/api/internal/id-first-stats"
STATE = os.path.expanduser("~/.hermes/state/probook/idfirst-state.json")
KEEP_DAYS = 14
TIMEOUT = 25

FALLBACK_FLOOR = 5      # ต่ำกว่านี้ = noise ปกติ ไม่เตือน
SPIKE_FACTOR = 2.0      # และต้องมากกว่าวันก่อนเกิน 2 เท่า
HIT_FLOOR = 50          # totalHit ต่ำกว่านี้...
HIT_BASELINE = 500      # ...ขณะที่ค่ากลาง 3 วันก่อนสูงกว่านี้ = worker/auth น่าจะพัง
FAIL_STREAK_ALERT = 2   # endpoint ล่มติดกันกี่วันจึงเตือน
RETRY_DELAYS = (20, 60, 120)


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


def load_state():
    try:
        with open(STATE) as f:
            s = json.load(f)
    except Exception:
        s = {}
    s.setdefault("history", [])
    return s


def save_state(s):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def median(xs):
    xs = sorted(xs)
    if not xs:
        return 0
    mid = len(xs) // 2
    return xs[mid] if len(xs) % 2 else (xs[mid - 1] + xs[mid]) / 2


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
    (รอบก่อนส่งถึงแล้ว = ล้างไฟล์ทิ้งที่นี่)"""
    if not _delivery_error(job_name):
        if os.path.exists(outbox):
            try:
                os.remove(outbox)   # ถึงมือแล้ว
            except Exception:
                pass
        return {"rounds": [], "dropped": 0}
    saved = _ob_read(outbox)
    dropped = saved.get("dropped") if isinstance(saved, dict) else 0
    return {"rounds": _ob_rounds(saved), "dropped": dropped if isinstance(dropped, int) else 0}


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
# ห้าม "ข้ามเงียบ" แทนการรอ: Hermes เขียน last_delivery_error ทับทุกรอบ รอบที่ไม่มีอะไรส่งจะลบร่องรอยว่ารอบก่อน
# ส่งไม่ออก แล้ว OUTBOX ถูกลบทิ้ง · ไม่แน่ใจ (ไม่มี pmset / อ่านไม่ออก) = ถือว่าตื่น ทำงานตามปกติ ห้ามเงียบเพราะเดา
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


def await_full_wake(cap_s=1800, dns_s=60, _dark=None, _sleep=time.sleep, _now=time.monotonic, _resolve=socket.getaddrinfo):
    """บล็อกจนแมคตื่นจริง แล้วรอ DNS อีกไม่เกิน dns_s วิ (แมคเพิ่งตื่น = DNS ยังไม่มา 10–60 วิ) · เพดาน cap_s นับ
    monotonic = นาฬิกาเดียวกับ timeout 3600 วิ ของ Hermes (ไม่เดินตอนหลับ) · เกินเพดาน/DNS ไม่มา = ทำงานต่อเลย
    ให้ทางล้มเดิมของสคริปต์ดังเอง ดีกว่าโดน Hermes ฆ่ากลางทาง · _dark/_sleep/_now/_resolve = ของปลอมใน self-test"""
    dark = _dark or dark_wake
    t0 = _now()
    while dark() and _now() - t0 < cap_s:
        _sleep(3)
    t1 = _now()
    while True:
        try:
            _resolve("google.com", 443)
            return
        except OSError:
            if _now() - t1 >= dns_s:
                return
            _sleep(2)


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

OUTBOX = os.path.expanduser("~/.hermes/state/probook/outbox-idfirst.json")
JOB_NAME = "idfirst-fallback-monitor"


def main():
    state = load_state()
    out = []

    data = None
    err = None
    for attempt, delay in enumerate((0,) + RETRY_DELAYS):
        if delay:
            time.sleep(delay)
        try:
            req = urllib.request.Request(URL, headers={"User-Agent": "hermes-probook-idfirst"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
                err = None
                break
        except Exception as e:
            err = e
    if data is None:
        if net_down():
            self_fail("net down")
            # เน็ตเราเองล่ม → ไม่ใช่หลักฐานว่า prod พัง ห้ามนับ failStreak (ไม่งั้น wifi งอแง 2 วัน = เตือนผิด)
            save_state(state)
            print("⚠️ อ่าน id-first-stats ไม่ได้รอบนี้ — เน็ต/DNS ของเครื่องนี้ล่ม (ไม่ใช่ prod) ไม่นับเป็นวันที่ล้ม")
            return
        state["failStreak"] = int(state.get("failStreak", 0)) + 1
        save_state(state)
        if state["failStreak"] >= FAIL_STREAK_ALERT:
            print(f"⚠️ id-first-stats เรียกไม่ได้ {state['failStreak']} วันติด — prod น่ามีปัญหา (เน็ตเครื่องนี้ปกติ)")
            print(f"   ({str(err)[:120]})")
            print("   ดูต่อ: /api/health-summary, log ของ container production-booking-app (stack 125)")
        return
    state["failStreak"] = 0

    daily = data.get("daily") or []
    if not daily:
        save_state(state)
        return

    latest = daily[0]
    at = str(latest.get("at", ""))
    date = at[:10]
    snap = {
        "date": date,
        "at": at,
        "totalHit": int(latest.get("totalHit", 0)),
        "totalFallback": int(latest.get("totalFallback", 0)),
        "fallbackBuckets": [b for b in (latest.get("buckets") or []) if int(b.get("fallback", 0)) > 0],
    }

    already_counted = state.get("lastCountedDate") == date
    history = [h for h in state["history"] if h.get("date") != date]
    prev_days = sorted(history, key=lambda h: h.get("date", ""), reverse=True)
    history = sorted([snap] + history, key=lambda h: h.get("date", ""), reverse=True)[:KEEP_DAYS]
    state["history"] = history
    state["lastCountedDate"] = date

    prev = prev_days[0] if prev_days else None
    prev_fb = int(prev.get("totalFallback", 0)) if prev else 0

    # streak = จำนวนวันติดกันที่ fallback ยังอยู่ในระดับปกติ (นับวันละครั้ง)
    if snap["totalFallback"] > FALLBACK_FLOOR:
        state["streak"] = 0
    elif not already_counted:
        state["streak"] = int(state.get("streak", 0)) + 1

    # เงื่อนไข 1 — fallback พุ่ง = ลิงก์ Drive พังเป็นกลุ่ม
    if snap["totalFallback"] > FALLBACK_FLOOR and snap["totalFallback"] > max(1, prev_fb) * SPIKE_FACTOR:
        buckets = ", ".join(f"{b['key']} ({b['fallback']})" for b in snap["fallbackBuckets"]) or "—"
        out.append(f"⚠️ id-first fallback พุ่ง: {snap['totalFallback']} (เมื่อวาน {prev_fb}) hit={snap['totalHit']}")
        out.append(f"   bucket ที่พุ่ง: {buckets}")
        out.append("   = ของถูกย้าย/ลบ/เปลี่ยนชื่อยกชุด — ดู digest ของ folder-integrity + /admin/footage-tools")

    # เงื่อนไข 2 — hit ตกเกือบ 0 ทั้งที่ยังมีงาน = worker ตาย หรือ Drive auth หมดอายุ
    base = median([int(h.get("totalHit", 0)) for h in prev_days[:3]])
    if snap["totalHit"] < HIT_FLOOR and base > HIT_BASELINE:
        out.append(f"⚠️ id-first hit ตกเหลือ {snap['totalHit']} (ค่ากลาง 3 วันก่อน {base:.0f})")
        out.append("   worker อาจตาย หรือ Drive auth หมดอายุ — เช็ก /api/health-summary ก่อน")

    save_state(state)

    if out:
        print("\n".join(out[:10]))
        sys.exit(0)
    # ปกติ = เงียบ


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
    """ทางจริง main()+run_once() ด้วยของปลอม ไม่แตะเน็ต/prod — ล็อกว่ารอบ exit 1 ส่งข้อความสำคัญถึงห้องครบ (exit_plan)"""
    import tempfile
    g, tmp = globals(), tempfile.mkdtemp(prefix="idfirst-selftest-")
    g.update(STATE=os.path.join(tmp, "s.json"), OUTBOX=os.path.join(tmp, "ob.json"), HERMES_JOBS=os.path.join(tmp, "jobs.json"),
             RETRY_DELAYS=(), net_down=lambda: True)

    def no_net(*a, **k):
        raise urllib.error.URLError("simulated DNS failure " + "x" * 200)
    urllib.request.urlopen = no_net

    def must_reach(essential, out, code):   # exit 1 = ห้องได้แค่ hermes_fail_view() → ทั้งก้อนต้องรอด
        view, whole = hermes_fail_view(out)
        assert code == 1 and whole and all(e in view for e in essential), (code, view)

    def reaches(essential, out, code):      # สิ่งที่ห้องได้จริง: exit 1 = hermes_fail_view() · exit 0 = ทั้งก้อน
        got = hermes_fail_view(out)[0] if code else out
        assert all(e in got for e in essential), (code, got)

    def run(delivery_err=None):
        _SELF_FAIL.clear()
        _ob_write(HERMES_JOBS, {"jobs": [{"name": JOB_NAME, "last_delivery_error": delivery_err}]})
        return run_once()

    must_reach(["อ่าน id-first-stats ไม่ได้รอบนี้", "ไม่ใช่ prod"], *run())
    # รายงานรอบก่อนส่งไม่ออก + รอบนี้เน็ตล่ม → ห้าม exit 1 (ถูกตัด แล้ว OUTBOX ล้างทิ้ง = หายถาวร)
    _ob_write(OUTBOX, {"runAt": "2026-11-10 09:30", "text": "⚠️ OLD-SPIKE-" + "z" * 200})
    out, code = run("DNS")
    assert code == 0 and out.startswith("‼️ idfirst-fallback-monitor") and "OLD-SPIKE-" + "z" * 200 in out, (code, out)
    g["load_state"] = lambda: {}["k" * 300]
    must_reach(["พังกลางคัน", "KeyError"], *run())

    # ── OUTBOX ไม่ซ้อนชั้น (14–17 พ.ย. 2569: 3 คืนส่งไม่ออก → รายงานห่อกันเป็นชั้น ๆ 3 ชั้น) ──
    real_main = main
    os.remove(OUTBOX)
    for _ in range(4):                   # พังทุกรอบ (load_state ยังพังจากข้อบน) และทุกรอบ Hermes ส่งไม่ออก
        out, code = run("DNS")
    saved = _ob_read(OUTBOX)
    assert len(saved["rounds"]) == 4 and not any("📮" in r["text"] or "‼️" in r["text"] for r in saved["rounds"]), saved
    assert out.count("📮 ส่งซ้ำ") == 3 and out.count("พังกลางคัน") == 4 and out.count("‼️") == 1, out
    out, code = run(None)                # รอบก่อนส่งถึง → ไม่ส่งซ้ำ เหลือแค่ของรอบนี้
    assert "📮" not in out and len(_ob_read(OUTBOX)["rounds"]) == 1, out
    # รูปไฟล์เดิม (ก่อน 17 พ.ย.) ยังส่งซ้ำได้หนึ่งครั้ง ไม่หาย
    _ob_write(OUTBOX, {"runAt": "2026-11-16 03:15", "text": "⚠️ OLD-FORMAT"})
    out, code = run("DNS")
    assert out.count("📮 ส่งซ้ำ — รายงานรอบ 2026-11-16 03:15") == 1 and "⚠️ OLD-FORMAT" in out, out
    # เพดาน 60 บรรทัด: ทิ้งรอบเก่าสุดแล้ว *บอก* · รอบเดียวยาวเกิน = ตัดท้ายพร้อมบอก
    os.remove(OUTBOX)
    g["main"] = lambda: print("\n".join(f"บรรทัด {i}" for i in range(25)))
    for _ in range(3):
        run("DNS")
    saved = _ob_read(OUTBOX)
    assert len(saved["rounds"]) == 2 and saved["dropped"] == 1, saved
    out, code = run("DNS")
    assert "อีก 1 รอบถูกตัดทิ้ง" in out and out.count("📮 ส่งซ้ำ") == 2, out
    os.remove(OUTBOX)
    g["main"] = lambda: print("\n".join(f"บรรทัด {i}" for i in range(80)))
    run("DNS")
    (only,) = _ob_read(OUTBOX)["rounds"]
    assert only["text"].count("\n") == OUTBOX_MAX_LINES and "ตัดอีก 20 บรรทัด" in only["text"], only
    # รอบนี้เงียบ (ปกติ) แต่ยังมีรอบค้าง → ไฟล์ต้องเก็บรอบค้างไว้ (การส่งซ้ำรอบนี้ก็อาจส่งไม่ออกอีก)
    os.remove(OUTBOX)
    g["main"] = lambda: print("⚠️ KEEP-ME")
    run("DNS")
    g["main"] = lambda: None
    for _ in range(2):
        out, code = run("DNS")
        assert out.count("⚠️ KEEP-ME") == 1 and out.count("📮 ส่งซ้ำ") == 1, out
        assert [r["text"] for r in _ob_read(OUTBOX)["rounds"]] == ["⚠️ KEEP-ME"], _ob_read(OUTBOX)
    out, code = run(None)                # ส่งถึงแล้ว + รอบนี้เงียบ → ไม่มีอะไรพิมพ์ ไม่มีไฟล์ค้าง
    assert out == "" and code == 0 and not os.path.exists(OUTBOX), (out, code)
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
    await_full_wake(_dark=lambda: next(states), _sleep=tick, _now=lambda: clock[0], _resolve=lambda h, p: hits.append(h))
    assert clock[0] == 9 and hits == ["google.com"], (clock, hits)   # รอข้าม 3 DarkWake แล้วทำงาน
    clock[0], tries = 0.0, [0]

    def flaky(h, p):
        tries[0] += 1
        if tries[0] < 3:
            raise OSError("nodename nor servname provided")
    await_full_wake(_dark=lambda: False, _sleep=tick, _now=lambda: clock[0], _resolve=flaky)
    assert tries[0] == 3 and clock[0] == 4, (tries, clock)          # ตื่นแล้วแต่ DNS ยังไม่มา = รอ
    clock[0] = 0.0

    def dead(h, p):
        raise OSError("down")
    await_full_wake(cap_s=30, dns_s=10, _dark=lambda: True, _sleep=tick, _now=lambda: clock[0], _resolve=dead)
    assert 30 <= clock[0] <= 45, clock                              # หลับเกินเพดาน/DNS ไม่มา = ทำงานต่อ ไม่ค้าง
    entry = open(__file__, encoding="utf-8").read().split('if __name__ == "__main__":')[-1]
    assert entry.find("sys.exit(0)") < entry.find("await_full_wake()") < entry.find("run_once()"), \
        "ทางจริงต้องรอแมคตื่นก่อน run_once() (และไม่อยู่ในทาง --self-test)"
    # ทางจริงเรียก await_full_wake() *ครั้งเดียว* ในบล็อก __main__ เท่านั้น — ไม่ใช่คอมเมนต์ (ตรวจข้อความหลุด)
    # และไม่อยู่ในฟังก์ชันที่ self-test เรียก (เทสต์ต้องไม่แตะ pmset/DNS จริง) · ตัวปลอมในเทสต์ส่ง keyword เสมอ
    import ast
    _tree = ast.parse(open(__file__, encoding="utf-8").read())
    _real = [n for n in ast.walk(_tree) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "await_full_wake"
             and not n.args and not n.keywords]
    _entry = [n for n in _tree.body if isinstance(n, ast.If) and "__main__" in ast.dump(n.test)]
    assert len(_entry) == 1 and len(_real) == 1 and any(n is _real[0] for n in ast.walk(_entry[0])), \
        "await_full_wake() ต้องถูกเรียกครั้งเดียวบนทางจริงในบล็อก __main__"
    # เพดาน OUTBOX ทิ้ง *รอบเก่าสุด* ก่อน (ไม่ใช่ใหม่สุด) และนับรวมกับที่เคยทิ้ง
    import tempfile as _tf
    _p, _h = os.path.join(_tf.mkdtemp(prefix="ob-cap-"), "ob.json"), OUTBOX_MAX_LINES // 2
    remember_report(_p, {"rounds": [{"runAt": "r1", "text": "\n".join(["OLD"] * _h)},
                                    {"runAt": "r2", "text": "\n".join(["MID"] * _h)}], "dropped": 2}, "\n".join(["NEW"] * _h))
    _s = _ob_read(_p)
    assert [r["runAt"] for r in _s["rounds"]][0] == "r2" and _s["rounds"][-1]["text"].startswith("NEW") and _s["dropped"] == 3, _s
    print("self-test ok")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
        sys.exit(0)
    await_full_wake()   # Hermes ยิงงานตอน DarkWake ได้ — รอเครื่องตื่นจริงก่อน (ดูบล็อก DARKWAKE)
    # ห่อ main() ด้วย run_once() เพื่อให้บล็อก OUTBOX + exit_plan ครอบ *ทุกทางออก* ของ main()
    # (สคริปต์นี้ return ออกกลางทางหลายจุด) โดยไม่ต้องไปแก้ print ทีละที่
    out, code = run_once()
    if out:
        print(out)
    sys.exit(code)
