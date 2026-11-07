from pathlib import Path
import sys
from full_audio import render_full_audio

root = Path(__file__).resolve().parents[1]
render_full_audio(
    root,
    root / (sys.argv[1] if len(sys.argv) > 1 else 'out/alook-full-08s-picture.mp4'),
    root / (sys.argv[2] if len(sys.argv) > 2 else 'out/alook-full-08s-with-audio.mp4'),
    root / 'out/full-08s-audio-qa.json',
)
