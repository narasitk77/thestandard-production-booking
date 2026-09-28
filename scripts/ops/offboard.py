#!/usr/bin/env python3
"""offboard.py — คนออกจากทีม: โอนใบอนาคต + ปิดบัญชี ใน transaction เดียว พร้อม audit

    python3 scripts/ops/offboard.py --leaver EMAIL [--to EMAIL --nick ชื่อเล่น]
                                    [--note "ข้อความ"] [--actor EMAIL] [--apply] [--selftest]

ค่าเริ่มต้นคือ dry-run: รัน SQL ชุดเดียวกับของจริงทุกบรรทัด แล้วจบด้วย ROLLBACK
(ไม่ใช่ "ข้าม" — บทเรียนซ้ำ 3 ครั้งของรีโปนี้: preview ที่เดินคนละทางกับของจริงคือ
preview ที่โกหก docs/bug-classes.md ข้อ 3) · `--apply` เปลี่ยนแค่ token สุดท้ายเป็น COMMIT

ทำอะไร (ขอบเขต: ใบที่ยังไม่ถ่าย = deletedAt IS NULL · status ไม่ใช่ CANCELLED/COMPLETED
· shootDate >= วันนี้ BKK):
  1. นับรอยเท้าของ leaver ทุกคอลัมน์อีเมลใน schema (อ่านอย่างเดียว)
  2. guard — ตกข้อเดียวหยุดทั้งหมด ไม่แตะอะไร (exit 2)
  3. transaction เดียว: Co-Producer → --to หรือ NULL · Producer → --to (ต้องมี --to)
     · adminNotes ต่อท้ายบรรทัดโอน · audit booking.update ต่อใบ (รูปเดียวกับ PATCH ของแอป)
     · users.active=false + audit user.deactivate · team_members.active=false + audit
  4. post-check (--apply): อ่านปลายทางซ้ำ ไม่เชื่อว่า "รันจบ = สำเร็จ"
  5. พิมพ์ checklist สิ่งที่เครื่องมือตั้งใจไม่ทำ (ปฏิทินให้ reconciler · ชีท · โค้ด · นอกแอป)
ไม่แตะ: createdByEmail (ประวัติ) · ใบอดีต · assignedEmails/director/videographer (แก้ผ่าน
/admin/<id> เพราะ route นั้น patch แขกปฏิทินในคำขอเดียวกัน) · Google API ใด ๆ
ดู docs/runbook-offboarding.md
"""
import argparse, json, os, re, shlex, sys, time, urllib.request, uuid

STACK_EP = 2
DB_CONTAINER = 'production-booking-db'
ENV_PATH = '/Users/narasit/.hermes/scripts/probook.env'
FUTURE = ('"deletedAt" IS NULL AND status::text NOT IN (\'CANCELLED\',\'COMPLETED\') '
          'AND "shootDate" >= (now() AT TIME ZONE \'Asia/Bangkok\')::date')
# Producer กว้างกว่า Co-Producer: footage-ready (ถ่ายไม่เกิน 3 วัน) และคำเชิญรีวิวหลังถ่าย
# (หน้าต่าง [วันนี้-8, วันนี้-1]) ยังอ่าน producerEmail ของใบ COMPLETED ที่เพิ่งถ่าย — ใบพวกนั้น
# ยังไม่ใช่ "ประวัติ" งานยังส่งไม่จบ · ใช้หน้าต่างกว้างสุด = 8 วัน
PRODUCER_SCOPE = (f'(({FUTURE}) OR ("deletedAt" IS NULL AND status::text = \'COMPLETED\' '
                  f'AND "shootDate" >= (now() AT TIME ZONE \'Asia/Bangkok\')::date - 8))')

# ── Portainer exec (ท่าเดียวกับ deploy.py — คัดลอกมา ไม่ import เพราะ deploy.py รัน side effect ตอน import) ──
def env_file(path=ENV_PATH):
    out = {}
    for line in open(path):
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1); out[k] = v
    return out

def _portainer(env, method, path, body=None, timeout=180):
    req = urllib.request.Request(env['PORTAINER_URL'].rstrip('/') + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'X-API-Key': env['PORTAINER_API_KEY'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return json.loads(raw) if raw.strip().startswith(b'{') else raw.decode('utf-8', 'replace')

def psql(env, sql, variables):
    """รัน SQL ใน container DB ผ่าน sh -c heredoc · ค่าทุกตัวเข้าเป็น -v (ไม่ต่อสตริง) · คืน (exit_code, output)"""
    vs = ' '.join(f'-v {k}={shlex.quote(v if v is not None else "")}' for k, v in variables.items())
    cmd = (f"psql -U prod_booking -d production_booking -A -F '|' -P pager=off -v ON_ERROR_STOP=1 {vs} -f - <<'SQL'\n"
           f"{sql}\nSQL")
    ex = _portainer(env, 'POST', f'/api/endpoints/{STACK_EP}/docker/containers/{DB_CONTAINER}/exec',
                    {'AttachStdout': True, 'AttachStderr': True, 'Tty': True, 'Cmd': ['sh', '-c', cmd]})
    out = _portainer(env, 'POST', f"/api/endpoints/{STACK_EP}/docker/exec/{ex['Id']}/start", {'Detach': False, 'Tty': True})
    info = _portainer(env, 'GET', f"/api/endpoints/{STACK_EP}/docker/exec/{ex['Id']}/json")
    return int(info.get('ExitCode') or 0), out if isinstance(out, str) else json.dumps(out)

# ── SQL (ฟังก์ชันบริสุทธิ์ — เทสได้โดยไม่แตะเน็ต) ────────────────────────────────
FOOTPRINT_SQL = f"""
WITH e AS (SELECT lower(:'leaver')::text AS v),
 fut AS (SELECT * FROM bookings WHERE {FUTURE})
SELECT 'users.active' k, count(*)::text n FROM users, e WHERE lower(email)=e.v AND active
UNION ALL SELECT 'team_members.active', count(*)::text FROM team_members, e WHERE lower(email)=e.v AND active
UNION ALL SELECT 'future.producerEmail', count(*)::text FROM bookings, e WHERE {PRODUCER_SCOPE} AND lower("producerEmail")=e.v
UNION ALL SELECT 'future.coProducerEmail', count(*)::text FROM fut, e WHERE lower("coProducerEmail")=e.v
UNION ALL SELECT 'future.coProducerEmail.withEvent', count(*)::text FROM fut, e WHERE lower("coProducerEmail")=e.v AND "calendarEventId" IS NOT NULL
UNION ALL SELECT 'future.crewOrDirector', count(*)::text FROM fut, e WHERE e.v = ANY("assignedEmails") OR e.v IN (lower("directorEmail"),lower("director2Email"),lower("director3Email"),lower("mainVideographerEmail"))
UNION ALL SELECT 'history.createdByEmail', count(*)::text FROM bookings, e WHERE lower("createdByEmail")=e.v
UNION ALL SELECT 'history.pastBookings', count(*)::text FROM bookings, e WHERE "deletedAt" IS NULL AND NOT ({FUTURE.replace('"deletedAt" IS NULL AND ', '')}) AND e.v IN (lower("producerEmail"),lower("coProducerEmail"))
UNION ALL SELECT 'ot.open', count(*)::text FROM ot_records, e WHERE lower("userEmail")=e.v AND "approvalStatus"::text IN ('DRAFT','SUBMITTED','REJECTED')
UNION ALL SELECT 'shoot_review_invites.open', count(*)::text FROM shoot_review_invites, e WHERE lower(email)=e.v AND "submittedAt" IS NULL
UNION ALL SELECT 'feedback_tickets.open', count(*)::text FROM feedback_tickets, e WHERE lower("reporterEmail")=e.v AND status::text<>'RESOLVED'
UNION ALL SELECT 'mix_jobs', count(*)::text FROM mix_jobs, e WHERE e.v IN (lower(coalesce("assigneeEmail",'')),lower(coalesce("requesterEmail",'')))
UNION ALL SELECT 'switcher_jobs', count(*)::text FROM switcher_jobs, e WHERE e.v IN (lower(coalesce("switcherEmail",'')),lower(coalesce("requestedBy",'')))
UNION ALL SELECT 'purchase.open', count(*)::text FROM purchase_batches, e WHERE lower(coalesce("ownerEmail",''))=e.v AND status::text IN ('DRAFT','SUBMITTED','REJECTED')
UNION ALL SELECT 'loans.open', count(*)::text FROM equipment_loans, e WHERE lower(coalesce(email,''))=e.v AND status::text <> 'RETURNED'
UNION ALL SELECT 'footageReady.willEmail', count(*)::text FROM bookings, e WHERE "deletedAt" IS NULL AND status::text IN ('CONFIRMED','COMPLETED') AND "readyNotifiedAt" IS NULL
        AND "shootDate" >= (now() AT TIME ZONE 'Asia/Bangkok')::date - 3 AND (lower("createdByEmail")=e.v OR lower("producerEmail")=e.v OR e.v = ANY("assignedEmails"));
"""

FUTURE_LIST_SQL = f"""
SELECT b."bookingCode", b.status::text, b."shootDate"::text, 'coProducer' AS role,
       coalesce(b.producer,''), coalesce(b."coProducer",''), (b."calendarEventId" IS NOT NULL)::text
FROM bookings b WHERE {FUTURE} AND lower(b."coProducerEmail")=lower(:'leaver')
UNION ALL
SELECT b."bookingCode", b.status::text, b."shootDate"::text, 'producer',
       coalesce(b.producer,''), coalesce(b."coProducer",''), (b."calendarEventId" IS NOT NULL)::text
FROM bookings b WHERE {PRODUCER_SCOPE} AND lower(b."producerEmail")=lower(:'leaver')
ORDER BY 3;
"""

FOOTAGE_LIST_SQL = f"""
SELECT "bookingCode" FROM bookings WHERE "deletedAt" IS NULL AND status::text IN ('CONFIRMED','COMPLETED') AND "readyNotifiedAt" IS NULL
  AND "shootDate" >= (now() AT TIME ZONE 'Asia/Bangkok')::date - 3
  AND (lower("createdByEmail")=lower(:'leaver') OR lower("producerEmail")=lower(:'leaver') OR lower(:'leaver') = ANY("assignedEmails"))
ORDER BY "shootDate";
"""

TO_INFO_SQL = """
SELECT 'user', coalesce(nickname,''), active::text, coalesce(array_to_string("producerOutlets", ','),'') FROM users WHERE lower(email)=lower(:'to')
UNION ALL SELECT 'nick.producer', d1.p, '', '' FROM (SELECT DISTINCT producer p FROM bookings WHERE lower("producerEmail")=lower(:'to') AND producer IS NOT NULL) d1
UNION ALL SELECT 'nick.coProducer', d.c, '', '' FROM (SELECT DISTINCT "coProducer" c FROM bookings WHERE lower("coProducerEmail")=lower(:'to') AND "coProducer" IS NOT NULL) d;
"""

OUTLETS_OF_FUTURE_SQL = f"""
SELECT DISTINCT o.code FROM bookings b JOIN outlets o ON o.id=b."outletId"
WHERE (({FUTURE}) AND lower(b."coProducerEmail")=lower(:'leaver')) OR (({PRODUCER_SCOPE}) AND lower(b."producerEmail")=lower(:'leaver'));
"""

def build_transaction(mode: str, transfer_producer: bool) -> str:
    """SQL ทั้งชุด — dry-run กับ apply ต่างกันแค่บรรทัดสุดท้าย (ROLLBACK/COMMIT)"""
    assert mode in ('dry-run', 'apply')
    parts = ['BEGIN;']
    # (a) Co-Producer → :to / NULL  (nick/to เป็น '' = NULL)
    parts.append(f"""
WITH tgt AS (
  SELECT id, "bookingCode", "coProducer", "coProducerEmail", "adminNotes" FROM bookings
  WHERE {FUTURE} AND lower("coProducerEmail")=lower(:'leaver') FOR UPDATE),
upd AS (
  UPDATE bookings b SET "coProducer"=nullif(:'nick',''), "coProducerEmail"=nullif(:'to',''),
         "adminNotes"=concat_ws(E'\\n', b."adminNotes", :'note'), "updatedAt"=now()
  FROM tgt WHERE b.id=tgt.id RETURNING b.id)
INSERT INTO audit_logs (id, "actorEmail", action, "entityType", "entityId", "bookingCode", changes)
SELECT gen_random_uuid()::text, :'actor', 'booking.update', 'Booking', tgt.id, tgt."bookingCode",
       jsonb_build_object(
         'coProducer', jsonb_build_object('from', tgt."coProducer", 'to', nullif(:'nick','')),
         'coProducerEmail', jsonb_build_object('from', tgt."coProducerEmail", 'to', nullif(:'to','')),
         'adminNotes', jsonb_build_object('from', tgt."adminNotes", 'to', concat_ws(E'\\n', tgt."adminNotes", :'note')),
         'offboardRun', :'run_id', 'via', 'offboard.py')
FROM tgt RETURNING 'coProducer→' || coalesce(nullif(:'to',''),'NULL') AS what, "bookingCode";""")
    if transfer_producer:
        parts.append(f"""
WITH tgt AS (
  SELECT id, "bookingCode", producer, "producerEmail", "adminNotes" FROM bookings
  WHERE {PRODUCER_SCOPE} AND lower("producerEmail")=lower(:'leaver') FOR UPDATE),
upd AS (
  UPDATE bookings b SET producer=:'nick', "producerEmail"=:'to',
         "adminNotes"=concat_ws(E'\\n', b."adminNotes", :'note'), "updatedAt"=now()
  FROM tgt WHERE b.id=tgt.id RETURNING b.id)
INSERT INTO audit_logs (id, "actorEmail", action, "entityType", "entityId", "bookingCode", changes)
SELECT gen_random_uuid()::text, :'actor', 'booking.update', 'Booking', tgt.id, tgt."bookingCode",
       jsonb_build_object(
         'producer', jsonb_build_object('from', tgt.producer, 'to', :'nick'),
         'producerEmail', jsonb_build_object('from', tgt."producerEmail", 'to', :'to'),
         'adminNotes', jsonb_build_object('from', tgt."adminNotes", 'to', concat_ws(E'\\n', tgt."adminNotes", :'note')),
         'offboardRun', :'run_id', 'via', 'offboard.py')
FROM tgt RETURNING 'producer→' || :'to' AS what, "bookingCode";""")
    # (c)(d) ปิดบัญชี — ไม่ลบ (import-producers / seed สร้างคืนเป็น active:true ถ้าแถวหาย)
    for table, etype in (('users', 'User'), ('team_members', 'TeamMember')):
        parts.append(f"""
WITH upd AS (UPDATE {table} SET active=false WHERE lower(email)=lower(:'leaver') AND active RETURNING email)
INSERT INTO audit_logs (id, "actorEmail", action, "entityType", "entityId", changes)
SELECT gen_random_uuid()::text, :'actor', 'user.deactivate', '{etype}', upd.email,
       jsonb_build_object('active', jsonb_build_object('from', true, 'to', false), 'reason', 'offboard',
                          'offboardRun', :'run_id', 'via', 'offboard.py')
FROM upd RETURNING '{table}.active→false' AS what, "entityId";""")
    parts.append('COMMIT;' if mode == 'apply' else 'ROLLBACK;')
    return '\n'.join(parts)

POSTCHECK_SQL = f"""
SELECT 'future.leaver.coProducer', count(*)::text FROM bookings WHERE {FUTURE} AND lower("coProducerEmail")=lower(:'leaver')
UNION ALL SELECT 'future.leaver.producer', count(*)::text FROM bookings WHERE {PRODUCER_SCOPE} AND lower("producerEmail")=lower(:'leaver')
UNION ALL SELECT 'audit.run', count(*)::text FROM audit_logs WHERE changes->>'offboardRun' = :'run_id'
UNION ALL SELECT 'users.active', count(*)::text FROM users WHERE lower(email)=lower(:'leaver') AND active
UNION ALL SELECT 'team_members.active', count(*)::text FROM team_members WHERE lower(email)=lower(:'leaver') AND active;
"""

VERIFY_SQL = f"""
SELECT 'users.active' k, count(*)::text n FROM users WHERE lower(email)=lower(:'leaver') AND active
UNION ALL SELECT 'team_members.active', count(*)::text FROM team_members WHERE lower(email)=lower(:'leaver') AND active
UNION ALL SELECT 'future.coProducer', count(*)::text FROM bookings WHERE {FUTURE} AND lower("coProducerEmail")=lower(:'leaver')
UNION ALL SELECT 'recent.producer', count(*)::text FROM bookings WHERE {PRODUCER_SCOPE} AND lower("producerEmail")=lower(:'leaver')
UNION ALL SELECT 'future.crewOrDirector', count(*)::text FROM bookings WHERE {FUTURE} AND (lower(:'leaver') = ANY("assignedEmails") OR lower(:'leaver') IN (lower("directorEmail"),lower("director2Email"),lower("director3Email"),lower("mainVideographerEmail")))
UNION ALL SELECT 'ot.open', count(*)::text FROM ot_records WHERE lower("userEmail")=lower(:'leaver') AND "approvalStatus"::text IN ('DRAFT','SUBMITTED','REJECTED')
UNION ALL SELECT 'loans.open', count(*)::text FROM equipment_loans WHERE lower(coalesce(email,''))=lower(:'leaver') AND status::text <> 'RETURNED'
UNION ALL SELECT 'qu.pending.asProducer (ประวัติ — ต้องมีคนตามแทน)', count(*)::text FROM bookings WHERE "deletedAt" IS NULL AND status::text <> 'CANCELLED' AND category::text='ADVERTORIAL' AND lower("producerEmail")=lower(:'leaver') AND (coalesce("agencyRef",'') = '' OR "agencyRef" !~ '[0-9]' OR upper("agencyRef") ~ 'TBC' OR "agencyRef" IN ('1234','QU1234'));
"""
VERIFY_MUST_BE_ZERO = {'users.active', 'team_members.active', 'future.coProducer', 'recent.producer', 'future.crewOrDirector', 'ot.open', 'loans.open'}

# ── helpers ────────────────────────────────────────────────────────────────────
def rows(output: str):
    """psql -A -F '|' → list[list[str]] (ตัดบรรทัด header/footer ของ psql ออก)"""
    out = []
    for line in output.replace('\r', '').split('\n'):
        line = line.strip()
        if not line or re.match(r'^\(\d+ rows?\)$', line) or line in ('BEGIN', 'COMMIT', 'ROLLBACK', 'UPDATE 0', 'INSERT 0 0'):
            continue
        if re.match(r'^(INSERT|UPDATE|DELETE) \d+', line) or line.startswith('psql:'):
            continue
        out.append(line.split('|'))
    return out

def kv(output: str):
    return {r[0]: r[1] for r in rows(output) if len(r) >= 2 and r[0] not in ('k', 'what')}

def fail(msg, code=2):
    print(f'\n✗ หยุด — {msg}'); sys.exit(code)

# ── selftest (ไม่แตะเน็ต) ───────────────────────────────────────────────────────
def selftest():
    a, b = build_transaction('dry-run', False), build_transaction('apply', False)
    assert a.rsplit('\n', 1)[0] == b.rsplit('\n', 1)[0] and a.endswith('ROLLBACK;') and b.endswith('COMMIT;'), 'dry-run ต้องต่างจาก apply แค่ token สุดท้าย'
    for s in (a, b, build_transaction('apply', True)):
        assert '@' not in s and 'แก้ว' not in s, 'ค่าคนต้องเข้าทาง -v เท่านั้น ห้ามฝังใน SQL'
        assert s.count("gen_random_uuid()::text") >= 3 and "'booking.update'" in s and "'user.deactivate'" in s
    assert 'producerEmail"=:' in build_transaction('apply', True) and 'producerEmail"=:' not in build_transaction('apply', False)
    assert "::date - 8" in build_transaction('apply', True), 'Producer scope must cover the 8-day post-shoot window (review invites)'
    # guard logic
    assert guard_reason(to=None, nick=None, fp={'future.producerEmail': '1'}, to_info=None, future_outlets=[]) is not None, 'ไม่มี --to แต่มีใบที่เป็น Producer → ต้องปฏิเสธ'
    assert guard_reason(to=None, nick=None, fp={'future.producerEmail': '0'}, to_info=None, future_outlets=[]) is None
    assert guard_reason(to='x@y', nick='ซัม', fp={'future.producerEmail': '0'}, to_info={'user': ('แซม', 'true', 'TSS'), 'nicks': {'แซม'}}, future_outlets=['TSS']) is not None, 'ชื่อเล่นไม่ตรง → ปฏิเสธ'
    assert guard_reason(to='x@y', nick='แซม', fp={'future.producerEmail': '0'}, to_info={'user': ('แซม', 'true', 'TSS'), 'nicks': set()}, future_outlets=['TSS', 'NWS']) is not None, 'outlet ไม่ครบ → ปฏิเสธ'
    assert guard_reason(to='x@y', nick='แซม', fp={'future.producerEmail': '0'}, to_info={'user': ('แซม', 'true', 'TSS,NWS'), 'nicks': set()}, future_outlets=['TSS', 'NWS']) is None
    assert rows("k|n\nusers.active|1\n(1 row)\n") == [['k', 'n'], ['users.active', '1']]
    print('selftest ok'); sys.exit(0)

def guard_reason(to, nick, fp, to_info, future_outlets):
    if (to is None) != (nick is None): return '--to กับ --nick ต้องมาคู่กัน'
    if to is None:
        if int(fp.get('future.producerEmail', '0')) > 0:
            return f"มีใบอนาคตที่เขาเป็น Producer {fp['future.producerEmail']} ใบ — Producer ต้องมีคนรับเสมอ (ใบไม่มี Producer = ปฏิทินไม่มีแขก) ใส่ --to/--nick"
        return None
    if not to_info or not to_info.get('user'): return f'--to {to} ไม่มีใน users'
    unick, uactive, uoutlets = to_info['user']
    if uactive != 'true': return f'--to {to} เป็น active=false'
    if nick != unick and nick not in to_info['nicks']:
        return f'--nick "{nick}" ไม่ตรง users.nickname="{unick}" และไม่เคยอยู่ในใบของเขา ({", ".join(sorted(to_info["nicks"])) or "-"}) — ชื่อเล่นห้ามเดา'
    have = {o for o in uoutlets.split(',') if o}
    missing = [o for o in future_outlets if o not in have]
    if missing: return f'--to ยังไม่ถูกแท็ก outlet {", ".join(missing)} — ไปเพิ่มที่ /admin/permissions ก่อน (ไม่ต้อง deploy)'
    return None

# ── main ───────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--leaver'); ap.add_argument('--to'); ap.add_argument('--nick')
    ap.add_argument('--note'); ap.add_argument('--actor'); ap.add_argument('--apply', action='store_true')
    ap.add_argument('--selftest', action='store_true')
    ap.add_argument('--verify', action='store_true', help='ตรวจว่าครบสำหรับ --leaver (อ่านอย่างเดียว ไม่ต้องมี --actor)')
    a = ap.parse_args()
    if a.selftest: selftest()
    if not a.leaver: ap.error('--leaver จำเป็น')
    env = env_file()
    if a.verify:
        leaver = a.leaver.strip().lower()
        code, out = psql(env, VERIFY_SQL, {'leaver': leaver})
        if code != 0: fail(f'verify SQL ล้ม:\n{out}', 1)
        pc = kv(out); bad = [k for k, v in pc.items() if k in VERIFY_MUST_BE_ZERO and v != '0']
        print(f'verify {leaver}:'); [print(f'  {k:34s} {v}') for k, v in pc.items()]
        if bad: fail(f'ยังไม่ครบ: {", ".join(bad)} — ดู docs/runbook-offboarding.md', 1)
        print('\n✅ ไม่มีอะไรค้างในบทบาทที่โอน (ปฏิทิน/แชตอยู่นอก DB — ตรวจตามขั้น 3 ของ runbook)'); sys.exit(0)
    actor = a.actor or env.get('OPERATOR_EMAIL') or fail('ไม่รู้ว่าใครสั่ง — ใส่ --actor EMAIL (ลง audit ทุกแถว)')
    leaver = a.leaver.strip().lower()
    to = a.to.strip().lower() if a.to else None
    nick = a.nick.strip() if a.nick else None
    if to == leaver: fail('--to เป็นคนเดียวกับ --leaver')
    today = time.strftime('%Y-%m-%d')
    note = a.note or (f'โอนงานจาก {leaver} → {to} ({nick}) เมื่อ {today} · ดำเนินการโดย {actor}' if to
                      else f'ถอด {leaver} ออกจากช่อง Co-Producer เมื่อ {today} (ออกจากทีม ไม่มีคนแทน) · ดำเนินการโดย {actor}')
    run_id = f"offboard-{today}-{uuid.uuid4().hex[:8]}"
    mode = 'apply' if a.apply else 'dry-run'
    print(f'offboard {mode} · leaver={leaver} · to={to or "NULL (ถอดออก)"} · run={run_id}\n')

    # 1. footprint
    code, out = psql(env, FOOTPRINT_SQL, {'leaver': leaver})
    if code != 0: fail(f'footprint SQL ล้ม (exit {code}):\n{out}', 1)
    fp = kv(out)
    print('รอยเท้า:'); [print(f'  {k:38s} {v}') for k, v in fp.items()]
    code, out = psql(env, FUTURE_LIST_SQL, {'leaver': leaver})
    fut = [r for r in rows(out) if len(r) >= 7 and r[0] != 'bookingCode']
    print(f'\nใบอนาคตที่จะแตะ ({len(fut)}):')
    for r in fut: print(f'  {r[0]:20s} {r[1]:10s} {r[2]} {r[3]:11s} PD={r[4]} CoPD={r[5]} event={r[6]}')
    code, out = psql(env, OUTLETS_OF_FUTURE_SQL, {'leaver': leaver})
    future_outlets = [r[0] for r in rows(out) if r and r[0] != 'code']

    # 2. guards
    to_info = None
    if to:
        code, out = psql(env, TO_INFO_SQL, {'to': to})
        rs = rows(out); u = next((r for r in rs if r[0] == 'user'), None)
        to_info = {'user': (u[1], u[2], u[3]) if u else None, 'nicks': {r[1] for r in rs if r[0].startswith('nick.') and r[1]}}
    why = guard_reason(to, nick, fp, to_info, future_outlets)
    if why: fail(why)
    if not fut and fp.get('users.active') == '0' and fp.get('team_members.active') == '0':
        print('\nไม่มีอะไรให้ทำ — ไม่มีใบอนาคตและบัญชีปิดอยู่แล้ว'); sys.exit(0)

    # 3. transaction (ชุดเดียวกันทั้งสองโหมด)
    started_utc = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())
    sql = build_transaction(mode, transfer_producer=bool(to))
    variables = {'leaver': leaver, 'to': to or '', 'nick': nick or '', 'note': note, 'actor': actor, 'run_id': run_id}
    code, out = psql(env, sql, variables)
    print(f'\n{mode}: psql exit {code}')
    touched = [r for r in rows(out) if len(r) >= 2 and r[0] not in ('what',)]
    for r in touched: print(f'  {r[0]:28s} {r[1]}')
    if code != 0: fail(f'transaction ล้ม — ไม่มีอะไรถูกเขียน (ON_ERROR_STOP):\n{out[-1500:]}', 1)
    expected = len(fut) + (1 if fp.get('users.active') == '1' else 0) + (1 if fp.get('team_members.active') == '1' else 0)
    print(f'  แถวที่แตะ {len(touched)} (คาด {expected})')
    if len(touched) != expected: fail(f'จำนวนแถวไม่ตรงที่คาด ({len(touched)} ≠ {expected}) — {"ถูก ROLLBACK แล้ว ตรวจก่อนรัน --apply" if mode == "dry-run" else "COMMIT ไปแล้ว ตรวจ audit run_id นี้"}', 1)

    # 4. post-check — อ่านปลายทางจริง (เฉพาะ apply)
    if mode == 'apply':
        code, out = psql(env, POSTCHECK_SQL, {'leaver': leaver, 'run_id': run_id})
        pc = kv(out)
        ok = (pc.get('future.leaver.coProducer') == '0' and pc.get('users.active') == '0' and pc.get('team_members.active') == '0'
              and pc.get('audit.run') == str(expected) and (not to or pc.get('future.leaver.producer') == '0'))
        print('\npost-check:'); [print(f'  {k:28s} {v}') for k, v in pc.items()]
        if not ok: fail('post-check ไม่ผ่าน — ดูตัวเลขข้างบน แล้วตรวจ audit_logs ที่ changes->>\'offboardRun\' = run_id', 1)
        print('\n✅ เขียนครบและอ่านกลับตรง')
    else:
        print('\n(dry-run) ทุกอย่างถูก ROLLBACK · รันซ้ำด้วย --apply ถ้าตัวเลขข้างบนถูก')
        print('  หมายเหตุ: ใบที่ถ่ายวันนี้อาจพลิกเป็น COMPLETED ระหว่าง dry-run กับ apply (auto-complete) — จำนวนแถวต่างกันได้ 1–2 ใบ')

    # 5. checklist สิ่งที่คนต้องทำต่อ (ตัวเลขจากรอยเท้าจริง)
    print('\nต้องทำต่อเอง:')
    n_ev = int(fp.get('future.coProducerEmail.withEvent', '0'))
    if n_ev or to:
        print(f'  [ปฏิทิน] reconciler รอบถัดไป (<=10 นาที) จะถอด/เพิ่มแขกให้ {n_ev} event เอง · ห้ามแก้แขกมือ')
        print('           รอบที่กำลังวิ่งตอน apply จะประทับ calendarSyncStatus=OK ด้วยลิสต์แขกเก่า — อย่าใช้คอลัมน์นั้นตัดสิน ตรวจด้วย:')
        print(f"           SELECT count(*) FROM audit_logs WHERE action='calendar.reconcile_patched' AND at > '{started_utc}' AND changes::text LIKE '%{leaver}%';   -- ต้องได้ {n_ev}")
        print('           คำบรรยาย "Producer/Co-Producer:" ใน event ไม่ตาม (calendar-refresh เขียนใหม่เฉพาะ event ที่ชื่อเรื่องเปลี่ยน) — ค้างจนกว่ามีคน PATCH ใบ')
    n_fr = int(fp.get('footageReady.willEmail', '0'))
    if n_fr:
        _, out_fr = psql(env, FOOTAGE_LIST_SQL, {'leaver': leaver})
        codes = [r[0] for r in rows(out_fr) if r and r[0] != 'bookingCode']
        print(f'  [footage-ready] จะยิงเมล "ฟุตเทจพร้อม" หาเขา {n_fr} ใบ (createdBy/producer/ทีม ที่ถ่ายไม่เกิน 3 วันและยังไม่แจ้ง) แล้วตีกลับ — ยอมรับได้: {", ".join(codes)}')
    if int(fp.get('future.crewOrDirector', '0')): print(f'  [UI] ใบอนาคตที่เขาอยู่ในทีม/ผู้กำกับ {fp["future.crewOrDirector"]} ใบ → แก้ที่ /admin/<id> (route นั้น patch แขกปฏิทินให้ในคำขอเดียว)')
    if to: print(f'  [ชีท] Producer Dashboard › Bookings คอลัมน์ PD / PD Email ของใบที่โอน Producer — แอปไม่ซิงก์ช่องนี้ (updateBookingRow ไม่มีฟิลด์)')
    print('  [ชีท] Producer Dashboard › _Users — ถ้ามีแถวของเขา ให้ลบ (dropdown ฟอร์ม AGN อ่านแท็บนี้ ไม่มีช่อง active)')
    print(f'  [โค้ด] grep -rn "{leaver.split("@")[0]}" src scripts docs — ถ้าอยู่ใน BUILT_IN_DEFAULT_COPRODUCERS / vp-assign / shared-mailboxes ต้องถอด + deploy (users.active ไม่หยุดกฎเหล่านั้น)')
    print('  [นอกแอป] HR/IT ระงับบัญชี Workspace · ถ้าเขาคือ impersonate subject → docs/runbook-impersonate-swap.md ก่อน · บันทึก docs/ops-log.md')
    if int(fp.get('ot.open', '0')) or int(fp.get('purchase.open', '0')) or int(fp.get('loans.open', '0')):
        print(f'  [ค้าง] OT ยังไม่อนุมัติ {fp.get("ot.open")} · purchase ยังไม่ปิด {fp.get("purchase.open")} · ยืมของยังไม่คืน {fp.get("loans.open")} — หลังปิดบัญชี รายการพวกนี้หายจากมุมมองปกติ (/ot/admin ต้องติ๊กแสดง disabled) จัดการก่อนบัญชี Workspace ถูกลบ')

if __name__ == '__main__':
    main()
