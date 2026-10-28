#!/bin/bash
# probook-field.sh — ส่งการ์ด Sony ทั้งใบจากหน้างานเข้ากล่องของใบจอง (v1.277, Phase 1)
#
#   probook-field.sh <ticket> <card-folder> [--originals] [--bwlimit 4M] [--base https://probook.thestandard.co]
#
# ticket    = โค้ดจากปุ่ม "ขอโค้ดส่งการ์ด" บนหน้าอัปของใบจอง (1 โค้ด = 1 การ์ด)
# card      = โฟลเดอร์รากของการ์ด (มี XDROOT/ หรือ M4ROOT/ + MEDIAPRO.XML) หรือสำเนาบน SSD
# --originals  ส่งต้นฉบับ (Clip/) ด้วยในรอบนี้ — ค่าเริ่มต้นคือ proxy+เสียงก่อน แล้วหยุดรอ (รันซ้ำด้วยโค้ดเดิม + --originals ทีหลัง)
#
# สิ่งที่สคริปต์นี้ "ไม่" ทำ: ไม่ตั้งชื่อโฟลเดอร์เอง (server สร้างให้ด้วย id) · ไม่ใช้ rclone sync/move ·
# ไม่ถือว่าเสร็จจาก exit 0 ของ copy — เสร็จคือ `rclone check` ตรง 0 ต่าง + server ตอบ complete
# ทุกทางที่ล้มหลัง start = exit ≠ 0 + แจ้ง server (`fail`) + แจ้งเตือนบนเครื่อง
#
# ต้องมี: rclone (PATH หรือ ~/.local/bin) ที่มี remote `field:` (OAuth client probook-field — ล็อกอินบัญชี @thestandard.co ของคุณเอง),
#         python3, caffeinate, curl · macOS (bash 3.2 ก็ได้)
set -euo pipefail

TICKET="${1:-}"; CARD="${2:-}"; shift 2 2>/dev/null || true
ORIGINALS=0; BWLIMIT=""; BASE="${PROBOOK_BASE:-https://probook.thestandard.co}"
while [ $# -gt 0 ]; do
  case "$1" in
    --originals) ORIGINALS=1 ;;
    --bwlimit) BWLIMIT="$2"; shift ;;
    --base) BASE="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac; shift
done
[ -n "$TICKET" ] && [ -n "$CARD" ] || { sed -n 2,8p "$0"; exit 2; }
CARD="${CARD%/}"
RCLONE="$(command -v rclone || true)"; [ -z "$RCLONE" ] && [ -x "$HOME/.local/bin/rclone" ] && RCLONE="$HOME/.local/bin/rclone"
[ -n "$RCLONE" ] || { echo "❌ ไม่พบ rclone — ติดตั้งก่อน"; exit 3; }
"$RCLONE" listremotes | grep -qx 'field:' || { echo "❌ ไม่มี remote 'field:' — ตั้งตามคู่มือ (OAuth client probook-field, ล็อกอินบัญชี @thestandard.co ของคุณ)"; exit 3; }

LOGDIR="$HOME/Library/Logs/ProBook Field"; mkdir -p "$LOGDIR"
STAMP="$(date +%Y%m%d-%H%M%S)-${TICKET:0:6}"; LOG="$LOGDIR/$STAMP.log"
# one run per card per machine; a lock left by a crash/kill -9/reboot is detected by its pid and cleared
LOCK="$HOME/Library/Application Support/ProBook Field/lock-${TICKET:0:12}"; mkdir -p "$(dirname "$LOCK")"
if ! mkdir "$LOCK" 2>/dev/null; then
  OLD=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then echo "❌ การ์ดนี้กำลังส่งอยู่แล้วจากเครื่องนี้ (pid $OLD)"; exit 4; fi
  rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"

# the SAME set for rclone copy, rclone check and the local manifest: no dot-files/dirs anywhere, no Sony temp
EXCL=(--exclude '.*' --exclude '.*/**' --exclude 'SALVAGE.TMP')
NOCLIP=(--exclude '**/[Cc][Ll][Ii][Pp]/**')
HB_PID=""; PHASE="start"; STARTED=0; CUR_BYTES=0

say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }
notify() { # osascript: a stray quote must not swallow the message
  local t="${1//\"/\'}" m="${2//\"/\'}"
  osascript -e "display notification \"$m\" with title \"ProBook Field — $t\"" >/dev/null 2>&1 || true
}
jstr() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }
api() { # api <action> <json-fields> — prints the body; curl failure → non-zero
  curl -sS -m 60 -X POST "$BASE/api/upload/ingest" -H 'Content-Type: application/json' \
    -d "{\"action\":\"$1\",\"ticket\":\"$TICKET\"$2}" 2>>"$LOG"
}
jget() { python3 -c 'import json,sys
try: v=json.load(sys.stdin)
except Exception: print(""); sys.exit()
for k in sys.argv[1].split("."): v=v.get(k) if isinstance(v,dict) else None
print("" if v is None else v)' "$1"; }
stop_hb() { if [ -n "$HB_PID" ]; then kill "$HB_PID" 2>/dev/null || true; wait "$HB_PID" 2>/dev/null || true; fi; HB_PID=""; }
count_of() { local v; v=$(printf '%s' "$1" | { grep -aoE "[0-9]+ $2" || true; } | { grep -oE '^[0-9]+' || true; } | tail -1); echo "${v:-0}"; }
cleanup() { stop_hb; rm -rf "$LOCK" 2>/dev/null || true; }
die() { # loud on every path: the server is told, the user sees it, exit ≠ 0
  local msg="$1"; trap - INT TERM; stop_hb
  say "❌ $msg"; notify "ล้ม" "$msg"
  if [ "$STARTED" = 1 ]; then api fail ",\"reason\":$(printf '%s' "$msg" | jstr)" >/dev/null 2>&1 || say "(แจ้ง server ไม่ได้ — ระบบจะจับได้เองใน ~20 นาที)"; fi
  cleanup; exit 1
}
trap 'die "หยุดกลางคัน (${PHASE})"' INT TERM
trap cleanup EXIT

# ── 1. ตรวจต้นทาง (ไม่เชื่อว่า "มีโฟลเดอร์" = "มีการ์ด") ────────────────────────────
[ -d "$CARD" ] || die "ไม่พบโฟลเดอร์การ์ด: $CARD"
SONY=0; MEDIAPRO=0
for d in XDROOT M4ROOT; do [ -d "$CARD/$d" ] && { SONY=1; [ -f "$CARD/$d/MEDIAPRO.XML" ] && MEDIAPRO=1; }; done
# relative paths so `*/.*` means "a dot component inside the card", never the card's own location
cfind() { (cd "$CARD" && find . -type f ! -path '*/.*' ! -name 'SALVAGE.TMP' "$@"); }
VIDEOS=$(cfind \( -iname '*.mp4' -o -iname '*.mxf' -o -iname '*.mov' \) | wc -l | tr -d ' ')
WAVS=$(cfind -iname '*.wav' | wc -l | tr -d ' ')
manifest() { # "<files> <bytes>" of what a pass sends: $1 = noclip | all
  if [ "$1" = noclip ]; then cfind ! -ipath '*/clip/*' -print0; else cfind -print0; fi \
    | (cd "$CARD" && xargs -0 stat -f %z 2>/dev/null) | awk '{n++; s+=$1} END{printf "%d %d", n+0, s+0}'
}
read -r F1 B1 <<<"$(manifest noclip)"; read -r FA BA <<<"$(manifest all)"
say "การ์ด: $CARD · ราก: $(ls -1 "$CARD" | tr '\n' ' ')"
say "วิดีโอ $VIDEOS · WAV $WAVS · Sony=$SONY MEDIAPRO=$MEDIAPRO · proxy+เสียง $F1 ไฟล์ $((B1/1000000)) MB · ทั้งการ์ด $FA ไฟล์ $((BA/1000000)) MB"
say "เช็กว่าขนาดนิ่ง (15 วิ) — กันสำเนาที่ยังก๊อปไม่เสร็จ"; sleep 15; read -r FAb BAb <<<"$(manifest all)"
[ "$FA" = "$FAb" ] && [ "$BA" = "$BAb" ] || die "ต้นทางยังเปลี่ยนอยู่ ($FA/$BA → $FAb/$BAb) — รอให้ก๊อปเสร็จก่อน"
if [ "$ORIGINALS" = 1 ]; then MF=$FA; MB=$BA; else MF=$F1; MB=$B1; fi
pyb() { [ "$1" = 1 ] && echo true || echo false; }

# ── 2. start: server ตัดสิน (สถานะใบ, กล่อง, ทางเดียว, โควตา) แล้วให้ id โฟลเดอร์การ์ด ───
PHASE=start
RESP=$(api start ",\"manifest\":{\"files\":$MF,\"bytes\":$MB,\"videos\":$VIDEOS,\"wavs\":$WAVS,\"sonyTree\":$(pyb $SONY),\"mediapro\":$(pyb $MEDIAPRO)}") || die "ติดต่อ server ไม่ได้ ($BASE)"
[ "$(printf '%s' "$RESP" | jget ok)" = "True" ] || die "server ปฏิเสธ: $(printf '%s' "$RESP" | jget code) — $(printf '%s' "$RESP" | jget error)"
STARTED=1
BOX=$(printf '%s' "$RESP" | jget boxId); CARDID=$(printf '%s' "$RESP" | jget cardFolderId)
PATHBOX=$(printf '%s' "$RESP" | jget pathFromBox); BUDGET=$(printf '%s' "$RESP" | jget budgetBytes); CODE=$(printf '%s' "$RESP" | jget bookingCode)
BUDGET="${BUDGET%.*}"; case "$BUDGET" in ''|*[!0-9]*) die "server ไม่ส่งโควตามา (budgetBytes=$BUDGET)";; esac
[ -n "$BOX" ] && [ -n "$CARDID" ] && [ -n "$PATHBOX" ] || die "server ตอบ start ไม่ครบ"
say "✅ start: $CODE → $PATHBOX (โควตาเหลือ $((BUDGET/1000000000)) GB)$( [ "$(printf '%s' "$RESP" | jget resumed)" = True ] && echo ' · ส่งต่อจากรอบก่อน')"
# the token on THIS laptop must see the folder (the server checked as the crew member via DWD, not this token)
"$RCLONE" lsjson field: --drive-root-folder-id "$CARDID" --max-depth 1 >/dev/null 2>>"$LOG" || die "บัญชีที่ล็อกอินใน rclone มองไม่เห็นโฟลเดอร์ปลายทาง (ไม่ใช่สมาชิกไดรฟ์ VIDEO หรือ token หมดอายุ) — แจ้งนัท"

# ── 3. heartbeat ทุก 60 วิ — ส่งเสมอแม้ยังไม่มีตัวเลข · มีชีวิตตลอด copy และ check ───────────
hb_loop() { set +e +o pipefail  # this loop must never die on a grep miss
  local rlog="$1"
  while true; do
    sleep 60
    # --stats-one-line:  "INFO  :   1.234 GiB / 4.5 GiB, 27%, 12.3 MiB/s, ETA 4m31s"
    local line bytes eta
    line=$(grep -a ' / .*, [0-9]*%' "$rlog" 2>/dev/null | tail -1)
    bytes=$(printf '%s' "$line" | python3 -c '
import sys,re; s=sys.stdin.read(); m=re.search(r"([\d.]+) ([KMGT]?i?B) /",s); u={"B":1,"KiB":1024,"MiB":1024**2,"GiB":1024**3,"TiB":1024**4}
print(int(float(m.group(1))*u.get(m.group(2),1)) if m else 0)' 2>/dev/null)
    eta=$(printf '%s' "$line" | grep -oE 'ETA [^ ,]+' | head -1 | sed 's/ETA //')
    api heartbeat ",\"phase\":\"$(cat "$LOCK/phase" 2>/dev/null || echo pass1)\",\"bytes\":${bytes:-0},\"eta\":\"${eta:0:30}\"" >/dev/null 2>&1
  done; }
setphase() { PHASE="$1"; echo "$1" > "$LOCK/phase"; }

run_pass() { # run_pass <pass1|pass2> <extra rclone filters...>
  local pass="$1"; shift
  local rlog="$LOG.$pass.rclone"; : > "$rlog"
  setphase "$pass"; say "▶ $pass: rclone copy → field:$PATHBOX"
  hb_loop "$rlog" & HB_PID=$!
  set +e
  caffeinate -i -s "$RCLONE" copy "$CARD" field: --drive-root-folder-id "$CARDID" "$@" "${EXCL[@]}" \
    --immutable --no-update-modtime --error-on-no-transfer --transfers 4 --drive-chunk-size 64M --retries 10 --retries-sleep 30s --low-level-retries 20 \
    --drive-stop-on-upload-limit --max-transfer "${BUDGET}B" --cutoff-mode cautious \
    ${BWLIMIT:+--bwlimit "$BWLIMIT"} -v --stats 30s --stats-one-line --log-file "$rlog"
  local rc=$?
  set -e
  case $rc in
    0|9) ;;  # 9 = nothing to send (a rerun after it all went up) — the check decides
    8) stop_hb; quota_wait "ถึงเพดานโควตาที่เหลือของวันนี้ (--max-transfer)" ;;
    7) if grep -aqiE 'upload limit|userRateLimitExceeded|uploadLimitExceeded' "$rlog"; then stop_hb; quota_wait "Drive แจ้งว่าโควตาอัปของบัญชีคุณวันนี้เต็ม"; fi
       die "rclone หยุดด้วย fatal error (exit 7) ดู $rlog" ;;
    6) die "ไฟล์บน Drive ไม่ตรงกับการ์ด (--immutable ปฏิเสธการเขียนทับ) — การ์ดถูกแก้หลังส่งรอบก่อน? แจ้งนัท · ดู $rlog" ;;
    *) die "rclone copy ล้ม (exit $rc) ดู $rlog" ;;
  esac
  setphase "check${pass#pass}"; say "▶ check${pass#pass}: rclone check (md5, by path จากกล่อง)"
  local out
  out=$("$RCLONE" check "$CARD" "field:$PATHBOX" --drive-root-folder-id "$BOX" --one-way "$@" "${EXCL[@]}" 2>&1) || true
  printf '%s\n' "$out" >> "$LOG"
  stop_hb
  if printf '%s' "$out" | grep -aq 'Duplicate object'; then die "บน Drive มีไฟล์ชื่อซ้ำ (rclone check: Duplicate object) — แจ้งนัท"; fi
  # a phrase rclone did not print is a grep miss (exit 1) — under pipefail that must read as 0, not kill the script
  MATCH=$(count_of "$out" 'matching files'); DIFF=$(count_of "$out" 'differences found'); MISSING=$(count_of "$out" 'files missing')
  say "check: ตรง $MATCH · ต่าง $DIFF · ขาด $MISSING"
  [ "$DIFF" = 0 ] && [ "$MISSING" = 0 ] && [ "$MATCH" -gt 0 ] || die "md5 ไม่ผ่าน (ตรง $MATCH · ต่าง $DIFF · ขาดบน Drive $MISSING)"
}
quota_wait() {
  setphase quota-wait
  api pause ",\"phase\":\"quota-wait\"" >/dev/null 2>&1 || true
  say "⏸ $1 — รันคำสั่งเดิมพรุ่งนี้ ไฟล์ที่ส่งแล้วจะถูกข้าม · ห้าม format การ์ด"; notify "รอโควตา" "$1"
  cleanup; exit 5
}

# ── 4. pass 1: proxy + เสียง (ข้าม Clip/) ──────────────────────────────────────
run_pass pass1 "${NOCLIP[@]}"
if [ "$ORIGINALS" = 0 ]; then
  setphase proxies-ok
  RESP=$(api pause ",\"phase\":\"proxies-ok\",\"bytes\":$B1,\"files\":$MATCH,\"check\":{\"matching\":$MATCH,\"differences\":$DIFF}") || die "แจ้ง server ไม่ได้"
  [ "$(printf '%s' "$RESP" | jget ok)" = "True" ] || die "server ไม่รับ pause: $(printf '%s' "$RESP" | jget error)"
  say "✅ proxy+เสียงส่งครบ $MATCH ไฟล์ ตรวจ md5 แล้ว · ห้าม format การ์ด · ส่งต้นฉบับทีหลัง: รันคำสั่งเดิม + --originals"
  notify "proxy ครบ" "$CODE · $MATCH ไฟล์ · ต้นฉบับยังไม่ส่ง"
  exit 0
fi

# ── 5. pass 2: ต้นฉบับ แล้ว complete ─────────────────────────────────────────────
run_pass pass2
setphase complete
RESP=$(api complete ",\"check\":{\"matching\":$MATCH,\"differences\":$DIFF}") || die "แจ้ง server ไม่ได้"
[ "$(printf '%s' "$RESP" | jget ok)" = "True" ] || die "server ไม่รับ complete: $(printf '%s' "$RESP" | jget code) — $(printf '%s' "$RESP" | jget error)"
say "✅ ครบ: $CODE $PATHBOX · $(printf '%s' "$RESP" | jget files) ไฟล์บน Drive ตรงกับการ์ด"
notify "ครบ" "$CODE · ส่งทั้งการ์ดแล้ว"
exit 0
