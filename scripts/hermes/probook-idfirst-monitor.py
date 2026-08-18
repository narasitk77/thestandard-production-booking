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


def main():
    state = load_state()
    out = []

    try:
        req = urllib.request.Request(URL, headers={"User-Agent": "hermes-probook-idfirst"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
    except Exception as e:
        state["failStreak"] = int(state.get("failStreak", 0)) + 1
        save_state(state)
        if state["failStreak"] >= FAIL_STREAK_ALERT:
            print(f"⚠️ id-first-stats เรียกไม่ได้ {state['failStreak']} วันติด — prod น่ามีปัญหา")
            print(f"   ({str(e)[:120]})")
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
    main()
