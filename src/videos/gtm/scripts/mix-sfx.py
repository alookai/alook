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
TRACK = array.array('f', [0]) * (FRAMES * 1600)
CUES = []


def read(name, start=None, end=None):
    with wave.open(str(ROOT / 'public/sfx/source' / name)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, RATE)
        data = array.array('h', w.readframes(w.getnframes()))
    if start is None:
        threshold = max(map(abs, data)) * .01
        active = [i for i, v in enumerate(data) if abs(v) > threshold]
        first = max(0, active[0] - 96)
        last = min(len(data), active[-1] + 480)
        return data[first:last]
    return data[round(start * RATE):round(end * RATE)]


def add(name, frame, db, start=None, end=None, duration=None, offset=0, absolute=False, playback_rate=None, opening=False):
    data = read(name, start, end)
    if duration is not None:
        data = data[:round(duration * RATE)]
    if playback_rate is not None:
        data = array.array('h', subprocess.check_output(['ffmpeg','-v','error','-f','s16le','-ar',str(RATE),'-ac','1','-i','pipe:0','-af',f'atempo=0.5,atempo={playback_rate*2}','-f','s16le','pipe:1'],input=data.tobytes()))
    if name.startswith('18'):
        db += 6
    gain = 32767 * 10 ** (db / 20) / max(map(abs, data))
    if not absolute:
        frame = math.ceil(230+(frame-170)*175/130-1e-8) if 170 <= frame < 300 else frame+105 if frame>=300 else frame
        frame += 90 if frame>=462 else 0
    if frame < 405 and not opening:
        return
    if not opening:
        frame += 36
    if not opening and 588 <= frame < 729:
        frame -= 15
    if not opening and frame >= 351:
        frame += 45
    if not opening and frame >= 243:
        frame -= 87
    if not opening and frame >= 309:
        frame += 24
    if not opening and frame >= 877:
        frame += 30
    at = frame * 1600 - offset
    assert at >= 0 and at + len(data) <= len(TRACK)
    fade = min(96, len(data) // 4)
    for i, value in enumerate(data):
        envelope = min(1, (i + 1) / fade, (len(data) - i) / fade) if name.startswith('18') else 1
        TRACK[at + i] += value * gain * envelope
    CUES.append({'sound': name[:2], 'frame': frame, 'startSample': at, 'samples': len(data), 'peakDb': db})


for frame in [74,141,183,201,216,231,305,534,543,591,689,1275,1377]:
    add('02-click.wav', frame, -18)
for frame in [20,170,207,716,738,887,943,1047,1076,1132,1435,1460,1485,1600,1648,1696]:
    add('04-join-drop.wav', frame, -19)
add('14-soft-air.wav', 594, -17, 0, 2)
add('16-paper-unfold-soft.wav', 1150, -17, .3, 1.1924)
add('12-todo-double-tick.wav', 1187, -12, .3, .52)
add('18-keyboard-soft.wav',1927,-17,.3,1.5,absolute=True)
add('04-join-drop.wav',1969,-19,absolute=True)
close = read('10-laptop-close.wav')
impact = max(range(len(close)), key=lambda i: abs(close[i]))
add('10-laptop-close.wav', 2441, -10, offset=impact, absolute=True)
for frame in [2071,2087,2150]:
    add('04-join-drop.wav', frame, -24, absolute=True)
for index, (first, last) in enumerate([(418,437),(486,498),(799,847),(1292,1327),(1531,1546),(1547,1561),(1562,1575)]):
    start = .3 + (index % 3) * .4
    add('18-keyboard-soft.wav', first, -17, start, 3.3, duration=(last-first)/30)

segments=[tuple(map(float,m)) for m in re.findall(r'from:(\d+)/30,to:(\d+)/30,sourceFrom:([\d.]+),sourceTo:([\d.]+)',(ROOT/'src/review-timing.ts').read_text())]
def source_frame(t):
    a,b,c,d=next(s for s in segments if s[2]<=t<s[3])
    return math.ceil(a+(t-c)/(d-c)*(b-a)-1e-8)

for a,b in [(123.6,123.872),(124.195,124.45),(124.45,124.722),(125.045,125.3),(125.3,125.572),(125.895,126.15),(126.15,126.66)]:
    first,last=source_frame(a+3),source_frame(b+3)
    add('18-keyboard-soft.wav',first,-17,.3,3.3,duration=(last-first)/30,absolute=True,opening=True)

for event in [1.62,2.45,3.3,3.6,3.85,5.22,6,6.85,7.15,7.4]:
    add('02-click.wav',source_frame(event),-18,absolute=True,opening=True)
for event in [.75,4.45]:
    add('04-join-drop.wav',source_frame(event),-19,absolute=True,opening=True)
add('18-keyboard-soft.wav',356,-17,.3,3.3,duration=1.65,absolute=True,opening=True)
add('02-click.wav',444,-18,absolute=True,opening=True)
for frame in [246,254,262,269,276,282,288,293,298,302]:
    add('04-join-drop.wav',frame,-26,absolute=True,opening=True)
add('04-join-drop.wav',308,-18,absolute=True,opening=True)
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
