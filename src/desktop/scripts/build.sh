#!/bin/sh
set -e

CONF="src-tauri/tauri.conf.json"
NEEDS_RESTORE=false

restore_config() {
  if [ "$NEEDS_RESTORE" = true ] && [ -f "$CONF.bak" ]; then
    mv "$CONF.bak" "$CONF"
  fi
}

trap restore_config EXIT

# If no signing key is set, temporarily disable updater artifact signing
if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
  sed -i.bak 's/"createUpdaterArtifacts": true/"createUpdaterArtifacts": false/' "$CONF"
  NEEDS_RESTORE=true
fi

tauri build "$@"
