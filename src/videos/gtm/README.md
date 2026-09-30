# Alook GTM film

Current full film: **103.067 seconds / 3092 frames, 1920×1080, 30 fps**, with music and sound effects, no narration. `AlookCleanReview` is the current composition. It follows Lin’s local agent from a pull-request conversation into shared work and family channels, ending with the social network and closing laptop.

## Setup

Install the monorepo dependencies with `pnpm install` at the repository root, then:

```sh
cd src/videos/gtm
npm ci
# Restore the separately distributed media as documented in ASSETS.md.
npm run verify:assets
npm run prepare:assets
```

Requires Node.js, Python 3, FFmpeg/ffprobe and Chrome. Remotion can download its managed browser; to use your installed Chrome, set `REMOTION_BROWSER_EXECUTABLE` to its executable path. The approved render was produced on macOS; system font fallback can differ elsewhere.

## Preview and export

```sh
npm run dev
npm run typecheck
npm run verify
npm run render
python3 scripts/verify-full-card-integrity.py out/alook-gtm-final.mp4
```

`npm run render` bundles the source, renders the complete current composition with one worker, then mixes the selected music and synchronized effects. It does not require any earlier rendered videos. Final output: `out/alook-gtm-final.mp4`; silent picture: `out/alook-gtm-picture.mp4`; audio/frame verification: `out/full-08s-audio-qa.json`.

The current edit includes 0.8-second staggered title lines; Lin’s “He runs locally and has my context” message in both composer and conversation; and the Many bots / One place card entering immediately after the last invite while the modal is still visible.

## Repository boundaries

Only source, textual provenance, tests, configuration and the npm lockfile are committed. Portraits, fonts, audio, videos, screenshots, build bundles, dependencies and caches are ignored. Restore exact media using [ASSETS.md](ASSETS.md) and `assets-manifest.json`.

The project imports the real web product components through video-local aliases and Next.js shims. Product code does not import the video project. Dependencies and lockfile are separate from the pnpm workspace.

Earlier compositions, audition scripts and rendering notes are retained for reference in [HISTORY.md](HISTORY.md). Their durations and intermediate filenames are historical; use the commands above for the current complete film.
