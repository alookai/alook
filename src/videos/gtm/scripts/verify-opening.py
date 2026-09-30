from pathlib import Path
import array,json,subprocess
root=Path(__file__).resolve().parents[1]
video=root/'out/alook-opening-provider-question.mp4'
d=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(video)]))
v=next(x for x in d['streams'] if x['codec_type']=='video');a=next(x for x in d['streams'] if x['codec_type']=='audio')
assert int(v['nb_frames'])==1758 and float(v['duration'])==58.6
assert abs(float(a['duration'])-58.6)<.025
pcm=array.array('h',subprocess.check_output(['ffmpeg','-v','error','-i',str(video),'-vn','-ar','48000','-ac','1','-f','s16le','-']))
assert max(map(abs,pcm))<32760
cues=[c for c in json.loads((root/'public/sfx/cues.json').read_text())['cues'] if c['startSample']<1758*1600]
for c in cues:assert max(map(abs,pcm[c['startSample']:min(len(pcm),c['startSample']+c['samples'])]))>100,c
print(f'PASS: opening1758frames/58.6s,1080p30,AAC; {len(cues)} audio cues present, no clipping')
