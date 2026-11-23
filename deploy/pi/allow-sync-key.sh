#!/usr/bin/env bash
# Lets the Mac's sync job (deploy/mac/install.sh) in with its own key, which
# can only read ~/yuzu-data: rrsync read-only, no shell, no forwarding.
#   allow-sync-key.sh "ssh-ed25519 AAAA... yuzu-sync"
set -euo pipefail
key=${1:?the public key to allow}
[[ $key == ssh-* ]] || { echo "Not a public key: $key" >&2; exit 1; }
mkdir -p ~/.ssh
chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
if ! grep -qF "$key" ~/.ssh/authorized_keys; then
  echo "command=\"rrsync -ro $HOME/yuzu-data\",restrict $key" >> ~/.ssh/authorized_keys
  echo "The sync key may now read $HOME/yuzu-data."
fi
