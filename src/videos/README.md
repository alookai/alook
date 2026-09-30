# Alook videos

Each directory is a separate video project. Generated video, media, frames, dependencies and build artifacts stay uncommitted.

| Project | Purpose | Build and export | Output |
| --- | --- | --- | --- |
| [logo](./logo) | Official logo animation | `npm ci && npm run build && npm run render:mp4` | `out/alook-logo-official.mp4` |
| [gtm](./gtm) | Complete 103.067-second product story with music/SFX | Restore media per [ASSETS.md](./gtm/ASSETS.md), then `npm ci && npm run render` | `out/alook-gtm-final.mp4` |

Run commands inside the respective project directory after installing root dependencies. Each project README contains setup and verification details.
