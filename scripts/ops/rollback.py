#!/usr/bin/env python3
"""rollback.py [sha] — ถอยพรอดกลับไปเวอร์ชันก่อนหน้า

ไม่ใส่ sha = อ่านจาก ~/.probook/deploy-state.json ที่ deploy.py จดไว้ตอน deploy รอบล่าสุด

⚠️ ถ้า release ที่จะถอยออกไป **แก้ prisma/schema.prisma** การถอยอิมเมจอย่างเดียว
   ไม่พอ และอันตราย: คอนเทนเนอร์รัน `prisma db push --accept-data-loss` ทุก boot
   อิมเมจเก่าจะ push schema เก่า = DROP คอลัมน์ใหม่ทิ้งพร้อมข้อมูลในนั้น
   สคริปต์จะเตือนและขอให้พิมพ์ยืนยันก่อน (ดู docs/runbook-deploy-rollback.md)
"""
import json, os, sys, time, urllib.error, urllib.request

STACK, EP = 125, 2
APP = 'https://probook.xtec9.xyz'
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

def main():
    state = {}
    if os.path.exists(STATE):
        state = json.load(open(STATE))
    target = sys.argv[1].strip() if len(sys.argv) > 1 else state.get('rollback_to')
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

    if state.get('schema_changed') and state.get('deploying') == cur:
        b = (state.get('backup') or {}).get('fileName', '(ไม่รู้)')
        print('\n⚠️  เวอร์ชันที่กำลังจะถอยออก แก้ schema ไว้')
        print('    อิมเมจเก่าจะ db push ด้วย schema เก่า = DROP คอลัมน์ใหม่ + ข้อมูลในนั้น')
        print(f'    backup ก่อน deploy รอบนั้นคือ: {b}')
        print('    ถ้าข้อมูลในคอลัมน์ใหม่สำคัญ ให้กู้ DB ก่อน แล้วค่อยถอยอิมเมจ')
        print('    วิธี: docs/runbook-deploy-rollback.md\n')
        if input('พิมพ์ ROLLBACK เพื่อยืนยันว่ารับความเสี่ยงนี้: ').strip() != 'ROLLBACK':
            print('ยกเลิก'); sys.exit(1)

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
        st = next((e['value'] for e in (portainer('GET', f'/api/stacks/{STACK}').get('Env') or [])
                   if e['name'] == 'IMAGE_TAG'), None)
        try:
            d = portainer('GET', f'/api/endpoints/{EP}/docker/containers/production-booking-app/json', timeout=60)
            img = d.get('Config', {}).get('Image', '?')
        except Exception:
            img = '?'
        code, body = app_get('/api/version')
        ok = st == tag and img.endswith(':' + tag) and code == 200
        print(f"  [{time.strftime('%H:%M:%S')}] stack={st} cont={img.split(':')[-1]} http={code}"
              + ('  ← ครบทั้งสาม' if ok else ''), flush=True)
        if ok:
            print(f'\n✅ ROLLED BACK ไปที่ {tag} · {body.strip()}')
            state['rolled_back_at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
            state['rollback_to'] = None
            json.dump(state, open(STATE, 'w'), indent=2, ensure_ascii=False)
            sys.exit(0)
        time.sleep(20)
    print('\n❌ ถอยไม่สำเร็จใน 20 นาที — อย่ายิงซ้ำ ให้เข้า Portainer ดูด้วยมือ')
    sys.exit(3)

if __name__ == '__main__':
    main()
