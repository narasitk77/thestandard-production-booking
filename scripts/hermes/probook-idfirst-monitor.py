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
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

URL = "https://probook.xtec9.xyz/api/internal/id-first-stats"
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


if __name__ == "__main__":
    # ห่อ main() เพื่อให้บล็อก OUTBOX ด้านบนครอบ *ทุกทางออก* ของ main() ได้
    # (สคริปต์นี้ return ออกกลางทางหลายจุด) โดยไม่ต้องไปแก้ print ทีละที่
    import contextlib
    import io as _io

    _buf = _io.StringIO()
    _crash = None
    try:
        with contextlib.redirect_stdout(_buf):
            main()
    except SystemExit:
        pass
    except Exception as _e:  # พังกลางคัน = แจ้งคน ไม่ใช่หายไปใน stderr
        _crash = f"\u26a0\ufe0f {JOB_NAME} \u0e1e\u0e31\u0e07\u0e01\u0e25\u0e32\u0e07\u0e04\u0e31\u0e19: {type(_e).__name__}: {str(_e)[:120]}"

    _report = _buf.getvalue().rstrip("\n")
    if _crash:
        _report = (_report + "\n" + _crash).strip()

    # ลำดับสำคัญ: อ่าน+ล้าง outbox ของรอบก่อนให้เสร็จ แล้วจึงเขียนของรอบนี้ทับ
    _resend = undelivered_lines(JOB_NAME, OUTBOX)
    _payload = "\n".join(_resend + ([_report] if _report else []))
    remember_report(OUTBOX, "\n".join(_payload.splitlines()[:60]))

    if _payload:
        print(_payload)
