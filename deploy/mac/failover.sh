#!/bin/bash
# When the Pi is down (docs/deploy.md): serves the newest copy of the data
# from this Mac as the live app, on port 5050, until Ctrl-C. Phones use the
# address it prints. Run it again to carry on: it keeps the data it served.
# When the Pi is back, failback.sh puts that data on it. Until then this
# Mac's copy is the only one written to.
#
#   deploy/mac/failover.sh            refuses while the Pi still answers
#   deploy/mac/failover.sh --force    serve anyway
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
REPLICA=$HOME/YuzuBoard/replica
FAIL=$HOME/YuzuBoard/failover
PI_URL=http://yuzuberrypi.local

if [[ ${1:-} != --force ]] && curl -fsS --max-time 4 "$PI_URL/api/health" >/dev/null 2>&1; then
  echo "The Pi is answering at $PI_URL, so two copies would take writes. Use --force if it's really broken." >&2
  exit 1
fi
if [[ ! -s $FAIL/homewall.db ]]; then
  newest=$(/usr/bin/python3 "$REPO/backup.py" latest "$REPLICA/backups")
  [[ -n $newest ]] || { echo "No synced data in $REPLICA/backups." >&2; exit 1; }
  mkdir -p "$FAIL"
  cp "$newest" "$FAIL/homewall.db"
  cp -cR "$REPLICA/uploads" "$FAIL/uploads" 2>/dev/null || cp -R "$REPLICA/uploads" "$FAIL/uploads"
  echo "Serving $(basename "$newest") (synced $(( ($(date +%s) - $(cat "$REPLICA/last-sync" 2>/dev/null || echo 0)) / 60 )) minutes ago)."
else
  echo "Carrying on with the data already served from $FAIL."
fi
ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "<this Mac's address>")
echo "Live on this Mac: http://$ip:5050. When the Pi is back: Ctrl-C, then deploy/mac/failback.sh"
exec "$REPO/.venv/bin/python" "$REPO/app.py" --port 5050 --db "$FAIL/homewall.db" --uploads "$FAIL/uploads/holds"
