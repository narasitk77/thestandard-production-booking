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
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

# env file: next to this script first (DSM mode — Task Scheduler runs it from its own folder), else ~/.probook
_ENV_CANDIDATES = [os.path.join(os.path.dirname(os.path.abspath(__file__)), 'nas-agent.env'), os.path.expanduser('~/.probook/nas-agent.env')]
ENV_FILE = next((p for p in _ENV_CANDIDATES if os.path.exists(p)), _ENV_CANDIDATES[-1])
# '.' = Finder/AppleDouble junk · '@' = Synology @eaDir thumbnails · '#' = #recycle / #snapshot (only visible when
# the scan runs ON the NAS — DSM mode, 2026-10-20; the SMB client never showed these)
SKIP_DIRS_PREFIX = ('.', '@', '#')
MAX_FILES_PER_FOLDER = 6000
# v1.288 — MEDIAPRO.XML read ON the NAS: the server learns what each Sony card should hold the minute the card lands,
# not hours later when the upload to Drive ends. Caps keep one odd card from bloating the manifest.
MAX_CARDS_PER_FOLDER = 50
MAX_LISTED_PER_CARD = 3000
# DSM mode scans every SCAN_EVERY seconds inside the 10-minute task (no DSM schedule change needed): POST when the
# picture changed, and at least every HEARTBEAT seconds so the server never sees a stale scanner.
SCAN_EVERY = 60
HEARTBEAT = 540
LOOP_SECONDS = 570


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


def scan(mount, errors=None, skipped=None):
    """-> list of {name, files:[{p,size}]} — same shape the bash agent sent (server code unchanged).
    A top-level folder that cannot be read completely is LEFT OUT (the server only judges folders it is
    shown, so an omitted folder can never be announced as drained) and recorded in `errors`; the rest of
    the share still reports. Pass errors=None to raise instead (selftest)."""
    folders = []
    for entry in sorted(os.listdir(mount)):  # PermissionError here = macOS (TCC) block — caller reports it
        top = os.path.join(mount, entry)
        if entry.startswith(SKIP_DIRS_PREFIX) or not os.path.isdir(top):
            continue
        try:
            files, last_write = walk_folder(top)
            # newest write of ANY file, hidden ones included (rsync & co. copy into a dot-named temp file the listing
            # skips): a long clip still being written must not read as "copy finished" (review v1.288)
            folder = {'name': entry, 'files': files, 'lastWrite': last_write}
            if len(files) >= MAX_FILES_PER_FOLDER:
                folder['truncated'] = True  # the listing stopped at the cap — the server must not judge cards from it
            cards = card_reports(top, files)
            if cards:
                folder['cards'] = cards
            folders.append(folder)
        except OSError as e:
            if errors is None:
                raise
            errors.append(f'{entry}: {e}')
            if skipped is not None:
                skipped.append(entry)
    return folders


def parse_mediapro(data):
    """MEDIAPRO.XML bytes -> (listed, origs): every file a Material names (its own uri + Proxy/RelevantInfo/Component),
    relative to the MEDIAPRO folder, and the originals alone. Same rule as src/lib/mediapro.ts parseMediapro.
    Not a MEDIAPRO / unreadable = raise (a card that "lists nothing" must never read as complete)."""
    root = ET.fromstring(data)
    local = lambda tag: tag.rsplit('}', 1)[-1]
    if local(root.tag) != 'MediaProfile':
        raise ValueError('not a MEDIAPRO.XML (no <MediaProfile>)')
    listed, origs = [], []
    rel = lambda uri: uri[2:] if uri.startswith('./') else None
    for m in root.iter():
        if local(m.tag) != 'Material':
            continue
        own = rel(m.get('uri') or '')
        if not own:
            continue
        origs.append(own)
        for f in [own] + [rel(c.get('uri') or '') for c in m.iter() if c is not m and local(c.tag) in ('Proxy', 'RelevantInfo', 'Component')]:
            if f and f not in listed:
                listed.append(f)
    return listed, origs


def card_reports(top, files):
    """Every MEDIAPRO.XML among `files` -> {dir, origs} (or {dir, error}). dir is relative to the folder. Only the
    originals travel: the server judges "copied short" on them (Sub/XML/thumbnails are the Drive gate's)."""
    cards = []
    for f in files:
        if os.path.basename(f['p']).upper() != 'MEDIAPRO.XML':
            continue
        d = os.path.dirname(f['p'])
        try:
            with open(os.path.join(top, f['p']), 'rb') as fh:
                _listed, origs = parse_mediapro(fh.read())
            cards.append({'dir': d, 'origs': origs[:MAX_LISTED_PER_CARD]})
        except FileNotFoundError:
            continue  # uploaded + removed by Cloud Sync between the walk and the read — the next scan has the rest
        except Exception as e:  # a copy still being written, or a broken file: say so, never "no card"
            cards.append({'dir': d, 'error': f'{type(e).__name__}: {e}'[:200]})
        if len(cards) >= MAX_CARDS_PER_FOLDER:
            break
    return cards


def walk_folder(top):
    """-> (files, last_write): the listing (hidden/system files left out) and the newest mtime/ctime of ANY file."""
    files, newest = [], 0.0
    # os.walk swallows unreadable subfolders by default — a half-blocked scan would read as "queue
    # empty" and announce a drain that did not happen. Raise instead; main() turns it into a FAIL.
    def boom(err):
        raise err
    for root, dirs, names in os.walk(top, onerror=boom):  # noqa: B007
        dirs[:] = [d for d in dirs if not d.startswith(SKIP_DIRS_PREFIX)]
        for n in names:
            fp = os.path.join(root, n)
            try:
                st = os.stat(fp)
            except OSError:
                continue
            newest = max(newest, st.st_mtime, st.st_ctime)
            if n.startswith('.') or n.startswith('._') or n == 'Thumbs.db':
                continue
            size = st.st_size
            files.append({'p': os.path.relpath(fp, top).replace(os.sep, '/'), 'size': size})
            if len(files) >= MAX_FILES_PER_FOLDER:
                break
        if len(files) >= MAX_FILES_PER_FOLDER:
            break
    return files, int(newest)


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
    """One scan + POST (Mac / --once), or in DSM mode a loop: scan every SCAN_EVERY s for LOOP_SECONDS, POST on change."""
    env = {**load_env(), **{k: v for k, v in os.environ.items() if k.startswith(('NAS_', 'PROBOOK_'))}}
    if env.get('NAS_LOCAL') != '1' or '--once' in sys.argv:
        return scan_and_post(env)
    import fcntl
    lock = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'nas-agent.lock'), 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log('skip — the previous loop is still running')
        return 0
    start, last_sig, last_post, worst = time.time(), None, 0.0, 0
    while True:
        r = scan_and_post(env, last_sig=last_sig, heartbeat_due=time.time() - last_post >= HEARTBEAT)
        if isinstance(r, tuple):  # (rc, sig, posted)
            rc, sig, posted = r
            # a failed POST (timeout / 5xx — the server may still be ingesting it) is not re-sent 60 s later: only a
            # changed picture or the heartbeat sends again (review v1.288: overlapping ingests duplicated alerts)
            if posted or rc == 4:
                last_sig, last_post = sig, time.time()
        else:
            rc = r
        worst = max(worst, rc)  # the run's exit code is its worst moment, not its last
        rc = worst
        if time.time() - start + SCAN_EVERY > LOOP_SECONDS:
            return rc
        time.sleep(SCAN_EVERY)


def scan_and_post(env, last_sig=None, heartbeat_due=True):
    """-> exit code (single run) or (rc, signature, posted) when called by the loop (last_sig given or not)."""
    looping = env.get('NAS_LOCAL') == '1' and '--once' not in sys.argv
    mount = env.get('NAS_MOUNT') or '/Volumes/production team'
    smb_url = env.get('NAS_SMB_URL') or 'smb://192.168.21.220/production%20team'
    # DSM mode (2026-10-20): the agent runs ON the Synology via Task Scheduler, reading the share's local
    # path (/volume1/production team) — nothing to mount, no VPN, no macOS TCC. NAS_LOCAL=1 in nas-agent.env.
    if env.get('NAS_LOCAL') == '1':
        globals()['ensure_mounted'] = lambda m, _u: None if os.path.isdir(m) else f'{m} is not a directory on this NAS'
    url = (env.get('PROBOOK_URL') or 'https://probook.thestandard.co').rstrip('/') + '/api/internal/nas-manifest'
    secret = env.get('NAS_SECRET', '')
    if not secret:
        log(f'FAIL NAS_SECRET missing in {ENV_FILE}')
        return 1
    why = ensure_mounted(mount, smb_url)
    if why:
        log(f'FAIL {mount} not mounted — {why}')
        return 2
    errors, skipped = [], []
    try:
        folders = scan(mount, errors, skipped)
    except PermissionError:
        log(f'FAIL macOS blocked reading {mount} — give Full Disk Access to {os.path.realpath(sys.executable)} '
            '(System Settings › Privacy & Security › Full Disk Access)')
        return 3
    sig = hashlib.sha1(json.dumps(folders, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()
    if looping and sig == last_sig and not heartbeat_due:
        return (0, sig, False)  # nothing changed since the last POST — the server already has this picture
    manifest = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'host': socket.gethostname(), 'folders': folders}
    if skipped:
        manifest['skipped'] = skipped  # left out (unreadable): not "removed from the NAS", never judged
    try:
        status, body = post(url, secret, manifest)
    except Exception as e:
        log(f'FAIL POST {url}: {type(e).__name__}: {e}')
        return (4, sig, False) if looping else 4
    files = sum(len(f['files']) for f in folders)
    if status != 200:
        log(f'FAIL POST → {status} {body[:160]}')
        return (4, sig, False) if looping else 4
    cards = sum(len(f.get('cards', [])) for f in folders)
    log(f'ok {len(folders)} folders · {files} files queued on NAS · {cards} MEDIAPRO → {status}')
    for err in errors:
        log(f'FAIL left out (unreadable, never judged as drained): {err[:200]}')
    rc = 5 if errors else 0
    return (rc, sig, True) if looping else rc


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
        assert [{k: v for k, v in f.items() if k != 'lastWrite'} for f in got] == [{'name': 'Show (NWS-ABC-261009-01)', 'files': [{'p': 'CAM-A/A001.MXF', 'size': 10}]}], got
        assert got[0]['lastWrite'] > 0
        globals()['is_mounted'] = lambda p: True   # pretend the share is mounted
        assert ensure_mounted(d, 'smb://unused') is None
        globals()['is_mounted'] = lambda p: os.path.ismount(p)
        # an unreadable subfolder: that FOLDER is left out and reported, the others still report
        os.makedirs(os.path.join(d, 'Other (NWS-ABC-261009-02)'))
        locked = os.path.join(d, 'Show (NWS-ABC-261009-01)', 'CAM-B')
        os.makedirs(locked); os.chmod(locked, 0)
        try:
            errs, skipped = [], []
            got = scan(d, errs, skipped)
            assert [f['name'] for f in got] == ['Other (NWS-ABC-261009-02)'], got
            assert len(errs) == 1 and errs[0].startswith('Show (NWS-ABC-261009-01)'), errs
            assert skipped == ['Show (NWS-ABC-261009-01)'], skipped
            try:
                scan(d)
                raise AssertionError('strict scan skipped an unreadable subfolder')
            except PermissionError:
                pass
        finally:
            os.chmod(locked, 0o755)
        assert not is_mounted(d), 'a plain folder is not a mount point'
        assert load_env('/nonexistent/env') == {}
    # v1.288 — MEDIAPRO read on the NAS
    with tempfile.TemporaryDirectory() as d:
        card = os.path.join(d, 'Show (NWS-ABC-261009-01)', 'CAM-A', 'XDROOT')
        os.makedirs(os.path.join(card, 'Clip'))
        open(os.path.join(card, 'MEDIAPRO.XML'), 'w').write(
            '<?xml version="1.0"?><MediaProfile xmlns="http://xmlns.sony.net/pro/metadata/mediaprofile"><Contents>'
            '<Material uri="./Clip/A001C001_261009XF.MXF" type="MXF" dur="10"><Proxy uri="./Sub/A001C001_261009XFS03.MP4"/>'
            '<RelevantInfo uri="./Clip/A001C001_261009XFM01.XML"/></Material>'
            '<Material uri="./Clip/A001C002_261009XF.MXF" type="MXF" dur="10"/></Contents></MediaProfile>')
        open(os.path.join(card, 'Clip', 'A001C001_261009XF.MXF'), 'wb').write(b'x' * 10)
        got = scan(d)
        assert got[0]['cards'] == [{'dir': 'CAM-A/XDROOT', 'origs': ['Clip/A001C001_261009XF.MXF', 'Clip/A001C002_261009XF.MXF']}], got[0].get('cards')
        with open(os.path.join(card, 'MEDIAPRO.XML'), 'rb') as fh:
            assert parse_mediapro(fh.read())[0] == ['Clip/A001C001_261009XF.MXF', 'Sub/A001C001_261009XFS03.MP4',
                                                     'Clip/A001C001_261009XFM01.XML', 'Clip/A001C002_261009XF.MXF']
        open(os.path.join(card, 'MEDIAPRO.XML'), 'w').write('<?xml version="1.0"?><Other/>')
        bad = scan(d)[0]['cards'][0]
        assert bad['dir'] == 'CAM-A/XDROOT' and 'not a MEDIAPRO' in bad['error'], bad
        open(os.path.join(card, 'MEDIAPRO.XML'), 'w').write('<MediaProfile><Contents><Mater')  # half-written copy
        assert 'error' in scan(d)[0]['cards'][0]
        os.remove(os.path.join(card, 'MEDIAPRO.XML'))
        assert 'cards' not in scan(d)[0], 'no MEDIAPRO on the NAS = no cards key (the server keeps what it saw before)'
        # the folder's lastWrite counts a hidden rsync temp file (still after MEDIAPRO.XML left the NAS); the cap marks truncation
        tmp = os.path.join(card, 'Clip', '.A001C002_261009XF.MXF.Xy12ab')
        open(tmp, 'wb').write(b'partial')
        os.utime(os.path.join(card, 'Clip', 'A001C001_261009XF.MXF'), (1, 1))
        os.utime(tmp, (4_000_000_000, 4_000_000_000))
        got = scan(d)[0]
        assert all(not f['p'].split('/')[-1].startswith('.') for f in got['files']), 'temp files are not listed'
        assert got['lastWrite'] >= 4_000_000_000, 'but they move the folder lastWrite'
        global MAX_FILES_PER_FOLDER
        cap, MAX_FILES_PER_FOLDER = MAX_FILES_PER_FOLDER, 1
        try:
            assert scan(d)[0].get('truncated') is True
        finally:
            MAX_FILES_PER_FOLDER = cap
    print('selftest ok')
    return 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
