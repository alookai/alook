from pathlib import Path
import subprocess,json,array
root=Path(__file__).resolve().parents[1]
p=root/'out/alook-social-ending.mp4'
meta=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(p)]))
v=next(s for s in meta['streams'] if s['codec_type']=='video');a=next(s for s in meta['streams'] if s['codec_type']=='audio')
assert int(v['nb_frames'])==627 and v['r_frame_rate']=='30/1'
assert (v['width'],v['height'],a['sample_rate'])==(1920,1080,'48000')
pcm=array.array('h',subprocess.check_output(['ffmpeg','-v','error','-i',str(p),'-vn','-ac','1','-ar','48000','-f','s16le','-']))
assert max(map(abs,pcm))<32760
for frame in [1927,1969,2101,2117,2180,2441]:
 local=frame-1915
 assert max(map(abs,pcm[(local-1)*1600:(local+4)*1600]))>100
peak=max(range(524*1600,535*1600),key=lambda i:abs(pcm[i]))
assert abs(peak-526*1600)<1600
assert max(map(abs,pcm[round((82.25-1915/30)*48000):]))<10
print(f'PASS: 627 frames / 20.9s, 1080p30, 48kHz AAC; 6 cues, no clipping, lid peak {peak/48000:.5f}s, silent CTA')
