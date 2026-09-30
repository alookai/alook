from pathlib import Path
import subprocess
root=Path(__file__).resolve().parents[1]
def run(args):return subprocess.check_output(args,cwd=root)
filters='[0:v]trim=end_frame=2100,settb=1/30,setpts=N[a];[1:v]trim=end_frame=119,settb=1/30,setpts=N[b];[0:v]trim=start_frame=2219,settb=1/30,setpts=N[c];[a][b][c]concat=n=3:v=1:a=0[v]'
run(['ffmpeg','-v','error','-y','-i','out/alook-full-milo-local-context.mp4','-i','out/invite-card-fixed.mp4','-filter_complex',filters,'-map','[v]','-an','-c:v','libx264','-preset','fast','-crf','18','-r','30','-video_track_timescale','15360','out/alook-invite-card-fixed-picture.mp4'])
source=(root/'scripts/mix-full-point-eight.py').read_text()
source=source.replace('out/alook-full-08s-picture.mp4','out/alook-invite-card-fixed-picture.mp4').replace('out/alook-full-08s-with-audio.mp4','out/alook-full-invite-card-fixed.mp4').replace('[1084, 1513, 2138]','[1084, 1513, 2107]').replace('out/full-08s-audio-qa.json','out/invite-card-audio-qa.json')
exec(compile(source,'mix-invite-card-fix','exec'),{'__file__':str(root/'scripts/mix-full-point-eight.py')})
out='out/alook-full-invite-card-fixed.mp4'
for n in [2105,2106,2107,2108,2155,2220,2240,2242,2243,3091]:
 run(['ffmpeg','-v','error','-y','-i',out,'-vf',f'select=eq(n\\,{n})','-frames:v','1',f'out/invite-card-{n}.png'])
run(['ffmpeg','-v','error','-y','-ss','68','-i',out,'-t','8','-c:v','libx264','-crf','18','-c:a','aac','-b:a','192k','out/invite-card-review.mp4'])
