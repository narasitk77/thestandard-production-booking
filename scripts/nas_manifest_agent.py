#!/usr/bin/env python3
"""NAS manifest agent — runs on the admin's Mac via launchd every 10 min (v1.262, replaces nas-manifest-agent.sh).

Scans the SMB-mounted "production team" NAS share and POSTs a manifest (per-folder relative paths + sizes)
to /api/internal/nas-manifest, which diffs it against Drive and announces when a folder's NAS queue drains.

Why it was rewritten (2026-10-09): the bash agent sat silent for 87 days. The share was not mounted
(`not mounted — skip`, exit 0 = launchd saw success) and when it was, macOS blocked launchd's bash from
reading a network volume (`Operation not permitted`). Nobody heard, because a skip looked like a run.
  - not mounted  → mount it (`osascript mount volume`, credentials from the Keychain — nothing stored here)
  - macOS blocks → exit 3 with the exact binary to give Full Disk Access to
  - any failure  → non-zero exit + one `FAIL` line (the server also flags a manifest older than 60 min)

Install (once):
  cp scripts/nas_manifest_agent.py ~/.probook/nas_manifest_agent.py
  ~/.probook/nas-agent.env: NAS_SECRET=<matches NAS_MANIFEST_SECRET/NEXTAUTH_SECRET on the server>
  plist ProgramArguments = [<this python>, ~/.probook/nas_manifest_agent.py]
  System Settings › Privacy & Security › Full Disk Access › + <this python>  (macOS blocks network volumes otherwise)
Self-check without NAS/network: python3 nas_manifest_agent.py --selftest
"""
import datetime
import json
import os
import socket
import subprocess
import sys
import urllib.error
import urllib.request

ENV_FILE = os.path.expanduser('~/.probook/nas-agent.env')
SKIP_DIRS_PREFIX = '.'
MAX_FILES_PER_FOLDER = 6000


def load_env(path=ENV_FILE):
    env = {}
    try:
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return env


def log(msg):
    print(f"[nas-agent] {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def scan(mount, errors=None):
    """-> list of {name, files:[{p,size}]} — same shape the bash agent sent (server code unchanged).
    A top-level folder that cannot be read completely is LEFT OUT (the server only judges folders it is
    shown, so an omitted folder can never be announced as drained) and recorded in `errors`; the rest of
    the share still reports. Pass errors=None to raise instead (selftest)."""
    folders = []
    for entry in sorted(os.listdir(mount)):  # PermissionError here = macOS (TCC) block — caller reports it
        top = os.path.join(mount, entry)
        if entry.startswith(SKIP_DIRS_PREFIX) or not os.path.isdir(top):
            continue
        files = []
        try:
            folders.append({'name': entry, 'files': walk_folder(top)})
        except OSError as e:
            if errors is None:
                raise
            errors.append(f'{entry}: {e}')
    return folders


def walk_folder(top):
    files = []
    # os.walk swallows unreadable subfolders by default — a half-blocked scan would read as "queue
    # empty" and announce a drain that did not happen. Raise instead; main() turns it into a FAIL.
    def boom(err):
        raise err
    for root, dirs, names in os.walk(top, onerror=boom):
        dirs[:] = [d for d in dirs if not d.startswith(SKIP_DIRS_PREFIX)]
        for n in names:
            if n.startswith('.') or n.startswith('._') or n == 'Thumbs.db':
                continue
            fp = os.path.join(root, n)
            try:
                size = os.path.getsize(fp)
            except OSError:
                continue
            files.append({'p': os.path.relpath(fp, top).replace(os.sep, '/'), 'size': size})
            if len(files) >= MAX_FILES_PER_FOLDER:
                break
        if len(files) >= MAX_FILES_PER_FOLDER:
            break
    return files


def is_mounted(path):
    return os.path.ismount(path)


def ensure_mounted(mount, smb_url):
    """-> None when mounted, else a reason string. Mounting uses the Keychain item macOS already has."""
    # ismount, not isdir: a leftover empty /Volumes folder would scan as "NAS has nothing queued"
    if is_mounted(mount):
        return None
    try:
        r = subprocess.run(['osascript', '-e', f'mount volume "{smb_url}"'], capture_output=True, text=True, timeout=60)
        if is_mounted(mount):
            log(f'mounted {smb_url}')
            return None
        return f'mount failed ({(r.stderr or r.stdout).strip()[:160] or "no output"})'
    except Exception as e:  # timeout, no GUI session, …
        return f'mount failed ({type(e).__name__}: {e})'


def post(url, secret, manifest):
    data = json.dumps(manifest, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST', headers={
        'Content-Type': 'application/json', 'x-nas-secret': secret, 'User-Agent': 'probook-nas-agent/1.262'})
    try:
        with urllib.request.urlopen(req, timeout=110) as r:
            return r.status, r.read(300).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read(300).decode('utf-8', 'replace')


def main():
    env = {**load_env(), **{k: v for k, v in os.environ.items() if k.startswith(('NAS_', 'PROBOOK_'))}}
    mount = env.get('NAS_MOUNT') or '/Volumes/production team'
    smb_url = env.get('NAS_SMB_URL') or 'smb://192.168.21.220/production%20team'
    url = (env.get('PROBOOK_URL') or 'https://probook.thestandard.co').rstrip('/') + '/api/internal/nas-manifest'
    secret = env.get('NAS_SECRET', '')
    if not secret:
        log(f'FAIL NAS_SECRET missing in {ENV_FILE}')
        return 1
    why = ensure_mounted(mount, smb_url)
    if why:
        log(f'FAIL {mount} not mounted — {why}')
        return 2
    errors = []
    try:
        folders = scan(mount, errors)
    except PermissionError:
        log(f'FAIL macOS blocked reading {mount} — give Full Disk Access to {os.path.realpath(sys.executable)} '
            '(System Settings › Privacy & Security › Full Disk Access)')
        return 3
    manifest = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'host': socket.gethostname(), 'folders': folders}
    try:
        status, body = post(url, secret, manifest)
    except Exception as e:
        log(f'FAIL POST {url}: {type(e).__name__}: {e}')
        return 4
    files = sum(len(f['files']) for f in folders)
    if status != 200:
        log(f'FAIL POST → {status} {body[:160]}')
        return 4
    log(f'ok {len(folders)} folders · {files} files queued on NAS → {status}')
    for err in errors:
        log(f'FAIL left out (unreadable, never judged as drained): {err[:200]}')
    return 5 if errors else 0


def selftest():
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, 'Show (NWS-ABC-261009-01)', 'CAM-A', '.hidden'))
        os.makedirs(os.path.join(d, '.DS_Store_dir'))
        open(os.path.join(d, 'Show (NWS-ABC-261009-01)', 'CAM-A', 'A001.MXF'), 'wb').write(b'x' * 10)
        open(os.path.join(d, 'Show (NWS-ABC-261009-01)', 'CAM-A', '._A001.MXF'), 'wb').write(b'x')
        open(os.path.join(d, 'Show (NWS-ABC-261009-01)', 'CAM-A', '.hidden', 'skip.MXF'), 'wb').write(b'x')
        open(os.path.join(d, 'loose.txt'), 'w').write('not a folder')
        got = scan(d)
        assert got == [{'name': 'Show (NWS-ABC-261009-01)', 'files': [{'p': 'CAM-A/A001.MXF', 'size': 10}]}], got
        globals()['is_mounted'] = lambda p: True   # pretend the share is mounted
        assert ensure_mounted(d, 'smb://unused') is None
        globals()['is_mounted'] = lambda p: os.path.ismount(p)
        # an unreadable subfolder: that FOLDER is left out and reported, the others still report
        os.makedirs(os.path.join(d, 'Other (NWS-ABC-261009-02)'))
        locked = os.path.join(d, 'Show (NWS-ABC-261009-01)', 'CAM-B')
        os.makedirs(locked); os.chmod(locked, 0)
        try:
            errs = []
            got = scan(d, errs)
            assert [f['name'] for f in got] == ['Other (NWS-ABC-261009-02)'], got
            assert len(errs) == 1 and errs[0].startswith('Show (NWS-ABC-261009-01)'), errs
            try:
                scan(d)
                raise AssertionError('strict scan skipped an unreadable subfolder')
            except PermissionError:
                pass
        finally:
            os.chmod(locked, 0o755)
        assert not is_mounted(d), 'a plain folder is not a mount point'
        assert load_env('/nonexistent/env') == {}
    print('selftest ok')
    return 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
