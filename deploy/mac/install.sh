#!/bin/bash
# Sets this Mac up beside the Pi (docs/deploy.md). Safe to run again, and run
# it again after changing sync-from-pi.sh or backup.py, which it copies:
#   - the folders under ~/YuzuBoard;
#   - a key for the sync job that the Pi lets read ~/yuzu-data and nothing else;
#   - the sync job itself, every 15 minutes (LaunchAgent com.yuzuboard.sync);
#   - the pre-push hook that runs the tests.
# Needs `ssh yuzu` to reach the Pi (~/.ssh/config), with the repo cloned there.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$HOME/YuzuBoard
PI=${YUZU_PI:-yuzu}
KEY=$HOME/.ssh/yuzu_sync
AGENT=com.yuzuboard.sync
PLIST=$HOME/Library/LaunchAgents/$AGENT.plist

mkdir -p "$DIR"/{bin,replica/backups,replica/uploads,test,logs}
cp "$REPO/deploy/mac/sync-from-pi.sh" "$REPO/backup.py" "$DIR/bin/"

# No passphrase: the sync job runs with nobody there to type one.
[[ -f $KEY ]] || ssh-keygen -q -t ed25519 -N '' -C yuzu-sync -f "$KEY"
if ! grep -q '^Host yuzu-sync$' ~/.ssh/config 2>/dev/null; then
  host=$(ssh -G "$PI" | awk '$1 == "hostname" { print $2 }')
  user=$(ssh -G "$PI" | awk '$1 == "user" { print $2 }')
  printf '\n# The sync job (YuzuBoard): may only read ~/yuzu-data on the Pi.\nHost yuzu-sync\n  HostName %s\n  User %s\n  IdentityFile %s\n  IdentitiesOnly yes\n' \
    "$host" "$user" "$KEY" >> ~/.ssh/config
fi
ssh "$PI" "~/yuzu-board/deploy/pi/allow-sync-key.sh '$(cat "$KEY.pub")'"

git -C "$REPO" config core.hooksPath .githooks

sed -e "s|@BIN@|$DIR/bin|g" -e "s|@LOGS@|$DIR/logs|g" "$REPO/deploy/mac/$AGENT.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/$AGENT" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Syncing from the Pi every 15 minutes into $DIR/replica (log: $DIR/logs/sync.log)."
