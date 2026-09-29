from pathlib import Path
import array, math, subprocess
root=Path(__file__).resolve().parents[1]
source=(root/'scripts/mix-clean-audio.py').read_text().split('result = array.array')[0]
source=source.replace('return 3.1 + output_times','return 4.1 + output_times').replace('10.9 + offset','11.9 + offset').replace('15.213,','16.213,')
ns={'__file__':str(root/'scripts/mix-clean-audio.py')}
exec(source,ns)
sr=48000
duration=522/30
sfx,music=ns['sfx'],ns['music']
result=array.array('f')
for i in range(round(duration*sr)):
    t=i/sr
    fade=min(1,t/.25,(duration-t)/.12)
    for ch in range(2):
        result.append((music[i*2+ch]*.82+sfx[i])*fade)
assert max(map(abs,result))<1
raw=root/'out/first-act-one-second.f32'
raw.write_bytes(result.tobytes())
subprocess.run(['ffmpeg','-v','error','-y','-i',str(root/'out/first-act-one-second-card.mp4'),'-i',str(root/'out/alook-card-stagger-picture.mp4'),'-f','f32le','-ar',str(sr),'-ac','2','-i',str(raw),'-filter_complex','[0:v]settb=1/30,setpts=N[a];[1:v]trim=start_frame=96:end_frame=492,settb=1/30,setpts=N[b];[a][b]concat=n=2:v=1:a=0[v]','-map','[v]','-map','2:a','-c:v','libx264','-preset','fast','-crf','18','-r','30','-video_track_timescale','15360','-c:a','aac','-b:a','192k','-movflags','+faststart',str(root/'out/alook-first-act-1s-question.mp4')],check=True)
raw.unlink()
print('Exported 522-frame first act with 1-second line entrances and remapped SFX.')
