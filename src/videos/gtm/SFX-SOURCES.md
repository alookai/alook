# Approved launch sound assets

Owner selections: video-making #354, #359, #364, #369, #377, #380, #386. Timing approved #389.

- 02 click: Kenney Interface Sounds click_003.ogg; CC0 https://kenney.nl/assets/interface-sounds
- 04 message: Kenney Interface Sounds drop_001.ogg; CC0, same pack.
- 12 todo and14 suction: locally synthesized original WAVs, selected auditions.
- 16 unfold: Breviceps, Unfold a map, CC0 https://freesound.org/people/Breviceps/sounds/447931/ ; public HQ MP3 preview, sped up1.6x and filtered180–4200Hz.
- 10 lid: Kukensius, Notebook close, CC0 https://freesound.org/people/Kukensius/sounds/320456/ ; public HQ MP3 preview.
- 18 keyboard: Plummet, Intense typing on a laptop MacBook keyboard, CC0 https://freesound.org/people/Plummet/sounds/749425/ ; public HQ MP3 preview seconds3–6, filtered120–3200Hz.

Original FLAC/WAV downloads were not used for Freesound assets. Selected WAV auditions are stored in source/; script trims audition padding. Rebuild: python3 scripts/mix-sfx.py. No BGM/voiceover.

14-soft-air.wav: locally synthesized seeded pink noise; scripts/generate-soft-suction.py. No external recording. 90Hz highpass, two1.3kHz lowpass stages, smooth2s swell; replaces14-vortex-suction for#719.
