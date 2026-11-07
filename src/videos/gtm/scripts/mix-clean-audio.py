from audio_tracks import CLEAN_PROFILE, build_opening_sfx, normalize_sfx, load_music
from pathlib import Path
import array, json, math, subprocess

root = Path(__file__).resolve().parents[1]
sr = 48000
frames = CLEAN_PROFILE.frames
duration = frames / 30
base = root / 'out/alook-card-stagger-picture.mp4'
out = root / 'out/alook-card-stagger-with-audio.mp4'

def run(*args):
    return subprocess.check_output(args)

track, cues = build_opening_sfx(root, CLEAN_PROFILE)
sfx = normalize_sfx(track)
music = load_music(root)
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
