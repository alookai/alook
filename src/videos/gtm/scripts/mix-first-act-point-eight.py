from dataclasses import replace
from audio_tracks import CLEAN_PROFILE, build_opening_sfx, normalize_sfx, load_music
from pathlib import Path
import array, math, subprocess
root=Path(__file__).resolve().parents[1]
profile = replace(CLEAN_PROFILE, opening_offset=3.7, join_start=11.5, drop_end=15.813)
track, cues = build_opening_sfx(root, profile)
sfx, music = normalize_sfx(track), load_music(root)
sr=48000
duration=510/30
result=array.array('f')
for i in range(round(duration*sr)):
    t=i/sr
    fade=min(1,t/.25,(duration-t)/.12)
    for ch in range(2):
        result.append((music[i*2+ch]*.82+sfx[i])*fade)
assert max(map(abs,result))<1
raw=root/'out/first-act-point-eight.f32'
raw.write_bytes(result.tobytes())
subprocess.run(['ffmpeg','-v','error','-y','-i',str(root/'out/first-act-point-eight-card.mp4'),'-i',str(root/'out/alook-card-stagger-picture.mp4'),'-f','f32le','-ar',str(sr),'-ac','2','-i',str(raw),'-filter_complex','[0:v]settb=1/30,setpts=N[a];[1:v]trim=start_frame=96:end_frame=492,settb=1/30,setpts=N[b];[a][b]concat=n=2:v=1:a=0[v]','-map','[v]','-map','2:a','-c:v','libx264','-preset','fast','-crf','18','-r','30','-video_track_timescale','15360','-c:a','aac','-b:a','192k','-movflags','+faststart',str(root/'out/alook-first-act-08s-question.mp4')],check=True)
raw.unlink()
print('Exported 510-frame first act with 0.8-second line entrances and remapped SFX.')
