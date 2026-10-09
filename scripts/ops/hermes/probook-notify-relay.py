#!/usr/bin/env python3
"""probook → operator's Discord room relay (Hermes `--no-agent` job, every 5 min) — v1.262

Posts what the operator wants to HEAR, from /api/internal/notify-feed:
  📣 ฟุตเทจพร้อม  — every footage-ready notice probook sent to a team (auto or 📣 by hand)
  ✅ NAS ส่งครบ    — a NAS queue drained (the Mac agent's manifest)
  ⚠️ NAS เงียบ     — the NAS picture is older than 2 h (once per 12 h while it stays silent)
Prints NOTHING when there is nothing new (Hermes then sends nothing).

Why (นัท 9 ต.ค. 2569 "ไม่มีแจ้งเตือนเมื่อฟุตเทจพร้อมมานานแล้ว"): the team got 31 notices in 14 days by
email + the "Ohm" Discord room, but the operator's own copy was a Gmail self-send (From = To) that never
landed — and the NAS "ส่งครบ" notice had been dead for 87 days. A record the server wrote is not a
message anyone read; this relay reads the records and delivers them where Nat actually looks.

At-least-once, never silent-skip: the cursor advances only past events this run printed. A failed fetch
prints one error line (at most every 6 h) and keeps the cursor, so the next run catches up.
Install:  cp scripts/ops/hermes/probook-notify-relay.py ~/.hermes/scripts/
Self-check without network: python3 probook-notify-relay.py --selftest
"""
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ENV_FILE = os.path.expanduser("~/.hermes/scripts/probook.env")
STATE = os.path.expanduser("~/.hermes/state/probook/notify-relay.json")
OUTBOX = os.path.expanduser("~/.hermes/state/probook/outbox-notify-relay.json")
HERMES_JOBS = os.path.expanduser("~/.hermes/cron/jobs.json")
JOB_NAME = "probook-notify-relay"
FIRST_RUN_BACKFILL_H = 24
NAS_STALE_ALERT_MIN = 120
NAS_ALERT_EVERY_S = 12 * 3600
ERROR_ALERT_EVERY_S = 6 * 3600
MAX_CHARS = 1800          # one Discord message
MAX_PAGES = 5
OVERLAP_MIN = 15        # re-read this far behind the cursor (late-committing audit rows)


def env_val(key, path=ENV_FILE):
    try:
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return os.environ.get(key, "")


def read_state():
    try:
        return json.load(open(STATE, encoding="utf-8"))
    except Exception:
        return {}


def write_state(st):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, STATE)  # never a half-written cursor


def _delivery_error(job_name=JOB_NAME):
    """last_delivery_error of this Hermes job (None = the previous message arrived, or unreadable).
    Same OUTBOX pattern as probook-worker-check.py: Discord delivery happens in Hermes AFTER this script
    exits and Hermes does not retry, so the script itself re-sends what did not arrive."""
    try:
        raw = json.load(open(HERMES_JOBS, encoding="utf-8"))
    except Exception:
        return None
    jobs = raw if isinstance(raw, list) else raw.get("jobs", raw)
    jobs = list(jobs.values()) if isinstance(jobs, dict) else jobs
    for j in jobs if isinstance(jobs, list) else []:
        if isinstance(j, dict) and j.get("name") == job_name:
            return j.get("last_delivery_error")
    return None


def undelivered():
    """text of the previous run that Hermes failed to post ("" = nothing pending)"""
    if not _delivery_error():
        try:
            os.remove(OUTBOX)
        except FileNotFoundError:
            pass
        return ""
    try:
        saved = json.load(open(OUTBOX, encoding="utf-8"))
    except Exception:
        return ""
    return f"📮 ส่งซ้ำ — ข้อความรอบ {saved.get('runAt', 'ก่อนหน้า')} ส่งไม่ออก\n{saved.get('text', '')}" if saved.get("text") else ""


def remember(text):
    if not text:
        return
    os.makedirs(os.path.dirname(OUTBOX), exist_ok=True)
    with open(OUTBOX + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"runAt": time.strftime("%Y-%m-%d %H:%M"), "text": text}, f, ensure_ascii=False)
    os.replace(OUTBOX + ".tmp", OUTBOX)


def net_down():
    for host in ("cloudflare.com", "google.com"):
        try:
            socket.getaddrinfo(host, 443)
            return False
        except Exception:
            continue
    return True


def fetch(base, secret, since):
    url = f"{base}/api/internal/notify-feed?" + urllib.parse.urlencode({"since": since, "limit": 50})
    req = urllib.request.Request(url, headers={"x-footage-ready-secret": secret, "User-Agent": "hermes-probook-relay"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def gb(b):
    return f"{b / 1024 ** 3:.1f} GB" if b else ""


def line_for(e):
    code, title = e.get("code") or "?", e.get("title") or ""
    head = f"{code} — {title}" if title else code
    if e["kind"] == "nas-drained":
        size = f" ({gb(e['bytes'])})" if e.get("bytes") else ""
        files = f" · บน Drive {e['files']} ไฟล์{size}" if e.get("files") is not None else ""
        return f"✅ NAS ส่งขึ้น Drive ครบ · {head}{files}"
    files = f" · {e['files']} ไฟล์" if e.get("files") is not None else ""
    who = f" · แจ้งมือโดย {e['by'].split('@')[0]}" if e["kind"] == "footage-ready-manual" and e.get("by") else ""
    people = f" · แจ้งทีม {e['people']} คน" if e.get("people") else " · ⚠️ ไม่มีคนในทีมได้รับเมล"
    err = f" · ⚠️ เมล: {e['emailError']}" if e.get("emailError") else ""
    link = e.get("boxUrl") or e.get("url") or ""
    return f"📣 ฟุตเทจพร้อม · {head}{files}{people}{who}{err}" + (f"\n   {link}" if link else "")


def fit(events):
    """-> (events that fit in one message, how many wait for the next run). Never drops one: what does
    not fit stays after the cursor and goes out 5 minutes later."""
    used, n = 0, 0
    for e in events:
        l = len(line_for(e)) + 1
        if n and used + l > MAX_CHARS - 80:
            break
        used, n = used + l, n + 1
    return events[:n], len(events) - n


def run(now=None, fetcher=fetch):
    now = now or datetime.now(timezone.utc)
    base = (env_val("PROBOOK_BASE") or "https://probook.thestandard.co").rstrip("/")
    secret = env_val("PROBOOK_LANDING_SECRET") or env_val("FOOTAGE_READY_SECRET")
    st = read_state()
    out = []
    if not secret:
        if time.time() - st.get("lastErrorAt", 0) > ERROR_ALERT_EVERY_S:
            st["lastErrorAt"] = time.time()
            write_state(st)
            return f"⚠️ relay แจ้งฟุตเทจ: ไม่มี PROBOOK_LANDING_SECRET ใน {ENV_FILE} — ส่งต่อไม่ได้"
        return ""

    cursor = st.get("cursor") or (now - timedelta(hours=FIRST_RUN_BACKFILL_H)).isoformat()
    # An audit row is stamped at INSERT and a slow writer can commit a moment after a later one, so read
    # OVERLAP_MIN behind the cursor every time and drop what was already delivered (by id).
    delivered = dict(st.get("delivered", {}))          # id -> at, kept DELIVERED_KEEP_H
    since = (datetime.fromisoformat(cursor.replace("Z", "+00:00")) - timedelta(minutes=OVERLAP_MIN)).isoformat()
    events, nas = [], None
    try:
        for _ in range(MAX_PAGES):
            d = fetcher(base, secret, since)
            nas = d.get("nas")
            events += [e for e in d.get("events", []) if e["id"] not in delivered]
            if not d.get("more") or not d.get("events"):
                break
            since = d["events"][-1]["at"]                   # gte: the boundary rows come back, de-duped below
    except Exception as e:
        if net_down():
            return ""  # this Mac is offline — catch up next run, nobody to warn
        if time.time() - st.get("lastErrorAt", 0) > ERROR_ALERT_EVERY_S:
            st["lastErrorAt"] = time.time()
            write_state(st)
            code = getattr(e, "code", "")
            hint = " — secret ใน probook.env ไม่ตรงกับ prod" if code == 401 else ""
            return f"⚠️ relay แจ้งฟุตเทจ: ดึง notify-feed ไม่ได้ ({code or type(e).__name__}){hint} · จะลองใหม่ทุก 5 นาที"
        return ""

    st.pop("lastErrorAt", None)  # fetched fine — the next failure is news again
    events = sorted({e["id"]: e for e in events}.values(), key=lambda e: (e["at"], e["id"]))
    send, waiting = fit(events)
    if send:
        out.append("\n".join(line_for(e) for e in send) + (f"\n…มีอีก {waiting} รายการ จะตามมาในรอบถัดไป" if waiting else ""))
        for e in send:
            delivered[e["id"]] = e["at"]
        st["cursor"] = max(cursor, send[-1]["at"]) if "cursor" in st else send[-1]["at"]
    elif "cursor" not in st:
        st["cursor"] = cursor  # first run with nothing to say: start from the backfill point
    # keep every id the NEXT run can re-read (cursor − overlap, with a margin) — pruning by wall-clock age
    # re-posted the last notice every 5 min once a quiet spell outlasted the keep period
    keep_after = (datetime.fromisoformat(st["cursor"].replace("Z", "+00:00")) - timedelta(minutes=OVERLAP_MIN + 5)).isoformat()
    st["delivered"] = {k: v for k, v in delivered.items() if v >= keep_after}
    st.pop("seenAtCursor", None)

    if nas and nas.get("error"):
        pass  # the server could not read its NAS state this time — not evidence either way
    elif nas and nas.get("stale") and (nas.get("ageMinutes") is None or nas["ageMinutes"] >= NAS_STALE_ALERT_MIN):
        if time.time() - st.get("nasAlertAt", 0) > NAS_ALERT_EVERY_S:
            st["nasAlertAt"] = time.time()
            age = f"{nas['ageMinutes'] // 60} ชม." if nas.get("ageMinutes") is not None else "ไม่เคยมีข้อมูล"
            out.append(f"⚠️ ตัวสแกน NAS เงียบ {age} — แจ้ง 'NAS ส่งขึ้น Drive ครบ' จะไม่มาจนกว่าจะกลับมา\n"
                       "   เช็กบนเครื่องนัท: tail /tmp/probook-nas-agent.log")
    elif nas and not nas.get("stale"):
        st.pop("nasAlertAt", None)

    write_state(st)
    return "\n".join(out)


def selftest():
    global STATE
    import tempfile
    d = tempfile.mkdtemp()
    STATE = os.path.join(d, "s.json")
    os.environ["PROBOOK_LANDING_SECRET"] = "x"
    global ENV_FILE
    ENV_FILE = os.path.join(d, "none.env")
    now = datetime(2026, 10, 9, 8, 0, tzinfo=timezone.utc)
    ev = lambda i, at, kind="footage-ready", **k: {"id": f"e{i}", "at": at, "kind": kind, "code": f"NWS-KYM-26100{i}-01",
                                                   "title": "Key Message", "files": 12, "bytes": 3 * 1024 ** 3, "people": 4,
                                                   "boxUrl": f"https://drive/{i}", **k}
    calls = []

    def f1(base, secret, since):
        calls.append(since)
        return {"events": [ev(1, "2026-10-09T01:00:00Z"), ev(2, "2026-10-09T02:00:00Z", "nas-drained")], "more": False,
                "nas": {"stale": False, "ageMinutes": 5}}
    out = run(now, f1)
    assert "📣 ฟุตเทจพร้อม · NWS-KYM-261001-01 — Key Message · 12 ไฟล์ · แจ้งทีม 4 คน" in out, out
    assert "✅ NAS ส่งขึ้น Drive ครบ · NWS-KYM-261002-01 — Key Message · บน Drive 12 ไฟล์ (3.0 GB)" in out, out
    assert calls[0] == "2026-10-08T07:45:00+00:00", calls       # first run backfills 24 h (+15 min overlap)
    # second run: the feed returns the last event again (gte) → nothing new, nothing printed
    assert run(now, lambda b, s, since: {"events": [ev(2, "2026-10-09T02:00:00Z", "nas-drained")], "more": False,
                                         "nas": {"stale": False}}) == ""
    # fetch error → one line, cursor kept; second error inside 6 h → silent
    def boom(*a):
        raise urllib.error.HTTPError("u", 401, "no", {}, None)
    globals()["net_down"] = lambda: False
    first = run(now, boom)
    assert "401" in first and "secret" in first, first
    assert run(now, boom) == ""
    assert read_state()["cursor"] == "2026-10-09T02:00:00Z"
    # stale NAS → one alert, then quiet for 12 h
    stale = lambda *a: {"events": [], "more": False, "nas": {"stale": True, "ageMinutes": 87 * 24 * 60}}
    assert "ตัวสแกน NAS เงียบ 2088 ชม." in run(now, stale)
    assert run(now, stale) == ""
    # many events → as many as fit now, the rest NEXT run (never summarised away)
    def many(base, secret, since):  # honours `since` like the real feed (at >= since)
        cut = datetime.fromisoformat(since.replace("Z", "+00:00"))
        evs = [ev(i, f"2026-10-09T03:{i:02d}:00Z") for i in range(10, 60)]
        return {"events": [e for e in evs if datetime.fromisoformat(e["at"].replace("Z", "+00:00")) >= cut], "more": False, "nas": {"stale": False}}
    got, rounds = set(), 0
    while rounds < 20:
        rounds += 1
        msg = run(now, many)
        if not msg:
            break
        assert len(msg) <= MAX_CHARS, len(msg)
        got |= {l.split(" · ")[1].split(" — ")[0] for l in msg.splitlines() if l.startswith("📣")}
    assert got == {f"NWS-KYM-26100{i}-01" for i in range(10, 60)}, sorted(got)[:5]
    assert rounds > 2, "should have needed several messages"
    # a row that commits late with an EARLIER timestamp than the cursor is still delivered (overlap window)
    def late(base, secret, since):
        e = ev(99, "2026-10-09T03:50:00Z")
        return {"events": [e] if e["at"] >= since.replace("+00:00", "Z") else [], "more": False, "nas": {"stale": False}}
    assert "NWS-KYM-2610099-01" in run(now, late)
    assert run(now, late) == ""
    # a quiet week later the last notice is NOT posted again
    later = now + timedelta(days=7)
    assert run(later, late) == "", "re-sent an old notice after a quiet spell"
    assert run(later + timedelta(minutes=5), late) == ""
    # outbox: Hermes failed to deliver → next run re-sends; delivered → cleared
    global OUTBOX, HERMES_JOBS
    OUTBOX, HERMES_JOBS = os.path.join(d, "ob.json"), os.path.join(d, "jobs.json")
    remember("📣 ฟุตเทจพร้อม · X")
    json.dump({"jobs": [{"name": JOB_NAME, "last_delivery_error": "DNS"}]}, open(HERMES_JOBS, "w"))
    assert undelivered().endswith("📣 ฟุตเทจพร้อม · X")
    json.dump({"jobs": [{"name": JOB_NAME, "last_delivery_error": None}]}, open(HERMES_JOBS, "w"))
    assert undelivered() == "" and not os.path.exists(OUTBOX)
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        again = undelivered()
        msg = run()
        if msg:
            remember(msg)
        out = "\n\n".join(x for x in (again, msg) if x)
        if out:
            print(out)
