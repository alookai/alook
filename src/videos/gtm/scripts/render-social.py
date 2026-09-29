from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parents[1]
def run(*args):subprocess.run(args,cwd=root,check=True)
run(sys.executable,'scripts/mix-sfx.py')
run('npx','remotion','render','AlookSocialEnding','out/social-ending-picture.mp4','--muted','--codec=h264','--crf=18','--concurrency=2')
run('ffmpeg','-y','-v','error','-i','out/social-ending-picture.mp4','-ss',str(1915/30),'-i','public/sfx/launch-sfx.wav','-map','0:v:0','-map','1:a:0','-t',str(627/30),'-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart','out/alook-social-ending.mp4')
run(sys.executable,'scripts/verify-social.py')
