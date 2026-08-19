# README capture app

This is an internal Next.js app for rendering the README artwork with the real Web components. It lives outside `src/web/src/app`, so it is not part of the production Web router and does not expose `/readme-capture` on alook.ai.

Run every capture from the repository root:

```bash
pnpm readme:capture
```

The command finds an unused local port, starts this app, captures the elements below, writes the assets, and terminates the local server.

| Selector | Output | Pixel size |
| --- | --- | --- |
| `#capture-overview` | `assets/readme/overview.png` | 2364×1594 |
| `#capture-identity` | `assets/readme/one-identity.png` | 1280×720 |
| `#capture-memory` | `assets/readme/memory.png` | 1280×720 |
| `#capture-reach` | `assets/readme/reach.png` | 1280×720 |
| `#capture-local` | `assets/readme/local-first.png` | 1280×720 |
| `#capture-collaboration` | `assets/readme/collaboration.png` | 1280×720 |
| `.card` in `assets/social-preview/readme-banner.html` | `assets/readme/banner.png` | 1280×500 |

The generator must launch the installed Chrome browser with `channel: "chrome"`. Do not switch it to Playwright’s bundled Chromium: that renderer can flatten the banner’s nested 3D typewriter layers and hide the paper.

Keep capture copy sourced from production components or existing project fixtures. Preserve each selector, aspect ratio, transparent rounded corners, light color scheme, and the element-level screenshot method. Update the capture contract test whenever a capture component or output mapping changes.
