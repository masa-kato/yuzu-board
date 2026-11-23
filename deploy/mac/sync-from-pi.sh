#!/bin/bash
# Copies the Pi's data to this Mac (docs/deploy.md), every 15 minutes from the
# LaunchAgent com.yuzuboard.sync: the database snapshots, the hold images and
# the last deploy's result, into ~/YuzuBoard/replica. Nothing is deleted here
# because it went from the Pi, and the Mac keeps its own snapshots by age.
# A notification says when the Pi has been out of reach for 2 hours, the
# newest snapshot isn't sound, or a deploy failed.
#
# deploy/mac/install.sh copies this to ~/YuzuBoard/bin with backup.py, since
# background jobs can't read ~/Documents.
set -uo pipefail

DIR=$HOME/YuzuBoard
REPLICA=$DIR/replica
BACKUP="/usr/bin/python3 $DIR/bin/backup.py"
LOG=$DIR/logs/sync.log
PI=yuzu-sync                  # ~/.ssh/config: the key that can only read ~/yuzu-data
OUT_OF_REACH=$((2 * 3600))

say() { echo "$(date '+%F %T') $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Yuzu Board\"" >/dev/null 2>&1 || true; }

# Keep the log short.
if [[ -f $LOG ]] && (( $(stat -f %z "$LOG") > 1000000 )); then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
mkdir -p "$REPLICA/backups" "$REPLICA/uploads"

if ! { rsync -a --timeout=60 "$PI:backups/" "$REPLICA/backups/" &&
       rsync -a --timeout=600 "$PI:uploads/" "$REPLICA/uploads/"; }; then
  last=$(cat "$REPLICA/last-sync" 2>/dev/null || echo 0)
  if (( $(date +%s) - last > OUT_OF_REACH )) && [[ ! -e $REPLICA/.told-out-of-reach ]]; then
    notify "The Pi hasn't answered for over 2 hours. The newest copy of the data is on this Mac (docs/deploy.md: failover)."
    touch "$REPLICA/.told-out-of-reach"
  fi
  say "Couldn't reach the Pi."
  exit 1
fi
date +%s > "$REPLICA/last-sync"
rm -f "$REPLICA/.told-out-of-reach"
# Absent until the first deploy.
rsync -a --timeout=60 "$PI:deploy/status.json" "$REPLICA/status.json" 2>/dev/null || true

$BACKUP prune "$REPLICA/backups" >/dev/null
newest=$($BACKUP latest "$REPLICA/backups")
if [[ -n $newest ]] && ! problem=$($BACKUP verify "$newest" 2>&1); then
  notify "The newest copy of the data from the Pi isn't sound: $(basename "$newest")."
  say "Unsound: $problem"
fi

# A failed deploy, said once.
if [[ -f $REPLICA/status.json ]]; then
  read -r result sha < <(/usr/bin/python3 -c 'import json, sys; s = json.load(open(sys.argv[1])); print(s["result"], s["sha"])' "$REPLICA/status.json" 2>/dev/null || echo "? ?")
  if [[ $result == failed && $sha != "$(cat "$REPLICA/.told-failed" 2>/dev/null)" ]]; then
    notify "The Pi didn't deploy $sha. The live app stays on the last good version (docs/deploy.md)."
    echo "$sha" > "$REPLICA/.told-failed"
  fi
fi
say "Synced. Newest snapshot: $(basename "${newest:-none}")"
