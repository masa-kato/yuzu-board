#!/usr/bin/env bash
# Keeps the Pi at http://<hostname>.local (docs/deploy.md), every minute on
# yuzu-name.timer. As the Wi-Fi comes up at boot, avahi can hear an echo of
# its own announcement, decide the name is taken, and move the Pi to
# <hostname>-2.local for good, so the phones lose the app. This takes the name
# back; users in the netdev group may, without sudo.
set -euo pipefail

AVAHI=(org.freedesktop.Avahi / org.freedesktop.Avahi.Server)
want=$(hostname)
have=$(busctl call "${AVAHI[@]}" GetHostName | sed -E 's/^s "(.*)"$/\1/')
state=$(busctl call "${AVAHI[@]}" GetState | awk '{ print $2 }')
# Only once it's done announcing (2, running): renaming it before then can
# crash avahi 0.8. The next minute's run gets it.
if [[ $have != "$want" && $state == 2 ]]; then
  echo "Avahi had the Pi as $have.local, so taking back $want.local"
  busctl call "${AVAHI[@]}" SetHostName s "$want"
fi
