from pathlib import Path
import subprocess,json,array,math
root=Path(__file__).resolve().parents[1]
base=root/'out/alook-gtm-full-2026-09-24-r13.mp4';source=root/'public/bgm/jazz-funk/02-gimme-that-groove.mp3';out=root/'out/alook-gtm-groove-impact-v2.mp4'
sections=[
 ('relay',0,8.05,6.435,1.06,.78,'anull',.025,.10),
 ('flood',8.2,10.07,31.345,1.10,1.0,'anull',.012,.09),
 ('overload',10.2,10.78,33.22,1.0,.8,'lowpass=f=1400',.008,.18),
 ('question',11.1,22.40,18.89,1.04,.6,'lowpass=f=3200',.04,.14),
 ('alook-logo',22.60,28.95,40.72,1.06,1.05,'anull',.009,.13),
 ('milo-card',29.233333,41.10,53.175,1.06,.96,'anull',.008,.12),
 ('family',41.30,49.80,6.435,1.04,.63,'anull',.035,.15),
 ('agents',50.60,64.75,62.15,1.07,.98,'anull',.01,.15),
 ('lin-reaction',64.933333,69.50,18.89,1.04,.62,'lowpass=f=3200',.03,.14),
 ('network',69.733333,78.53,55.72,1.10,1.1,'anull',.007,.10),
 ('logo-close',78.733333,82.30,78.89,1.0,1.0,'anull',.007,.45),
]
filters=['[1:a]loudnorm=I=-21:TP=-3:LRA=11,aresample=48000,asplit='+str(len(sections))+''.join(f'[s{i}]' for i in range(len(sections)))]
for i,(name,start,end,src,tempo,gain,effect,fi,fo) in enumerate(sections):
 d=end-start
 filters.append(f'[s{i}]atrim=start={src}:end={src+d*tempo:.8f},asetpts=PTS-STARTPTS,atempo={tempo},{effect},apad,atrim=duration={d:.8f},volume={gain},afade=t=in:d={fi},afade=t=out:st={d-fo:.8f}:d={fo},adelay={round(start*48000)}S:all=1[m{i}]')
filters.append('[0:a]'+''.join(f'[m{i}]' for i in range(len(sections)))+f'amix=inputs={len(sections)+1}:duration=first:normalize=0,alimiter=limit=0.9:level=false:latency=1[a]')
subprocess.run(['ffmpeg','-v','error','-y','-i',str(base),'-i',str(source),'-filter_complex',';'.join(filters),'-map','0:v','-map','[a]','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-movflags','+faststart',str(out)],check=True)
(root/'out/groove-impact-cues.json').write_text(json.dumps([dict(zip(['scene','start','end','sourceStart','tempo','gain','filter','fadeIn','fadeOut'],s)) for s in sections],indent=2)+'\n')
def run(*args):return subprocess.check_output(args)
def pcm(p):return array.array('h',run('ffmpeg','-v','error','-i',str(p),'-vn','-ac','1','-ar','48000','-f','s16le','-'))
def vh(p):return run('ffmpeg','-v','error','-i',str(p),'-map','0:v','-c','copy','-f','hash','-')
assert vh(out)==vh(base)
v=next(s for s in json.loads(run('ffprobe','-v','error','-show_streams','-of','json',str(out)))['streams'] if s['codec_type']=='video')
assert v['nb_frames']=='2575' and v['avg_frame_rate']=='30/1' and abs(float(v['duration'])-85.833333)<.001
x,y=pcm(out),pcm(base);assert max(map(abs,x))<32760;assert max(map(abs,x[round(83.35*48000):]))<10
music=lambda a,b:math.sqrt(sum((x[i]-y[i])**2 for i in range(round(a*48000),round(b*48000)))/round((b-a)*48000))
for name,start,end,*_ in sections:
 rms=music(start+.06,min(end-.08,start+.4));assert rms>30;print(name,round(20*math.log10(rms/32768),1),'dBFS',flush=True)
for gap,hit in [(22.48,22.65),(29.05,29.29),(69.6,69.80),(78.62,78.80)]:assert music(gap,gap+.04)<music(hit,hit+.04)*.15
print('PASS: identical picture,2575frames,pitch-preserving atempo,no clipping,4 key pauses/reentries,silent CTA')
