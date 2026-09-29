import subprocess, json, sys
from pathlib import Path
video=sys.argv[1] if len(sys.argv)>1 else 'out/alook-acts2-3-paced-large-input.mp4'
meta=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',video]))
assert abs(float(meta['format']['duration'])-41)<.05
assert meta['streams'][0]['width']==1920 and meta['streams'][0]['height']==1080
for start,duration in [(10.6,5.3),(27.1,5.8)]:
    raw=subprocess.check_output(['ffmpeg','-v','error','-ss',str(start),'-i',video,'-t',str(duration),'-vf','crop=2:1080:135:0,format=rgb24','-f','rawvideo','-'])
    heights=[]
    for f in range(len(raw)//6480):
        column=raw[f*6480:(f+1)*6480]
        ys=[y for y in range(450,750) if all(abs(column[y*6+c]-[234,231,223][c])<10 for c in range(3))]
        heights.append(len(ys))
    assert min(heights)>80, (start,min(heights))
    transitions=[(round(start+i/30,3),h) for i,h in enumerate(heights) if i==0 or abs(h-heights[i-1])>8]
    assert max(heights)-min(heights)<8,(start,transitions)
    print(f'PASS: {len(heights)} encoded typing frames at {start}s, composer strip height {min(heights)}–{max(heights)}px')
out=Path('out/paced-qa');out.mkdir(exist_ok=True)
times=[0.2,3,7.3,11,13,15.8,20.97,21,23.1,25.5,27.5,29.3,32.8,34.3,38,40.966]
for t in times:
    subprocess.run(['ffmpeg','-v','error','-ss',str(t),'-i',video,'-frames:v','1','-y',str(out/f'{t}.png')],check=True)
print('PASS: 1080p / 41s; extracted join, typing, invite and final encoded frames.')
