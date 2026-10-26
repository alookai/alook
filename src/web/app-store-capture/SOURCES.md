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

`assets/app-store/manifest.json` records local runtime-import source/asset hashes and selected locked renderer dependencies, actual renderer, fixture clock, logical viewports and generated JPEG hashes. The source walker follows local runtime imports, including shared workspace modules. The dependency projection includes selected package integrity, snapshots, peer bindings and patch bytes; unrelated lock entries and root package metadata are excluded. A complete review tree still identifies the entire uncommitted candidate. Encoding and subpixel rasterization can differ across Chrome versions or repeated captures; a byte hash is not a visual comparison.

## Six-story device compositions

The current screenshot set has six stories for each of two phone dimensions, landscape iPad and Duo: 24 RGB JPEGs. The screenshot surround omits the former wordmark and page counter; existing App UI stays intact. Phone spacing reuses the story group after reclaiming that top band. iPad uses its own wide title/device layout. Duo's companion, continuity, closed-device check-in and dual-form setup scenes select different real component surfaces and hardware arrangements. Expanded devices have no decorative central crease overlay. A Duo-only rerender retains the eighteen unchanged phone/iPad files under their original input/renderer batch in the aggregate manifest; it does not present them as newly rendered from the later source.

Reference decisions were checked against [Apple's product page guidance](https://developer.apple.com/app-store/product-page/), [screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/), and actual phone/tablet screenshots from [Discord's official App Store listing](https://apps.apple.com/us/app/discord-talk-play-hang-out/id985746746) (public Apple lookup, US, version 350.0). References informed feature hierarchy and the landscape tablet arrangement; their images are not repository or output inputs. The selected 2752×2064 landscape iPad and 2007×2853 Duo store canvases are distinct from the CSS UI viewports.

Each screenshot uses canvas-specific title margins and device framing. The central ART SAFE AREA in Apple's separate creative-header/search templates is not applied to the screenshot group. The old fourteen-image count and lone portrait iPad/one-story Duo composition no longer define the generator contract.

## Duo geometry

Both illustrated CSS bodies use 10px/mm before perspective: unfolded 1646×1178 and folded 841×1178. The dimensions follow [Apple technical specifications](https://www.apple.com/iphone-duo/specs/): 164.6×117.8mm and 84.1×117.8mm. Screen apertures retain hardware ratios 2670:1878 and 1398:2034, with component frames fitted without stretching. Bezel widths, corners, crease, hinge, buttons and perspective remain illustration approximations.

The 2007×2853 poster is a store canvas listed in [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/), distinct from the inner hardware panel's 1878×2670 pixels. Neither defines a CSS viewport. Duo's workspace browser frames are 951×669 and 466×678 logical pixels, derived from simulator screen descriptors at UI scale 3 as reference rectangles. Identity/continuity motion scenes retain their 1120×660 logical stage and fit without distortion. These frames do not establish the current native WebView's usable area, which can exclude safe insets. [Apple development guidance](https://developer.apple.com/iphone-duo/prepare/) requires layouts to follow the current window/view.

These are browser marketing compositions, not screenshots from a native build. Reusing Web components does not prove native status-bar/safe-area parity or a successful store submission. No private simulator screenshot is a pipeline input.

## Historical static packages

The previous implementation and its rendered files remain in Git history. The current generator does not read their HTML or screenshot inputs, and the former 13-image byte freeze no longer applies.

- `alook-store-v6-actual-source-and-approved-output.zip`, SHA256 `1e883c1d1933d4996fc1748519315cf663eb513476517d53e7e86adea5455246`: original warm-orange six-phone-story/tablet prototype. `approved-manifest.json` retains its 15 input and 13 output records.
- `alook-store-duo-v1-actual-source-and-output.zip`, SHA256 `b7bc3a4beee1951f308771e9d94700895e6c8011c598a5926f5e831a09436e6f`: original Duo template and frozen dark public-demo images. `duo-manifest.json` retains its 11 input and one output records.
- `duo-refinement.json` is the historical physical-scale-v2 HTML binding at commit `30cc2f9be9aff68c76e68c4584d4b0fbb0f74012`. It is not a live template manifest for the component generator.

Those packages used public homepage/demo scenes, not private conversations or native runtime evidence. The historical static HTML and bitmap inputs have been retired from this directory. Original manifests are preserved for attribution, while current source/output metadata is recorded separately.

## Centered-brand creative exports

`creative/source.json` identifies the approved standalone HTML with SHA-256 `f17b90df66ed06777834687e843137711b4ee48fdf42f4fb1c2097c49563b6a2` and the two original reference PNGs. `creative/artwork.css` is the flattened final cascade from that source; the document omits its preview controls, hidden old thumbnail and unused standalone orange face. No store-account screenshot or private coordination record is a production/repository input.

The embedded original Caveat, DM Sans, official Logo and four face SVG bytes were matched to their existing repository inputs. The 247-byte noise SVG is extracted unchanged from that HTML. The header uses a 1600×685.833333 logical canvas at scale 2.4; search uses 1200×800 at scale 1.6. Colors, positions, rotations and crop follow the approved source, rather than being reconstructed from a preview screenshot.

Placement safety rectangles come from [Apple's creative template](https://devimages-cdn.apple.com/design/resources/download/app-store/creative_assets-templates.sketch), SHA-256 `0f6f6f86e89ccf8a74f9214b29481c6748e21fc677ecc72fbc623ae3470d8957`: header (1097,493,1646,661) on 3840×1646; search (418,382.5,1084,515) on 1920×1280. The generator records actual element bounds and resource readiness. These bounds belong to creative placements, not gallery screenshots or a native safe-area claim.

The creative manifest records the real Chrome renderer, local input hashes and its Playwright/Sharp dependency projection, original composition identity and generated PNG hashes. Original PNG hashes identify references; another PNG encoder or browser rasterizer can produce different file bytes. Compare decoded appearance, typography and crop as well as metadata. A reproducible export does not imply store processing/review approval or App submission.

The supplied reference PNGs were converted from browser JPEG previews. The generator captures clear PNG directly; JPEG compression pixels are not part of the composition contract. The approved HTML remains the source for fonts, assets, geometry and crop.
