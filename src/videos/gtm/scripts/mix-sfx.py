from sfx_track import build_base_sfx
from pathlib import Path
import array
import json
import math
import re
import wave
import subprocess

ROOT = Path(__file__).resolve().parents[1]
RATE = 48000
FRAMES = 2590
TRACK, CUES = build_base_sfx(ROOT, FRAMES)

peak = max(map(abs, TRACK))
assert peak < 32767, f'Clipping: {peak}'
assert not any(TRACK[round(83.85*RATE):]), 'CTA must be silent'
assert len(CUES) == 68
output = array.array('h', (round(v) for v in TRACK))
with wave.open(str(ROOT / 'public/sfx/launch-sfx.wav'), 'wb') as w:
    w.setparams((1,2,RATE,0,'NONE','not compressed'))
    w.writeframes(output.tobytes())
report = {'frames':FRAMES,'duration':len(output)/RATE,'peakDb':20*math.log10(peak/32767),'cues':sorted(CUES,key=lambda c:c['startSample'])}
(ROOT / 'public/sfx/cues.json').write_text(json.dumps(report,indent=2)+'\n')
print(f'{len(CUES)} cues, {len(output)/RATE:.6f}s, peak {report["peakDb"]:.2f} dBFS; CTA silent')
