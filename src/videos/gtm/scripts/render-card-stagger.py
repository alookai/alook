from pathlib import Path
import subprocess
root=Path(__file__).resolve().parents[1]
patches=[(0,95),(1066,1161),(1486,1581),(2102,2197)]
for i,(start,end) in enumerate(patches):
    subprocess.run(['pnpm','exec','remotion','render','build','AlookCleanReview',f'out/card-stagger-{i}.mp4','--frames',f'{start}-{end}','--codec','h264','--crf','18','--concurrency','2','--browser-executable','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],cwd=root,check=True)
cmd=['ffmpeg','-v','error','-y','-i','out/alook-clean-milo-direct.mp4']
for i in range(4):cmd+=['-i',f'out/card-stagger-{i}.mp4']
filters=[]
for i,(start,end) in enumerate([(78,1048),(1126,1450),(1528,2048),(2126,2975)]):
    filters += [f'[{i+1}:v]settb=1/30,setpts=N[p{i}]',f'[0:v]trim=start_frame={start}:end_frame={end},settb=1/30,setpts=N[d{i}]']
filters+=[''.join(f'[p{i}][d{i}]' for i in range(4))+'concat=n=8:v=1:a=0[v]']
cmd+=['-filter_complex',';'.join(filters),'-map','[v]','-an','-c:v','libx264','-preset','fast','-crf','18','-r','30','-video_track_timescale','15360','out/alook-card-stagger-picture.mp4']
subprocess.run(cmd,cwd=root,check=True)
