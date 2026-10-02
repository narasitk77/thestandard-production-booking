#!/usr/bin/env python3
"""rollback.py [sha] [--check] [--allow-schema-drop] — ถอยพรอดกลับไปเวอร์ชันก่อนหน้า

ไม่ใส่ sha = อ่านจาก ~/.probook/deploy-state.json ที่ deploy.py จดไว้ตอน deploy รอบล่าสุด

⚠️ คอนเทนเนอร์ push schema ทุก boot · อิมเมจก่อน v1.252 push แบบ --accept-data-loss = ตาราง/คอลัมน์ที่
   DB มีแต่อิมเมจนั้นไม่รู้จัก ถูก DROP พร้อมข้อมูล (เคยเกิดจริง v1.231: ผู้กำกับคนที่ 2-3 ของทุกใบหาย)
   v1.252 — เทียบ schema ปลายทางกับ **DB จริงบนพรอด** ก่อนยิงทุกครั้ง (scripts/ops/schema_diff.py)
   เดิมดูแค่ธง schema_changed ของ deploy รอบล่าสุด ⇒ `rollback.py <sha เก่ากว่านั้น>` ไม่เตือนเลย
   - อิมเมจก่อน v1.252 ที่จะลบของที่มีข้อมูล / ชนิดคอลัมน์ต่าง → ปฏิเสธ (exit 5) · --allow-schema-drop
     + พิมพ์ยืนยันเองใน terminal เท่านั้น (AI pipe ข้อความเข้าไม่ได้)
   - อิมเมจ v1.252+ → ด่านตอนบูตข้าม push ที่จะลบ = DB เก็บของไว้ · ปฏิเสธถ้าต้องทั้งลบและเพิ่ม
     (ข้ามทั้งก้อน = โค้ดเก่าไม่ได้คอลัมน์ของมัน)
   --check = ตรวจอย่างเดียว บอกผลแล้วออก (ไม่ backup ไม่ยิง)
   backup ใหม่ก่อนยิงทุกครั้ง · ล้าง SCHEMA_ACCEPT_DATA_LOSS ทุกครั้ง (ค่ายอมลบห้ามตามไปอิมเมจอื่น)
exit: 0 สำเร็จ/ไม่มีอะไรให้ถอย · 1 ยกเลิก · 2 ใช้ผิด · 3 ไม่ครบใน 20 นาที · 4 ขึ้นแล้วแต่ schema ไม่ตามคาด · 5 ปฏิเสธ
"""
import json, os, re, sys, time, urllib.error, urllib.request

STACK, EP = 125, 2
# 2026-10-02 — แอปย้ายไป probook.thestandard.co (xtec9 ตอบ /api/version เป็น 404 แล้ว = เฝ้าผลไม่มีวันเห็น 200)
APP = os.environ.get('PROBOOK_URL', 'https://probook.thestandard.co').rstrip('/')
STATE = os.path.expanduser('~/.probook/deploy-state.json')
UA = {'User-Agent': 'curl/8.7.1', 'Accept': '*/*'}

ENV = {}
for line in open('/Users/narasit/.hermes/scripts/probook.env'):
    line = line.strip()
    if '=' in line and not line.startswith('#'):
        k, v = line.split('=', 1); ENV[k] = v
URL, KEY = ENV['PORTAINER_URL'].rstrip('/'), ENV['PORTAINER_API_KEY']

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

def db_container_backup():
    """backup ตอนแอปล่ม: pg_dump ใน production-booking-db ผ่าน Portainer exec (ทางเดียวกับที่ schema_diff อ่าน DB)
    เหตุผล: เหตุที่ต้องถอยบ่อยที่สุดคือแอปพัง — ถ้า backup ต้องยิงผ่านแอป rollback.py จะถอยไม่ได้ตอนที่จำเป็นที่สุด
    แล้วคนจะหันไปแก้ IMAGE_TAG เองใน Portainer ซึ่งไม่มีด่าน (ผู้ตรวจจับได้) · ไฟล์อยู่ใน /tmp ของคอนเทนเนอร์ db
    (คอนเทนเนอร์ db ไม่ถูกสร้างใหม่ตอนถอยอิมเมจแอป) · ไม่มี pipefail ใน sh → ตรวจขนาดแทน (dump จริง ~1 MB)"""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from offboard import env_file, _portainer
    env = env_file()
    path = f"/tmp/pre-rollback-{time.strftime('%Y%m%dT%H%M%S')}.sql.gz"
    cmd = f'pg_dump -U prod_booking -d production_booking --no-owner --no-privileges | gzip > {path} && wc -c < {path}'
    ex = _portainer(env, 'POST', f'/api/endpoints/{EP}/docker/containers/production-booking-db/exec',
                    {'AttachStdout': True, 'AttachStderr': True, 'Tty': True, 'Cmd': ['sh', '-c', cmd]})
    out = _portainer(env, 'POST', f"/api/endpoints/{EP}/docker/exec/{ex['Id']}/start", {'Detach': False, 'Tty': True}, timeout=900)
    info = _portainer(env, 'GET', f"/api/endpoints/{EP}/docker/exec/{ex['Id']}/json")
    nums = re.findall(r'\d+', out if isinstance(out, str) else json.dumps(out))
    size = int(nums[-1]) if nums else 0
    if info.get('Running') or info.get('ExitCode') not in (0,) or size < 100_000:
        raise RuntimeError(f"pg_dump ในคอนเทนเนอร์ db ไม่สำเร็จ (exit {info.get('ExitCode')}, {size} bytes)")
    return {'fileName': f'{path} (ในคอนเทนเนอร์ production-booking-db)', 'driveFileId': None, 'sizeBytes': size}

def main():
    state = {}
    if os.path.exists(STATE):
        state = json.load(open(STATE))
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    if flags - {'--check', '--allow-schema-drop'}:
        print(f'ไม่รู้จัก {sorted(flags - {"--check", "--allow-schema-drop"})}'); print(__doc__); sys.exit(2)
    pos = [a for a in sys.argv[1:] if not a.startswith('--')]
    target = pos[0].strip() if pos else state.get('rollback_to')
    if not target:
        print('ไม่รู้ว่าจะถอยไปเลขอะไร — ไม่มี state และไม่ได้ระบุ sha')
        print(f'  ดูได้ที่ {STATE} หรือส่ง sha มาเป็น argument'); sys.exit(2)
    tag = target if target.startswith('sha-') else f'sha-{target}'

    s = portainer('GET', f'/api/stacks/{STACK}')
    envs = s.get('Env') or []
    cur = next((e['value'] for e in envs if e['name'] == 'IMAGE_TAG'), None)
    print(f'ตอนนี้ = {cur}')
    print(f'จะถอยไป = {tag}')
    if cur == tag:
        print('ตั้งไว้ตรงแล้ว ไม่มีอะไรให้ถอย'); sys.exit(0)

    # v1.252 — เทียบกับ DB จริง ก่อน backup/ยิง · ตรวจไม่ได้ = ปฏิเสธ (ไม่ใช่ "ไม่มีอะไรหาย")
    import schema_diff
    try:
        a = schema_diff.assess(tag)
    except Exception as e:
        print(f'\n❌ ตรวจ schema กับ DB พรอดไม่ได้ ({type(e).__name__}: {e}) — ไม่ถอย'); sys.exit(5)
    ok, lines, needs_confirm, expect_skip = schema_diff.verdict(a, 'rollback')
    print(f"schema: อิมเมจ v{a['version']} · {'มีด่านตอนบูต' if a['guarded'] else 'ไม่มีด่าน (ก่อน v1.252)'}")
    for l in lines: print('  ' + l)
    if '--check' in flags:
        sys.exit(0 if ok else 5)
    if not ok:
        if not (needs_confirm and '--allow-schema-drop' in flags):
            sys.exit(5)
        if not schema_diff.confirm_drop(len(a['losses']), tag, a['losses']):
            print('ยกเลิก'); sys.exit(1)

    from deploy import backup_now, container_state
    # Id ของคอนเทนเนอร์เดิม — ต้องได้ก่อนยิง ไม่งั้นแยกตัวใหม่กับตัวเก่าไม่ออก
    old_id = None
    for _ in range(3):
        img0, old_id = container_state()
        if old_id:
            break
        time.sleep(5)
    if not old_id:
        print(f'\n❌ อ่านคอนเทนเนอร์ปัจจุบันไม่ได้ ({img0}) — ยืนยันผลหลังยิงไม่ได้ ไม่ถอย'); sys.exit(5)

    # backup ใหม่ทุกครั้ง — backup ของรอบ deploy อาจเก่าหลายวันและไม่มีข้อมูลที่เพิ่งเขียน
    try:
        b = backup_now()
    except Exception as e:
        print(f'  backup ผ่านแอปไม่ได้ ({type(e).__name__}: {str(e)[:120]}) — แอปอาจล่มอยู่ ใช้ pg_dump ในคอนเทนเนอร์ db แทน')
        try:
            b = db_container_backup()
        except Exception as e2:
            print(f'\n❌ backup ก่อนถอยไม่สำเร็จทั้งสองทาง ({e2}) — ไม่ถอย'); sys.exit(5)
    print(f"  ✓ backup {b['fileName']}  {round(b['sizeBytes']/1048576, 2)}MB  driveId={b['driveFileId']}")
    if not a['guarded'] and a['empty_drops']:
        # อิมเมจเก่าลบ "ของว่าง" ทิ้งตอนบูต — นับซ้ำหลัง backup เผื่อมีคนเขียนเข้ามาระหว่างนั้น
        try:
            filled = schema_diff.recount_empty(a)
        except Exception as e:
            print(f'\n❌ นับของว่างซ้ำไม่ได้ ({e}) — ไม่ถอย'); sys.exit(5)
        if filled:
            print(f'\n❌ ของที่เคยว่างมีข้อมูลเข้ามาแล้ว {filled} — อิมเมจนี้จะลบทิ้ง ไม่ถอย'); sys.exit(5)
    stale = next((e['value'] for e in envs if e['name'] == 'SCHEMA_ACCEPT_DATA_LOSS'), '')
    envs = [e for e in envs if e['name'] != 'SCHEMA_ACCEPT_DATA_LOSS']
    if stale:
        print(f'  ล้าง SCHEMA_ACCEPT_DATA_LOSS ({stale}) — ค่ายอมลบห้ามตามไปอิมเมจอื่น')

    for e in envs:
        if e['name'] == 'IMAGE_TAG': e['value'] = tag
    print('ยิง redeploy — client มักขาดก่อน Portainer ทำเสร็จ ห้ามยิงซ้ำ')
    try:
        portainer('PUT', f'/api/stacks/{STACK}/git/redeploy?endpointId={EP}',
                  {'env': envs, 'prune': False, 'pullImage': True,
                   'repositoryReferenceName': 'refs/heads/main', 'repositoryAuthentication': False},
                  timeout=150)
        print('  PUT ตอบกลับแล้ว')
    except Exception as e:
        print(f'  PUT ขาดตอนฝั่งเรา ({type(e).__name__}) — ไปเฝ้าผลแทน')

    deadline = time.time() + 20 * 60
    while time.time() < deadline:
        try:
            st = next((e['value'] for e in (portainer('GET', f'/api/stacks/{STACK}').get('Env') or [])
                       if e['name'] == 'IMAGE_TAG'), None)
        except Exception as e:
            st = f'ERR {type(e).__name__}'  # poll พลาดหนึ่งรอบ = "ยังไม่ครบ" ไม่ใช่แครช
        img, cid = container_state()
        code, body = app_get('/api/version')
        fresh = old_id is None or (cid is not None and cid != old_id)
        ok = st == tag and img.endswith(':' + tag) and code == 200 and fresh
        print(f"  [{time.strftime('%H:%M:%S')}] stack={st} cont={img.split(':')[-1]} http={code}"
              + ('' if fresh else ' (ยังเป็นคอนเทนเนอร์เดิม)') + ('  ← ครบทั้งสาม' if ok else ''), flush=True)
        if ok:
            try:
                sync = json.loads(body).get('schemaSync')
            except Exception:
                sync = 'unreadable'
            state['rolled_back_at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
            state['rollback_to'] = None
            state['rollback_backup'] = {k: b[k] for k in ('fileName', 'driveFileId', 'sizeBytes')}
            # DB มีของมากกว่า schema ของอิมเมจที่รันอยู่ (ด่านเก็บไว้) — จดให้คนอ่าน · deploy.py เทียบ DB จริงเองอยู่แล้ว
            state['db_kept'] = a['losses'] if expect_skip else []
            json.dump(state, open(STATE, 'w'), indent=2, ensure_ascii=False)
            want = 'skipped' if expect_skip else 'in-sync'
            if a['guarded'] and sync not in (want, 'accepted'):
                print(f'\n❌ ถอยแล้วแต่ schemaSync={sync} ไม่ตรงที่คาด ({want}) — ดู log คอนเทนเนอร์ `[schema-guard]`')
                sys.exit(4)
            print(f'\n✅ ROLLED BACK ไปที่ {tag} · {body.strip()}')
            if expect_skip:
                print(f"   DB ยังเก็บ {len(a['losses'])} รายการที่อิมเมจนี้ไม่รู้จัก — ถูกต้องแล้ว จะกลับมาใช้ตอน deploy ไปข้างหน้า")
            sys.exit(0)
        time.sleep(20)
    print('\n❌ ถอยไม่สำเร็จใน 20 นาที — อย่ายิงซ้ำ ให้เข้า Portainer ดูด้วยมือ')
    sys.exit(3)

if __name__ == '__main__':
    main()
