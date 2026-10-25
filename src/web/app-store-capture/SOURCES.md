# Artwork sources

## Current component rendering

`app/` is a local Next application outside the production router. `captures/poster.tsx` and `poster.css` retain the selected warm-orange composition, copy and illustrated hardware. Screen content comes from imported Web components, with the same data objects used by the public [Alook homepage](https://alook.ai/):

| Scene | Component and data source |
| --- | --- |
| Workspace / phone / tablet / Duo | `LandingInteractiveShell`; `landing-interactive-shell-data.ts` DEMO servers, channels, profiles and messages |
| Identity / continuity | `LandingShellMotion`; existing timeline and scene fixtures |
| Maya profile | `LandingProfileContent`; existing profile content and avatar |
| Enlarged general reply | `Message`; original Alli object in `DEMO_MESSAGES["demo-general"]` |
| Enlarged continuity replies | `Message`; original first two `CONTINUITY_WORK_MESSAGES` objects |
| Input detail | Shared `Composer`, with sending disabled in local fixture IO |

All component paths are under `src/web/src/components/`. Shared providers retain fixture profile ownership; the capture does not fetch production conversations. Current continuity is the homepage's work scene (Alli/Shelly), rather than the old frozen Home screenshot. Message authors, bodies and timestamps come directly from those objects, without a second fixture copy. Display time uses a fixed reference clock and UTC; the original timestamp strings are unchanged.

The capture imports production global CSS and local fonts, keeping normal 16px root type instead of the public demo's 14px preview wrapper. Each iframe sets an explicit logical viewport, independent of the poster's pixel dimensions. Public symlinks reuse `src/web/public/alook.svg`, homepage people avatars, and `src/web/src/app/fonts/`. Five `assets/face-*.svg` files are the original face groups extracted from the official logo, preserving paths, colours, expressions and approved crops. No generated character or screenshot bitmap supplies App UI.

`assets/app-store/manifest.json` records direct source/asset hashes, actual renderer, fixture clock, logical viewports and generated JPEG hashes. Transitive shared code is identified by the complete review tree or committed source, not only the direct input list. Encoding and subpixel rasterization can differ across Chrome versions or repeated captures; a byte hash is not a visual comparison.

## Duo geometry

Both illustrated CSS bodies use 10px/mm before perspective: unfolded 1646×1178 and folded 841×1178. The dimensions follow [Apple technical specifications](https://www.apple.com/iphone-duo/specs/): 164.6×117.8mm and 84.1×117.8mm. Screen apertures retain hardware ratios 2670:1878 and 1398:2034, with component frames fitted without stretching. Bezel widths, corners, crease, hinge, buttons and perspective remain illustration approximations.

The 2007×2853 poster is a store canvas listed in [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/), distinct from the inner hardware panel's 1878×2670 pixels. Neither defines a CSS viewport. Duo's browser frames are 951×669 and 466×678 logical pixels, derived from simulator screen descriptors at UI scale 3 as reference rectangles. They do not establish the current native WebView's usable area, which can exclude safe insets. [Apple development guidance](https://developer.apple.com/iphone-duo/prepare/) requires layouts to follow the current window/view.

These are browser marketing compositions, not screenshots from a native build. Reusing Web components does not prove native status-bar/safe-area parity or a successful store submission. No private simulator screenshot is a pipeline input.

## Historical static packages

The previous implementation and its rendered files remain in Git history. The current generator does not read their HTML or screenshot inputs, and the former 13-image byte freeze no longer applies.

- `alook-store-v6-actual-source-and-approved-output.zip`, SHA256 `1e883c1d1933d4996fc1748519315cf663eb513476517d53e7e86adea5455246`: original warm-orange six-phone-story/tablet prototype. `approved-manifest.json` retains its 15 input and 13 output records.
- `alook-store-duo-v1-actual-source-and-output.zip`, SHA256 `b7bc3a4beee1951f308771e9d94700895e6c8011c598a5926f5e831a09436e6f`: original Duo template and frozen dark public-demo images. `duo-manifest.json` retains its 11 input and one output records.
- `duo-refinement.json` is the historical physical-scale-v2 HTML binding at commit `30cc2f9be9aff68c76e68c4584d4b0fbb0f74012`. It is not a live template manifest for the component generator.

Those packages used public homepage/demo scenes, not private conversations or native runtime evidence. The historical static HTML and bitmap inputs have been retired from this directory. Original manifests are preserved for attribution, while current source/output metadata is recorded separately.
