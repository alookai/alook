# App Store artwork capture

Generate the warm-orange marketing compositions from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm app-store:capture
```

This standalone Next app follows `readme-capture` and lives outside the production router. `captures/poster.tsx` draws the marketing layout. Each device contains a local iframe with its own logical viewport, importing real Web components and the homepage's existing demo data through `captures/surface.tsx`. No screenshot bitmap or hand-written App markup supplies the screen UI.

Workspace scenes use `LandingInteractiveShell`, including the shared rail, sidebar, header, message list, composer and user bar. Identity, continuity and profile scenes reuse `LandingShellMotion`, `LandingProfileContent` and their existing fixtures. Enlarged messages use the real `Message` component with the original fixture objects. Only the marketing headline, device illustrations and surrounding artwork are capture-specific.

The normal App root size is 16px; the public demo's 14px preview modifier is not applied. Desktop workspaces use 1280×800 logical pixels; phone scenes use 402×874. Duo uses 951×669 and 466×678 screen-reference rectangles. These are browser layout inputs, not measurements of a native WebView's usable safe area. See [SOURCES.md](SOURCES.md) for the geometry and evidence boundaries.

The generator starts its own Next process group on an unused loopback port and launches installed Chrome with `channel: "chrome"`, without an existing profile. It opens the mobile general channel using its actual control, waits for frame readiness, fonts and images, rejects external requests/resource errors, captures the poster and validates RGB JPEG dimensions. Success, errors and signals close its owned browser and Next group; unrelated services are not stopped. Fixtures use local providers without account credentials or backend writes.

## Outputs

Paths are relative to `assets/app-store/`:

| Story | 1206×2622 phone | 1320×2868 phone |
| --- | --- | --- |
| Share your agents | `phone-1206x2622/01-share-agents.jpg` | `phone-1320x2868/01-share-agents.jpg` |
| Let teammates talk to your agent | `phone-1206x2622/02-teamwork.jpg` | `phone-1320x2868/02-teamwork.jpg` |
| A companion of your own | `phone-1206x2622/03-companion.jpg` | `phone-1320x2868/03-companion.jpg` |
| Pick up where you left off | `phone-1206x2622/04-context.jpg` | `phone-1320x2868/04-context.jpg` |
| Check in from your phone | `phone-1206x2622/05-phone.jpg` | `phone-1320x2868/05-phone.jpg` |
| Keep your existing setup | `phone-1206x2622/06-existing-setup.jpg` | `phone-1320x2868/06-existing-setup.jpg` |

The tablet is `tablet-2064x2752/01-share-agents.jpg` (2064×2752), retaining the complete desktop navigation and user bar. The Duo is `duo-2007x2853/06-existing-setup.jpg` (2007×2853).

All 14 are three-channel sRGB JPEGs without alpha. `manifest.json` records actual Chrome version, direct input hashes, reference clock, locale/timezone, component viewports and output hashes. Browser time is fixed to 2026-10-25 UTC for stable fixture date labels; fixture timestamps are unchanged. The repository HEAD identifies the baseline; an uncommitted candidate also needs its review tree/file binding. Direct hashes are not a complete transitive dependency graph. Browser/font rasterization can change JPEG bytes between runs, so hashes do not prove visual equivalence.

```bash
pnpm app-store:capture --output /tmp/alook-store-artwork
pnpm app-store:capture --overview --output /tmp/alook-store-review
```

`--overview` composites a 1206×1679 review sheet from the six generated small-phone images and adds it to that run's manifest. It does not recapture a second set of live UI frames. The command overwrites only its declared images and manifest, without clearing unrelated destination files. A failure can leave partial images or a previous manifest; use outputs only after the command succeeds.

## Source and updates

See [SOURCES.md](SOURCES.md). Normal generation is local and needs no online page, private account, database or credentials. Public asset links are relative to repository logo, fonts and homepage avatars. The five face SVGs retain the official logo paths and approved crops.

Edit capture composition or shared fixture consumers, regenerate all 14, review all stories/crops and update contracts and provenance for intentional changes. Keep production rendering free of capture flags. The old static package manifests are historical; their former byte freeze does not constrain this component implementation. These marketing outputs do not prove native layout parity, store acceptance or a particular installed build.
