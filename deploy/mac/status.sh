#!/bin/bash
# One look at the Yuzu Board's deploy (docs/deploy.md): what the Pi runs next
# to this checkout and GitHub, the last deploy, the last sync, the newest snapshot.
REPO=$(cd "$(dirname "$0")/../.." && pwd)
REPLICA=$HOME/YuzuBoard/replica
PI_URL=http://yuzuberrypi.local

git -C "$REPO" fetch --quiet origin main 2>/dev/null
dirty=$(git -C "$REPO" status --porcelain | head -1)
running=$(curl -fsS --max-time 4 "$PI_URL/api/health" 2>/dev/null |
  /usr/bin/python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])' 2>/dev/null || echo "no answer")
echo "This checkout:  $(git -C "$REPO" rev-parse --short HEAD)${dirty:+ (with changes not committed)}"
echo "GitHub main:    $(git -C "$REPO" rev-parse --short origin/main)"
echo "The Pi runs:    $running ($PI_URL)"
if [[ -f $REPLICA/status.json ]]; then
  echo "Last deploy:    $(/usr/bin/python3 -c 'import json, sys; s = json.load(open(sys.argv[1])); print(s["result"], s["sha"], s["at"], "-", s["message"])' "$REPLICA/status.json")"
fi
if [[ -f $REPLICA/last-sync ]]; then
  echo "Last sync:      $(( ($(date +%s) - $(cat "$REPLICA/last-sync")) / 60 )) minutes ago"
else
  echo "Last sync:      never"
fi
newest=$(/usr/bin/python3 "$REPO/backup.py" latest "$REPLICA/backups")
echo "Newest copy:    ${newest:+$(basename "$newest")}${newest:-none} ($(ls "$REPLICA/backups" 2>/dev/null | wc -l | tr -d ' ') snapshots on this Mac)"
