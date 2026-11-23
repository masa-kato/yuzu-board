#!/bin/bash
# Puts the data back on the Pi and starts the app there (docs/deploy.md):
#
#   deploy/mac/failback.sh                 after a failover: the data this Mac served
#   deploy/mac/failback.sh --from-replica  a rebuilt Pi: the newest synced snapshot
#
# What the Pi had is kept first, as a snapshot tagged before-failback.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
REPLICA=$HOME/YuzuBoard/replica
FAIL=$HOME/YuzuBoard/failover
PI=${YUZU_PI:-yuzu}
PI_URL=http://yuzuberrypi.local

if [[ ${1:-} == --from-replica ]]; then
  db=$(/usr/bin/python3 "$REPO/backup.py" latest "$REPLICA/backups")
  images=$REPLICA/uploads
else
  db=$FAIL/homewall.db
  images=$FAIL/uploads
  if lsof -tiTCP:5050 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Stop failover.sh first (Ctrl-C), so its data is final." >&2
    exit 1
  fi
fi
[[ -n $db && -s $db ]] || { echo "Nothing to put back (no $db)." >&2; exit 1; }
/usr/bin/python3 "$REPO/backup.py" verify "$db"

echo "Stopping the app on the Pi and keeping what it had..."
ssh "$PI" 'systemctl --user stop yuzu-board
  mkdir -p ~/yuzu-data/backups ~/yuzu-data/uploads
  if [ -s ~/yuzu-data/homewall.db ]; then
    /usr/bin/python3 ~/yuzu-board/backup.py snapshot ~/yuzu-data/homewall.db ~/yuzu-data/backups --tag before-failback
  fi'
echo "Copying $(basename "$db") and the hold images..."
rsync -a "$db" "$PI:yuzu-data/homewall.db"
rsync -a "$images/" "$PI:yuzu-data/uploads/"
ssh "$PI" 'systemctl --user start yuzu-board'

for _ in $(seq 30); do
  if curl -fsS --max-time 2 "$PI_URL/api/health" >/dev/null 2>&1; then
    [[ ${1:-} == --from-replica ]] || mv "$FAIL" "$FAIL-done-$(date +%Y%m%d-%H%M)"
    echo "The Pi is live again at $PI_URL."
    exit 0
  fi
  sleep 1
done
echo "The Pi didn't answer: ssh $PI journalctl --user-unit yuzu-board" >&2
exit 1
