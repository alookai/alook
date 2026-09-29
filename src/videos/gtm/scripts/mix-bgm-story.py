from pathlib import Path
import json,subprocess,sys
root=Path(__file__).resolve().parents[1]
source=root/'public/bgm/candidates/03-pop-track-03.mp3'
video=root/'out/alook-gtm-full-2026-09-24-r9.mp4'
output=root/'out/bgm-auditions/03-story-edit-v4.mp4'
segments=[
 ('relay',0,11.5,.05,13.261,.46,'lowpass=f=950',.12,.15),
 ('question',11.85,26.55,52.899,66.11,.65,'highpass=f=200,lowpass=f=2000',.15,.18),
 ('alook-reveal',26.7,41.35,35.284,48.495,.82,'anull',.025,.07),
 ('home',41.35,50.2,.05,8.857,.60,'lowpass=f=2200',.04,.07),
 ('collaboration',50.2,65.033333,61.706,74.917,.85,'anull',.025,.08),
 ('lin-lift',65.033333,69.833333,.05,4.454,.48,'highpass=f=220,lowpass=f=1700',.04,.13),
 ('network',69.833333,77.083333,79.321,88.128,1.0,'anull',.025,.12),
 ('spin',77.083333,78.833333,86.4,88.15,6.0,'highpass=f=2500,lowpass=f=9500,areverse',1.65,.08),
 ('logo',78.833333,82.40,90.601,94.167667,.9,'anull',.025,.18),
]
filters=['[1:a]loudnorm=I=-20:TP=-4:LRA=11,aresample=48000,asplit=9'+''.join(f'[s{i}]' for i in range(9))]
for i,(name,start,end,a,b,gain,effect,fadein,fadeout) in enumerate(segments):
 dur=end-start;tempo=(b-a)/dur
 filters.append(f'[s{i}]atrim=start={a}:end={b},asetpts=PTS-STARTPTS,atempo={tempo:.9f},{effect},apad,atrim=duration={dur:.9f},afade=t=in:st=0:d={fadein},afade=t=out:st={dur-fadeout:.9f}:d={fadeout},volume={gain},adelay={round(start*48000)}S:all=1[m{i}]')
filters.append('[0:a]'+''.join(f'[m{i}]' for i in range(9))+'amix=inputs=10:duration=first:normalize=0,alimiter=limit=0.9:level=false:latency=1[a]')
subprocess.run(['ffmpeg','-y','-v','error','-i',str(video),'-i',str(source),'-filter_complex',';'.join(filters),'-map','0:v','-map','[a]','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-movflags','+faststart',str(output)],check=True)
(root/'out/bgm-auditions/03-story-edit-v4-cues.json').write_text(json.dumps([dict(zip(['scene','start','end','sourceStart','sourceEnd','gain','filter','fadeIn','fadeOut'],s)) for s in segments],indent=2)+'\n')
print(output)
