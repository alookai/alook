# New Bot feature video

A 1492-frame / 49.733-second Remotion sequence at 30 fps. It demonstrates a team request, bot creation, invitations and team conversation, followed by the Alook brand close. This is the approved revision 15 source: opus5.5, gpt-6-astra and grok-4.7 model labels; opening dialogue clearance; pointer-led close-ups.

The scene reuses Alook product components with local fixtures. It creates no real bots and sends no network messages. The renderer uses the existing web logo, fonts and Lin portrait; `prepare.mjs` copies those into the ignored `public` directory and generates product CSS.

## Build and render

Install the repository's web workspace dependencies first. From `src/videos/new-bot`:

```sh
npm install
npm ci --prefix .render-deps
npm run typecheck
npm test
npm run build
npm run render
```

`npm run render` creates the silent 720p video at `out/new-bot-720.mp4`. Source is `src/video.tsx`; timeline constants and assertions are in `src/timing.json` and `scripts/timing.test.cjs`. Rendering uses one worker.

The reviewed video uses “Make Me Happy” by Alex-Productions. Audio and rendered media are not stored in Git. Supply the licensed track separately when producing the final mix and retain the track's required credit. `scripts/review-audio.py` generates only a temporary beat guide; it is not the selected score.

All generated CSS, fonts, copied images, dependency folders, bundle output and rendered media are ignored. The project imports current web components, so verify its typecheck, tests and key frames after changes to those components.
