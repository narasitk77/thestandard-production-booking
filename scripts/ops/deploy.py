#!/usr/bin/env python3
"""deploy.py <short-sha> [--set KEY=VALUE ...] — deploy พรอด โดยจดทางถอยไว้ก่อนเสมอ

--set ตั้ง/แก้ env บน stack ในรอบ redeploy เดียวกัน (container ถูกสร้างใหม่ครั้งเดียว) ·
ค่าเดิมถูกจดลง deploy-state.json คู่ rollback_to เพื่อย้อนได้ · ห้ามใช้กับ secret (ค่าโผล่ใน shell history)

v1.252 — ก่อนแตะอะไร เทียบ schema ของอิมเมจปลายทางกับ **DB จริงบนพรอด** (scripts/ops/schema_diff.py):
  --check                 ตรวจอย่างเดียว บอกว่าอะไรจะหาย/เพิ่ม แล้วออก (ไม่ backup ไม่ยิง)
  --set SCHEMA_ACCEPT_DATA_LOSS='table:x column:t.c'   release ที่ตั้งใจลบ · ต้องพิมพ์ยืนยันเองใน terminal
                          ค่านี้ใช้ครั้งเดียว — รอบถัดไปสคริปต์ล้างทิ้งให้ (ค่าค้าง + ถอยกลับ = ลบของใหม่)
  --allow-schema-drop     ปลดล็อกอิมเมจก่อน v1.252 ที่จะลบข้อมูล (ต้องพิมพ์ยืนยันใน terminal · AI pipe ไม่ได้)
exit: 0 สำเร็จ · 1 ยกเลิก · 2 ใช้ผิด · 3 ไม่ครบสามชั้นใน 20 นาที · 4 ขึ้นแล้วแต่ schema ไม่ลง · 5 ปฏิเสธเพราะ schema
อ่านผลจาก exit code เสมอ: `python3 scripts/ops/deploy.py <sha> > /tmp/deploy.log 2>&1; rc=$?; tail -30 /tmp/deploy.log; echo exit=$rc`

ลำดับที่ยอมข้ามไม่ได้ (ทุกขั้นมีเหตุผลจากของที่เคยพังจริง):

  1. จด IMAGE_TAG ปัจจุบัน = จุดที่รู้ว่าดี  → ~/.probook/deploy-state.json
     ไม่จดไว้ก่อน = ตอนของใหม่พังจะไม่มีใครรู้ว่าต้องถอยไปเลขอะไร
  2. เตือนถ้า release นี้แก้ prisma/schema.prisma — ดู "กับดักใหญ่" ข้างล่าง
  3. สั่ง backup DB แล้ว **ยืนยันว่ามีไฟล์ใหม่โผล่ในไดรฟ์จริง** ไม่ใช่แค่ 200
  4. ค่อย deploy
  5. ยืนยันครบสาม: stack env == container image == tag ที่ต้องการ AND แอปตอบ 200
     (คอนเทนเนอร์เก่ายังตอบ HTTP อยู่ระหว่าง Portainer ดึงอิมเมจ — เคยเกือบ
      ประกาศว่า deploy แล้วทั้งที่ยังเป็นของเก่า 2026-08-24)

⚠️ กับดักใหญ่ — image rollback ไม่ย้อน schema
   คอนเทนเนอร์รัน `prisma db push --accept-data-loss` ทุก boot ดังนั้นการถอย
   อิมเมจกลับไปเวอร์ชันที่ schema.prisma ยังไม่มีคอลัมน์ใหม่ = **DROP คอลัมน์นั้น
   พร้อมข้อมูลในนั้น** ถ้า release นี้แตะ schema ให้ถือว่า rollback ต้องกู้ DB ด้วย
   ไม่ใช่แค่ถอยอิมเมจ (วิธีกู้อยู่ใน docs/runbook-deploy-rollback.md)
"""
import json, os, subprocess, sys, time, urllib.error, urllib.request

# ── กันตัวเองตายกลางการเฝ้าผล ────────────────────────────────────────────────
# `python3 deploy.py <sha> | head -12` ฆ่าสคริปต์นี้ด้วย SIGPIPE ตอนบรรทัดที่ 12
# แล้ว pipeline คืน **exit 0** (โค้ดของ head) ซึ่งอ่านแล้วเหมือน deploy สำเร็จ
# ทั้งที่การเฝ้าถูกตัดกลางคัน — PUT ยิงไปแล้วแต่ไม่มีใครรู้ผล (เกิดจริง 2026-09-24)
# หน้าที่ของสคริปต์นี้คือ *ยืนยันผล* ปลายทางของ stdout หายไปต้องไม่ทำให้มันเลิกยืนยัน
signal_mod = __import__('signal')
if hasattr(signal_mod, 'SIGPIPE'):
    signal_mod.signal(signal_mod.SIGPIPE, signal_mod.SIG_IGN)

class _KeepGoingStdout:
    """เขียนไม่ได้ก็ไม่เป็นไร — อย่าตาย"""
    def write(self, text):
        try:
            sys.__stdout__.write(text); sys.__stdout__.flush()
        except (BrokenPipeError, ValueError, OSError):
            pass
    def flush(self):
        try:
            sys.__stdout__.flush()
        except (BrokenPipeError, ValueError, OSError):
            pass

sys.stdout = _KeepGoingStdout()

STACK, EP = 125, 2
# 2026-10-02 — แอปย้ายไป probook.thestandard.co (xtec9 ตอบ /api/version เป็น 404 แล้ว = เฝ้าผลไม่มีวันเห็น 200)
APP = os.environ.get('PROBOOK_URL', 'https://probook.thestandard.co').rstrip('/')
STATE = os.path.expanduser('~/.probook/deploy-state.json')
UA = {'User-Agent': 'curl/8.7.1', 'Accept': '*/*'}   # แอปตอบ 403 ให้ UA เปล่า

def env_file(path='/Users/narasit/.hermes/scripts/probook.env'):
    out = {}
    for line in open(path):
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1); out[k] = v
    return out

ENV = env_file()
URL, KEY = ENV['PORTAINER_URL'].rstrip('/'), ENV['PORTAINER_API_KEY']
SECRET = ENV['PROBOOK_LANDING_SECRET']

def portainer(method, path, body=None, timeout=120):
    r = urllib.request.Request(URL + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'X-API-Key': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r, timeout=timeout))

def app_get(path, timeout=25):
    try:
        r = urllib.request.urlopen(urllib.request.Request(APP + path, headers=UA), timeout=timeout)
        return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, ''
    except Exception:
        return 0, ''

def stack_tag():
    s = portainer('GET', f'/api/stacks/{STACK}')
    return next((e['value'] for e in (s.get('Env') or []) if e['name'] == 'IMAGE_TAG'), None), s

def container_image():
    return container_state()[0]

def container_state():
    """(image, container Id) — Id ใช้แยกคอนเทนเนอร์ใหม่ออกจากตัวเก่า (redeploy tag เดิม = image ตรงตั้งแต่ก่อนยิง)"""
    try:
        d = portainer('GET', f'/api/endpoints/{EP}/docker/containers/production-booking-app/json', timeout=60)
        return d.get('Config', {}).get('Image', '?'), d.get('Id')
    except Exception as e:
        return f'ERR {type(e).__name__}', None

def backup_now():
    """สั่ง backup แล้วคืนชื่อไฟล์ — โยน exception ถ้าไม่ได้ไฟล์จริง"""
    req = urllib.request.Request(APP + '/api/internal/backup/run', method='POST',
        headers={**UA, 'x-backup-secret': SECRET, 'Content-Type': 'application/json'}, data=b'{}')
    d = json.load(urllib.request.urlopen(req, timeout=300))
    if not d.get('ok') or not d.get('fileName') or not d.get('driveFileId'):
        raise RuntimeError(f'backup ไม่สำเร็จ: {d}')
    if not d.get('sizeBytes'):
        raise RuntimeError('backup ได้ไฟล์ขนาด 0 — ถือว่าไม่มี backup')
    return d

def wait_until(tag, minutes=20, old_id=None):
    deadline = time.time() + minutes * 60
    while time.time() < deadline:
        try:
            st, _ = stack_tag()
        except Exception as e:
            st = f'ERR {type(e).__name__}'  # poll พลาดหนึ่งรอบ = "ยังไม่ครบ" ไม่ใช่แครช (แครช = exit 1 = อ่านว่ายกเลิก)
        img, cid = container_state()
        code, body = app_get('/api/version')
        # v1.252 — ต้องเป็นคอนเทนเนอร์ **ใหม่** ด้วย: redeploy tag เดิม (เช่นรอบ opt-in) ครบสามข้อตั้งแต่ตัวเก่า
        fresh = old_id is None or (cid is not None and cid != old_id)
        ok = st == tag and img.endswith(':' + tag) and code == 200 and fresh
        print(f"  [{time.strftime('%H:%M:%S')}] stack={st} cont={img.split(':')[-1]} http={code}"
              + ('' if fresh else ' (ยังเป็นคอนเทนเนอร์เดิม)') + ('  ← ครบทั้งสาม' if ok else ''), flush=True)
        if ok:
            return True, body
        time.sleep(20)
    return False, ''

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    target = sys.argv[1].strip()
    tag = target if target.startswith('sha-') else f'sha-{target}'
    sha = tag[4:]
    sets = {}
    rest = sys.argv[2:]
    check_only = allow_drop = False
    # v1.252 — ไม่รู้จัก = ใช้ผิด (exit 2) ก่อนแตะเน็ต · เดิมทิ้งเงียบ ๆ: `--chek`/`--dry-run` กลายเป็น deploy จริง
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == '--check':
            check_only = True
        elif a == '--allow-schema-drop':
            allow_drop = True
        elif a == '--set' and i + 1 < len(rest) and '=' in rest[i + 1]:
            k, v = rest[i + 1].split('=', 1)
            if k.strip() == 'IMAGE_TAG':
                print('ใช้ <sha> ตั้ง IMAGE_TAG ไม่ใช่ --set'); sys.exit(2)
            sets[k.strip()] = v.strip()
            i += 1
        else:
            print(f'ไม่รู้จัก argument: {a!r} (--set ต้องตามด้วย KEY=VALUE)'); print(__doc__); sys.exit(2)
        i += 1

    cur, stack = stack_tag()
    print(f'IMAGE_TAG ปัจจุบัน (จุดถอย) = {cur}')
    print(f'จะ deploy                     = {tag}')
    if cur == tag:
        print('⚠️  ตั้งไว้ตรงแล้ว — จะ redeploy เพื่อให้คอนเทนเนอร์สลับ')

    # 0) v1.252 — อิมเมจนี้จะทำอะไรกับ DB พรอด (เทียบ DB จริง ไม่ใช่ git) · ตรวจก่อน backup/จดทางถอย:
    #    ถูกปฏิเสธ = ไม่เหลือ backup/state ครึ่ง ๆ กลาง ๆ · ตรวจไม่ได้ = ปฏิเสธ (ไม่ใช่ "ไม่มีอะไรหาย")
    import schema_diff
    try:
        a = schema_diff.assess(tag)
    except Exception as e:
        print(f'\n❌ ตรวจ schema กับ DB พรอดไม่ได้ ({type(e).__name__}: {e}) — ไม่ deploy'); sys.exit(5)
    opt_in = sets.get('SCHEMA_ACCEPT_DATA_LOSS', '').replace(',', ' ').split()
    ok, lines, needs_confirm, _ = schema_diff.verdict(a, 'deploy', opt_in)
    print(f"schema: อิมเมจ v{a['version']} · {'มีด่านตอนบูต' if a['guarded'] else 'ไม่มีด่าน (ก่อน v1.252)'}")
    for l in lines: print('  ' + l)
    # ชื่อใน opt-in ที่ไม่ได้จะหายจริงรอบนี้ = พิมพ์ผิด/ก๊อปเกิน — ห้ามไปค้างบน stack เป็นใบอนุญาตลบของในอนาคต
    extra = [x for x in opt_in if x not in a['losses']]
    if extra and a['losses']:
        print(f'\n❌ SCHEMA_ACCEPT_DATA_LOSS มีชื่อที่ไม่ได้จะหายรอบนี้: {extra} — ใส่แค่ที่อยู่ในรายการ "ของที่มีข้อมูลและจะหาย"'); sys.exit(2)
    if check_only:
        sys.exit(0 if ok else 5)
    if not ok:
        if not (needs_confirm and allow_drop):
            sys.exit(5)
        print('\n⚠️  --allow-schema-drop: จะปล่อยให้อิมเมจนี้ลบข้อมูลข้างบน')
    if needs_confirm and not schema_diff.confirm_drop(len(a['losses']), tag, a['losses']):
        print('ยกเลิก'); sys.exit(1)
    # opt-in ใช้ครั้งเดียว: ใส่เฉพาะเมื่อรอบนี้มีของที่ต้องลบจริง · ไม่งั้นไม่ส่งไปค้างบน stack
    if 'SCHEMA_ACCEPT_DATA_LOSS' in sets and not a['losses']:
        print('  (ไม่มีอะไรต้องลบ — ไม่ตั้ง SCHEMA_ACCEPT_DATA_LOSS)'); sets.pop('SCHEMA_ACCEPT_DATA_LOSS')
    # Id ของคอนเทนเนอร์เดิม — ต้องได้ก่อนยิง ไม่งั้นแยกตัวใหม่กับตัวเก่าไม่ออก (redeploy tag เดิม = ครบสามชั้นตั้งแต่ตัวเก่า)
    old_id = None
    for _ in range(3):
        img0, old_id = container_state()
        if old_id:
            break
        time.sleep(5)
    if not old_id:
        print(f'\n❌ อ่านคอนเทนเนอร์ปัจจุบันไม่ได้ ({img0}) — ยืนยันผลหลังยิงไม่ได้ ไม่ deploy'); sys.exit(5)

    # 2) release นี้แตะ schema ไหม
    schema_changed = False
    if cur and cur.startswith('sha-'):
        try:
            d = subprocess.run(['git', 'diff', '--name-only', cur[4:], sha, '--', 'prisma/schema.prisma'],
                               capture_output=True, text=True, timeout=30)
            schema_changed = bool(d.stdout.strip())
        except Exception:
            pass
    if schema_changed:
        # v1.252 — ห้ามแนะนำ "กู้ DB จาก backup" อีก: ทิ้งทุกอย่างที่เขียนหลัง deploy ทั้งที่ rollback.py ถอยได้โดยไม่เสียอะไร
        print('\n⚠️  release นี้แก้ prisma/schema.prisma — ถ้าต้องถอย ใช้ rollback.py (มันเทียบกับ DB จริงแล้วปฏิเสธเองถ้าจะเสียข้อมูล)')
        print('    ห้ามเปลี่ยน IMAGE_TAG เองใน Portainer · docs/runbook-deploy-rollback.md\n')

    # 3) backup ก่อน แล้วยืนยันว่าได้ไฟล์จริง
    print('สั่ง backup DB ก่อน deploy…')
    b = backup_now()
    print(f"  ✓ {b['fileName']}  {round(b['sizeBytes']/1048576, 2)}MB  driveId={b['driveFileId']}")
    if not a['guarded'] and a['empty_drops']:
        # อิมเมจเก่าลบ "ของว่าง" ทิ้งตอนบูต — นับซ้ำหลัง backup เผื่อมีคนเขียนเข้ามาระหว่างนั้น
        try:
            filled = schema_diff.recount_empty(a)
        except Exception as e:
            print(f'\n❌ นับของว่างซ้ำไม่ได้ ({e}) — ไม่ deploy'); sys.exit(5)
        if filled:
            print(f'\n❌ ของที่เคยว่างมีข้อมูลเข้ามาแล้ว {filled} — อิมเมจนี้จะลบทิ้ง ไม่ deploy'); sys.exit(5)

    # 1) จดทางถอย — เขียน "ก่อน" ยิง deploy เสมอ
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    prev = {}
    if os.path.exists(STATE):
        try: prev = json.load(open(STATE))
        except Exception: prev = {}
    # redeploy tag เดิม (เช่นรอบ opt-in) ห้ามเขียนจุดถอยเป็นตัวเอง — rollback.py จะตอบ "ไม่มีอะไรให้ถอย" ทั้งที่พรอดพัง
    rollback_to = prev.get('rollback_to') if cur == tag and prev.get('rollback_to') else cur
    state = {
        'rollback_to': rollback_to,
        'deploying': tag,
        # env ที่ --set จะเปลี่ยน พร้อมค่าเดิม (None = ยังไม่มีบน stack) — ย้อนได้โดยไม่ต้องเดา
        'env_changes': {k: {'from': next((e['value'] for e in (stack.get('Env') or []) if e['name'] == k), None), 'to': v} for k, v in sets.items()},
        'schema_changed': schema_changed,
        'backup': {'fileName': b['fileName'], 'driveFileId': b['driveFileId'], 'sizeBytes': b['sizeBytes']},
        'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'history': ([prev] + (prev.get('history') or []))[:10] if prev else [],
    }
    state['history'] = [{k: v for k, v in h.items() if k != 'history'} for h in state['history']]
    json.dump(state, open(STATE, 'w'), indent=2, ensure_ascii=False)
    print(f'  ✓ จดทางถอยไว้ที่ {STATE} → rollback_to={rollback_to}')

    # 4) deploy
    envs = stack.get('Env') or []
    # v1.252 — ค่ายอมลบข้อมูลรอบก่อนห้ามค้างข้ามไปรอบนี้ (ผู้ตรวจ: ค่าค้างบน stack + ถอยกลับ = ยอมลบของใหม่)
    stale = next((e['value'] for e in envs if e['name'] == 'SCHEMA_ACCEPT_DATA_LOSS'), '')
    envs = [e for e in envs if e['name'] != 'SCHEMA_ACCEPT_DATA_LOSS']
    if stale and 'SCHEMA_ACCEPT_DATA_LOSS' not in sets:
        print(f'  ล้าง SCHEMA_ACCEPT_DATA_LOSS ที่ค้างจากรอบก่อน ({stale})')
    if not any(e['name'] == 'IMAGE_TAG' for e in envs):
        envs.append({'name': 'IMAGE_TAG', 'value': tag})
    for e in envs:
        if e['name'] == 'IMAGE_TAG': e['value'] = tag
    for k, v in sets.items():
        hit = next((e for e in envs if e['name'] == k), None)
        if hit: hit['value'] = v
        else: envs.append({'name': k, 'value': v})
        print(f'  --set {k} = {v}')
    print('ยิง redeploy (pullImage=true) — client มักขาดก่อน Portainer ทำเสร็จ ห้ามยิงซ้ำ')
    try:
        portainer('PUT', f'/api/stacks/{STACK}/git/redeploy?endpointId={EP}',
                  {'env': envs, 'prune': False, 'pullImage': True,
                   'repositoryReferenceName': 'refs/heads/main', 'repositoryAuthentication': False},
                  timeout=150)
        print('  PUT ตอบกลับแล้ว')
    except Exception as e:
        print(f'  PUT ขาดตอนฝั่งเรา ({type(e).__name__}) — ตามคาด ไปเฝ้าผลแทน')

    # 5) ยืนยันครบสาม (คอนเทนเนอร์ใหม่จริง)
    ok, body = wait_until(tag, old_id=old_id)
    if ok:
        # v1.252 — HTTP 200 ไม่ได้แปลว่า schema ลง: ด่านอาจข้าม push แล้วโค้ดใหม่วิ่งบน schema เก่า
        try:
            sync = json.loads(body).get('schemaSync')
        except Exception:
            sync = 'unreadable'
        if a['guarded'] and sync not in ('in-sync', 'accepted'):
            print(f'\n❌ DEPLOYED {tag} แต่ schema ไม่ลง (schemaSync={sync}) — โค้ดใหม่กำลังวิ่งบน schema เก่า')
            print('   ดู log คอนเทนเนอร์บรรทัด `[schema-guard] run failed:` ว่าข้ามเพราะอะไร')
            print(f'   ถอยกลับ: python3 scripts/ops/rollback.py   (จะกลับไป {rollback_to})')
            sys.exit(4)
        print(f'\n✅ DEPLOYED {tag} · {body.strip()}')
        print(f'   ถอยกลับ: python3 scripts/ops/rollback.py')
        sys.exit(0)
    print(f'\n❌ ไม่ครบสามเงื่อนไขใน 20 นาที — อย่ายิงซ้ำ')
    print(f'   ถอยกลับ: python3 scripts/ops/rollback.py   (จะกลับไป {rollback_to})')
    sys.exit(3)

if __name__ == '__main__':
    main()
