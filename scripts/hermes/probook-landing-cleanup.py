#!/usr/bin/env python3
"""probook landing drop-folder cleanup — ported from the Claude Code routine
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
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("PROBOOK_BASE", "https://probook.xtec9.xyz").rstrip("/")
PATH = "/api/internal/landing/manage?prune=today&dryRun="
ENV_FILE = os.path.expanduser("~/.hermes/scripts/probook.env")
DRY_TIMEOUT = 180
APPLY_TIMEOUT = 280
SETTLE_SEC = 60  # รอหลัง apply ที่ 504/timeout ก่อนไป verify


def secret():
    val = os.environ.get("PROBOOK_LANDING_SECRET")
    if val:
        return val.strip()
    try:
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line.startswith("PROBOOK_LANDING_SECRET="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return ""


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


def main():
    token = secret()
    if not token:
        print("⚠️ landing-cleanup ไม่ได้รัน — ไม่พบ PROBOOK_LANDING_SECRET")
        print(f"   ใส่ค่าไว้ที่ {ENV_FILE} (บรรทัด PROBOOK_LANDING_SECRET=…)")
        return

    # 1) DRY-RUN (read-only → retry ได้ 1 ครั้งถ้าโดน proxy ตัด)
    status, data, err = call(True, token, DRY_TIMEOUT)
    if status in (0, 502, 503, 504):
        time.sleep(10)
        status, data, err = call(True, token, DRY_TIMEOUT)

    if status == 401:
        print("⚠️ landing-cleanup: prod ตอบ 401 — shared secret ไม่ตรงแล้ว (prod หมุน NEXTAUTH_SECRET?)")
        print(f"   อัปเดตค่าใน {ENV_FILE} แล้วรอบหน้าจะทำงานเอง")
        return
    if status != 200 or not isinstance(data, dict):
        print(f"⚠️ landing-cleanup: dry-run ไม่สำเร็จ (http={status}) {str(err)[:120]}")
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


if __name__ == "__main__":
    main()
