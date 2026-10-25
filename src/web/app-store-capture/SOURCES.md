# Approved artwork sources

The visual source is the v6 warm-orange prototype package `alook-store-v6-actual-source-and-approved-output.zip`, SHA256 `1e883c1d1933d4996fc1748519315cf663eb513476517d53e7e86adea5455246`. It contains six phone stories and the complete tablet desktop composition. `approved-manifest.json` is the original package manifest, recording all 15 source hashes and the original 13 JPEG hashes. The local generator preserves those 15 source bytes; it adapts serving paths and the generation entry only.

| Original prototype input | Repository location |
| --- | --- |
| `index.html`, `tablet.html` | This directory, unchanged HTML/CSS |
| `demo-phone.png`, `demo-desktop.png` | `assets/` in this directory |
| `face-red.svg`, `face-purple.svg`, `face-teal.svg`, `face-blue.svg`, `face-orange.svg` | `assets/` in this directory |
| `alook.svg` | `src/web/public/alook.svg` |
| `caveat.woff2` | `src/web/src/app/fonts/caveat-latin.woff2` |
| `dm-sans.woff2` | `src/web/src/app/fonts/dm-sans-latin.woff2` |
| `identity.webp`, `profile.webp`, `continuity.webp` | `src/web/public/landing/posters/` |

The two demo screenshots are frozen public [Alook demo](https://alook.ai/demo) inputs: desktop 2880×1800, SHA256 `fc39ef3ab09fd6bb18726ac9ceb068b0ab5c00d1d83c6b6d4189d3b72a0a75ed`; phone 1206×2622, SHA256 `402a9183e37fea06cdd4a8a6183198bd7268e2a66dec092fc1a21f1be85350df`. They show the same Gus/Shelly/Alli/Tracy/Cecilia general story. Their existing times and compact 14px demo styling are retained. The Maya identity/profile and Home continuity scenes remain separate, as on the public [Alook homepage](https://alook.ai/); the normal App's default 16px styling is a different surface.

The five SVG faces are the original `data-face` groups in the official logo, with their existing expressions enabled and the approved standalone viewBoxes. No new character was generated. Refresh them only from the official SVG, preserving paths, colours, expression geometry and the approved crop.

The enlarged public quotations are exact original text, with attribution and source time:

- Alli, Oct 21, 2026, 1:02 AM (public desktop screenshot): “Let visitors open a room, read what the team is doing, and ask a question in the composer. Keep the existing product story below it.”
- Alli, Aug 7, 2026, 4:32 PM (Home continuity screenshot): “@Tracy Can we confirm the Saturday plan we discussed?”
- Tracy, Aug 7, 2026, 4:32 PM (same Home scene): “Saturday at six works. I’ve added the address to our plan.”

The phone screenshot retains its own displayed times; the desktop quotation keeps the original desktop time. These are enlarged source quotations, not additional messages or a claim that the separate stories are one conversation.

For an intentional public-demo refresh, capture the same full desktop/phone rectangles from the public fixture, retaining the complete navigation and bottom user bar for desktop, then replace the two local PNGs. Record the source/viewport/time and new hashes here, review all crops and quotations, and regenerate the outputs. Do not add private accounts or production data to this pipeline. Normal generation never fetches the online demo.

The original package used Chrome/CUA screenshot JPEG bytes. This tool uses installed Chrome through Playwright at CSS pixel scale and quality 80. Capture metadata records the actual renderer and generated hashes; original approved hashes remain independently recorded. Changes in colour profile or JPEG encoding require a colour-aware visual comparison, not a false claim of identical bytes. Repeated captures with the same Chrome can also differ at subpixel raster edges; the input hashes and output mapping remain the stable source contract.

The additional Duo composition comes from `alook-store-duo-v1-actual-source-and-output.zip`, SHA256 `b7bc3a4beee1951f308771e9d94700895e6c8011c598a5926f5e831a09436e6f`. Its original `duo-manifest.json` binds 11 inputs and one 2007×2853 RGB JPEG reference. Eight inputs are byte-identical shared logo/font/face files. The three new inputs are preserved unchanged: `duo.html` here, and `assets/duo-open-demo.jpg` (1426×1003) / `assets/duo-closed-demo.jpg` (466×678).

The Duo source package records that these two images were captured from the public demo on 2026-10-25, using the actual dark theme, with no login, message send, DOM/CSS changes or rewritten text/times. The folded scene retains its displayed Chinese dates and the unfolded scene its English dates. The HTML draws the metal device frames and centre crease; it contains no hardware photograph. This is a marketing composition, not evidence of a native device or runtime test. Ordinary generation uses only these frozen local inputs. The original 13-file source/output manifest remains separate and unchanged.
