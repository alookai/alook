# Logo animation

The approved five-second Alook logo animation, built with Remotion. This project is isolated from Alook's product workspaces and commits source code only; generated media stays under the ignored `out/` directory.

## Build

```sh
cd src/videos/logo
npm ci
npm run build
```

## Render

```sh
npm run render:mp4
npm run render:gif
```

Outputs:

- `out/alook-logo-official.mp4` — 1080×1080, 60 fps, 5 seconds
- `out/alook-logo-official.gif` — 540×540, 30 fps, 5-second loop

Optional source checks:

```sh
npm run render:first-still
npm run render:final-still
npm run render:reference-still
npm run verify
```

The verification command also compares the bundled SVG with the monorepo's canonical `assets/alook.svg`.
