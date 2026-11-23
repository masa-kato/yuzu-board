#!/usr/bin/env bash
# Sets the Pi up to run the Yuzu Board (docs/deploy.md). Safe to run again.
# On a fresh Pi:
#   git clone https://github.com/masa-kato/yuzu-board.git ~/yuzu-board
#   ~/yuzu-board/deploy/pi/install.sh
# It asks for the Pi's password once, the first time, for two system settings:
# services that start at boot without a login (linger), and port 80 without root.
set -euo pipefail

LIVE=$HOME/yuzu-board
STAGING=$HOME/yuzu-staging
DATA=$HOME/yuzu-data
UNITS=$HOME/.config/systemd/user

cd "$LIVE"
echo "Python packages..."
[[ -x .venv/bin/python ]] || python3 -m venv .venv
.venv/bin/python -m pip install --quiet -r requirements.txt

# A second checkout of the same repository, where update.sh tests a commit
# before the live app gets it.
[[ -d $STAGING ]] || git worktree add --quiet --detach "$STAGING" HEAD
mkdir -p "$DATA/uploads/holds" "$DATA/backups" "$DATA/deploy"

if [[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null) != yes ]]; then
  echo "Letting the services start at boot without a login (asks for your password)..."
  sudo loginctl enable-linger "$USER"
fi
if (( $(sysctl -n net.ipv4.ip_unprivileged_port_start) > 80 )); then
  echo "Letting the app use port 80 without root (asks for your password)..."
  echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/60-yuzu-port80.conf >/dev/null
  sudo sysctl --quiet -p /etc/sysctl.d/60-yuzu-port80.conf
fi

echo "Services..."
mkdir -p "$UNITS"
cp deploy/pi/systemd/*.service deploy/pi/systemd/*.timer "$UNITS/"
systemctl --user daemon-reload
systemctl --user enable --quiet yuzu-board.service
systemctl --user enable --quiet --now yuzu-update.timer yuzu-backup.timer
if [[ -s $DATA/homewall.db ]]; then
  systemctl --user restart yuzu-board.service
  echo "The Yuzu Board is up: http://$(hostname).local"
else
  echo "No database yet at $DATA/homewall.db: copy it there (docs/deploy.md), then"
  echo "  systemctl --user start yuzu-board"
fi
