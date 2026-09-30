from pathlib import Path
import array, json, math, subprocess
root = Path(__file__).resolve().parents[1]
base = root / 'out/ending-later-1s-picture.mp4'
out = root / 'out/ending-later-1s-preview.mp4'
sr = 48000
start, end, duration = 83.80, 86.85, 87.333333
filters = "atrim=0:89.18,asetpts=PTS-STARTPTS,loudnorm=I=-21:TP=-3:LRA=11,aresample=48000,volume='if(lt(t,11.1),0.82,if(lt(t,26.1),0.65,if(lt(t,69.73),0.9,1)))':eval=frame,afade=t=in:d=0.25"
def run(*args):
    return subprocess.check_output(args)
samples = array.array('f', run('ffmpeg','-v','error','-i',str(root/'public/bgm/jazz-funk/03-dirty-thinkin.mp3'),'-af',filters,'-ac','2','-ar',str(sr),'-f','f32le','-'))
first, last = round(start*sr), round(end*sr)
processed = array.array('f', samples[:first*2])
source_start = 85.30
crossfade = round(.12*sr)
for frame in range(first, last):
    n = frame-first
    source_frame = round(source_start*sr)+n
    u = min(1, n/crossfade)
    blend = .5-.5*math.cos(math.pi*u)
    for ch in range(2):
        original = samples[frame*2+ch]
        tail = samples[source_frame*2+ch] if source_frame*2+ch < len(samples) else 0
        t=n/sr
        impact = .12*math.sin(2*math.pi*52*max(0,t-.18))*math.exp(-max(0,t-.18)*7)*(min(1,max(0,t-.18)/.006))
        processed.append(original*(1-blend)+tail*blend+impact)
processed.extend([0.]*(round(duration*sr)*2-len(processed)))
assert processed[:first*2] == samples[:first*2]
assert max(abs(processed[i]-processed[i-2]) for i in range(first*2,first*2+200)) < .2
raw = out.with_suffix('.f32')
raw.write_bytes(processed[round(78*sr)*2:].tobytes())
subprocess.run(['ffmpeg','-v','error','-y','-i',str(base),'-f','f32le','-ar',str(sr),'-ac','2','-i',str(raw),'-filter_complex','[0:a]volume=5dB[sfx];[sfx][1:a]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.9:level=false:latency=1[a]','-map','0:v','-map','[a]','-c:v','copy','-c:a','aac','-b:a','192k','-ar',str(sr),'-movflags','+faststart',str(out)],check=True)
raw.unlink()
def vhash(path):
    return run('ffmpeg','-v','error','-i',str(path),'-map','0:v','-c','copy','-f','hash','-')
assert vhash(out) == vhash(base)
meta=json.loads(run('ffprobe','-v','error','-show_streams','-of','json',str(out)))
v=next(s for s in meta['streams'] if s['codec_type']=='video')
assert v['nb_frames']=='280' and abs(float(v['duration'])-(duration-78))<.001
mixed=array.array('f',run('ffmpeg','-v','error','-i',str(out),'-vn','-ac','2','-ar',str(sr),'-f','f32le','-'))
peak=max(map(abs,mixed))
assert peak<1
assert max(map(abs,mixed[round((86.85-78)*sr)*2:])) < .001
print(json.dumps({'output':str(out),'peak_dbfs':20*math.log10(peak),'music_prefix_exact':True,'picture_hash_equal':True,'ending':[start,end],'source_ending_start':source_start,'frames':v['nb_frames']}))
