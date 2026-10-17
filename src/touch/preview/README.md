# Native UI preview

The current scope is `/Alook#5620/future/#37#210`, `#212` and `#213`: existing human and BOT DMs share the original message-history and BOOT voice-confirmation flow. The full-client feature migration from `#195` is withdrawn. Do not add a contact picker, new-DM action, DM notifications, text-input page, keyboard or full-client message tools.

## Implementation plan

- [x] `firmware/touch/ownership.h`, `ui.h`, `ui.cpp`, `dm_ui.cpp`: add the existing-DM list and selection data, use the same text-free character page for people and BOTs, and show the actual full recipient in messages and voice confirmation. Keep the list refresh as its only bottom action.
- [x] `preview/build.py`, `render.cpp`: render the firmware widgets; check raw row-to-recipient mapping, refresh, absence of removed controls, current-recipient generation, history, retry, empty transcript and sending locks.
- [x] `preview/template.html`, `export.py`: use actual LVGL control rectangles for clickable sample navigation. Export the current native frame set, including the retained Profile, Nearby, Settings, authorization and failure pages.
- [ ] Independent review and final operation map: Madox reviews source and native samples; Jarvis owns the combined diagram. This is not device, API or voice-service acceptance.

The list distinguishes successful emptiness from failure. A failed read without cache shows only the error and refresh; a failed refresh with cache retains the last known rows. Native visible-text checks cover both paths and the successful empty response.

## Boundary

`UiData.dm_enabled` defaults to false for the original preview fixtures; `Application` enables the existing human/BOT DM contract. This preview does not run Application, authentication, real DM reads, microphone, BLE, models or a physical device. Current implementation scope is the r2 plan and its three explicitly approved integration repairs. UI evidence and real service/device evidence remain separate gates.

The host program compiles the actual LVGL firmware widgets, avatar artwork, generated Chinese font and Speaker assets. It exports 466 × 466 RGB565 frames; PNG export applies the physical circular boundary. All accounts, messages, relationships, presence, battery and login codes are samples. Presence in the sample is not evidence of the DM endpoint's actual status. Custom-photo regression fixtures use the existing Web landing asset.

## Current UI contract

Home keeps Speaker bubbles: DMs, Profile and More. DMs opens existing conversations, with current selection, activity order, unread and refresh. Selection opens that recipient's full-screen avatar. Horizontal swipes switch DMs; an upward swipe opens messages. Both people and BOT avatars have no text; online uses the approved soft green glow and offline has none. Names and real content remain verbatim; English is used for controls and sample content.

Chat uses continuous history. Its bottom-center arrow means the true latest messages, including from the bottom of an older bounded window. Permission to read and to send are separate. BOOT records for the current recipient; release transcribes; Review shows the full recipient and text; Send confirms. Record again waits for another BOOT press. Failed send keeps the same intent; no transcript disables Send. Sending locks Send, rerecord, discard and PWR. PWR returns selected-DM pages to its avatar, then opens Home from the avatar; without a selected DM it returns Home.

My profile keeps only received pending requests in canonical newest-first order. Closing a nearby card returns to the list and holds it for that Profile visit. The acceptance and discovery fixtures remain samples. Failed reads retain cached requests and cannot assert an empty list. More keeps Wi-Fi, Brightness, Update and Log out. Update shows current firmware and separate check/install states per `/Alook#5620/future/#37#214`; preview versions, progress and results are samples. Application's release checks and native OTA path require their own runtime validation. Log out requires its primary confirmation; its close icon keeps the account and returns to the avatar, or Home when there is no selected DM.

## Build and delivery

After the existing pinned dependency and asset setup:

```sh
python3 src/touch/tools/font.py
python3 src/touch/preview/build.py
python3 src/touch/preview/export.py
```

Host prerequisites are Clang, Python3, Pillow, pnpm and existing asset-tool dependencies. Generated output is ignored in `src/touch/build/preview/`. Current delivery uses `touch-*-v17.png`, `touch-preview-v17.html`, `touch-controls-v17.json`, an operation table and a native-page archive. The HTML embeds the PNGs and can open locally. Its navigation is a sample wrapper, not the firmware Application controller. Unprefixed original BOT frames are regression references; the `dm-*` frames show the expanded recipient scope.
