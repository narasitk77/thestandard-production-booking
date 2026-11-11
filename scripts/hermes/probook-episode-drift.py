#!/usr/bin/env python3
"""probook-episode-drift — รายงานประจำวัน: รหัสตอนในใบจอง (Episode.episodeId) ตรงกับ Producer Dashboard ไหม
Hermes `--no-agent` · cron `30 5 * * *` (05:30 เวลาไทย — ก่อนรอบ sync ใบจองของ PMDC) · stdlib ล้วน ไม่มี LLM
เรียก /api/internal/episode-sync/run (v1.286) จากในคอนเทนเนอร์แอปผ่าน Portainer exec (secret อยู่ในคอนเทนเนอร์)

ที่มา: 4 พ.ย. 2569 Dashboard เปลี่ยน PP-26-056-H01 → S01 แต่ใบจองยังผูก H01 ทำให้ PMDC ขึ้น "Unresolved Episode"
ทุกคืน (PMDC อ่านแท็บ Bookings คอลัมน์ Episode IDs แล้วค้น Airtable ด้วยรหัสตรงตัว) · นัทสั่ง: "ควรซิงค์ ... ไม่อยากเปลี่ยนด้วยมือเอง"

ทำอะไร:
  1. GET  รายงาน drift (อ่านอย่างเดียว) — อ่าน Dashboard ไม่ได้/ว่าง/ชี้ชีททดสอบ = ⚠️ ไม่ใช่ "ไม่มี drift"
  2. ถ้ามีคู่ที่เชื่อได้ (หายหนึ่ง โผล่ใหม่หนึ่ง + ชื่อตอนเฉพาะที่ตรงกัน) → POST {auto:true, apply:true}
     เซิร์ฟเวอร์ตัดสินว่าเขียนจริงไหม: เฉพาะเมื่อ stack ตั้ง EPISODE_SYNC_AUTOAPPLY=1 (ค่าเริ่มต้น 0 = dry-run + บอกตรง ๆ)
  3. drift ที่ไม่เชื่อให้แก้เอง → ⚠️ รายโปรเจกต์ พร้อม "คู่ที่น่าจะใช่" ถ้ามี (คนสั่งแก้ทีละคู่ผ่าน call_internal.py)

ผลลัพธ์ (README scripts/hermes "หลักการที่ต้องรักษาไว้"):
  - ไม่มี drift = เงียบ · มีข้อค้นพบ = พิมพ์ดัง ๆ แต่ exit 0 (สคริปต์ทำงานสำเร็จ — ปัญหาอยู่ที่ข้อมูล)
  - exit 1 เฉพาะเมื่อ *เรา* อ่านรายงานไม่ได้ (ok:false, Portainer/wget ล้ม, พังกลางคัน) — ข้อความสั้นที่รอดการตัด ~177 ตัวของ Hermes
  - POST แก้อัตโนมัติไม่รู้ผล = exit 0 + ข้อความ ❓ เต็ม (ถ้า exit 1 Hermes จะตัดรายงานทิ้งเหลือบรรทัดเดียว)
  - OUTBOX: รายงานรอบที่ Hermes ส่ง Discord ไม่ถึง จะถูกพิมพ์ซ้ำนำหน้ารอบถัดไป

wget: `-q --tries=1` (รูปเดียวกับ footage-check/audit-tools/call_internal.py ที่ใช้มาจริง) · busybox wget ยิงซ้ำเองเมื่ออ่าน
response ช้า (บทเรียน 19 ต.ค. 2569) · ทิ้ง body ของ non-2xx เสมอ → route จึงตอบการปฏิเสธเป็น 200 + ok:false

  python3 probook-episode-drift.py              # รันจริง (Hermes เรียกแบบนี้)
  python3 probook-episode-drift.py --dry-run    # อ่านรายงานอย่างเดียว ไม่เรียก auto
  python3 probook-episode-drift.py --self-test  # ตัวสร้างข้อความ + ตัวอ่านผล wget ด้วยข้อมูลปลอม ไม่แตะ prod
"""
import base64
import json
import os
import re
import sys
import time
import urllib.request

PROBOOK_ENV = os.path.expanduser("~/.hermes/scripts/probook.env")
BASE = "http://127.0.0.1:3000/api/internal/episode-sync/run"


def read_env(path):
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def parse_wget(raw):
    """ผลดิบจาก exec → dict ของ JSON ตัวแรก (ทนข้อความต่อท้าย) · ไม่มี JSON = error พร้อม rc ของ wget (pure — self-test)"""
    head, _, tail = raw.partition("__RC__")
    m = re.match(r"\s*(\d+)", tail)
    rc = int(m.group(1)) if m else None
    i = head.find("{")
    if i < 0:
        raise RuntimeError(f"route ไม่ตอบ JSON (wget rc={rc} · 401/500 = busybox ทิ้ง body): {head.strip()[-200:]!r}")
    try:
        obj, _ = json.JSONDecoder().raw_decode(head[i:])
    except ValueError:
        raise RuntimeError(f"อ่าน JSON จาก route ไม่ออก (wget rc={rc}): {head.strip()[-200:]!r}")
    if not isinstance(obj, dict):
        raise RuntimeError(f"route ตอบ JSON ที่ไม่ใช่ object (wget rc={rc})")
    return obj


def container_call(method, body=None, timeout=330):
    """ยิง route ภายในจากในคอนเทนเนอร์แอป → dict · ล้มทุกแบบ = raise (ห้ามกลายเป็น 'ไม่มี drift')"""
    e = read_env(PROBOOK_ENV)
    base, key, ep = e["PORTAINER_URL"].rstrip("/"), e["PORTAINER_API_KEY"], e.get("PORTAINER_ENDPOINT_ID", "2")

    def call(path, payload, t):
        req = urllib.request.Request(base + path, data=json.dumps(payload).encode(), method="POST",
                                     headers={"X-API-Key": key, "Content-Type": "application/json"})
        return urllib.request.urlopen(req, timeout=t)

    hdr = 'x-episode-sync-secret: $NEXTAUTH_SECRET'
    if method == "GET":
        cmd = f'wget -q --tries=1 -O - --header="{hdr}" "{BASE}"; rc=$?; echo; echo "__RC__$rc"'
    else:
        b64 = base64.b64encode(json.dumps(body).encode()).decode()   # base64 = ไม่มีอักขระที่ shell ตีความ
        cmd = (f'wget -q --tries=1 -O - --header="{hdr}" --header="Content-Type: application/json" '
               f'--post-data="$(echo {b64} | base64 -d)" "{BASE}"; rc=$?; echo; echo "__RC__$rc"')
    eid = json.loads(call(f"/api/endpoints/{ep}/docker/containers/production-booking-app/exec",
                          {"AttachStdout": True, "AttachStderr": True, "Tty": True, "Cmd": ["sh", "-c", cmd]}, 60).read())["Id"]
    raw = call(f"/api/endpoints/{ep}/docker/exec/{eid}/start", {"Detach": False, "Tty": True}, timeout).read().decode("utf-8", "replace")
    return parse_wget(raw)


def why_line(d):
    s = d.get("suggested") or {}
    pair = f"{s.get('from')} → {s.get('to')}" if s else "?"
    reason = d.get("reason")
    if reason == "weak-label":
        return f"คู่ที่น่าจะใช่: {pair} แต่ชื่อตอนใน Dashboard ไม่เฉพาะพอให้แก้อัตโนมัติ — ถ้าถูก ให้สั่งแก้คู่นี้"
    if reason == "label-mismatch":
        return f"ถ้าคู่คือ {pair} ชื่อตอนใน Dashboard ไม่ตรงกับที่ใบจองเก็บ — ไม่เชื่อว่าเป็นตอนเดียวกัน"
    if reason == "several":
        return f"จับคู่เองไม่ได้ (รหัสใน Dashboard ที่ยังไม่มีใบจอง {len(d.get('unclaimed', []))}: {', '.join(d.get('unclaimed', [])[:6])})"
    if reason == "no-unclaimed":
        codes = d.get("dashboardCodes") or []
        return (f"รหัสใน Dashboard ของโปรเจกต์: {', '.join(codes[:8])} — ทุกตัวมีใบจองถือแล้ว จับคู่เองไม่ได้" if codes
                else "Dashboard ไม่มีโปรเจกต์นี้แล้ว")
    return f"ต้องคนดู ({reason or d.get('kind')})"


def lines_for_drift(drift):
    """ข้อความของ drift ที่ไม่ใช่คู่ที่เชื่อได้ (pure — self-test)"""
    return [f"  • {d['project']}: รหัสที่ใบจองถือแต่ Dashboard ไม่มี = {', '.join(d['orphans'])} · ใบ {', '.join(d['bookings'][:8])} · {why_line(d)}"
            for d in drift if d["kind"] != "rename-candidate"]


def describe_result(r):
    ws = f" · เตือน: {'; '.join(r['warnings'])}" if r.get("warnings") else ""
    b = ", ".join(x["bookingCode"] or "?" for x in r.get("bookings", []))
    if not r["ok"]:
        return f"  ✗ {r['from']} → {r['to']}: ไม่สำเร็จ — {r.get('error') or '; '.join(r.get('blockers', []))}"
    if r.get("nothingToDo"):
        return f"  ✓ {r['from']} → {r['to']}: เปลี่ยนไปแล้วก่อนหน้า (audit ยืนยัน)"
    verb = "จะเปลี่ยน (dry-run)" if r["dryRun"] else "เปลี่ยนแล้ว"
    return f"  ✓ {r['from']} → {r['to']}: {verb} ในใบ {b}{ws}"


def compose(report, auto, auto_err=None):
    """ข้อความรายงาน (None = เงียบ) · pure — self-test
    report = ผล GET · auto = ผล POST (None = ไม่ได้เรียก) · auto_err = exception ของ POST (ผลไม่แน่นอน)"""
    if not report.get("ok"):
        return f"⚠️ รหัสตอน vs Dashboard: ตรวจไม่ได้ — {report.get('error')}"
    drift = report.get("drift", [])
    if not drift:
        return None
    out = []
    cands = [d for d in drift if d["kind"] == "rename-candidate"]
    pairs = ", ".join(f"{d['candidate']['from']}→{d['candidate']['to']}" for d in cands)
    if cands:
        if auto_err is not None:
            out.append(f"❓ ส่งคู่ {pairs} ไปแก้อัตโนมัติแล้ว **ไม่รู้ผล** ({type(auto_err).__name__}: {str(auto_err)[:140]}) — "
                       "เซิร์ฟเวอร์อาจแก้ไปแล้ว: ดู audit_logs action booking.episode_renamed หรือรอรายงานรอบหน้า "
                       "(รันซ้ำปลอดภัย — คู่ที่แก้แล้วจะตอบว่าเปลี่ยนไปแล้ว)")
        elif auto is None:
            out.append(f"🔎 คู่ที่เชื่อได้ (สคริปต์รัน --dry-run จึงไม่ได้เรียก auto): {pairs}")
        elif auto.get("results") is None:
            out.append(f"⚠️ แก้รหัสตอนอัตโนมัติไม่ได้ลงมือ: {auto.get('error') or 'ไม่ระบุสาเหตุ'}")
        else:
            if not auto.get("applied"):
                out.append("🔎 คู่ที่เชื่อได้ แต่ **ยังไม่ได้แก้** (สวิตช์ EPISODE_SYNC_AUTOAPPLY ปิดอยู่) — ถ้ายืนยันว่าถูก ให้นัทสั่งเปิดสวิตช์หรือสั่งแก้ทีละคู่:")
            elif auto.get("ok") and auto["results"] and all(r["ok"] for r in auto["results"]):
                out.append("🔁 แก้รหัสตอนตาม Dashboard แล้ว:")
            else:
                out.append("⚠️ ผลการแก้รหัสตอนตาม Dashboard (มีคู่ที่ไม่สำเร็จ):")
            out += [describe_result(r) for r in auto["results"]]
            got = {(r["from"], r["to"]) for r in auto["results"]}
            missing = [f"{d['candidate']['from']}→{d['candidate']['to']}" for d in cands if (d["candidate"]["from"], d["candidate"]["to"]) not in got]
            if missing:
                out.append(f"  ⚠️ คู่จากรายงานที่ไม่อยู่ในผลรอบแก้: {', '.join(missing)} — ข้อมูลเปลี่ยนระหว่างสองคำสั่ง ยังไม่ได้แก้ (รอบหน้าจะรายงานใหม่)")
            notes = next((r.get("notes") for r in auto["results"] if r.get("committed") and r.get("notes")), None)
            if notes:
                out += [f"  ℹ️ {n}" for n in notes]
    rest = lines_for_drift(drift)
    if rest:
        out.append("⚠️ รหัสตอนที่ Dashboard ไม่มีแล้ว และไม่เชื่อพอจะแก้เอง — ต้องคนตัดสิน (PMDC ขึ้น Unresolved Episode ทุกคืนจนกว่าจะแก้):")
        out += rest
    return "\n".join(out)


# ── OUTBOX + SELF-FAIL (ก๊อปจาก probook-tuy-digest.py — README scripts/hermes ข้อ 4) ──
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
# ⚠️ แก้ 11 พ.ย. 2569 (ตรวจกับ Hermes ที่ติดตั้งอยู่): รอบที่ exit ≠ 0 ไม่ได้ส่ง stdout เต็ม — scheduler.py:6420 ส่ง
# _summarize_cron_failure_for_delivery() ซึ่งตัดเหลือ ~177 ตัวอักษร (ฉบับเต็มอยู่แค่ใน ~/.hermes/cron/output/) และการส่ง
# สรุปนั้นสำเร็จ = last_delivery_error ว่าง = OUTBOX ไม่ส่งซ้ำ · สคริปต์นี้จึง exit 1 เฉพาะเมื่อข้อความสั้นอยู่แล้ว
# (อ่านระบบไม่ได้/พังกลางคัน) ส่วนข้อความยาวที่คนต้องอ่านครบ = exit 0 แล้วพูดดัง ๆ ในข้อความเอง
_SELF_FAIL = []


def self_fail(reason=""):
    """ทำเครื่องหมายว่ารอบนี้ 'เราทำงานไม่สำเร็จ' — epilogue จะ exit 1"""
    _SELF_FAIL.append(reason or "self-failure")


OUTBOX = os.path.expanduser("~/.hermes/state/probook/outbox-episode-drift.json")
JOB_NAME = "probook-episode-drift"


def main(dry_run=False):
    report = container_call("GET")
    if not report.get("ok"):
        self_fail("report not ok")             # อ่าน Dashboard ไม่ได้ ฯลฯ = เราตรวจไม่ได้ (ไม่ใช่ "ไม่มี drift")
    auto, auto_err = None, None
    if report.get("ok") and not dry_run and any(d["kind"] == "rename-candidate" for d in report.get("drift", [])):
        try:
            auto = container_call("POST", {"auto": True, "apply": True})
        except Exception as e:                 # ผลไม่แน่นอน: อาจแก้ไปแล้ว — ห้ามทิ้งรายงาน GET และต้องบอกตรง ๆ
            auto_err = e                       # exit 0 on purpose: a failed run reaches Discord as ~177 chars (see above)
    text = compose(report, auto, auto_err)
    if text:
        print(text)


def self_test():
    cand = {"project": "PP-26-056", "kind": "rename-candidate", "orphans": ["PP-26-056-H01"], "unclaimed": ["PP-26-056-S01"],
            "bookings": ["AGN-261026-01", "AGN-261126-02"], "candidate": {"from": "PP-26-056-H01", "to": "PP-26-056-S01"}}
    weak = {"project": "PP-26-056", "kind": "ambiguous", "reason": "weak-label", "orphans": ["PP-26-056-H01"],
            "unclaimed": ["PP-26-056-S01"], "bookings": ["AGN-261026-01"], "suggested": {"from": "PP-26-056-H01", "to": "PP-26-056-S01"},
            "dashboardCodes": ["PP-26-056-L01", "PP-26-056-S01"]}
    sev = {"project": "PP-26-039", "kind": "ambiguous", "reason": "several", "orphans": ["PP-26-039-L02"],
           "unclaimed": ["PP-26-039-L03", "PP-26-039-S01"], "bookings": ["AGN-261001-01"], "dashboardCodes": []}
    noun = {"project": "PP-26-040", "kind": "orphan-only", "reason": "no-unclaimed", "orphans": ["PP-26-040-H01"], "unclaimed": [],
            "bookings": ["AGN-261002-01"], "dashboardCodes": ["PP-26-040-L01", "PP-26-040-S01"]}
    gone = {"project": "PP-26-077", "kind": "orphan-only", "reason": "no-unclaimed", "orphans": ["PP-26-077-L01"], "unclaimed": [],
            "bookings": ["AGN-261003-01"], "dashboardCodes": []}
    ok = {"ok": True, "dashboardEpisodes": 9, "bookingRows": 20}
    res = {"ok": True, "dryRun": True, "from": "PP-26-056-H01", "to": "PP-26-056-S01", "nothingToDo": False,
           "bookings": [{"bookingCode": "AGN-261026-01"}, {"bookingCode": "AGN-261126-02"}], "warnings": []}

    # ตัวอ่านผล wget: JSON + ขยะต่อท้าย (Tty \r\n, ข้อความ busybox) ต้องอ่านออก · ไม่มี JSON = error ที่บอก rc
    assert parse_wget('{"ok": true, "drift": []}\r\n\r\n__RC__0\r\n') == {"ok": True, "drift": []}
    assert parse_wget('{"ok": true}\r\nwritten to stdout\r\n__RC__0') == {"ok": True}
    for raw in ("wget: server returned error: HTTP/1.1 401 Unauthorized\r\n__RC__1", "\r\n__RC__1", "{not json\r\n__RC__0", "[1,2]\r\n__RC__0"):
        try:
            parse_wget(raw)
            raise AssertionError(f"ต้อง raise: {raw!r}")
        except RuntimeError as e:
            assert "wget rc=" in str(e), e

    assert compose({"ok": True, "drift": []}, None) is None, "ไม่มี drift = เงียบ"
    t = compose({"ok": False, "error": "อ่าน Dashboard ไม่ได้: x"}, None)
    assert "ตรวจไม่ได้" in t and "x" in t
    t = compose({**ok, "drift": [cand]}, {"ok": True, "autoApplyEnabled": False, "applied": False, "results": [res], "note": "off"})
    assert "ยังไม่ได้แก้" in t and "จะเปลี่ยน (dry-run)" in t
    t = compose({**ok, "drift": [cand]}, {"ok": True, "applied": True, "results": [{**res, "dryRun": False}]})
    assert "แก้รหัสตอนตาม Dashboard แล้ว" in t and "เปลี่ยนแล้ว" in t
    t = compose({**ok, "drift": [cand]}, {"ok": True, "applied": True, "results": [{**res, "dryRun": False, "warnings": ["x: ชีท"]}]})
    assert "เตือน: x: ชีท" in t
    t = compose({**ok, "drift": [cand]}, {"ok": False, "error": "เกินเพดาน", "drift": [cand]})
    assert "ไม่ได้ลงมือ: เกินเพดาน" in t
    fail = {"ok": False, "from": "PP-26-056-H01", "to": "PP-26-056-S01", "blockers": [], "error": "เขียนชีทไม่สำเร็จ", "bookings": []}
    t = compose({**ok, "drift": [cand]}, {"ok": False, "applied": True, "failed": 1, "results": [fail]})
    assert "มีคู่ที่ไม่สำเร็จ" in t and "✗ PP-26-056-H01 → PP-26-056-S01: ไม่สำเร็จ — เขียนชีทไม่สำเร็จ" in t
    t = compose({**ok, "drift": [cand]}, {"ok": False, "applied": True, "results": [{**res, "dryRun": False}]})
    assert "มีคู่ที่ไม่สำเร็จ" in t, "เชื่อ ok ของเซิร์ฟเวอร์ ไม่ใช่แค่ผลรายคู่"
    # POST ล้ม/ไม่รู้ผล: ต้องยังมีข้อค้นพบจาก GET และบอกว่าอาจแก้ไปแล้ว
    t = compose({**ok, "drift": [cand, weak]}, None, TimeoutError("timed out"))
    assert "ไม่รู้ผล" in t and "PP-26-056-H01→PP-26-056-S01" in t and "TimeoutError" in t and "คู่ที่น่าจะใช่" in t
    # เหตุผลแต่ละแบบพูดความจริง (no-unclaimed ห้ามบอกว่า "ไม่มีรหัสใหม่")
    t = compose({**ok, "drift": [weak, sev, noun, gone]}, None)
    assert "คู่ที่น่าจะใช่: PP-26-056-H01 → PP-26-056-S01" in t
    assert "รหัสใน Dashboard ที่ยังไม่มีใบจอง 2" in t
    assert "PP-26-040-L01, PP-26-040-S01 — ทุกตัวมีใบจองถือแล้ว" in t
    assert "Dashboard ไม่มีโปรเจกต์นี้แล้ว" in t
    assert not re.search(r"@thestandard|secret", t, re.I)
    # applied แต่ผลว่าง/คู่หาย: ห้ามขึ้น "🔁 แก้แล้ว" และต้องบอกว่าคู่ไหนยังไม่ได้แก้
    t = compose({**ok, "drift": [cand]}, {"ok": True, "applied": True, "results": []})
    assert "แก้รหัสตอนตาม Dashboard แล้ว" not in t and "ไม่อยู่ในผลรอบแก้: PP-26-056-H01→PP-26-056-S01" in t, t
    # แก้สำเร็จ: บอกสิ่งที่ไม่ได้แก้ (ปฏิทิน/OT) ครั้งเดียว
    done = {**res, "dryRun": False, "committed": True, "notes": ["ปฏิทิน: ไม่แก้", "OT: ป้ายเดิม"]}
    t = compose({**ok, "drift": [cand]}, {"ok": True, "applied": True, "results": [done]})
    assert "แก้รหัสตอนตาม Dashboard แล้ว" in t and t.count("ℹ️ ปฏิทิน: ไม่แก้") == 1 and "ℹ️ OT: ป้ายเดิม" in t, t
    print("self-test ok")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
        sys.exit(0)
    if "--dry-run" in sys.argv:
        main(dry_run=True)
        sys.exit(1 if _SELF_FAIL else 0)
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
        self_fail("crash")
        _crash = f"⚠️ {JOB_NAME} พังกลางคัน: {type(_e).__name__}: {str(_e)[:200]}"

    _report = _buf.getvalue().rstrip("\n")
    if _crash:
        _report = (_report + "\n" + _crash).strip()

    # ลำดับสำคัญ: อ่าน+ล้าง outbox ของรอบก่อนให้เสร็จ แล้วจึงเขียนของรอบนี้ทับ
    _resend = undelivered_lines(JOB_NAME, OUTBOX)
    _payload = "\n".join(_resend + ([_report] if _report else []))
    remember_report(OUTBOX, "\n".join(_payload.splitlines()[:60]))

    if _payload:
        print(_payload)
    if _SELF_FAIL:
        sys.exit(1)
