# Alook videos

Each directory here is a self-contained video project. Generated video, GIF, frame, dependency, and build artifacts must stay uncommitted.

## Project index

| Project | Purpose | Build | Final outputs |
| --- | --- | --- | --- |
| [`logo`](./logo) | Official Alook logo animation | `cd src/videos/logo && npm ci && npm run build` | `npm run render:mp4` → `out/alook-logo-official.mp4`; `npm run render:gif` → `out/alook-logo-official.gif` |

When adding a project, give it its own package manifest and README, then add one row here with the exact build command and output paths.
