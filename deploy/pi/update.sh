#!/usr/bin/env bash
# The Pi's deploy (docs/deploy.md), every 2 minutes on yuzu-update.timer.
# When GitHub's main has moved:
#   1. test the new commit in a checkout of its own (~/yuzu-staging), so the
#      live app is untouched if it fails;
#   2. snapshot the database, since the new code's migrations run as it starts;
#   3. move the live checkout to it and restart the app;
#   4. wait for the app to answer as the new version, or go back.
# A commit that failed isn't tried again; the next one is.
#
#   update.sh              deploy origin/main if it's new
#   update.sh --ref SHA    the same steps for any commit (to try the pipeline)
#
# `touch ~/yuzu-data/deploy/paused` stops deploys until it's removed.
set -euo pipefail

LIVE=$HOME/yuzu-board
STAGING=$HOME/yuzu-staging
DATA=$HOME/yuzu-data
STATE=$DATA/deploy
PYTHON=$LIVE/.venv/bin/python
HEALTH=http://127.0.0.1/api/health

# For the Mac's sync job, which says when a deploy failed.
record() {  # result sha message
  printf '{"result": "%s", "sha": "%s", "at": "%s", "message": "%s"}\n' "$1" "$2" "$(date -Iseconds)" "$3" > "$STATE/status.json"
}

failed() {  # sha why
  echo "$1" > "$STATE/failed"
  record failed "$1" "$2"
  echo "Not deployed: $1 ($2)" >&2
}

# Until the app answers as `sha`, for up to 30 seconds.
answers_as() {
  local sha=$1
  for _ in $(seq 30); do
    if curl -fsS --max-time 2 "$HEALTH" 2>/dev/null | grep -q "\"version\": *\"$sha\""; then
      return 0
    fi
    sleep 1
  done
  return 1
}

main() {
  mkdir -p "$STATE"
  if [[ -e $STATE/paused ]]; then
    echo "Deploys are paused ($STATE/paused)."
    return 0
  fi
  local ref=origin/main
  if [[ ${1:-} == --ref ]]; then
    ref=$2
  fi

  git -C "$LIVE" fetch --quiet origin main
  local new old
  new=$(git -C "$LIVE" rev-parse --short "$ref^{commit}")
  old=$(git -C "$LIVE" rev-parse --short HEAD)
  if [[ $new == "$old" ]] || [[ -e $STATE/failed && $(cat "$STATE/failed") == "$new" ]]; then
    return 0
  fi
  echo "Deploying $new (running $old)"

  # 1. Test it where the live app can't see.
  git -C "$STAGING" checkout --quiet --detach "$new"
  if ! git -C "$LIVE" diff --quiet "$old" "$new" -- requirements.txt; then
    "$PYTHON" -m pip install --quiet -r "$STAGING/requirements.txt"
  fi
  if ! (cd "$STAGING" && "$PYTHON" -m unittest discover -s tests -q); then
    failed "$new" "its tests failed"
    return 1
  fi

  # 2. A snapshot to go back to by hand if the migrations go wrong.
  /usr/bin/python3 "$STAGING/backup.py" snapshot "$DATA/homewall.db" "$DATA/backups" --tag "pre-deploy-$new"

  # 3. Switch.
  git -C "$LIVE" reset --quiet --hard "$new"
  systemctl --user restart yuzu-board

  # 4. Check, or go back.
  if answers_as "$new"; then
    rm -f "$STATE/failed"
    record ok "$new" "deployed"
    echo "Deployed $new"
    return 0
  fi
  echo "$new didn't come up, so going back to $old" >&2
  git -C "$LIVE" reset --quiet --hard "$old"
  systemctl --user restart yuzu-board
  answers_as "$old" || echo "...and $old didn't answer either: see journalctl --user -u yuzu-board" >&2
  failed "$new" "it didn't start, so $old is back"
  return 1
}

# All of it is read before any of it runs: step 3 replaces this file.
main "$@"
exit $?
