#!/usr/bin/env python3
"""probook worker-health watchdog — ported from the Claude Code routine
`probook-worker-check` (2026-08-18). Read-only. Prints NOTHING when healthy,
so Hermes `--no-agent` delivery stays silent unless something is wrong.

Why it exists: probook runs 12 supervised workers inside the app container.
The in-app dead-man switch emails when a heartbeat goes stale — but it runs
INSIDE the app, so a dead container fires nothing. This is the outside observer.

The Portainer log scan from the original routine is NOT here: it needs an
authenticated Portainer session (browser). /api/health-summary covers the
"worker went stale" class on its own; the log scan only added the
"HTTP call fails every run while the job still completes" class.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("PROBOOK_BASE", "https://probook.xtec9.xyz").rstrip("/")
STATE = os.path.expanduser("~/.hermes/state/probook/worker-check.json")
TIMEOUT = 20
RETRY_DELAYS = (20, 60, 120)  # เน็ตของเครื่องนี้สะดุดเป็นชั่วโมงได้ (DNS ล่ม 11:03–12:00 วันที่ 19 ส.ค.)


def net_down():
    """เน็ต/DNS ของเครื่องนี้พังเอง ≠ prod ล่ม — ต้องแยกให้ออก ไม่งั้นตะโกนผิดคน"""
    import socket
    for host in ("cloudflare.com", "google.com", "github.com"):
        try:
            socket.getaddrinfo(host, 443)
            return False
        except Exception:
            continue
    return True


def get(path, timeout=TIMEOUT):
    """-> (status, body_text). status 0 = no response at all."""
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "hermes-probook-watchdog"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:  # 503 carries the body we need
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def get_retry(path, timeout=TIMEOUT):
    """ไม่มีคำตอบเลย = ลองใหม่ตามจังหวะ RETRY_DELAYS ก่อนจะสรุปว่าเข้าไม่ถึง"""
    status, body = get(path, timeout)
    for delay in RETRY_DELAYS:
        if status != 0:
            return status, body
        time.sleep(delay)
        status, body = get(path, timeout)
    return status, body


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(s):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def hours(sec):
    try:
        return f"{float(sec) / 3600:.1f} ชม."
    except Exception:
        return "?"


def main():
    state = load_state()
    lines = []

    status, body = get_retry("/api/health-summary")

    if status == 0:
        if net_down():
            # เครื่องนี้เน็ต/DNS ล่ม → เราไม่รู้อะไรเลยเรื่อง prod ห้ามตะโกนว่า prod ตาย
            save_state(state)
            print("⚠️ เช็ก probook ไม่ได้รอบนี้ — เน็ต/DNS ของเครื่องนี้ล่ม (ไม่ใช่ prod)")
            print(f"   ({body[:100]}) รอบหน้าจะลองใหม่เอง")
            return
        state["neverTicked"] = {}
        state["appDownStreak"] = int(state.get("appDownStreak", 0)) + 1
        save_state(state)
        print("⚠️ probook ตอบไม่ได้เลย — /api/health-summary ไม่มีการตอบกลับ (เน็ตเครื่องนี้ปกติ)")
        print(f"   ({body[:120]}) ครั้งที่ {state['appDownStreak']} ติดกัน")
        print("   ดูต่อ: Portainer stack 125 → container production-booking-app (ผมรีสตาร์ทให้ไม่ได้)")
        return
    state["appDownStreak"] = 0

    try:
        data = json.loads(body)
        workers = data.get("workers", [])
    except Exception:
        workers = []
        lines.append(f"⚠️ /api/health-summary ตอบ HTTP {status} แต่อ่าน JSON ไม่ได้: {body[:120]}")

    if status not in (200, 503) and not lines:
        lines.append(f"⚠️ /api/health-summary ตอบ HTTP {status} (คาด 200 หรือ 503)")

    # stale = คำนวณจากฝั่ง server แล้ว (interval + grace 2 ชม.) — เชื่อ flag ได้เลย
    stale = [w for w in workers if w.get("enabled") and w.get("stale")]
    if stale:
        lines.append(f"⚠️ worker ค้าง {len(stale)} ตัว (health-summary = HTTP {status}):")
        for w in stale:
            lines.append(f"   • {w.get('key')} — ไม่ tick มา {hours(w.get('lastTickAgoSec'))}")

    # neverTicked ครั้งเดียวไม่ใช่เรื่องผิดปกติ (worker รายวัน / เพิ่ง redeploy)
    # แจ้งเฉพาะตัวที่ยัง neverTicked ติดกัน 2 รอบ
    prev_never = set(state.get("neverTicked", {}).keys()) if isinstance(state.get("neverTicked"), dict) else set()
    now_never = {w.get("key") for w in workers if w.get("enabled") and w.get("neverTicked")}
    repeat_never = sorted(now_never & prev_never)
    if repeat_never:
        lines.append(f"⚠️ ไม่เคย tick เลย 2 รอบติด: {', '.join(repeat_never)} (supervisor อาจไม่ได้รันสคริปต์)")
    state["neverTicked"] = {k: True for k in sorted(now_never)}

    vstatus, vbody = get_retry("/api/version", timeout=15)
    if vstatus != 200:
        lines.append(f"⚠️ /api/version ตอบ HTTP {vstatus} (คาด 200)")

    save_state(state)

    if lines:
        print("\n".join(lines[:10]))
        sys.exit(0)
    # เงียบเมื่อปกติ — ไม่ print อะไรเลย = Hermes ไม่ส่งข้อความ


if __name__ == "__main__":
    main()
