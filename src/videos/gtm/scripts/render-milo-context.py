from pathlib import Path
import subprocess, json
root=Path(__file__).resolve().parents[1]
base='out/alook-full-08s-with-audio.mp4'
scene='out/milo-context-scene.mp4'
out='out/alook-full-milo-local-context.mp4'
def run(args):
    return subprocess.check_output(args,cwd=root)
filters='[0:v]trim=end_frame=1297,settb=1/30,setpts=N[a];[1:v]settb=1/30,setpts=N[b];[0:v]trim=start_frame=1513,settb=1/30,setpts=N[c];[a][b][c]concat=n=3:v=1:a=0[v]'
run(['ffmpeg','-v','error','-y','-i',base,'-i',scene,'-filter_complex',filters,'-map','[v]','-map','0:a','-c:v','libx264','-preset','fast','-crf','18','-r','30','-video_track_timescale','15360','-c:a','copy','-movflags','+faststart',out])
meta=json.loads(run(['ffprobe','-v','error','-count_frames','-show_streams','-of','json',out]))
v=next(s for s in meta['streams'] if s['codec_type']=='video')
assert int(v['nb_read_frames'])==3092
assert (v['width'],v['height'],v['avg_frame_rate'])==(1920,1080,'30/1')
def ahash(path):
    return run(['ffmpeg','-v','error','-i',path,'-map','0:a','-c','copy','-f','hash','-']).decode().strip()
assert ahash(base)==ahash(out)
report={'output':out,'frames':3092,'duration':3092/30,'replacedFrames':[1297,1512],'audioHashEqual':True}
(root/'out/milo-context-qa.json').write_text(json.dumps(report,indent=2)+'\n')
for n in [1296,1355,1363,1380,1512,1513,3091]:
    run(['ffmpeg','-v','error','-y','-i',out,'-vf',f'select=eq(n\\,{n})','-frames:v','1',f'out/milo-context-{n}.png'])
print(json.dumps(report))
