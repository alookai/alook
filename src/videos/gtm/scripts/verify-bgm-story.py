from pathlib import Path
import subprocess,json,array,math
root=Path(__file__).resolve().parents[1]
p=root/'out/bgm-auditions/03-story-edit-v4.mp4';base=root/'out/alook-gtm-full-2026-09-24-r9.mp4'
def pcm(path):return array.array('h',subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-vn','-ac','1','-ar','48000','-f','s16le','-']))
def video_hash(path):return subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-map','0:v','-c','copy','-f','hash','-'])
x,y=pcm(p),pcm(base)
meta=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(p)]))
v=next(s for s in meta['streams'] if s['codec_type']=='video')
assert v['nb_frames']=='2578' and v['avg_frame_rate']=='30/1' and abs(float(v['duration'])-85.933333)<.001
assert video_hash(p)==video_hash(base)
assert max(map(abs,x))<32760
assert max(map(abs,x[round(83.45*48000):]))<10
music=lambda a,b:math.sqrt(sum((x[i]-y[i])**2 for i in range(round(a*48000),round(b*48000)))/round((b-a)*48000))
assert music(11.56,11.8)<music(10.5,11.2)*.2,'Missing musical pause'
assert music(26.61,26.69)<music(26.8,27.2)*.2,'Missing reveal break/downbeat'
for name,a,b in [('opening',8,10),('question',18,20),('reveal',28,30),('home',43,45),('collaboration',57,59),('network',72.7,74.7),('spin',77.5,78.3),('logo',78.9,79.9)]:
 r=music(a,b);assert r>20;print(name,round(20*math.log10(r/32768),1),'dBFS difference RMS')
print('PASS: unchanged picture,85.933s,CFR30,no clipping,story pauses,all music sections,clean CTA tail')
