from pathlib import Path
import array, math, subprocess
root=Path(__file__).resolve().parents[1]
source=(root/'scripts/mix-clean-audio.py').read_text().split('result = array.array')[0]
source=source.replace('return 3.1 + output_times','return 3.7 + output_times').replace('10.9 + offset','11.5 + offset').replace('15.213,','15.813,')
source=source.replace('for t in [1.62, 2.45, 3.3, 3.6, 3.85]', 'for t in [1.62, 2.45, 3.35, 3.6, 3.85]')
ns={'__file__':str(root/'scripts/mix-clean-audio.py')}
exec(source,ns)
sr=48000
duration=510/30
sfx,music=ns['sfx'],ns['music']
result=array.array('f')
for i in range(round(duration*sr)):
    t=i/sr
    fade=min(1,t/.25,(duration-t)/.12)
    for ch in range(2):
        result.append((music[i*2+ch]*.82+sfx[i])*fade)
assert max(map(abs,result))<1
raw=root/'out/first-act-point-eight.f32'
raw.write_bytes(result.tobytes())
subprocess.run(['ffmpeg','-v','error','-y','-i',str(root/'out/alook-first-act-cursor-picture.mp4'),'-f','f32le','-ar',str(sr),'-ac','2','-i',str(raw),'-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart',str(root/'out/alook-first-act-cursor-fixed.mp4')],check=True)
raw.unlink()
print('Exported 510-frame first act with 0.8-second line entrances and remapped SFX.')
