# Video.js Neutral skin adaptation

This directory contains the compiled Neutral video skin stylesheet from `@videojs/react` version `10.4.0`, distributed under the Apache License, Version 2.0. The license is included as `LICENSE.txt`.

Upstream: https://github.com/videojs/video.js

`neutral.css` is copied from the published package path `dist/dev/presets/video/neutral-skin.css`. Its scope has already been lowered by the upstream build; it contains no `@scope` rules. This owned copy is paired with the adapted Neutral layout in `../video-controls.tsx`; the integration imports only public React primitives and icons, with no private runtime skin imports or selector overrides against a packaged skin's internals. A version upgrade must review this composition and stylesheet together.

The React composition follows the official editable Neutral catalog at https://shadcn.videojs.org/r/react/css/neutral/video.json, version `10.4.0`. Alook replaces fullscreen entry/exit with its Dialog, omits fullscreen/PiP/remote player features and their controls, retains the finished playback/menu/visibility primitives, and adds the existing original-file download action. `attachment.css` contains Alook sizing and theme bindings.

The published package declares Apache-2.0 and supplies the included license. It has no additional NOTICE file. Copyright attribution is retained through that license and this provenance record; no upstream source file is represented as new original work.
