#!/bin/sh
set -eu
plugin_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/alook-file-save-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
mkdir -p "$test_dir/Sources/FileSaveCopyCore" "$test_dir/Tests/FileSaveCopyTests"
cp "$plugin_dir/ios/Sources/FileSaveCopy.swift" "$test_dir/Sources/FileSaveCopyCore/"
cp "$plugin_dir/ios/Tests/FileSaveCopyTests.swift" "$test_dir/Tests/FileSaveCopyTests/"
cat > "$test_dir/Package.swift" <<'PACKAGE'
// swift-tools-version:5.3
import PackageDescription
let package = Package(name: "FileSaveCopyCore", platforms: [.macOS(.v11)], targets: [.target(name: "FileSaveCopyCore"), .testTarget(name: "FileSaveCopyTests", dependencies: ["FileSaveCopyCore"])])
PACKAGE
swift test --package-path "$test_dir"
