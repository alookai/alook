from pathlib import Path
import subprocess
root=Path(__file__).resolve().parents[1]
subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','anoisesrc=color=pink:amplitude=0.7:duration=2:sample_rate=48000:seed=714','-af','highpass=f=90,lowpass=f=1300:p=2,lowpass=f=1300:p=2,afade=t=in:st=0:d=1.62:curve=qsin,afade=t=out:st=1.62:d=0.38:curve=qsin','-ac','1','-c:a','pcm_s16le',str(root/'public/sfx/source/14-soft-air.wav')],check=True)
