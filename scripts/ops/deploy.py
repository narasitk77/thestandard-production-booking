#!/usr/bin/env python3
"""deploy.py <short-sha> — deploy พรอด โดยจดทางถอยไว้ก่อนเสมอ

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

STACK, EP = 125, 2
APP = 'https://probook.xtec9.xyz'
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
    try:
        d = portainer('GET', f'/api/endpoints/{EP}/docker/containers/production-booking-app/json', timeout=60)
        return d.get('Config', {}).get('Image', '?')
    except Exception as e:
        return f'ERR {type(e).__name__}'

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

def wait_until(tag, minutes=20):
    deadline = time.time() + minutes * 60
    while time.time() < deadline:
        st, _ = stack_tag()
        img = container_image()
        code, body = app_get('/api/version')
        ok = st == tag and img.endswith(':' + tag) and code == 200
        print(f"  [{time.strftime('%H:%M:%S')}] stack={st} cont={img.split(':')[-1]} http={code}"
              + ('  ← ครบทั้งสาม' if ok else ''), flush=True)
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

    cur, stack = stack_tag()
    print(f'IMAGE_TAG ปัจจุบัน (จุดถอย) = {cur}')
    print(f'จะ deploy                     = {tag}')
    if cur == tag:
        print('⚠️  ตั้งไว้ตรงแล้ว — จะ redeploy เพื่อให้คอนเทนเนอร์สลับ')

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
        print('\n⚠️  release นี้แก้ prisma/schema.prisma')
        print('    ถอยอิมเมจกลับ = db push ด้วย schema เก่า = DROP คอลัมน์ใหม่ทิ้งพร้อมข้อมูล')
        print('    ถ้าต้อง rollback ให้กู้ DB จาก backup ด้วย ไม่ใช่ถอยอิมเมจอย่างเดียว')
        print('    (docs/runbook-deploy-rollback.md)\n')

    # 3) backup ก่อน แล้วยืนยันว่าได้ไฟล์จริง
    print('สั่ง backup DB ก่อน deploy…')
    b = backup_now()
    print(f"  ✓ {b['fileName']}  {round(b['sizeBytes']/1048576, 2)}MB  driveId={b['driveFileId']}")

    # 1) จดทางถอย — เขียน "ก่อน" ยิง deploy เสมอ
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    prev = {}
    if os.path.exists(STATE):
        try: prev = json.load(open(STATE))
        except Exception: prev = {}
    state = {
        'rollback_to': cur,
        'deploying': tag,
        'schema_changed': schema_changed,
        'backup': {'fileName': b['fileName'], 'driveFileId': b['driveFileId'], 'sizeBytes': b['sizeBytes']},
        'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'history': ([prev] + (prev.get('history') or []))[:10] if prev else [],
    }
    state['history'] = [{k: v for k, v in h.items() if k != 'history'} for h in state['history']]
    json.dump(state, open(STATE, 'w'), indent=2, ensure_ascii=False)
    print(f'  ✓ จดทางถอยไว้ที่ {STATE} → rollback_to={cur}')

    # 4) deploy
    envs = stack.get('Env') or []
    if not any(e['name'] == 'IMAGE_TAG' for e in envs):
        envs.append({'name': 'IMAGE_TAG', 'value': tag})
    for e in envs:
        if e['name'] == 'IMAGE_TAG': e['value'] = tag
    print('ยิง redeploy (pullImage=true) — client มักขาดก่อน Portainer ทำเสร็จ ห้ามยิงซ้ำ')
    try:
        portainer('PUT', f'/api/stacks/{STACK}/git/redeploy?endpointId={EP}',
                  {'env': envs, 'prune': False, 'pullImage': True,
                   'repositoryReferenceName': 'refs/heads/main', 'repositoryAuthentication': False},
                  timeout=150)
        print('  PUT ตอบกลับแล้ว')
    except Exception as e:
        print(f'  PUT ขาดตอนฝั่งเรา ({type(e).__name__}) — ตามคาด ไปเฝ้าผลแทน')

    # 5) ยืนยันครบสาม
    ok, body = wait_until(tag)
    if ok:
        print(f'\n✅ DEPLOYED {tag} · {body.strip()}')
        print(f'   ถอยกลับ: python3 scripts/ops/rollback.py')
        sys.exit(0)
    print(f'\n❌ ไม่ครบสามเงื่อนไขใน 20 นาที — อย่ายิงซ้ำ')
    print(f'   ถอยกลับ: python3 scripts/ops/rollback.py   (จะกลับไป {cur})')
    sys.exit(3)

if __name__ == '__main__':
    main()
