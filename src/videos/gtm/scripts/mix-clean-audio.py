from pathlib import Path
import array, json, math, subprocess

root = Path(__file__).resolve().parents[1]
sr = 48000
frames = 3047
duration = frames / 30
base = root / 'out/alook-card-stagger-picture.mp4'
out = root / 'out/alook-card-stagger-with-audio.mp4'

def run(*args):
    return subprocess.check_output(args)

def mapped(frame):
    return frame + 159 + (76 if frame >= 907 else 0) + (96 if frame >= 1251 else 0) + (96 if frame >= 1771 else 0)

source = (root / 'scripts/mix-sfx.py').read_text()
source = source.replace('FRAMES = 2590', 'FRAMES = 3047')
source = source.replace('    at = frame * 1600 - offset', '    if frame < 333:\n        return\n    frame = mapped(frame)\n    at = frame * 1600 - offset')
source = source[:source.index('peak = max(map(abs, TRACK))')]
ns = {'__file__': str(root / 'scripts/mix-sfx.py'), 'mapped': mapped}
exec(source, ns)
track, cues = ns['TRACK'], ns['CUES']

def add_at(name, time, db, length=None):
    data = ns['read'](name)
    if length is not None:
        data = data[:round(length * sr)]
    gain = 32767 * 10 ** (db / 20) / max(map(abs, data))
    at = round(time * sr)
    for i, value in enumerate(data):
        envelope = min(1, (i + 1) / 96, (len(data) - i) / 96)
        track[at + i] += value * gain * envelope
    cues.append({'sound': name[:2], 'frame': round(time * 30), 'startSample': at, 'samples': len(data), 'peakDb': db})

source_times = [0, .65, .76, 1.5, 1.8, 2, 2.2, 2.45, 2.5, 2.8, 3, 3.3, 3.38, 3.55, 3.6, 3.86, 4.3]
output_times = [0, .6, 1, 2, 2.5, 3.1, 3.5, 3.85, 4.1, 4.65, 5.25, 5.8, 6.25, 6.6, 7.1, 7.7, 7.8]
def opening_time(t):
    i = next(i for i in range(len(source_times)-1) if source_times[i] <= t <= source_times[i+1])
    return 3.1 + output_times[i] + (t-source_times[i])/(source_times[i+1]-source_times[i])*(output_times[i+1]-output_times[i])

add_at('04-join-drop.wav', opening_time(.75), -19)
for t in [1.62, 2.45, 3.3, 3.6, 3.85]:
    add_at('02-click.wav', opening_time(t), -18)
for offset in [0, .85, 1.55, 2.15, 2.65, 3.05, 3.4, 3.68, 3.9, 4.08]:
    add_at('04-join-drop.wav', 10.9 + offset, -26)
add_at('04-join-drop.wav', 15.213, -18)
for frame in [1066, 1486, 2102]:
    add_at('14-soft-air.wav', frame / 30, -25, .24)

assert max(map(abs, track)) < 32767
assert len(track) == frames * 1600
sfx = array.array('f', (v / 32767 * 10 ** (5/20) for v in track))
filters = 'loudnorm=I=-21:TP=-3:LRA=11,aresample=48000'
music = array.array('f', run('ffmpeg','-v','error','-i',str(root/'public/bgm/jazz-funk/03-dirty-thinkin.mp3'),'-af',filters,'-ac','2','-ar',str(sr),'-f','f32le','-'))
coda_start = 83.8 + 427/30
coda_end = 86.85 + 427/30
loop_at, loop_length, crossfade = 48., 16., .04
result = array.array('f')
for frame in range(round(duration * sr)):
    t = frame / sr
    music_time = t if t < loop_at else t-loop_length
    gain = .82 if t < 16.4 else .65 if t < 31.4 else .9 if t < 83.96 else 1.
    gain *= min(1, t/.25)
    for ch in range(2):
        def sample(seconds):
            ix = round(seconds*sr)*2+ch
            return music[ix] if 0 <= ix < len(music) else 0.
        v = sample(music_time)
        if loop_at <= t < loop_at+crossfade:
            u = .5-.5*math.cos(math.pi*(t-loop_at)/crossfade)
            v = sample(t)*(1-u)+v*u
        if t >= coda_start:
            n = t-coda_start
            u = .5-.5*math.cos(math.pi*min(1,n/.12))
            impact_t = max(0,n-.18)
            impact = .12*math.sin(2*math.pi*52*impact_t)*math.exp(-impact_t*7)*min(1,impact_t/.006)
            v = v*(1-u)+sample(85.3+n)*u+impact
        if t >= coda_end:
            v = 0.
        result.append(v*gain+sfx[frame])
assert max(map(abs,result)) < .98
raw = out.with_suffix('.f32')
raw.write_bytes(result.tobytes())
subprocess.run(['ffmpeg','-v','error','-y','-i',str(base),'-f','f32le','-ar',str(sr),'-ac','2','-i',str(raw),'-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart',str(out)],check=True)
raw.unlink()
def vhash(path):
    return run('ffmpeg','-v','error','-i',str(path),'-map','0:v','-c','copy','-f','hash','-')
assert vhash(base) == vhash(out)
meta = json.loads(run('ffprobe','-v','error','-count_frames','-show_streams','-of','json',str(out)))
v = next(s for s in meta['streams'] if s['codec_type']=='video')
assert int(v['nb_read_frames']) == frames
assert v['width']==1920 and v['height']==1080 and v['avg_frame_rate']=='30/1'
encoded = array.array('f',run('ffmpeg','-v','error','-i',str(out),'-vn','-ac','2','-ar',str(sr),'-f','f32le','-'))
peak = max(map(abs,encoded))
assert peak < 1
assert max(map(abs,encoded[round((coda_end+.05)*sr)*2:])) < .001
report = {'output':str(out),'frames':frames,'duration':duration,'picture_hash_equal':True,'peak_dbfs':20*math.log10(peak),'music_repeat':{'at':loop_at,'from':loop_at-loop_length,'seconds':loop_length,'speed':1},'coda':[coda_start,coda_end],'cues':sorted(cues,key=lambda c:c['startSample'])}
(root/'out/card-stagger-audio-qa.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='cues'}),flush=True)
