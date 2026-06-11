#!/bin/sh
set -e

CONF="src-tauri/tauri.conf.json"
NEEDS_RESTORE=false

# If no signing key is set, temporarily disable updater artifact signing
if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
  sed -i.bak 's/"createUpdaterArtifacts": true/"createUpdaterArtifacts": false/' "$CONF"
  NEEDS_RESTORE=true
fi

tauri build "$@"
EXIT_CODE=$?

if [ "$NEEDS_RESTORE" = true ]; then
  mv "$CONF.bak" "$CONF"
fi

exit $EXIT_CODE
