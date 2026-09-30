# Alook GTM · v8

## Current sound export (2026-09-28)
`out/alook-clean-with-audio.mp4`: 99.167s / 2975 frames, 1080p30; identical picture stream to `alook-clean-milo-direct.mp4`. Dirty Thinkin at original speed, one 16-second musical repeat (48s back to 32s) to fit the longer picture, approved natural coda moved to 95.633–98.683s. No voiceover. Opening SFX rebuilt for the single relay; later cues shifted across three cards. Export: `python3 scripts/mix-clean-audio.py`. QA report: `out/clean-audio-qa.json`; decoded frame count, picture hash, cue bounds, unclipped audio and silent final tail pass (AAC peak −3.38 dBFS). Prior approved music film preserved.

## Current picture review (2026-09-27)
Composition: `AlookCleanReview`; output: `out/alook-clean-milo-direct.mp4`.
99.167s / 2975 frames. The approved 15.8s opening replaces the old 11.1s opening. Former demo headers and their shrink/offset wrapper are removed. PPT first page states the problem: “My team needs my agent sometimes” (#878).
Three 2.6s orange full-screen cards use two lines and the approved opening motion: “Your local agent / Now on Alook”, “Same bot / In every room”, and “Many bots / One place”. Emphasis: local + Alook, every room, Many bots. All full-screen cards, including the opening, omit sentence-ending punctuation (#873). The import card starts directly after the Milo profile hold; the 20-frame page switch runs underneath the opaque card, so server UI never flashes before it (#876–877).
Silent picture review; the approved music film `out/alook-gtm-final.mp4` is preserved. Music/SFX has not been rebuilt for the new timeline.
Build with `npm run build`, then `npx remotion render build AlookCleanReview out/alook-clean-milo-direct.mp4 --concurrency=1 --timeout=120000`.
Checks: `npm run typecheck`, `node scripts/test-clean-review.cjs`, `node scripts/test-first-deck.cjs`.

## Setup

From the monorepo, install its normal pnpm dependencies first. This project has an independent npm lockfile:

```sh
cd src/videos/gtm
npm ci
npm run prepare:assets
python3 -m venv /tmp/alook-gtm-tts
/tmp/alook-gtm-tts/bin/pip install edge-tts==7.2.8
/tmp/alook-gtm-tts/bin/python scripts/narrate.py
npm run dev
```

Narration uses `en-US-JennyNeural` at −4%. `src/narration.json` holds the approved voiceover and placement; `src/voice-timing.json` records the generated take durations. Replacing a voice requires regenerating timings and checking corresponding visuals.

## Build and render

```sh
npm run build
npm run verify
npx tsc --noEmit
npm run render
```

Output: `out/alook-gtm-v8.mp4`. Assets, audio, bundles, screenshots and rendered video are ignored by Git. Set `REMOTION_BROWSER_EXECUTABLE` for `scripts/preview.mjs`, or pass `--browser-executable` to the Remotion CLI when using a locally installed Chromium.

## Product fidelity

`src/Product.tsx` imports actual web components: Shell, ServerRail, ChannelSidebarTreeOwner, ChannelHeader, DmSidebar, DmHeader, Message, UserBar and the current generated avatar renderer. Fixture data uses the web preview profile provider. Web code has no dependency on video tooling.

`scripts/prepare.mjs` compiles the real product Tailwind stylesheet and copies canonical logo/fonts. Messages are enlarged for video legibility. Framework adapters replace Next navigation/image wrappers inside the renderer only; no live account or API is used. The fictional Fieldnotes page is demonstration content, not an Alook screen.

## Story timing

| Seconds | Action |
| --- | --- |
| 0–12 | Lin relays Alex’s requests to local Codex; writing is interrupted |
| 12–29 | Existing local agent becomes Milo and joins the conversation |
| 29–40 | Alex asks Milo directly; Lin finishes the draft |
| 40–54 | Local Claude Code becomes Nova; page and copy work divide |
| 54–65 | Lin gives Milo a sharing boundary in DM, then works in Studio |
| 65–74 | Same Milo answers Sam in Home |
| 74–84 | Alex’s payoff; nine agents expand from one local computer |
| 84–92 | Canonical Alook logo, exact slogan, Start sharing / alook.ai |

## QA

`npm run verify` checks audio placement/assets, total timeline, nine-agent count, slogan and sharing-boundary invariants. Use the final encoded MP4 for visual QA, including mid-transition frames and latest-message visibility. `scripts/preview.mjs` is a development aid, not a replacement for final-video frame extraction.

## Earlier acts 2–3 review (2026-09-16)
The current composition is 78.5 seconds. Its second/third-act review starts at frame 360 and lasts 66.5 seconds; the return to Notes is removed. Third act starts at 00:33.5 in this review. The Alook window stays at its existing position/scale across the join.

```sh
npx remotion render AlookGTM out/alook-acts2-3-trimmed.mp4 --frames=360-2354 --codec=h264 --crf=18 --concurrency=2 --muted
python3 scripts/verify-composer-video.py
```

This review uses English burned captions, without narration. Composer caret CSS is scoped to the video: synthetic caret stays outside inline layout, and the ProseMirror trailing break cannot create an extra line before it.

## Click closeups revision
Current review: `out/alook-acts2-3-click-closeups.mp4`, same 66.5-second second/third-act cut. Camera maintains 1.55–1.75× closeups; Dock, Import, Invite and each invitation row receive a held closeup before the click. No full-scene resets in these acts.

Render with the preceding command, replacing the output filename; run `python3 scripts/verify-composer-video.py out/alook-acts2-3-click-closeups.mp4`.

## Author badge review
`out/alook-acts2-3-author-badges.mp4` adds a ghost badge between each author name and timestamp. Human participants show Human; agents show canonical backend icon and label. The video-only `VideoMessage.tsx` adapter reuses the product Message, Badge and ProviderLogo components; no product files change.

Latest review: `out/alook-acts2-3-tinted-tags.mp4` (66.5s, 1080p, muted). Author badges use translucent tinted backgrounds with small rectangular corners, following the Notion-tag direction; supersedes fully transparent badges.

Latest combined review: `out/alook-acts2-3-unified-badges-zoom.mp4`. Shared IdentityBadge in messages and both Invite lists; clearly distinct gray/green/orange/blue/purple translucent fills. Composer camera 1.9x with matching 1.824x mention popup; 66.5s/1080p/muted.

## Current paced review
`out/alook-acts2-3-paced-large-input.mp4`: 41 seconds, 1080p, muted, English on-screen captions. The full composition is 53 seconds. `src/review-timing.ts` maps source actions, captions and camera onto shorter per-scene durations; the Notes return remains removed. Invite segments and dialogue waits are shortened. Composer closeup is 2.45x; mention popup matches at 2.352x and stays fully in frame.

```sh
npx remotion render AlookGTM out/alook-acts2-3-paced-large-input.mp4 --frames=360-1589 --codec=h264 --crf=18 --concurrency=2 --muted
python3 scripts/verify-composer-video.py
```

The old narration placement is not retimed for this muted review. Encoded-frame QA samples both typing intervals, Invite, dialogue and the actual last frame.

## Current action-closeup review
`out/alook-acts2-3-action-closeups.mp4` keeps the 41s pacing and approved 2.45x typing view. Import/Milo reveal is 2.5x, Dock/add-member clicks 2.3x, Invite rows 2.1x, conversations 2.15x. Act-two camera follows new message positions; author avatars and the longest message remain in-frame. Same render range 360–1589.

## Acts 3–4 review
`out/alook-acts3-4-continuous.mp4`: 44s, 1080p, muted, English captions. Render range 990–2309 (composition33–77s). Act4 starts20s into review. Same MacBook and product surface: Studio completion → Milo DM sharing boundary → Studio demo context → Home question/answer. Product DM/Home accept scoped fixture messages; canonical Milo avatar persists. Camera follows rail controls with held click targets and closeup messages; no fades. `python3 scripts/verify-acts34.py` validates encoded duration/resolution, typing stability and extracts transition/final frames.

## Current acts 3–4 schedule revision
`out/alook-acts3-4-meeting-schedule.mp4`:36s, frames990–2069. Act4 begins20s. Supersedes the DM-boundary cut: Alex shares2:00–2:30 PM Google Meet in Studio, Lin joins, then the Home exchange gives the meeting schedule and when Lin is free. Meet URL is a fictional demonstration fixture. No DM detour. `python3 scripts/verify-acts34.py` checks the current artifact.

## Current stable join / readable server switch
`out/alook-acts3-4-readable-switch.mp4`:40s, frames990–2189. Product frame capture waits for fonts, portal badges and scroll-layout commit; prior36s export jumped approximately50px at20.0 and20.133s. Regression measures all33 frames19.5–20.567s. Home rail closeup holds0.9s before switching and2s after; camera then moves to family dialogue. Same meeting story, no DM. Current verifier: `python3 scripts/verify-acts34.py`.

## Current copy/paste opening
`out/alook-copy-paste-full.mp4`:81s,1080p,muted. `out/alook-copy-paste-opening.mp4`:first26s including Alook import. First act is20s: Alex request → right-click Copy → Codex right-click Paste → identical complete request → Send. Later acts retain their prior source pacing, shifted8s in composition time. Human avatars are approved lifestyle photos; Home uses the cat image; no Human badges.

Validate the full artifact with `python3 scripts/verify-opening.py`. Acts3–4 now start at41s (render frames1230–2429); existing `verify-acts34.py` takes the standalone40s cut.

Latest review after Tiff feedback: `out/alook-repeat-relay-opening.mp4` (26s) and `out/alook-repeat-relay-full.mp4` (81s). Three rounds of exact-text Copy/Paste/Send, accelerating after the first; captions split at the first app switch. Shared relay state: `src/opening-relay.ts`.

Current wide-import revision: `out/alook-wide-import-opening.mp4` (28s), `out/alook-wide-import-full.mp4` (81s), muted. Keep1.05x wide view through suction source17.1, then zoom to2.5x Milo closeup by18.2; birth17.35–18.3. Codex remains above import during suction.

## Current centered computer and Introducing review (2026-09-20)
The current 112s review timeline is exported only as two silent 1080p/30fps excerpts. All full-computer shots share a 1.16x centered camera; closeup action targets are preserved. First-act PPT transition adds a second slide, types Introducing…, drags the canonical Dock icon into the slide, and composes the logo with Caveat Alook lettering.

```sh
npm run typecheck
npm run build
npx remotion render AlookGTM out/alook-acts12-dock-logic.mp4 --frames=0-1844 --muted --codec=h264 --crf=18 --concurrency=2
npx remotion render AlookGTM out/alook-acts45-story-order.mp4 --frames=1845-3359 --muted --codec=h264 --crf=18 --concurrency=2
```

Acts 1–2: 61.5 seconds. Acts 4–5: 50.5 seconds; this revision includes Sam’s birthday-dinner request, Milo’s meeting reply, and an animated yellow remembered note beside his identity. Inspect encoded pickup, drag, drop, final brand lockup, import, invite, messages, and final encoded frame. Earlier verification scripts target historical artifacts and durations, not this timeline.

Document-window removal (#234): the opening starts in Codex; the obsolete Launch announcement/Notes window is removed from every Mac scene. PPT title pages and subsequent camera timings are retained. Current first excerpt is `out/alook-acts12-dock-logic.mp4` (61.5s).

PPT transitions (#238) use continuous opposing window motion without an app-switcher overlay. The memory mock (#236) follows the product BotMarkSticker yellow paper, Caveat heading and Marks icon; an avatar check and saved request indicate remembering. Video-only adapters leave product components unchanged.

Dock and story correction (#241/#243/#245): dedicated Keynote icon opens PPT after an explicit click; Codex/Alook return clicks target their own icons. Act 4 starts with the design-review meeting. After the meeting, Lin identifies missing invitation email, code review and tests, invites the matching bots, and assigns those tasks. The final ready message follows their completed work.

## Acts 3–4 continuous review (#250)
`out/alook-acts34-continuous-story.mp4`: 30.5s, silent 1080p/30fps. Composition51–81.5s; fourth act begins at10.5s. The same invitation transcript and camera persist at the boundary; Alex’s meeting appears0.8s later, then Lin joins and the camera moves to Home.

```sh
npx remotion render AlookGTM out/alook-acts34-continuous-story.mp4 --frames=1530-2444 --muted --codec=h264 --crf=18 --concurrency=2
```

Shared initial transcript lives in `src/meeting-story.ts` and is reused by MacOpening, FourthAct and ThirdAct. Boundary stills at61.4667/61.5 match exactly across the upper1920×930 product/camera region; only the caption changes. Earlier #247 exports predate this corrected boundary.

Verification command: `/opt/homebrew/bin/python3 scripts/verify-continuous-acts34.py` (requires Pillow/ffmpeg). Checks stream metadata and encoded boundary continuity, extracts12 timestamped QA frames including the final frame.

## Standalone end-card review (#255)
`out/alook-end-card-review.mp4`: 7.5s, silent1920×1080/30fps; separate `AlookEndCard` composition. Starts from the last collaboration view, slides a cream brand sheet upward, and holds canonical logo/Caveat wordmark, exact slogan, Start sharing, alook.ai and github.com/alookai/alook. Does not alter the approved story composition.

```sh
npx remotion render AlookEndCard out/alook-end-card-review.mp4 --muted --codec=h264 --crf=18 --concurrency=2
```

## Sequential end-card revision (#260)
Supersedes the combined card. `out/alook-end-card-sequential.mp4`:16s,480frames, silent1080p/30fps. 0–1.35s move from final collaboration into centered official animation;1.35–6.35s original five-second animation;6.45–7.55s logo shifts left and Caveat Alook reveals;8.6–11.5s standalone slogan;11.7–16s standalone Start sharing and website/GitHub destinations.

`src/official-logo-animation.tsx` is an unchanged byte-for-byte copy of `/Users/gustavoye/Desktop/alook-logo-motion-video/src/Composition.tsx` (approved official animation). Its original60fps frame timeline is sampled explicitly at60 frames per second within the30fps end-card composition. Source animation, expressions and three-orbit merge are unchanged.

```sh
npx remotion render AlookEndCard out/alook-end-card-sequential.mp4 --muted --codec=h264 --crf=18 --concurrency=2
```

CTA focus revision (#263): `out/alook-end-card-website-focus.mp4` (16s). alook.ai is the main CTA; Start sharing is a smaller lead-in; repository is secondary with the same GitHub SVG used by the marketing page. Previous sequential preview is superseded.

Latest end-card revision (#266): `out/alook-end-card-closing-laptop.mp4` (18s,silent1080p/30fps). Official animation/wordmark/slogan play inside minimal preview on3D laptop. Lid closes10.8–13.2s; view rotates front→top and approaches11.2–14.5s; exterior carries primary alook.ai and secondary GitHub icon/repository. Source: ClosingLaptop.tsx, EndCard.tsx, Root.tsx. Render with AlookEndCard composition; earlier flat end-card artifacts superseded.

## Shared story/ending laptop (#269/#271)
Current `AlookGTM` is132.2s:112s story plus20.2s connected ending. `AlookEndCard` is the standalone20.2s continuation. Every MacOpening scene uses ClosingLaptop with the original screen coordinates preserved. The front view prioritizes the display and exposes a narrow keyboard strip. At112s the last collaboration pose is retained; the camera pulls back, a minimal preview slides over that same desktop, then the same lid closes and reveals the exterior CTA.

Latest review: `out/alook-act5-to-ending-shared-laptop.mp4` (40.2s, silent1080p/30fps). Review starts at story92s; ending starts20s into review.

```sh
npx remotion render AlookGTM out/alook-act5-to-ending-shared-laptop.mp4 --frames=2760-3965 --muted --codec=h264 --crf=18 --concurrency=2
/opt/homebrew/bin/python3 scripts/verify-shared-laptop.py
```

Typecheck/build and earlier Dock/import/dialogue still regressions checked. Raw boundary screenshots at111.9667/112s have identical product/camera pixels. Validator checks metadata, encoded join continuity and extracts16 samples including finalframe1205. Earlier laptop preview files use superseded geometry.

Latest base-depth correction (#274): `out/alook-ending-laptop-depth.mp4` (22.2s, frames3300–3965 of AlookGTM). Keyboard and palmrest regain visible depth,18px front edge, compensated6.5° body/lid angle preserves front screen. Same story/ending model. Typecheck/render and12 encoded samples checked; previous thin-base review superseded.

## Full pruning pass (#279)
Current full composition:82.9s (71.5s story +11.4s ending), reduced from132.2s by49.3s/37.3%. Latest output `out/alook-full-pruned.mp4`,2487frames, silent1080p/30fps. Retimed idle beats/PPT/input/transition segments; opening relay10s, firstPPT10.8s, import4.8s, invites3.6s, introtyping2.2s, directmessages5s, meeting/family13.5s, secondPPT6.2s, multi-invite4.8s, assignmenttyping2.6s, collaboration8s. Key message reading time retained.

Typing is linear and continuous. Official logo motion plays in2.5s and begins lateral movement/revealing Caveat at its halfway point; source artwork unchanged. Shared laptop depth and exterior website/GitHub CTA remain. Ending pullback/preview/close sequence is compressed; finalCTA holds2.5s. Narration has not been retimed; this is a silent visual review.

```sh
npm run typecheck
node scripts/test-slide-typing.cjs
node scripts/test-pruned-timing.cjs
npx remotion render AlookGTM out/alook-full-pruned.mp4 --muted --codec=h264 --crf=18 --concurrency=2
/opt/homebrew/bin/python3 scripts/verify-pruned-film.py
```

Earlier durations/frame ranges and artifacts above are historical, superseded by this pacing pass.

Latest revision (#282): first What-if question reading hold extended by1s; full film83.9s. Output: src/videos/gtm/out/alook-full-pruned-hold.mp4.

Latest revision (#286): fast PPT Dock clicks without target zoom/idle; direct second slide without Add Slide click. Full film77.7s/2331frames, story66.3s. What-if hold remains1.7s. Output: out/alook-full-fast-ppt.mp4 (relative to gtm).

Latest revision (#289): corrected by #291/#292: invitation stays4.8s, assignment typing1.6s; collaboration messages8→4.8s. Full73.5s/2205frames. Output: src/videos/gtm/out/alook-full-fast-dialogue.mp4.

Latest #291–293: invitation retained4.8s; assignment1.6s; collaboration messages4.8s. Shared0.42s upward message entrance with slight overshoot and smooth list scroll, measured in playback seconds despite scene acceleration. Full73.5s/2205frames, out/alook-full-message-motion.mp4. Tests: scripts/test-message-motion.cjs plus timing/typing checks.

Latest #296/#297: family scene now Sam asks Lin about Mom’s birthday dinner → Lin delegates to Milo with six people/Saturday7/Italian → Milo accepts and remembers details. Meeting setup and follow-on meeting references removed; Home camera revised. Final lid CTA uses plain alook.ai without arrow. Duration73.5s, out/alook-family-planning.mp4. Story checks: scripts/test-family-story.cjs.

## Launch narrative review (#306)
Separate `AlookLaunchReview` composition:73.5s,1080p/30fps,silent. `out/alook-launch-review.mp4`. Editorial panels replace the two PPT intervals; short kinetic headings explain relay/import/direct access/Home/teamwork. Product framing makes room for each heading. Existing `AlookGTM`, invitation timing, approved assets and ending remain available.

Render: `npx remotion render AlookLaunchReview out/alook-launch-review.mp4 --muted --codec=h264 --crf=18 --concurrency=2`.
Validation: `node scripts/test-launch-beats.cjs`, existing message/typing/family/timing checks, `npm run typecheck`, `python3 scripts/verify-launch-review.py`. Encoded samples: `out/launch-qa/`.

## PPT transition restoration (#315)
`AlookLaunchReview` now restores both original PPT window transitions and original continuous Film playback. Explanatory headings above the computer remain. Fullscreen editorial panels removed. Output: `out/alook-launch-ppt-restored.mp4`, 73.5s silent 1080p/30fps.
Render: `npx remotion render AlookLaunchReview out/alook-launch-ppt-restored.mp4 --muted --codec=h264 --crf=18 --concurrency=2`.
QA: `python3 scripts/verify-launch-review.py out/alook-launch-ppt-restored.mp4 out/ppt-restored-qa`.

## Family memory focus (#318)
Output: `out/alook-memory-focus.mp4`, AlookLaunchReview, 73.5s silent 1080p/30fps. Early family conversation shortened from6.4s to4.4s; note reveal at38.8s, Remembered at40s, closeup held through44s. Note camera targets940/520 at2.8x. Explanation heading follows38.8–44.3s. Later PPT, invitation and ending timing unchanged.
Verification: existing timing/story/motion/typing/launch tests; `python3 scripts/verify-launch-review.py out/alook-memory-focus.mp4 out/memory-focus-qa`.

## Stable family excerpt (#321)
`out/alook-family-stable.mp4`:9.2s, frames1008–1283 of AlookLaunchReview. Shared heading space avoids repeated framing changes; family chat holds the same camera, one move to the memory card, Remembered holds1s. Thanks tail shortened. Full timeline now69.2s; only the requested excerpt exported.

## Family cadence matched to work (#326)
`out/alook-family-matched.mp4`:262frames/8.733s, frames1008–1269 of AlookLaunchReview. Sam→Lin→Milo arrivals use29/56frame gaps, identical to work Lin→Alex→Milo. Stable camera and1s Remembered hold preserved. Full timeline2062frames/68.733s; only excerpt exported. Timing regression explicitly compares arrival frames.

## Logo-orange laptop (#329)
Shared ClosingLaptop chassis/lid/palmrest/trackpad use canonical logo orange #FF9915 with warm highlights and shadows. Dark keyboard and inner display bezel preserved. Output `out/alook-orange-laptop.mp4`: latest matched-family full composition,2062frames/68.733s, silent1080p/30fps.

## Approved B muted orange (#335)
Shared shell base #C88445 with restrained highlights/shadows. Supersedes bright logo-orange exterior. Output `out/alook-muted-orange.mp4`,68.733s/2062frames, current full edit.

Latest #335/#337 deliverable: `out/alook-muted-orange-clean-titles.mp4`, B#C88445 exterior and no decorative title underlines.68.733s/2062frames.

## A soft amber (#340)
Owner revised selection to A#D49A56. Shared shell and restrained shading updated; text-only headings and timing retained. Latest output: `out/alook-soft-amber.mp4`,2062frames/68.733s.

## Fullscreen lid CTA (#343)
ClosingLaptop zoom begins with closure and reaches1.6x as orbit finishes. Amber lid exceeds full frame; CTA remains centered. Ending-only output `out/alook-ending-fullscreen-lid.mp4`,11.4s/342frames.

## Approved sound version (2026-09-21)

`AlookLaunchReview` includes `public/sfx/launch-sfx.wav`:41 frame-indexed cues from the seven owner-selected sounds. Sources and licensing: `public/sfx/SOURCES.md`; editable mixing schedule: `scripts/mix-sfx.py`; generated cue report: `public/sfx/cues.json`. Assets remain local generated media in ignored `public/`.

Rebuild with `python3 scripts/mix-sfx.py`, then render:

```sh
python3 scripts/render-sfx.py
```

Current source duration2608 frames at30fps (86.933s); opening and social-ending excerpts have been exported, not a new full movie. Preserves approved soft amber/fullscreen closing lid. To export silent, add `--muted`.

The render script muxes the WAV through ffmpeg to avoid the observed43ms AAC offset in direct Remotion output, then verifies all cues and the lid impact. Studio still previews the same WAV.

Provider revision (2026-09-21): second PPT shows Codex/Claude Code/OpenCode/Cursor with staggered slide-in. Later relay segment extends130→175frames (+1.5s), with later headings/audio shifted accordingly. `node scripts/test-provider-slide.cjs` covers provider list and motion.

Codex clarity revision: after first send, source6.5–6.85 has70frames for camera move, streamed reply and reading hold. Codex identity/local runtime explicitly visible; import heading identifies the same Codex agent. `node scripts/test-relay-reply.cjs` verifies streaming and request/response order.

Current review: `out/alook-opening-provider-question.mp4`,40.1s/1203frames. Rebuild: `python3 scripts/render-opening.py`. First PPT rotates Codex→Claude Code→Cursor→local agent by typing/deleting, with keyboard only during active input. Import headline restored to “Your local agent. Now on Alook.” Second PPT title dominates with two small rows of named bot badges; preview `out/more-bots-two-rows.png`. Previous full movies are historical renders.

Typography revision #412–414: first provider names use dark-green Caveat; second slide keeps “Bring more bots to collaborate.” on one line, with four small backend-name-only badges in a single bottom row. Current layout PNG:`out/more-bots-compact.png`. Rebuild opening via render-opening.py; duration unchanged40.1s.

Latest exported opening filename: `out/alook-opening-brand-type.mp4` (40.1s, Caveat provider names, green text). The compact second-slide preview was delivered separately.

Second-slide correction #418: provider icons restored;48px collaboration sentence dominates32px introductory line, both unbroken. Current still:`out/more-bots-emphasis.png`.

Social network bridge (#421–424): eight fictional candid human photos plus existing Lin/Alex/Sam; bots use GeneratedAvatar. Lin’s bots orbit first; widening camera introduces Alex/Sam and community links with bidirectional message pulses. Accelerating rotation/blur converges into unchanged official logo animation. Review: `out/alook-social-ending.mp4`, 19.3667s/581frames. Rebuild `python3 scripts/render-social.py`; verify `python3 scripts/verify-social.py` and `node scripts/test-social-network.cjs`. Full source83.2s/2496frames;50 sound cues, lid impactframe2398. Avatar prompts: `src/assets/people/social-promptset.md`.

Social-entry revision #428/#430: Lin types/sends “Alook is sooo good.”, holds, then the message avatar lifts continuously from its measured DOM position into the network. Chat fades behind the floating photo. Bot names and orbit rings removed; bots roll horizontally beneath each owner before orbiting at140/125px. Current excerpt `out/alook-social-ending.mp4`23.1s/693frames; full source2608frames,52cues, lid impactframe2510. Earlier social timing is superseded.

Social motion correction #433–435: Lin floating/central label removed. Bots enter from the right along one shared tangent-line/circle path; distance spacing equals final orbit spacing, with rolling rotation on the straight and shared deceleration after the last arrival. 120Hz sampling verifies no same-owner bot disc intersections or human penetration for groups of2–4. Timing stays23.1s.

Social regions #437: four9.5%-opacity ellipses behind the graph, using canonical rear-logo colors pink#FE4365, purple#8A5A9E, teal#45ADA8, blue#6A8CAF. Fade into view with community reveal, then share spin/collapse. Close sound #439 advanced3frames/100ms tofullframe2507, excerpt592 (19.733s nominal). Duration unchanged23.1s.

Overlap #441: Lin bot motion starts with the3.6s lift (first visible roll3.7s), alongside background fade; shared clock and avatar-relative scale carry bots continuously into the network at4.8s.

Organic regions/early pullback #444–445: regular ellipses replaced by four deterministic asymmetric closed cubic curves, retaining9.5% logo colors. Pullback starts network+0.15s instead of+2.2s; Alex/Sam/community and their sound cues reveal earlier. Excerpt duration23.1s unchanged.

Compact network #448: human centers and organic regions scaled to70%, final camera scale.50 (was.35), making final avatars43% larger. Orbit radius108 forLin/102 forothers (was140/125), safely above95px combined avatar radii. Other human labels sit below orbital envelope; Lin remains unlabelled. Entry uses matching108px radius for continuous handoff. Excerpt23.1s unchanged.

#450 final density correction supersedes preceding70%/.50 draft: person centers and regions50%, final camera.60. Compared with delivered#447, screen center gaps~14% tighter and avatars~71% larger. Radius108/102 retained; neighboring people’s bot entry straight shortened to180px. Global120Hz checks: bot-bot min111.11px vs62px diameter; other-human clearance165.23px vs95px combined radii.

Social labels #455: removed all remaining human node labels; network avatars now uniformly have no names. Duration remains23.1s. Rebuild via scripts/render-social.py.

Opening fixes #465/#467: explicit notification-content flex class prevents selection/menu reflow; pointer into Keynote shares boundary position/size and holds through click. Current first-two-act review: out/alook-opening-glitches-fixed.mp4,40.1s with audio.

Local desktop vortex preview #472: DesktopFiles adds macOS-style folder/PDF/sheet/text icons. Visible desktop copies spiral with fading trails; original files remain. Codex rotates/shrinks with blur into Import, bounded within desktop. Milo explicitly references Launch brief.pdf on Lin’s Desktop. Current opening: out/alook-opening-local-vortex.mp4 (40.1s with sound). Motion source: local-vortex.ts.

Readable files #475/#476: explicit flex centering for all icons/labels;80px icons/16px labels. Import retimed to2s inside unchanged735–879frame section; file copies lift, hold, travel along a shallow arc, then shrink, with late label fade and reduced blur. Suction audio stretched with pitch-preserving atempo. Current opening out/alook-opening-readable-files.mp4 (40.1s).

Ending #481 WIP: standalone slogan card removed; logo lockup flows straight into closure, trimming2.2s. Social ending now627frames/20.9s; full source2542frames/84.733s. Lid peak moved tofullframe2441 (excerpt17.533s). Network slogan awaits clarification of spoken vs on-screen narration. Current out/alook-social-ending.mp4 only previews the completed closing change.

#481/#484 complete: slogan now appears above social network in the same68px DM Sans heading treatment as preceding scenes (excerpt4.8–12.05s), leaving before network spin. Logo proceeds directly to closure; no separate slogan page. Current review out/alook-network-slogan-ending.mp4,20.9s. Full source84.733s remains unexported.

Background #487: social network, logo scene and ending content layer share #faf6ed with prior headings. Removed contrasting off-white panel; friendship regions remain. Output out/alook-ending-unified-background.mp4,20.9s.

Fullscreen correction #490/#492: removed faux app titlebar/×; logo centered in entire laptop screen. Fullscreen network camera uses960/371.3333/1.68 to cover all screen edges (accounts for camera’s70px close-up aim offset). Encoded side-strip pixels match background exactly at6/11/13.4s. Latest out/alook-ending-clean-fullscreen.mp4,20.9s.

Full current export #495 (2026-09-22): out/alook-gtm-full-2026-09-22.mp4,2542frames/84.733333s,1920×1080/30fps,48kHz AAC,23.2MB. Includes readable desktop import, aligned files, all approved family/collaboration scenes, network heading, clean fullscreen logo and shortened close. All52audio cues and closing impact81.3716s verified;12encoded keyframes visually inspected. Rebuild with scripts/render-sfx.py.

### Current opening review (2026-09-23)

The 48.1-second teammate/result revision was rejected and reverted. Current first two acts restore the prior 40.1-second story, camera, dialogue and sound timing. Only “Copy. Paste. Repeat.” changes to “Your teammate needs your agent.” Latest review: `out/alook-opening-restored-new-heading.mp4`. Build with `python3 scripts/render-opening.py`; the script output is `out/alook-opening-provider-question.mp4`.

### PR-thread first act (2026-09-23)

Latest requested layout: local Codex on the left and a browser PR discussion on the right. Alex's migration review passes to Codex; Lin pastes the exact reply into the thread; Alex follows up about production. No notification overlays or GitHub integration are implied. First-act review: `out/alook-pr-opening.mp4`, 13.5s/405frames with nine interaction cues and no BGM. Reproduce with `python3 scripts/render-pr-opening.py`. The previously exported 40.1s opening and full film predate this PR revision.

### Three complete PR relay rounds (#558, 2026-09-23)
Opening now32s/960frames: migration → production safety → rollback. Every reviewer request is sent to Codex and its exact answer pasted back by Lin. Current exchange stays in view; request reading ≥1.7s, full agent answer ≥1.3s before copying, repost ≥1.5s. Opening headings preserved. Later scenes/audio shift+555frames (18.5s), source full duration103.233s; full movie has not been re-exported. Current preview: `out/alook-pr-opening.mp4`; reproduce with `python3 scripts/render-pr-opening.py`. Verification: PR round/stream/timing/headings/message checks, project/root typecheck; encoded960frames/1080p30 and18cues checked;12encoded samples visually inspected. Root tests remain blocked by agent-driver missing Node types.

2026-09-24: Latest PR opening is 22s (660 frames), with separate Lin author header and editor tabs, first relay at prior speed, then faster relays. Export: `out/alook-pr-opening.mp4`; command: `python3 scripts/render-pr-opening.py`. Delivered video-making#580. Full movie not re-exported. Supersedes earlier 32s preview.

2026-09-24 #591/#593: Copy hover highlights, first GitHub closeup stays fixed while heading exits, PR/Codex persist until PPT covers them. Latest full: `out/alook-gtm-full-2026-09-24-r2.mp4` (93.233s); opening `out/alook-pr-opening.mp4` (22s). Encoded transitions and all61 cues verified.

2026-09-24 #596: social heading stays static until the logo scene; removed heading-driven scene translation/scaling. Latest full `out/alook-gtm-full-2026-09-24-r3.mp4`,93.233s. Reproduce ending with AlookSocialEnding,627frames; full AlookLaunchReview,2797frames.

2026-09-24 #599/#601: unified avatar entry/graph geometry and cream background; graph lowered110 local pixels, returns to logo center during collapse; heading opacity fades during spin; brighter warm-orange lid. Latest full `out/alook-gtm-full-2026-09-24-r4.mp4`,93.233s. Encoded handoff, graph clearance, fade, lid and61audio cues verified.

2026-09-24 #604: lid face uses canonical front-bot #FF9915 solid fill. Latest full `out/alook-gtm-full-2026-09-24-r5.mp4` (2797 frames,93.233333s,CFR30fps). Final encoded frame and61audio cues checked.

2026-09-24 #610/#613/#614: teammate heading and its layout pulse removed. Clean picture/SFX full r6; new Pop Track03 story edit `out/bgm-auditions/03-story-edit.mp4`. Rebuild music with `python3 scripts/mix-bgm-story.py`; validate with `python3 scripts/verify-bgm-story.py`. Music source/license in public/bgm/candidates/SOURCES.md. First-act reading holds not retimed.

2026-09-24 #616/#618/#619/#621: action-first opening11.7s, reading holds removed; PPT now3pages (teammate→local-agent question→Introducing Alook); Codex gpt-latest/high. Full2578frames/85.933s;63SFX. Clean export `out/alook-gtm-full-2026-09-24-r7.mp4`; music `out/bgm-auditions/03-story-edit-v2.mp4`; opening `out/alook-pr-opening.mp4`. Rebuild full with render-sfx.py; music mix-bgm-story.py; verify scripts updated for current timeline.

Latest first-person PPT copy (#624): “My teammate needs my agent.” Full clean: `out/alook-gtm-full-2026-09-24-r8.mp4`; music: `out/bgm-auditions/03-story-edit-v3.mp4`. 85.933s,1080p30.

Latest #627/#632/#633: continuous opening cursor with18 aligned click targets; local-agent hold -0.5s, Introducing Alook hold +0.5s. `out/alook-pr-opening.mp4` (11.7s), `out/alook-gtm-full-2026-09-24-r9.mp4`, `out/bgm-auditions/03-story-edit-v4.mp4` (85.933s).

Music direction superseded by#636: Pop Track03 rejected. New jazz/funk full-video candidates in `out/bgm-jazz-funk/`:01-you-got-jazz.mp4,02-gimme-that-groove.mp4,03-dirty-thinkin.mp4. All use cleanr9 and contain no former BGM; no candidate approved yet. Reproduce with `python3 scripts/mix-jazz-funk.py`.

APPROVED MUSIC (#642): Gimme that Groove! by Michael Ramir C. Latest full `out/alook-gtm-final.mp4` (same as `out/bgm-jazz-funk/02-gimme-that-groove-v2.mp4`),87.433s/2623frames. First act13.2s ends with10 accelerating unanswered requests using social-network avatars; clean base `out/alook-gtm-full-2026-09-24-r10.mp4`. Other music candidates unselected.

Latest #645–648: two relay cycles, flood and zoom-out overlap. Final `out/alook-gtm-final.mp4` = `out/bgm-jazz-funk/02-gimme-that-groove-v3.mp4` (84.533s/2536frames). Cleanr11; opening10.3s/309frames. Approved02 music retained.

Latest#651/#653/#654: 🤯 overload beat0.9s afterzoom; Milo card+0.5s; SamThanks framing stable untilPPT transition. Full rerender r12/85.833s/2575frames; selected02-v4 copied to `out/alook-gtm-final.mp4`. Opening11.1s/333frames.

#657 music impact audition: `out/alook-gtm-groove-impact.mp4`, same85.833s picture/SFX.11 edited sections,4–10%pitch-preserving acceleration in driving sections,brief pre-hit gaps. Original `out/alook-gtm-final.mp4` retained for comparison. Reproduce via scripts/mix-groove-impact.py; cue map out/groove-impact-cues.json.

Latest#660/#661: PPT directly enters MultiInvite,3 bot rows slide in. Cleanr13; `out/alook-gtm-final.mp4` (02-v5 normal mix), `out/alook-gtm-groove-impact-v2.mp4` (edited-music alternative).85.833s; both preserve their prior audio exactly.

#664: impact music alternatives REJECTED for fragmented arrangement. Use `out/alook-gtm-final.mp4` (continuous approved02, latest r13 picture). Do not promote impact/impact-v2 as current.

#665 correction: `out/alook-gtm-groove-subtle.mp4` keeps original02 playback/speed/arrangement; only3x0.2s music gain dips at22.6,29.233,69.733. Uncompressed output outside cue windows identical to normal mix. Fragmentedimpact alternatives rejected.

#668: Milo import now reuses production ProfileCard (banner, avatar, Bot/owner, message input), framed completely. Cleanr14; final=02-v6; subtle-v2 updated picture. 2575 frames/85.833s; each audio stream byte-identical to its preceding version.

#673 supersedes subtle mixes: retain continuous original BGM; no more music adjustments. Milo card hold now1.0s (+0.5s), all later picture/SFX shifted15frames. Cleanr15, final=02-v7,2590frames/86.333s. Music source/speed/gain/fades unchanged.

#676/#677: latest main final is You Got Jazz (01-you-got-jazz-v8.mp4), alternative03-dirty-thinkin-v8.mp4. Both use r15 picture/SFX,2590frames/86.333s; original playback order/speed, same mix parameters. Supersedes previous02 selection.

#680 FINAL selection: Dirty Thinkin. Main final=03-dirty-thinkin-v9.mp4; SFX branch +5dB for audibility, music branch unchanged. Picture r15/2590frames/86.333s. Supersedes You Got Jazz selection.

#683/#684: final03-v10, cleanr16. Typing-only16cues +6dB beyond previous mix. Dirty Thinkin fade83.2–85.0s AFTER lid closes; final tail silent after85.1s. Picture/timings unchanged2590frames.

#687/#694: Introducing Alook has subtitle “Open-source Discord for human–agent collaboration.” in two lines. Cleanr17/final03-v11; same2590frames and byte-identical audio to03-v10.

#697: final03-v12 adds smooth varispeed/pitch descent after lid closure83.2–85.55s,1×→0.5×. Original BGM PCM before83.2s and SFX processing preserved. Rebuild scripts/mix-bgm-ending.py. Preview out/alook-ending-pitch-down.mp4. Picture hash/2590frames preserved; stereo peak−4.15dBFS, silent after85.85s. Owner listening review pending.

#700 supersedes v12: final03-v13 removes slowdown. Original-speed music preserved through82.8s;120ms crossfade to the song’s own final accent/natural decay (source85.3s), with short52Hz low impact at82.98s. Export scripts/mix-bgm-impact-ending.py; preview out/alook-ending-impact.mp4. Picture hash/2590frames unchanged, peak−4.15dBFS.

APPROVED ENDING (#703,2026-09-25): Gus approved final03-v13 original-speed climax → closing impact → natural decay. Main out/alook-gtm-final.mp4 remains v13.

#704: approved v13 ending/audio locked. Full86.336s1080p film delivered as attachment; SHA256645a5e5a531bfd2ccbec401f7894ee248899b15b4d2d391b445954bd11343f63. Lossless audio stream backup: out/bgm-jazz-funk/approved-v13-audio.m4a (complete approved music+SFX mix). Preserve this ending for future picture revisions.

#706/#708: Introducing slide group raised40–54px, logo drag landing moved with slot; subtitle22px/500 deepgreen#263c36. Final03-v14/cleanr18,2590frames; lockedv13 audio copied byte-for-byte. Encoded drop/hold frames inspected; typecheck/first-deck pass.

#711: product subtitle removed from Introducing PPT and moved beneath final logo in BrandPreview, two-line44px/500 deepgreen with late word-reveal fade. Final03-v15/cleanr19,2590frames; lockedv13 audio byte-identical. Encoded opening,logo,closing frames checked.

#715/#718/#719: final03-v16/cleanr20. Ending descriptor single-lineCaveat80px/500; softer locally synthesized pink-noise suction replaces old piercing effect26.9–28.9s. Generate-soft-suction.py→mix-sfx.py→render picture→muxcleanr20→mix-current-final.py. Approved BGM arrangement/ending unchanged; other67SFX cue data andPCM exact.2590frames; peak−4.15dBFS.

#722/#723: final03-v17/cleanr21 uses single-line Georgia64px/400 subtitle: “Open-source Discord, for human–agent collaboration.” This replaces handwriting.2590frames, audio stream byte-identical tov16, encoded frame checked.

#738 APPROVED B: final03-v18/cleanr22. Largeicon left, Alook and two-line AvenirNextBold76px right, no comma. Name reveal delayed until icon clears; encoded reveal/hold/close checked.2590frames;v17 audio copied exactly.

#741: final03-v19/cleanr23 transfers1s from Lin post-send hold(1.8→0.8s) to complete final brand card. Social sequence and3SFX cues−1s; closing and approved BGM stay at original timing. Total2590frames/86.333s. EndCard uses endingStoryTime; current music build mix-current-final.py.

#775/#777 LOCKED FULL v20: main out/alook-gtm-final.mp4 = 03-dirty-thinkin-v20.mp4, clean r24. 2620 frames / 87.333s. Approved Dirty Thinkin coda83.8–86.85 (original +1s), CTA +1s, Avenir Next500 italic descriptor, meat 🥩 proxy opening. Rebuild scripts/mix-current-final.py. Typecheck, encoded opening/brand/CTA frames, unclipped audio and silent tail passed. SHA256 68f8f3463d19a9dc8b413df3decd113ee3aa6eb425c7426c294a69b60c5c1ea3.

## Orange card line timing revision
`out/alook-card-stagger-with-audio.mp4`: 101.57s / 3047 frames / 1080p30; line entrances 0.5s apart, each orange card extended0.6s. Picture: `out/alook-card-stagger-picture.mp4`. Reproduce from the previous clean picture with `python3 scripts/render-card-stagger.py`, then `python3 scripts/mix-clean-audio.py`. Audio verification: `out/card-stagger-audio-qa.json`.

First-act comparison: `out/alook-first-act-1s.mp4`, 17.4s, 1s line interval, music/SFX included. Composition `AlookFirstActOneSecond`; default full-film timing stays at .5s.

Latest first-act preview: `out/alook-first-act-08s-question.mp4`, 17s/510frames; .8s line intervals and opening question mark, synchronized music/SFX. Composition `AlookFirstActPointEight`.

Cursor/menu fix preview: `out/alook-first-act-cursor-fixed.mp4`, 17s/510frames, .8s titles and question mark. Shared current first-act playback clock; selection endpoints synchronized with menus; adjusted Codex Copy sound.

Latest corrected preview: `out/alook-first-act-no-flash.mp4`, 17s/510frames. Reuses verified intact title segment and latest cursor-fix scene/audio. `python3 scripts/verify-title-integrity.py out/alook-first-act-no-flash.mp4` checks every title entrance/hold frame for line dropouts. Supersedes cursor-fixed export containing a corrupted frame46.

Latest full film: `out/alook-full-08s-with-audio.mp4`, 103.07s/3092frames. All orange cards .8s per line; approved opening question, corrected cursor/menu and no-flash title included. Rebuild using `render-cards-point-eight.py`, `mix-full-point-eight.py`; verify title frames using `verify-full-card-integrity.py`. Audio report `out/full-08s-audio-qa.json`.

## Milo local/context wording — 2026-09-29
Latest review export: out/alook-full-milo-local-context.mp4 (3092 frames / 103.07s / 1080p30). Lin types and posts “You can talk to @Milo. He runs locally and has my context.” per video-making#937–938. This supersedes the context-only revision.
Reproduce: npm run build; render AlookCleanReview frames1297–1512 to out/milo-context-scene.mp4 (H264, CRF18, concurrency1); then python3 scripts/render-milo-context.py. It replaces that interval in the previous full .8s export and copies encoded audio unchanged.
QA: project typecheck, test-milo-introduction.cjs and test-clean-review.cjs; decoded frame count, unchanged audio hash, complete composer and sent message visible. Typed copy derives from the posted message and uses actual character length.

## Invite-to-card timing — 2026-09-29
Current full review: out/alook-full-invite-card-fixed.mp4; short review: out/invite-card-review.mp4 (68–76s).
Many bots starts at full frame2107, 31 frames earlier, after all invites complete while the modal is still open. Its extra31-frame hold keeps the original exit and following demo timing. The transition air cue moves to2107; music arrangement unchanged.
Rebuild: npm run build; render AlookCleanReview frames2100–2242 to out/invite-card-fixed.mp4; run python3 scripts/render-invite-card-fix.py. The assembly retains the prior film from2219 onward, preserving its established exit frames.
Validate: typecheck, test-clean-review.cjs, test-milo-introduction.cjs; verify-full-card-integrity.py on the final MP4, plus decoded boundary frames. Audio/frame metadata: out/invite-card-audio-qa.json.
