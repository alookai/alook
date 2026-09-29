from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
def run(*args):
    subprocess.run(args, cwd=root, check=True)

run(sys.executable, 'scripts/mix-sfx.py')
run('npx','remotion','render','AlookLaunchReview','out/alook-launch-sfx-picture.mp4','--muted','--codec=h264','--crf=18','--concurrency=2')
run('ffmpeg','-y','-v','error','-i','out/alook-launch-sfx-picture.mp4','-i','public/sfx/launch-sfx.wav','-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart','out/alook-launch-with-sfx.mp4')
run(sys.executable,'scripts/verify-sfx.py')
