#!/bin/sh
set -e

if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
  exec tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}' "$@"
fi

exec tauri build "$@"
