# App Store artwork capture

Generate the approved warm-orange artwork locally from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm app-store:capture
```

The generator lives next to `readme-capture`, outside the production router. It serves only its declared local files on an unused loopback port and launches the installed Chrome with `channel: "chrome"`. It waits for Caveat, DM Sans and all images, captures the fixed body rectangle, validates RGB JPEG output, then closes its own browser and HTTP server. Render errors, missing resources and external requests fail the command. It does not use an existing browser profile or stop other services.

The HTML/CSS is the approved v6 source, unchanged. `clean` hides the original study footer. The large-phone source scales the original composition to 1320px wide and clips its bottom background to exactly 2868px, as in the approved generation. The tablet fits the complete desktop screenshot inside a landscape device frame, including both navigation columns and the bottom user bar.

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

The thirteenth image is `tablet-2064x2752/01-share-agents.jpg` (2064×2752).

The fourteenth image is `duo-2007x2853/06-existing-setup.jpg` (2007×2853). Its unchanged source places an unfolded device behind a folded device, using the supplied dark public-demo images and CSS device frames. The original 13 images and sources are retained.

All 14 deliverables are three-channel RGB JPEGs with no alpha. `manifest.json` records the actual Chrome version, input hashes and output dimensions/SHA256. It contains no clock-dependent timestamp. JPEG encoding, colour profiles and subpixel raster edges can differ across browser versions, screenshot APIs or repeated captures; file hashes alone do not establish visual equivalence with the original CUA captures.

For a separate output directory or an optional 1206×1679 review contact sheet:

```bash
pnpm app-store:capture --output /tmp/alook-store-artwork
pnpm app-store:capture --overview --output /tmp/alook-store-review
```

`--overview` adds `overview.jpg` to that run's manifest. The command overwrites only its declared images and manifest; it does not clear unrelated files in the destination. A failed run can leave partial images, but does not write a successful manifest for that run. Review the exit status before using its outputs.

## Source and updates

See [SOURCES.md](SOURCES.md) [approved-manifest.json](approved-manifest.json) and [duo-manifest.json](duo-manifest.json). Normal generation reads committed static inputs and needs no online page, private account, database or credentials. The source package's font/logo/homepage assets are reused from their byte-identical repository locations. Four public demo screenshots and five extracted logo faces are stored under `assets/` here.

To update the artwork, edit the local HTML/CSS or deliberately replace the documented public input, preserve message authors/text/times, regenerate all 14 images, and compare them with the approved reference. Update the source record and contract tests when an input or mapping changes. Keep full desktop navigation in the tablet image. A change in demo fixtures is not an instruction to recapture production or private conversations automatically.

These are marketing compositions using public demo/homepage scenes. They do not prove native App, Duo or build37 behavior, successful store submission, review approval or installation. The general story and the separate Maya/Home scenes retain their original attribution.
