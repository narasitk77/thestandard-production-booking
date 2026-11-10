#!/usr/bin/env python3
"""probook-tuy-digest — สรุปใบจองที่เปลี่ยน ส่งถึงตุ้ย (tossapol.b@, Production Coordinator) ทาง Pig
วันละ 2 รอบ `30 8,17 * * *` (เวลาไทย) · Hermes `--no-agent` · stdlib ล้วน ไม่มี LLM

นัทสั่ง 10 พ.ย. 2569 หลังรอบทดลอง (#31EB06): "ตั้งตรวจ worker คอย เรื่องส่งให้ตุ้ยด้วย"
→ นัทเลือก: สรุปวันละ 2 รอบ (08:30 / 17:30) · รวมส่วน "✍️ ที่ตุ้ยแก้เอง"

กฎ = ชุดเดียวกับที่ปุ๊กประกาศสำหรับ Pig: ยกเลิก/ลบใบ · ถอด/เพิ่มตอน · เลื่อนวัน/เวลา/สถานที่ ·
เปลี่ยนทีม (เฉพาะงานที่ยังไม่ถ่ายเสร็จและถ่ายภายใน 7 วัน) · เปลี่ยน Producer · ใบจองใหม่ ·
**ไม่นับการอนุมัติ** (รวมการจัดทีมครั้งแรกตอนอนุมัติ = แถว assign ที่ fromStatus REQUESTED / from ว่าง) ·
งานที่ถ่ายวันนี้–พรุ่งนี้และยังไม่จบ = หัว 🔴 ด่วน

ช่วงเวลา = ต่อจากรอบก่อน (state `lastEnd`) ถึงตอนนี้ — เครื่องหลับ/Hermes ไม่รัน = รอบหน้าครอบให้ ไม่มีอะไรหล่น

ทางออก (stdout = ข้อความถึงนัทในห้อง hermes-agent · ว่าง = ไม่ส่ง):
  - ส่งถึงตุ้ยแล้ว  → 1 บรรทัดยืนยัน (qid + ลิงก์รายงาน) · เลื่อน lastEnd
  - ไม่มีอะไรเปลี่ยน → เงียบ · เลื่อน lastEnd
  - อ่าน prod ไม่ได้ → ⚠️ + exit 1 · **ไม่**เลื่อน lastEnd (ห้ามแปลง error เป็น "ไม่มีอะไรเปลี่ยน")
  - Pig ปฏิเสธ (HTTP error / ok:false) → ⚠️ + exit 1 · ไม่เลื่อน (รอบหน้าส่งรวม)
  - Pig ไม่ตอบ / ตอบอ่านไม่ออก → ⚠️ "ไม่แน่ใจว่าถึง" + exit 1 · **เลื่อน** lastEnd และ**ห้ามยิงซ้ำ**
    (กฎ CLAUDE.local.md: curl ค้าง = ข้อความอาจไปแล้ว ยิงซ้ำ = ตุ้ยได้ซ้ำ) — นัทเช็กกับตุ้ยเอง

LOG ถาวร: ทุกครั้งที่ยิง Pig (ทุกผล) ต่อท้าย 1 บรรทัดใน ~/.hermes/state/probook/tuy-digest-log.jsonl
(ข้อความเต็ม + ช่วงเวลา + ผล + qid + ลิงก์) — หน้ารายงานของ Pig อยู่แค่ 14 วัน · ไฟล์นี้มีชื่อคน
จึงอยู่นอกรีโป (รีโปเป็น public)

กุญแจ Pig อ่านจาก ~/.zshrc ตอนรันเท่านั้น (บรรทัด `export PIG_SECRET=`) — ห้ามคัดลอกไปไว้ที่อื่น
(CLAUDE.local.md: "อยู่ใน ~/.zshrc เท่านั้น") · Portainer อ่านจาก ~/.hermes/scripts/probook.env

  python3 probook-tuy-digest.py              # รันจริง (Hermes เรียกแบบนี้)
  python3 probook-tuy-digest.py --dry-run    # ทางเดียวกับรันจริงทุกขั้น ยกเว้นไม่ยิง Pig และไม่เขียน state/log
  python3 probook-tuy-digest.py --self-test  # เทสต์ตัวสร้างข้อความด้วยข้อมูลปลอม ไม่แตะ prod
"""
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BKK = timezone(timedelta(hours=7))
TUY = "tossapol.b@thestandard.co"
PIG_TO = "ตุ้ย"                       # → person:ตุ้ย (ส่งถึงตุ้ยคนเดียว — นัทสั่ง "แจ้งตุ้ยคนเดียว")
STATE = os.path.expanduser("~/.hermes/state/probook/tuy-digest.json")
SENT_DIR = os.path.expanduser("~/.hermes/state/probook/tuy-digest")   # <วันเวลา>_<qid>.md ฉบับละไฟล์ + log.jsonl
SENT_LOG = os.path.join(SENT_DIR, "log.jsonl")
PROBOOK_ENV = os.path.expanduser("~/.hermes/scripts/probook.env")
ZSHRC = os.path.expanduser("~/.zshrc")
APP = "https://probook.thestandard.co"    # ลิงก์หน้าใบจอง /admin/<id> (นัทขอ 10 พ.ย. "แนบลิงก์ไปด้วย")
TH_MON = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."]

# READ-ONLY: findMany เท่านั้น — ไม่มี create/update/delete ในสคริปต์นี้
QUERY_JS = r"""
const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient()
;(async () => {
  const since = new Date(process.env.SINCE), until = new Date(process.env.UNTIL)
  const LIMIT = 5000
  const audits = await prisma.auditLog.findMany({ where: { at: { gt: since, lte: until }, action: { startsWith: 'booking.' } },
    orderBy: { at: 'asc' }, take: LIMIT,
    select: { at: true, actorEmail: true, action: true, bookingCode: true, fromStatus: true, toStatus: true, changes: true } })
  const codes = [...new Set(audits.map(a => a.bookingCode).filter(Boolean))]
  const bookings = await prisma.booking.findMany({ where: { bookingCode: { in: codes } },
    select: { id: true, bookingCode: true, status: true, deletedAt: true, shootDate: true, shootEndDate: true, callTime: true, estimatedWrap: true,
      locationName: true, producer: true, program: { select: { name: true } }, episodes: { select: { episodeId: true, title: true } } } })
  const cancelled = bookings.filter(b => b.status === 'CANCELLED' || b.deletedAt).map(b => b.bookingCode)
  const reqs = cancelled.length ? await prisma.auditLog.findMany({ where: { action: 'booking.cancel_requested', bookingCode: { in: cancelled } },
    orderBy: { at: 'desc' }, select: { bookingCode: true, changes: true } }) : []
  const users = await prisma.user.findMany({ select: { email: true, thaiName: true } })
  console.log('OUT>' + JSON.stringify({ audits, bookings, reqs, users, truncated: audits.length >= LIMIT }))
  await prisma.$disconnect()
})().catch(e => { console.log('OUT>' + JSON.stringify({ error: String(e && e.message || e) })); process.exit(1) })
"""


def read_env(path):
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def pig_creds():
    """PIG_SECRET/PIG_HOST จาก ~/.zshrc ตอนรัน — ไม่เก็บไว้ที่อื่น"""
    secret = host = None
    with open(ZSHRC, encoding="utf-8") as f:
        for line in f:
            m = re.match(r'\s*export\s+(PIG_SECRET|PIG_HOST)=(.*)$', line)
            if m:
                v = m.group(2).strip().strip('"').strip("'")
                if m.group(1) == "PIG_SECRET":
                    secret = v
                else:
                    host = v
    if not secret or not host:
        raise RuntimeError("ไม่พบ PIG_SECRET / PIG_HOST ใน ~/.zshrc")
    return secret, host.rstrip("/")


def fetch(since_utc, until_utc):
    """อ่าน prod ผ่าน Portainer docker exec (ทางเดียวกับ footage-check/drive_inventory.py)"""
    e = read_env(PROBOOK_ENV)
    base, key, ep = e["PORTAINER_URL"].rstrip("/"), e["PORTAINER_API_KEY"], e.get("PORTAINER_ENDPOINT_ID", "2")

    def call(path, payload, timeout=180):
        req = urllib.request.Request(base + path, data=json.dumps(payload).encode(), method="POST",
                                     headers={"X-API-Key": key, "Content-Type": "application/json"})
        return urllib.request.urlopen(req, timeout=timeout)

    b64 = base64.b64encode(QUERY_JS.encode()).decode()
    tmp = f"/tmp/_tuydigest_{os.getpid()}.cjs"
    sh = (f"echo {b64} | base64 -d > {tmp} && cd /app && SINCE={since_utc} UNTIL={until_utc} "
          f"NODE_PATH=/app/node_modules node {tmp}; rm -f {tmp}")
    eid = json.loads(call(f"/api/endpoints/{ep}/docker/containers/production-booking-app/exec",
                          {"AttachStdout": True, "AttachStderr": True, "Tty": True, "Cmd": ["sh", "-c", sh]}).read())["Id"]
    raw = call(f"/api/endpoints/{ep}/docker/exec/{eid}/start", {"Detach": False, "Tty": True}).read().decode("utf-8", "replace")
    line = next((l for l in raw.splitlines() if l.startswith("OUT>")), None)
    if line is None:
        raise RuntimeError(f"คอนเทนเนอร์ไม่ตอบผลการอ่าน: {raw[-200:]!r}")
    d = json.loads(line[4:])
    if "error" in d:
        raise RuntimeError(f"อ่าน DB ไม่สำเร็จ: {d['error'][:200]}")
    if d.get("truncated"):
        raise RuntimeError("audit ในช่วงนี้เกิน 5,000 แถว — ไม่ส่งสรุปที่ไม่ครบ")
    return d


# ── ตัวสร้างข้อความ (pure — เทสต์ใน --self-test) ─────────────────────────────
def build(d, since, now):
    """d = ผลจาก fetch() · since/now = datetime (tz) · คืน (text | None, จำนวนรายการ)"""
    since, now = since.astimezone(BKK), now.astimezone(BKK)
    B = {b["bookingCode"]: b for b in d["bookings"]}
    U = {u["email"].lower(): u for u in d["users"]}
    today = now.date()
    tomorrow = today + timedelta(days=1)

    def day(s):
        x = datetime.fromisoformat(s[:10])
        return f"{x.day} {TH_MON[x.month]}" + ("" if x.year == now.year else f" {(x.year + 543) % 100}")

    def first(email):
        e = (email or "").lower()
        if e == "narasit.k@thestandard.co":
            return "นัท"
        if e.split("@")[0] in ("sound", "video"):
            return e.split("@")[0].capitalize()
        t = re.sub(r"^(นางสาว|นาย|นาง)\s*", "", (U.get(e) or {}).get("thaiName") or "").split(" ")[0]
        return t or e.split("@")[0]

    def title(b):
        ts = [" ".join(x["title"].split()) for x in b["episodes"] if x.get("title") and x["title"].strip() not in ("-", "TBC")]
        t = ts[0] if ts else ""
        if t.isdigit():
            t = f"EP {t}"
        if len(t) > 36:
            t = t[:36].rsplit(" ", 1)[0] + "…"
        return (t + (f" (+{len(ts) - 1} ตอน)" if len(ts) > 1 else "")).strip()

    def when(b):
        return f"{b['callTime']}–{b['estimatedWrap']}" if b.get("estimatedWrap") else b["callTime"]

    def span(b):
        s = datetime.fromisoformat(b["shootDate"][:10]).date()
        e = datetime.fromisoformat((b.get("shootEndDate") or b["shootDate"])[:10]).date()
        return s, e

    def finished(b):
        s, e = span(b)
        return b["status"] == "COMPLETED" or e < today or (e == today and (b.get("estimatedWrap") or "23:59") <= now.strftime("%H:%M"))

    def urgent(b):
        s, e = span(b)
        return s <= tomorrow and e >= today and not finished(b)

    def within7(b):
        s, e = span(b)
        return e >= today and s <= today + timedelta(days=7)

    def line(b, rest):
        return " ".join(x for x in (day(b["shootDate"]), b["bookingCode"], title(b)) if x) + f" · {rest}"

    reasons = {}
    for r in d.get("reqs", []):            # ล่าสุดก่อน (orderBy desc) — คำขอยกเลิกอาจมาก่อนช่วงเวลานี้
        reasons.setdefault(r["bookingCode"], (r.get("changes") or {}).get("reason"))
    items, crew = [], {}
    for a in d["audits"]:
        b = B.get(a.get("bookingCode"))
        ch = a.get("changes") or {}
        if not b or not isinstance(ch, dict):
            continue
        act = a["action"]
        by_tuy = (a.get("actorEmail") or "").lower() == TUY
        it = dict(code=b["bookingCode"], by_tuy=by_tuy, shoot=b["shootDate"][:10], b=b)
        if (act in ("booking.status_change", "booking.force_status") and a.get("toStatus") == "CANCELLED") or act in ("booking.delete", "booking.soft_delete"):
            r = reasons.get(b["bookingCode"])
            txt = ("ลบใบ" if "delete" in act else "ยกเลิก") + (f" — เหตุผล: {r}" if r else "")
            items.append(dict(it, kind="cancel", text=line(b, txt)))
        elif act in ("booking.episodes_removed", "booking.episodes_added"):
            who = "" if by_tuy else f" (โดย {first(a.get('actorEmail'))})"
            if act.endswith("removed"):
                rem = ch.get("removed") or []
                txt = f"ถอด {len(rem)} ตอน ({', '.join(rem)}) เหลือ {len(b['episodes'])} ตอน"
            else:
                txt = f"เพิ่ม {ch.get('count') or len(ch.get('episodeIds') or [])} ตอน"
            items.append(dict(it, kind="eps", text=line(b, txt + who)))
        elif act in ("booking.update", "booking.producer_edit"):
            if "shootDate" in ch or "shootEndDate" in ch:
                f_ = (ch.get("shootDate") or {}).get("from") or b["shootDate"]
                items.append(dict(it, kind="date", text=line(b, f"เลื่อนวัน {day(f_)} → {day(b['shootDate'])}")))
            if "callTime" in ch or "estimatedWrap" in ch:
                f_ = f"{(ch.get('callTime') or {}).get('from', b['callTime'])}–{(ch.get('estimatedWrap') or {}).get('from', b.get('estimatedWrap'))}"
                items.append(dict(it, kind="time", text=line(b, f"เวลา {f_} → {when(b)}")))
            if "locationName" in ch or "shootType" in ch:
                items.append(dict(it, kind="loc", text=line(b, f"สถานที่ → {(b.get('locationName') or '')[:40]}")))
            if "producer" in ch or "producerEmail" in ch:
                items.append(dict(it, kind="producer", text=line(b, f"Producer {(ch.get('producer') or {}).get('from', '?')} → {b['producer']}")))
        elif act == "booking.assign" and "assignedEmails" in ch:
            frm = (ch["assignedEmails"] or {}).get("from") or []
            if a.get("fromStatus") == "REQUESTED" or not frm:
                continue                       # จัดทีมครั้งแรกตอนอนุมัติ = ส่วนหนึ่งของการอนุมัติ ไม่ใช่การเปลี่ยนทีม
            c = crew.setdefault((b["bookingCode"], by_tuy), dict(it, frm=set(x.lower() for x in frm), to=None, actor=a.get("actorEmail")))
            c["to"] = set(x.lower() for x in (ch["assignedEmails"] or {}).get("to") or [])
        elif act == "booking.create":
            items.append(dict(it, kind="new", by_tuy=False,
                              text=f"{day(b['shootDate'])} {b['bookingCode']} {title(b)} {when(b)} · {b['producer']}".replace("  ", " ")
                              + (" (ยกเลิกแล้ว)" if b["status"] == "CANCELLED" else "")))
    for (code, by_tuy), c in crew.items():
        b = c["b"]
        add, rem = sorted(c["to"] - c["frm"]), sorted(c["frm"] - c["to"])
        if (not add and not rem) or not within7(b) or finished(b):
            continue
        t = " ".join([f"+{first(x)}" + (" (ใส่ตัวเอง)" if x == (c["actor"] or "").lower() else "") for x in add] + [f"−{first(x)}" for x in rem])
        items.append(dict(code=code, by_tuy=by_tuy, shoot=b["shootDate"][:10], b=b, kind="crew", actor=c["actor"],
                          text=" ".join(x for x in (day(b["shootDate"]), code, title(b), b["callTime"]) if x) + f" · {t}"))
    if not items:
        return None, 0

    ICON = {"cancel": "❌ ยกเลิก/ลบใบ", "eps": "✂️ ถอด/เพิ่มตอน", "date": "📅 เลื่อนวัน", "time": "🕐 เปลี่ยนเวลา",
            "loc": "📍 เปลี่ยนสถานที่", "crew": "👥 เปลี่ยนทีม", "producer": "🎬 เปลี่ยน Producer", "new": "🆕 ใบจองใหม่"}
    ORDER = ["cancel", "eps", "date", "time", "loc", "crew", "producer", "new"]

    def block(rows):
        out = []
        for k in ORDER:
            rs = sorted([r for r in rows if r["kind"] == k], key=lambda r: (r["shoot"], r["code"]))
            if not rs:
                continue
            actors = {r.get("actor") for r in rs}
            by = f" (โดย {first(actors.pop())})" if k == "crew" and len(actors) == 1 and None not in actors and not rs[0]["by_tuy"] else ""
            out.append(ICON[k] + (f" {len(rs)} ใบ" if k == "new" else "") + by)
            out += ["• " + r["text"] + (f"\n  {APP}/admin/{r['b']['id']}" if r["b"].get("id") else "") for r in rs]
        return out

    hdr = f"{since.day} {TH_MON[since.month]} {since:%H:%M} – " + ("" if since.date() == now.date() else f"{now.day} {TH_MON[now.month]} ") + f"{now:%H:%M}"
    lines = [f"สรุปใบจองที่เปลี่ยน ({hdr}) · ไม่นับการอนุมัติ", ""]
    others = [r for r in items if not r["by_tuy"]]
    urg = [r for r in others if r["kind"] != "new" and urgent(r["b"])]
    rest = [r for r in others if r not in urg]
    if urg:
        lines += ["🔴 ด่วน · ถ่ายวันนี้–พรุ่งนี้"] + block(urg) + [""]
    if rest:
        lines += block(rest) + [""]
    mine = [r for r in items if r["by_tuy"]]
    if mine:
        lines += ["✍️ ที่ตุ้ยแก้เอง (ไว้เช็กว่าจับได้ครบ)"] + block(mine) + [""]
    return "\n".join(lines).rstrip() + "\n", len(items)


# ── ส่ง ────────────────────────────────────────────────────────────────────
def send(text):
    """คืน ('ok', resp) | ('rejected', detail) | ('unknown', detail) — 'unknown' = ห้ามยิงซ้ำ"""
    secret, host = pig_creds()
    body = json.dumps({"to": f"person:{PIG_TO}", "text": text}, ensure_ascii=False).encode()
    req = urllib.request.Request(host + "/relay", data=body, method="POST",
                                 headers={"X-Relay-Secret": secret, "Content-Type": "application/json",
                                          "User-Agent": "hermes-probook-tuy-digest"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return "rejected", f"HTTP {e.code} {e.read()[:200]!r}"
    except Exception as e:                 # timeout / เน็ตขาดกลางทาง — อาจส่งไปแล้ว
        return "unknown", f"{type(e).__name__}: {str(e)[:150]}"
    try:
        resp = json.loads(raw)
    except Exception:
        return "unknown", f"ตอบอ่านไม่ออก: {raw[:150]!r}"
    if resp.get("ok") is True:
        return "ok", resp
    return "rejected", raw[:200]


def log_sent(entry):
    """เก็บทุกฉบับที่ยิง Pig (นัทสั่ง "อยากเก็บที่ส่งให้ตุ้ยด้วย") — log.jsonl 1 บรรทัด + ไฟล์ .md ฉบับเต็ม
    เขียนไม่ได้ = exception ดังขึ้นไปถึง epilogue (ไม่ใช่เงียบ)"""
    os.makedirs(SENT_DIR, exist_ok=True)
    with open(SENT_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    at = datetime.fromisoformat(entry["sentAt"]).astimezone(BKK)
    name = f"{at:%Y-%m-%d_%H%M}_{entry.get('qid') or entry['result']}.md"
    with open(os.path.join(SENT_DIR, name), "w", encoding="utf-8") as f:
        f.write(f"<!-- ถึง: {entry['to']} · ผล: {entry['result']} · qid: {entry.get('qid')} · {entry.get('reportUrl') or ''}\n"
                f"     ช่วง: {entry['window'][0]} → {entry['window'][1]} (UTC) · {entry['items']} รายการ -->\n\n{entry['text']}")


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_state(st):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


# ── OUTBOX: ส่งซ้ำรายงานที่ Hermes ส่งไม่ออก ────────────────────────────────
# บล็อกนี้ถูกคัดลอกไว้เหมือนกันทุกสคริปต์ใน scripts/hermes/ *โดยเจตนา* — deploy คือการก๊อปไฟล์
# ด้วยมือไป ~/.hermes/scripts/ ดังนั้น module ร่วมที่ลืมก๊อป = ImportError = job
# ตายทั้งตัว ซึ่งแย่กว่าโค้ดซ้ำ 40 บรรทัด. แก้ที่ไหนให้แก้ให้ครบทุกที่.
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
# ปลอดภัยกับรายงาน: scheduler.py:3660 เมื่อ returncode != 0 ยัง append
# "stdout:\n<payload>" ไปกับข้อความ ดังนั้นคนอ่านยังได้เนื้อรายงานครบเหมือนเดิม
_SELF_FAIL = []


def self_fail(reason=""):
    """ทำเครื่องหมายว่ารอบนี้ 'เราทำงานไม่สำเร็จ' — epilogue จะ exit 1"""
    _SELF_FAIL.append(reason or "self-failure")

OUTBOX = os.path.expanduser("~/.hermes/state/probook/outbox-tuy-digest.json")
JOB_NAME = "probook-tuy-digest"


def main(dry_run=False):
    st = load_state()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    if not st.get("lastEnd"):
        # ไม่มี state = ไม่รู้ว่าส่งถึงไหนแล้ว · เดาย้อนหลัง = เสี่ยงส่งซ้ำ → หยุดให้คนตั้งค่า
        self_fail("no state")
        print(f"⚠️ {JOB_NAME}: ไม่มี state ({STATE}) — ตั้ง lastEnd ก่อน (ISO UTC) ไม่งั้นไม่รู้ว่าส่งถึงไหนแล้ว")
        return
    since = datetime.fromisoformat(st["lastEnd"].replace("Z", "+00:00"))
    s_utc, n_utc = since.strftime("%Y-%m-%dT%H:%M:%SZ"), now.strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        d = fetch(s_utc, n_utc)
    except Exception as e:
        self_fail("fetch")
        print(f"⚠️ สรุปใบจองถึงตุ้ย: อ่าน prod ไม่ได้ — รอบนี้ไม่ส่ง (รอบหน้าครอบช่วงนี้ให้) · {type(e).__name__}: {str(e)[:160]}")
        return
    text, n = build(d, since, now)
    if dry_run:
        print(text or f"(ไม่มีอะไรเปลี่ยนตั้งแต่ {since.astimezone(BKK):%d/%m %H:%M} — รอบจริงจะเงียบ)")
        return
    if not text:
        st.update(lastEnd=n_utc, lastRun=now.isoformat(), lastResult="nothing")
        save_state(st)
        return
    result, detail = send(text)
    st["lastRun"] = now.isoformat()
    entry = dict(sentAt=now.isoformat(), to=f"person:{PIG_TO}", window=[s_utc, n_utc], items=n, result=result,
                 qid=detail.get("qid") if result == "ok" else None,
                 reportUrl=detail.get("report_url") if result == "ok" else None,
                 detail=None if result == "ok" else str(detail)[:300], text=text)
    if result == "ok":
        # state ก่อน log: log เขียนไม่ได้ต้องไม่ทำให้รอบหน้าส่งซ้ำ
        st.update(lastEnd=n_utc, lastResult="sent", lastQid=entry["qid"])
        save_state(st)
        log_sent(entry)
        print(f"📨 ส่งสรุปใบจองถึงตุ้ยแล้ว {n} รายการ ({since.astimezone(BKK):%d/%m %H:%M}–{now.astimezone(BKK):%H:%M}) · #{entry['qid']} {entry['reportUrl'] or ''}")
    elif result == "unknown":
        st.update(lastEnd=n_utc, lastResult="unknown")   # เลื่อน = ไม่ยิงซ้ำ
        save_state(st)
        log_sent(entry)
        self_fail("pig unknown")
        print(f"⚠️ สรุปใบจองถึงตุ้ย ({n} รายการ): ไม่แน่ใจว่าถึงไหม — Pig ไม่ตอบ/ตอบอ่านไม่ออก · ไม่ยิงซ้ำ (อาจถึงแล้ว) · เช็กกับตุ้ย · {detail}")
    else:
        st["lastResult"] = "rejected"
        save_state(st)
        log_sent(entry)
        self_fail("pig rejected")
        print(f"⚠️ สรุปใบจองถึงตุ้ย ({n} รายการ): Pig ปฏิเสธ — ยังไม่ถึง รอบหน้าส่งรวมให้ · {detail}")


def self_test():
    """ข้อมูลปลอม 1 ชุด ล็อกกฎที่รีเช็ก 10 พ.ย. จับได้ — ไม่แตะ prod"""
    now = datetime(2026, 11, 10, 11, 23, tzinfo=BKK)
    since = now - timedelta(hours=24)

    def bk(code, **o):
        return dict(dict(id=f"id-{code}", bookingCode=code, status="CONFIRMED", deletedAt=None, shootDate="2026-11-13T00:00:00.000Z", shootEndDate=None,
                         callTime="09:00", estimatedWrap="12:00", locationName="Studio 1", producer="แอ๊นท์",
                         program={"name": "Long-form"}, episodes=[{"episodeId": code, "title": "ตอนหนึ่ง"}]), **o)

    def A(act, code, actor="krittapon.j@thestandard.co", **o):
        return dict(dict(at="2026-11-09T12:00:00.000Z", actorEmail=actor, action=act, bookingCode=code,
                         fromStatus=None, toStatus=None, changes=None), **o)

    crew = lambda f, t: {"assignedEmails": {"from": f, "to": t}}
    d = {"users": [{"email": "krittapon.j@thestandard.co", "thaiName": "กฤตพล จียะเกียรติ"},
                   {"email": "phuridej.p@thestandard.co", "thaiName": "ภูริเดช พ"}, {"email": "thanakorn.s@thestandard.co", "thaiName": "ธนกร ศ"}],
         "bookings": [bk("NEW-1"), bk("APPR-1"), bk("SWAP-1"), bk("TODAY-1", shootDate="2026-11-10T00:00:00.000Z", estimatedWrap="18:00"),
                      bk("DONE-1", shootDate="2026-11-10T00:00:00.000Z", estimatedWrap="11:00", status="COMPLETED"),
                      bk("CXL-1", status="CANCELLED"), bk("EPS-1", episodes=[{"episodeId": "EPS-1B", "title": "สัมภาษณ์แขก"}])],
         "reqs": [{"bookingCode": "CXL-1", "changes": {"reason": "แขกขอเลื่อน"}}],
         "audits": [A("booking.create", "NEW-1", "p@thestandard.co"),
                    A("booking.assign", "APPR-1", TUY, fromStatus="REQUESTED", toStatus="ASSIGNED", changes=crew([], ["video@thestandard.co"])),
                    A("booking.approve", "APPR-1", TUY),
                    A("booking.assign", "SWAP-1", TUY, fromStatus="CONFIRMED", changes=crew(["phuridej.p@thestandard.co"], ["thanakorn.s@thestandard.co"])),
                    A("booking.assign", "TODAY-1", fromStatus="CONFIRMED", changes=crew(["video@thestandard.co"], ["video@thestandard.co", "krittapon.j@thestandard.co"])),
                    A("booking.assign", "DONE-1", fromStatus="CONFIRMED", changes=crew(["video@thestandard.co"], ["video@thestandard.co", "krittapon.j@thestandard.co"])),
                    A("booking.status_change", "CXL-1", TUY, fromStatus="CONFIRMED", toStatus="CANCELLED"),
                    A("booking.episodes_removed", "EPS-1", "narasit.k@thestandard.co", changes={"removed": ["EPS-1A"], "remaining": ["EPS-1B"]})]}
    text, n = build(d, since, now)
    assert "APPR-1" not in text, "การจัดทีมตอนอนุมัติต้องไม่นับเป็นเปลี่ยนทีม"
    assert "SWAP-1" in text and "+ธนกร −ภูริเดช" in text, text
    top = text.split("🔴")[1].split("\n\n")[0] if "🔴" in text else ""
    assert "TODAY-1" in top and "+กฤตพล (ใส่ตัวเอง)" in top, text
    assert "DONE-1" not in text, "เปลี่ยนทีมของงานที่ถ่ายเสร็จแล้วต้องไม่ส่ง"
    mine = text.split("✍️")[1]
    assert "CXL-1" in mine and "แขกขอเลื่อน" in mine and "SWAP-1" in mine, text
    assert "ถอด 1 ตอน (EPS-1A)" in text and "(โดย นัท)" in text, text
    assert "🆕 ใบจองใหม่ 1 ใบ" in text and "NEW-1" in text, text
    assert f"{APP}/admin/id-SWAP-1" in text and f"{APP}/admin/id-NEW-1" in text, "ทุกรายการต้องมีลิงก์หน้าใบจอง"
    assert not re.search(r"\d{3}-?\d{3}-?\d{4}|@thestandard", text), "ห้ามมีเบอร์/อีเมลในข้อความ"
    assert build(dict(d, audits=[A("booking.approve", "APPR-1", TUY)]), since, now) == (None, 0), "อนุมัติอย่างเดียว = ไม่มีอะไรส่ง"
    print("self-test ok\n" + text)


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
        _crash = f"⚠️ {JOB_NAME} พังกลางคัน: {type(_e).__name__}: {str(_e)[:160]}"

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
