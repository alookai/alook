# App Store artwork capture

Generate the complete six-story screenshot set from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm app-store:capture
```

This standalone Next app follows `readme-capture` and lives outside the production router. Each scene imports real Web components and the homepage's existing demo data through `captures/surface.tsx`, inside its own logical iframe viewport. Screenshot bitmaps and hand-written App UI are not inputs. The marketing headlines, illustrated devices and surrounding face artwork belong to the capture composition.

The 24 screenshots have no outer Logo/wordmark or page counter. Actual UI branding remains part of the application. Two phone sizes each show six stories. Landscape iPad has six layouts around its broad workspace. Duo has six dedicated compositions: expanded collaboration, identity/profile across both forms, continuity with message details, closed-device check-in and both forms for the existing setup story. Device-specific headlines keep the same feature meaning.

## Outputs

Paths are relative to `assets/app-store/`:

| Story | 1206×2622 phone | 1320×2868 phone | 2752×2064 iPad | 2007×2853 Duo |
| --- | --- | --- | --- | --- |
| Share your agents | `phone-1206x2622/01-share-agents.jpg` | `phone-1320x2868/01-share-agents.jpg` | `tablet-2752x2064/01-share-agents.jpg` | `duo-2007x2853/01-share-agents.jpg` |
| Let teammates talk to your agent | `phone-1206x2622/02-teamwork.jpg` | `phone-1320x2868/02-teamwork.jpg` | `tablet-2752x2064/02-teamwork.jpg` | `duo-2007x2853/02-teamwork.jpg` |
| A companion of your own | `phone-1206x2622/03-companion.jpg` | `phone-1320x2868/03-companion.jpg` | `tablet-2752x2064/03-companion.jpg` | `duo-2007x2853/03-companion.jpg` |
| Pick up where you left off | `phone-1206x2622/04-context.jpg` | `phone-1320x2868/04-context.jpg` | `tablet-2752x2064/04-context.jpg` | `duo-2007x2853/04-context.jpg` |
| Check in from your device | `phone-1206x2622/05-phone.jpg` | `phone-1320x2868/05-phone.jpg` | `tablet-2752x2064/05-phone.jpg` | `duo-2007x2853/05-phone.jpg` |
| Keep your existing setup | `phone-1206x2622/06-existing-setup.jpg` | `phone-1320x2868/06-existing-setup.jpg` | `tablet-2752x2064/06-existing-setup.jpg` | `duo-2007x2853/06-existing-setup.jpg` |

All 24 are three-channel sRGB JPEGs without alpha. The former single portrait-tablet image has been retired. File sequence numbers organize output paths; no page numbering is drawn into the screenshots.

The normal App root font size is 16px. Workspace viewports are 1280×800 for phone desktop details/iPad, 402×874 for phone screens, and 951×669 / 466×678 for expanded / folded Duo workspaces. Identity/continuity motion stages retain their own 1120×660 viewport and fit the illustrated aperture without stretching. These browser inputs and CSS hardware frames do not measure native safe insets.

## Selection and review

Capture one device family, one feature across families, or one specific composition:

```bash
pnpm app-store:capture --device tablet --output /tmp/alook-ipad-review
pnpm app-store:capture --story 3 --output /tmp/alook-companion-review
pnpm app-store:capture --device duo --story 5 --output /tmp/alook-duo-check-in
pnpm app-store:capture --device tablet --overview --output /tmp/alook-ipad-overview
```

`--device` accepts `phone`, `tablet` or `duo`. `phone` generates both phone sizes. `--story` accepts integers 1–6. No filter generates all 24. Invalid options fail before the owned service/browser launches.

`--overview` adds a review sheet of the first six selected outputs to the same manifest. Each tile preserves its original aspect ratio with cream padding. It composites existing output bytes rather than taking another UI capture. For an unfiltered run these are the six smaller-phone stories. Use separate output directories for separate selections: each successful run's `manifest.json` describes that run's output set. The command overwrites declared outputs and its manifest without clearing unrelated destination files. Failure can leave partial images or an older manifest; use a run only after success.

## Reproducibility and boundaries

The generator starts its own Next process group on an unused loopback port and launches installed Chrome with `channel: "chrome"`, without an existing profile. It opens the narrow community general channel through its actual control, waits for real surfaces, fonts and images, rejects unexpected external requests/resource errors, captures each poster and validates RGB JPEG metadata. Success, errors and signals close its owned browser and Next group. Fixtures require no private account, backend write or production credentials.

`manifest.json` records actual Chrome version, direct input hashes, repository HEAD, fixed fixture reference clock (2026-10-25 UTC), locale/timezone, measured viewports and output hashes. An optional `renderBatches` list preserves the actual renderer/input hashes and output paths when unchanged images are retained across a targeted rerender. The committed Duo-only revision retains the eighteen phone/iPad images under their earlier batch; the latest `inputs` belong to the new six-image Duo batch. A complete default run replaces this with a fresh single-run manifest. Uncommitted candidates additionally need their full review tree/file binding. Direct hashes are not a transitive dependency graph; browser/font rasterization can change bytes. Review actual composition and native-size changed regions as well as hashes.

See [SOURCES.md](SOURCES.md) for component, reference and geometry provenance. Edit a composition or fixture consumer, regenerate the affected complete set and review every story/crop. Keep production rendering free of capture flags. Creative product-page headers/search artwork are separate from these screenshots; their central template safe area does not constrain these screenshot layouts. These marketing renders do not prove native layout parity, store acceptance or a particular installed build.

## Product-page header and search creatives

The separate approved centered-brand composition exports PNG artwork through the same capture tool directory and installed Chrome/sharp, without starting the gallery's Next app:

```bash
pnpm app-store:creative
pnpm app-store:creative --asset header --output /tmp/alook-header
pnpm app-store:creative --asset search --output /tmp/alook-search
```

Default `--asset all` writes `creative/alook-header-3840x1646.png`, `creative/alook-search-1920x1280.png` and their own `creative/manifest.json` under `assets/app-store/`. Single-asset selections emit only the selected PNG and a run-specific manifest; use separate directories for separate selections. The gallery command, default 24 JPEGs and existing gallery manifest are unchanged.

A small owned loopback server serves only the artwork document, CSS/noise and declared local fonts/Logo/four face SVGs. It has no production route, account or backend state. The generator waits for loaded fonts/images, rejects external/resource errors, measures eight critical subjects against the placement's Apple safe rectangle, validates three-channel RGB PNG output without alpha, and closes its owned context/browser/server on success, failure or interruption. Unrelated destination files and services are retained. A failed run can leave partial files; rely on a manifest only after success.

The composition uses the final approved HTML cascade: large centered wordmark and four supporting blue/teal/purple/red faces, with no interface thumbnail or standalone orange face. The header keeps its one-line headline. Actual critical element boxes, local resources, renderer and input/output hashes are recorded. CSS filter blur is outside element-box measurements; visual comparison against the supplied originals remains necessary. See source provenance below and in [SOURCES.md](SOURCES.md).

The supplied reference PNGs were converted from browser JPEG previews. The generator captures clear PNG directly; JPEG compression pixels are not part of the composition contract. The approved HTML remains the source for fonts, assets, geometry and crop.
