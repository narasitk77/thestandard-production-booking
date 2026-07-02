#!/bin/bash
# v1.111 — NAS manifest agent (runs on the ADMIN's Mac via launchd, every ~10 min).
# Scans the SMB-mounted "production team" NAS share and POSTs a manifest
# (per-folder relative paths + sizes) to the app, which diffs it against the
# Production Team Drive folders and emails when a folder finishes syncing.
#
# Install (one-time):
#   cp scripts/nas-manifest-agent.sh ~/.probook/nas-manifest-agent.sh
#   echo 'NAS_SECRET=<secret>' > ~/.probook/nas-agent.env   # matches NAS_MANIFEST_SECRET on the server
#   launchctl load ~/Library/LaunchAgents/co.thestandard.probook-nas-agent.plist
#
# Exits quietly when the share isn't mounted (laptop away from office) — the
# server just keeps the last manifest and its timestamp shows the staleness.

set -euo pipefail

MOUNT="${NAS_MOUNT:-/Volumes/production team}"
URL="${PROBOOK_URL:-https://probook.xtec9.xyz}/api/internal/nas-manifest"
ENV_FILE="$HOME/.probook/nas-agent.env"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"
SECRET="${NAS_SECRET:-}"

if [ ! -d "$MOUNT" ]; then
  echo "[nas-agent] $MOUNT not mounted — skip"
  exit 0
fi
if [ -z "$SECRET" ]; then
  echo "[nas-agent] NAS_SECRET missing ($ENV_FILE) — skip"
  exit 1
fi

python3 - "$MOUNT" <<'PY' > /tmp/probook-nas-manifest.json
import json, os, sys, datetime, socket

mount = sys.argv[1]
folders = []
for entry in sorted(os.listdir(mount)):
    top = os.path.join(mount, entry)
    if entry.startswith('.') or not os.path.isdir(top):
        continue
    files = []
    for root, dirs, names in os.walk(top):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for n in names:
            if n.startswith('.') or n.startswith('._') or n == 'Thumbs.db':
                continue
            fp = os.path.join(root, n)
            try:
                size = os.path.getsize(fp)
            except OSError:
                continue
            rel = os.path.relpath(fp, top)
            files.append({'p': rel.replace(os.sep, '/'), 'size': size})
            if len(files) >= 6000:
                break
    folders.append({'name': entry, 'files': files})

print(json.dumps({
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'host': socket.gethostname(),
    'folders': folders,
}, ensure_ascii=False))
PY

HTTP=$(curl -sS -o /tmp/probook-nas-manifest-resp.json -w '%{http_code}' \
  -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H "x-nas-secret: $SECRET" \
  --data-binary @/tmp/probook-nas-manifest.json \
  --max-time 110)
echo "[nas-agent] POST $URL → $HTTP $(cat /tmp/probook-nas-manifest-resp.json 2>/dev/null | head -c 200)"
[ "$HTTP" = "200" ]
