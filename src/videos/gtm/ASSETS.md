# Media assets

Binary media is deliberately excluded from Git. The asset manifest records the exact files needed for the current film; `npm run verify:assets` checks size and SHA-256.

Obtain `alook-gtm-assets-1.zip` and `alook-gtm-assets-2.zip` from the video-making delivery accompanying this PR, then unzip both into `src/videos/gtm/`. Together they supply fictional portraits, selected SFX and the Inter font. Existing web fonts and the official logo are copied by `npm run prepare:assets`.

Download the selected music separately (not included in the source PR or asset archive):

```sh
mkdir -p public/bgm/jazz-funk
curl --fail --location https://assets.mixkit.co/music/989/989.mp3 -o public/bgm/jazz-funk/03-dirty-thinkin.mp3
npm run verify:assets
```

Music: “Dirty Thinkin’” by Michael Ramir C., Mixkit. Check the [Mixkit music license](https://mixkit.co/license/modal/musicFree/) for your intended use. The video uses original playback speed, one musical repeat and the approved natural ending.

Portraits: fictional people generated for this film. Prompts are in `src/assets/people/README.md` and `social-promptset.md`.

SFX provenance: [SFX-SOURCES.md](SFX-SOURCES.md). Inter: [official project](https://github.com/rsms/inter), SIL Open Font License (included in `INTER-LICENSE.txt`). Other typefaces are copied from the web project. Historical experiments may need additional media; the bundle supports the current `AlookCleanReview` export.
