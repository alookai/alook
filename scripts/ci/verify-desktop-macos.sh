#!/usr/bin/env bash
set -euo pipefail

: "${STAGE_DIR:?STAGE_DIR is required}"
: "${EXPECTED_TARGET:?EXPECTED_TARGET is required}"
: "${EXPECTED_VERSION:?EXPECTED_VERSION is required}"
: "${EXPECTED_TEAM_ID:?EXPECTED_TEAM_ID is required}"
: "${EXPECTED_SIGNING_IDENTITY:?EXPECTED_SIGNING_IDENTITY is required}"

case "$EXPECTED_TARGET" in
  aarch64-apple-darwin)
    stage_target="macos-aarch64"
    release_arch="aarch64"
    binary_arch="arm64"
    ;;
  x86_64-apple-darwin)
    stage_target="macos-x86_64"
    release_arch="x64"
    binary_arch="x86_64"
    ;;
  *)
    echo "Unsupported macOS target: $EXPECTED_TARGET" >&2
    exit 1
    ;;
esac

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
stage_dir=$(cd "$STAGE_DIR" && pwd)
dmg="$stage_dir/files/Alook_${EXPECTED_VERSION}_${release_arch}.dmg"
archive="$stage_dir/files/Alook_${EXPECTED_VERSION}_${release_arch}.app.tar.gz"
archive_signature="${archive}.sig"

node "$repository_root/scripts/ci/desktop-release-artifacts.mjs" validate \
  --target "$stage_target" --version "$EXPECTED_VERSION" --stage "$stage_dir"
node "$repository_root/scripts/ci/verify-minisign.mjs" \
  --file "$archive" --signature "$archive_signature" \
  --config "$repository_root/src/desktop/src-tauri/tauri.conf.json" \
  --version "$EXPECTED_VERSION" --trusted-file "Alook.app.tar.gz"

work_dir=$(mktemp -d "$RUNNER_TEMP/alook-macos-verify.XXXXXX")
mount_dir="$work_dir/dmg"
archive_dir="$work_dir/archive"
mkdir "$mount_dir" "$archive_dir"
mounted=0
cleanup() {
  if [[ "$mounted" == 1 ]]; then hdiutil detach "$mount_dir" -quiet || true; fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

assert_app() {
  local app_path=$1
  local label=$2
  local signature entitlements executable architectures version identifier

  codesign --verify --deep --strict --verbose=2 "$app_path"
  signature=$(codesign -dvvv "$app_path" 2>&1)
  grep -Fq "Identifier=ai.alook.desktop" <<<"$signature"
  grep -Fq "TeamIdentifier=${EXPECTED_TEAM_ID}" <<<"$signature"
  grep -Fq "Authority=${EXPECTED_SIGNING_IDENTITY}" <<<"$signature"
  grep -Eq 'flags=.*runtime' <<<"$signature"
  grep -Eq '^Timestamp=.+$' <<<"$signature"
  if grep -Eq '^Timestamp=(none|)$' <<<"$signature"; then
    echo "$label is missing a secure timestamp" >&2
    return 1
  fi

  entitlements="$work_dir/${label}.entitlements.plist"
  codesign -d --entitlements :- "$app_path" >"$entitlements" 2>/dev/null
  if value=$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.get-task-allow' "$entitlements" 2>/dev/null); then
    [[ "$value" != "true" ]] || { echo "$label enables get-task-allow" >&2; return 1; }
  fi

  version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_path/Contents/Info.plist")
  identifier=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Contents/Info.plist")
  [[ "$version" == "$EXPECTED_VERSION" ]]
  [[ "$identifier" == "ai.alook.desktop" ]]

  executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Contents/Info.plist")
  architectures=$(lipo -archs "$app_path/Contents/MacOS/$executable")
  [[ "$architectures" == "$binary_arch" ]] || { echo "$label has unexpected architecture: $architectures" >&2; return 1; }

  xcrun stapler validate "$app_path"
  spctl --assess --type execute --verbose=4 "$app_path"
}

xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_dir" -quiet
mounted=1
dmg_apps=("$mount_dir"/*.app)
[[ ${#dmg_apps[@]} -eq 1 && -d "${dmg_apps[0]}" ]] || { echo "DMG must contain exactly one top-level app" >&2; exit 1; }
assert_app "${dmg_apps[0]}" "dmg-app"
hdiutil detach "$mount_dir" -quiet
mounted=0

while IFS= read -r member; do
  [[ "$member" != /* && "$member" != ".." && "$member" != ../* && "$member" != */../* ]] || {
    echo "Updater archive contains an unsafe path: $member" >&2
    exit 1
  }
done < <(tar -tzf "$archive")
tar -xzf "$archive" -C "$archive_dir"
archive_apps=("$archive_dir"/*.app)
[[ ${#archive_apps[@]} -eq 1 && -d "${archive_apps[0]}" ]] || { echo "Updater archive must contain exactly one top-level app" >&2; exit 1; }
assert_app "${archive_apps[0]}" "updater-app"

echo "Verified staged macOS DMG and updater app for $EXPECTED_TARGET."
