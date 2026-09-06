# Native OAuth mobile activation — Slice 3

## Scope and delivery contract

- Base: `origin/main@eed535647921e8fc7a0db51f9e1e2238affebc14`.
- Branch/worktree: `feat/native-oauth-mobile-slice-3` at `/Users/gener/Desktop/alookai/alook-worktrees/samara-native-oauth-mobile-slice-3`.
- Activate the already-merged native OAuth owner and WebView exchange on iOS and Android. Do not change the server protocol, browser social login, email OTP, or hosted association payloads.
- The primary mobile return is exactly `https://auth.alook.ai/auth/native/return`. The secondary, user-triggered mobile fallback is exactly `ai.alook://auth/native/return`. Desktop remains `ai.alook.desktop://auth/native/return`.
- This slice may create a first Draft PR after local gates. It must not deploy Cloudflare/DNS/TLS changes, release an app, upload to a store, or mutate production.
- The full provider-to-browser-to-installed-app chain and production HTTPS association remain release preflight. Local configuration and development-sign checks cannot claim that chain as PASS.

## Features / show case

1. iOS declares `applinks:auth.alook.ai` for the narrow native return path and registers `ai.alook` as a fallback scheme while retaining bundle ID `ai.alook.ios` and Apple team `5RF24VHDQB`.
2. Android declares an `android:autoVerify="true"` HTTPS App Link for `auth.alook.ai/auth/native/return`, plus a separate non-verified `ai.alook://auth/native/return` fallback, on the existing `singleTask` activity and package `ai.alook.android`.
3. Both mobile targets compile and register the same native OAuth commands, durable native store, deep-link intake, and system-browser opener already used by desktop. Mobile preparation reports `ios` or `android`; each build accepts only its mobile return identities.
4. Checked-in generated projects and release validation fail when mobile IDs, Apple team/entitlement, Android verified intent, fallback, signing fingerprint, or hosted association JSON drift apart.

## Designs overview

### Native ownership and least privilege

- Keep state, PKCE verifier, owner key, callback candidates, and persistence in the merged Rust owner. Move only the dependencies and module/plugin registration needed by iOS/Android from desktop-only target scope to common scope.
- Add a dedicated mobile capability for the existing native OAuth command ACL. It permits only the trusted `main` WebView at `https://alook.ai`, and still grants no raw deep-link events or store API.
- Desktop keeps single-instance registration ahead of deep-link registration. Mobile does not enable the desktop single-instance plugin; Android retains `launchMode="singleTask"` so hot links reach the existing activity.

### Exact callback identities

- Rust selects the platform from the compiled target; the WebView cannot choose it.
- Desktop accepts only `ai.alook.desktop://auth/native/return`.
- iOS and Android accept the primary `https://auth.alook.ai/auth/native/return` and secondary `ai.alook://auth/native/return` forms, with the existing exact, bounded query contract. Cross-platform schemes, other hosts/ports/paths, userinfo, fragments, duplicate/extra fields, and encoded aliases remain rejected.
- Opening either mobile link foregrounds the OS activity/application by platform behavior. Desktop alone uses its explicit show/unminimize/focus helper.

### Generated projects and release contract

- Tauri deep-link mobile configuration is the source of truth: one HTTPS app-link entry and one explicit non-app-link fallback entry. Re-run the checked-in iOS and Android generators and review their output.
- iOS release validation inspects the signed app entitlement, bundle ID, team application identifier, and fallback URL scheme. Android validation inspects the packaged manifest/App Link, package/version, and signer SHA-256 fingerprint.
- CI source-contract tests tie generated declarations to the hosted `APPLE_APP_SITE_ASSOCIATION` and `ANDROID_ASSET_LINKS` constants. The expected self-hosted Android release certificate remains `9D:C6:ED:E9:4B:A6:63:EE:C9:EC:98:FF:7B:AF:D5:5E:24:8B:6C:4B:C2:15:7F:CF:04:2D:F5:9B:0E:41:08:06`. A distinct Play App Signing fingerprint, if applicable, remains an external release prerequisite.

## New deps

- None.
- Existing `tauri-plugin-deep-link`, `tauri-plugin-store`, `base64`, `getrandom`, `sha2`, `subtle`, and `url` dependencies move from the desktop-only Cargo target table to common dependencies so the merged owner compiles on mobile.
- `tauri-plugin-single-instance` remains desktop-only.

## TODOs

- [x] Add exact mobile deep-link configuration, Apple team configuration, a least-privilege mobile native OAuth capability, and mobile dev scripts that merge the localhost-only development capability. Files: `src/desktop/package.json`, `src/desktop/src-tauri/tauri.conf.json`, `src/desktop/src-tauri/tauri.ios.conf.json`, `src/desktop/src-tauri/tauri.dev.conf.json`, `src/desktop/src-tauri/capabilities/native-oauth-mobile.json`.
- [x] Compile and register the merged native owner/runtime on mobile, preserve desktop plugin ordering, accept only platform-correct callbacks, and extend Rust tests. Files: `src/desktop/src-tauri/Cargo.toml`, `src/desktop/src-tauri/src/lib.rs`, `src/desktop/src-tauri/src/native_oauth.rs`, `src/desktop/src-tauri/src/native_oauth_runtime.rs`. `Cargo.lock` did not change because all packages were already locked.
- [x] Regenerate and review iOS/Android projects for the exact associated domain, custom scheme, verified intent, fallback intent, `singleTask`, bundle/package IDs, and signing settings. Changed generated files: `src/desktop/src-tauri/gen/apple/alook-desktop_iOS/alook-desktop_iOS.entitlements` and `src/desktop/src-tauri/gen/android/app/src/main/AndroidManifest.xml`.
- [x] Add focused mobile source/runtime contract coverage and preserve the desktop security contract. Files: `scripts/ci/native-oauth-mobile.test.ts`, `scripts/ci/native-oauth-desktop.test.ts`, `scripts/ci/workflow-contract.test.ts`.
- [x] Harden signed mobile artifact verification for bundle/package/team/entitlement/intent/fallback/fingerprint drift without uploading or releasing. File: `.github/workflows/mobile-release.yml`.
- [x] Run focused Rust/CI tests, mobile target builds available locally, then full repository typecheck, lint, test, typegrep, and knip gates. Exact outcomes and environment-only preflight gaps are below.
- [x] Update this plan and prepare the first normal commit/push/Draft handoff. The commit, push, and Draft creation are the final delivery actions after this audited snapshot; Git ownership then stops for Madox's independent QA.

## QA tests

- [x] Rust accepts mobile preparation for `ios` and `android`, rejects unknown platforms, and never exposes state/verifier/owner key in registration.
- [x] Desktop accepts only its desktop scheme; mobile accepts only exact HTTPS and fallback identities. Wrong scheme/host/port/path, userinfo, fragment, encoded key/value aliases, duplicate/extra fields, mixed code/status, and oversize callbacks are mutation-free.
- [x] Mobile registration includes native OAuth commands and plugins while raw event/store/deep-link guest permissions stay absent; desktop single-instance/deep-link/opener order remains unchanged.
- [x] iOS source and generated project agree on `ai.alook.ios`, `5RF24VHDQB`, `applinks:auth.alook.ai`, `/auth/native/return`, and fallback `ai.alook`.
- [x] Android source and generated manifest agree on `ai.alook.android`, `singleTask`, exact HTTPS `autoVerify` link, and separate non-verified fallback.
- [x] Hosted AASA/assetlinks constants agree with native IDs/team/host/path and the self-hosted release fingerprint; no `link.alook.ai` residue exists in the slice.
- [x] Signed-artifact workflow checks the exact iOS entitlement/application identifier/fallback arrays and exact Android packaged intent-filter structures/signer fingerprint before artifact publication.
- [x] Local iOS simulator/dev-sign and Android build/manifest checks completed. Results are labeled local only; production association/provider behavior remains unverified until release preflight.

## Results

- Implemented the exact `auth.alook.ai` HTTPS return and the mobile-only `ai.alook` fallback without changing the hosted worker protocol, browser social login, or OTP paths. Desktop keeps its distinct `ai.alook.desktop` callback.
- Moved only the already-used native OAuth dependencies and deep-link/store registration into the common mobile build. Mobile receives the existing command handler, durable owner setup, and listener retirement; desktop alone retains single-instance and explicit window foregrounding.
- Generated iOS now carries `applinks:auth.alook.ai`; generated Android carries exactly two deep-link filters on the existing `singleTask` activity. Production capabilities expose only `native-oauth` to the trusted `https://alook.ai` main WebView. The iOS/Android dev scripts explicitly merge the localhost-only development capability.
- Release workflow validation now reads the signed iOS plists and the packaged Android manifest structurally, then cross-checks the hosted worker source and self-hosted Android signing fingerprint before artifact publication.

### Local QA evidence

- `cargo fmt --check`: PASS.
- `cargo test --lib`: PASS, 66/66.
- Focused CI contracts: PASS, 3 files and 64/64 tests.
- `actionlint .github/workflows/mobile-release.yml` and `git diff --check`: PASS.
- `pnpm tauri ios init --ci --skip-targets-install`: PASS with `APPLE_DEVELOPMENT_TEAM=5RF24VHDQB`.
- `pnpm tauri android init --ci --skip-targets-install`: PASS.
- `pnpm --dir src/desktop tauri ios build --debug --target aarch64-sim --ci`: PASS; local simulator bundle at `src/desktop/src-tauri/gen/apple/build/arm64-sim/Alook.app`. Its Info.plist has the exact bundle ID and fallback array. Simulator signing is local/ad hoc and therefore is not evidence for the production entitlement/provider chain.
- `pnpm --dir src/desktop tauri android build --debug --apk --target aarch64 --ci`: PASS; local debug APK at `src/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`. An `aapt dump xmltree` structural check passed for `singleTask`, the exact verified HTTPS filter, and the exact separate fallback.
- `pnpm typecheck`: PASS, 11/11 tasks.
- `pnpm lint`: PASS, 5/5 tasks.
- `pnpm test`: PASS. The changed web suite passed 7,102/7,102; agent-driver passed 721 with 4 skipped; CI scripts passed 221/221; all other package suites were green from the shared worktree cache. Existing React test-renderer/act warnings remain tracked by the separate queued harness task.
- `pnpm typegrep:ws`: PASS.
- `pnpm typegrep:agent-driver`: PASS.
- `pnpm knip`: PASS, 8/8 tasks; existing configuration hints only.

### Release-only preflight

- No Cloudflare, DNS, TLS, hosted association payload, store, deployment, release, or production configuration was mutated.
- The production provider-to-browser-to-installed-app chain, Apple-signed associated-domain entitlement, live AASA/assetlinks retrieval and cache behavior, and any distinct Play App Signing fingerprint remain explicitly unverified. They must be checked during release preflight and are not claimed as PASS here.
- Branch/base at implementation start: `feat/native-oauth-mobile-slice-3` from `origin/main@eed535647921e8fc7a0db51f9e1e2238affebc14`.
