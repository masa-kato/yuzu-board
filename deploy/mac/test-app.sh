#!/bin/bash
# The test web app (docs/deploy.md): this working copy, changes and all, on
# port 5051 against a copy of the live data, so nothing done in it touches the
# real logbook. Every page says "Test copy". It restarts itself when a .py file
# changes; a .js or .css change shows on reload. Ctrl-C stops it.
#
#   deploy/mac/test-app.sh           start it (on a new copy of the data the first time)
#   deploy/mac/test-app.sh --fresh   start it on a new copy of the newest data
#
# Open http://localhost:5051, or http://<this Mac's address>:5051 on a phone.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
TEST=$HOME/YuzuBoard/test
REPLICA=$HOME/YuzuBoard/replica
PORT=${PORT:-5051}

# The newest snapshot from the Pi (or, before there is one, this checkout's own database).
fresh() {
  local newest
  newest=$(/usr/bin/python3 "$REPO/backup.py" latest "$REPLICA/backups")
  if [[ -z $newest && -s $REPO/homewall.db ]]; then
    newest=$REPO/homewall.db
  fi
  [[ -n $newest ]] || { echo "No data to copy yet: $REPLICA/backups is empty." >&2; exit 1; }
  mkdir -p "$TEST"
  rm -rf "$TEST/homewall.db" "$TEST/uploads"
  /usr/bin/python3 "$REPO/backup.py" snapshot "$newest" "$TEST" --tag copy >/dev/null
  mv "$TEST"/homewall-*-copy.db "$TEST/homewall.db"
  # A clone on APFS: instant, and takes no room until something changes.
  local images=$REPLICA/uploads
  [[ -d $images/holds ]] || images=$REPO/uploads
  cp -cR "$images" "$TEST/uploads" 2>/dev/null || cp -R "$images" "$TEST/uploads"
  echo "Test data: a copy of $(basename "$newest")"
}

if [[ ${1:-} == --fresh || ! -s $TEST/homewall.db ]]; then
  fresh
fi
ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
echo "Test app: http://localhost:$PORT${ip:+, or http://$ip:$PORT on a phone}"
exec "$REPO/.venv/bin/python" "$REPO/app.py" --port "$PORT" --reload --label "Test copy" \
  --db "$TEST/homewall.db" --uploads "$TEST/uploads/holds"
