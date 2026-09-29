from pathlib import Path
import json,subprocess,array
r=Path(__file__).resolve().parents[1]
p=r/'out/alook-pr-opening.mp4'
m=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(p)]))
v=next(s for s in m['streams'] if s['codec_type']=='video');a=next(s for s in m['streams'] if s['codec_type']=='audio')
assert (int(v['nb_frames']),v['width'],v['height'],v['r_frame_rate'])==(333,1920,1080,'30/1')
assert abs(float(a['duration'])-11.1)<.025
pcm=array.array('h',subprocess.check_output(['ffmpeg','-v','error','-i',str(p),'-vn','-ar','48000','-ac','1','-f','s16le','-']))
assert max(map(abs,pcm))<32760
cues=[c for c in json.loads((r/'public/sfx/cues.json').read_text())['cues'] if c['frame']<333]
assert len(cues)==23
for c in cues: assert max(map(abs,pcm[c['startSample']:c['startSample']+c['samples']]))>100
print('PASS: 11.1s/333frames,1080p30,AAC; all23 PR interaction cues present; no clipping')
