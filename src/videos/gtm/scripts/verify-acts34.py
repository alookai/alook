import json, subprocess, sys
from pathlib import Path
video=sys.argv[1] if len(sys.argv)>1 else 'out/alook-acts3-4-readable-switch.mp4'
meta=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',video]))
assert abs(float(meta['format']['duration'])-40)<.04
v=next(x for x in meta['streams'] if x['codec_type']=='video')
assert (v['width'],v['height'],int(v['nb_frames']))==(1920,1080,1200)
assert not any(x['codec_type']=='audio' for x in meta['streams'])
for start,duration in [(6.1,5.8)]:
 raw=subprocess.check_output(['ffmpeg','-v','error','-ss',str(start),'-i',video,'-t',str(duration),'-vf','crop=2:1080:135:0,format=rgb24','-f','rawvideo','-'])
 heights=[]
 for f in range(len(raw)//6480):
  column=raw[f*6480:(f+1)*6480]
  heights.append(sum(all(abs(column[y*6+c]-[234,231,223][c])<10 for c in range(3)) for y in range(450,750)))
 assert min(heights)>80 and max(heights)-min(heights)<8,(start,min(heights),max(heights))
 print('PASS stable composer',start,len(heights),min(heights),max(heights))
out=Path('out/schedule-qa');out.mkdir(exist_ok=True)
for t in [19.96,20,21.3,23,26.3,26.5,27.5,28.3,29,30.5,32.5,36,39.96]:
 subprocess.run(['ffmpeg','-v','error','-ss',str(t),'-i',video,'-frames:v','1','-y',str(out/f'{t}.png')],check=True)
print('PASS 40s/1200frames, 1080p, muted. Encoded transition, boundary, rail clicks, messages and last frame extracted.')

raw=subprocess.check_output(['ffmpeg','-v','error','-ss','19.5','-i',video,'-t','1.1','-vf','crop=2:600:300:0,format=rgb24','-f','rawvideo','-'])
bounds=[]
for n in range(len(raw)//3600):
 column=raw[n*3600:(n+1)*3600]
 ys=[y for y in range(360,590) if max(column[y*6:y*6+3])<110]
 assert ys, n
 bounds.append((min(ys),max(ys)))
assert max(b[0] for b in bounds)-min(b[0] for b in bounds)<=2,bounds
assert max(b[1] for b in bounds)-min(b[1] for b in bounds)<=2,bounds
print('PASS join regression:',len(bounds),'frames; text bounds',sorted(set(bounds)))
