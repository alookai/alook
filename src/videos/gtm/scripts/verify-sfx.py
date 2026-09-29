from pathlib import Path
import array,json,subprocess,sys
root=Path(__file__).resolve().parents[1]
video=Path(sys.argv[1]) if len(sys.argv)>1 else root/'out/alook-launch-with-sfx.mp4'
report=json.loads((root/'public/sfx/cues.json').read_text())
meta=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(video)]))
v=next(s for s in meta['streams'] if s['codec_type']=='video');a=next(s for s in meta['streams'] if s['codec_type']=='audio')
assert int(v['nb_frames'])==report['frames'] and v['avg_frame_rate']=='30/1'
assert abs(float(v['duration'])-report['duration'])<.001
assert (v['width'],v['height'],a['sample_rate'])==(1920,1080,'48000')
pcm=array.array('h',subprocess.check_output(['ffmpeg','-v','error','-i',str(video),'-vn','-ac','1','-ar','48000','-f','s16le','-']))
assert max(map(abs,pcm))<32760
for cue in report['cues']:
 start=cue['startSample'];assert max(map(abs,pcm[start:start+cue['samples']]))>100,f'Missing cue: {cue}'
close=next(c for c in report['cues'] if c['sound']=='10');target=close['frame']*1600
impact=max(range(target-4800,target+4800),key=lambda i:abs(pcm[i]))
assert abs(impact-target)<1600
assert max(map(abs,pcm[-48000:]))<10
print(f"PASS: {report['frames']} frames,1080p30,{len(report['cues'])} cues,no clipping,lid peak {impact/48000:.5f}s,silent CTA")
