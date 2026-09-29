from pathlib import Path
import subprocess
root=Path(__file__).resolve().parents[1]
for i,(start,end) in enumerate([(1084,1188),(1513,1617),(2138,2242)]):
    subprocess.run(['pnpm','exec','remotion','render','build','AlookCleanReview',f'out/card-point-eight-{i}.mp4','--frames',f'{start}-{end}','--codec','h264','--crf','18','--concurrency','1','--browser-executable','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],cwd=root,check=True)
cmd=['ffmpeg','-v','error','-y','-i','out/alook-clean-milo-direct.mp4','-i','out/alook-first-act-no-flash.mp4']
for i in range(3):cmd+=['-i',f'out/card-point-eight-{i}.mp4']
filters=['[1:v]settb=1/30,setpts=N[opening]']
for i,(start,end) in enumerate([(474,1048),(1126,1450),(1528,2048),(2126,2975)]):
    filters.append(f'[0:v]trim=start_frame={start}:end_frame={end},settb=1/30,setpts=N[d{i}]')
    if i<3:filters.append(f'[{i+2}:v]settb=1/30,setpts=N[c{i}]')
filters+=['[opening][d0][c0][d1][c1][d2][c2][d3]concat=n=8:v=1:a=0[v]']
cmd+=['-filter_complex',';'.join(filters),'-map','[v]','-an','-c:v','libx264','-preset','fast','-crf','18','-r','30','-video_track_timescale','15360','out/alook-full-08s-picture.mp4']
subprocess.run(cmd,cwd=root,check=True)
