from pathlib import Path
import subprocess,array,math,json
root=Path(__file__).resolve().parents[1];base=root/'out/alook-gtm-full-2026-09-24-r14.mp4';source=root/'public/bgm/jazz-funk/02-gimme-that-groove.mp3';out=root/'out/alook-gtm-groove-subtle-v2.mp4';original=root/'out/alook-gtm-final.mp4'
hits=[22.6,29.233333,69.733333]
expression='1'
for hit in hits:
 a=hit-.16;b=hit-.04;c=hit+.04
 expression=f"({expression})*if(between(t,{a},{b}),1-0.4*(t-{a})/{b-a},if(between(t,{b},{c}),0.6+0.4*(t-{b})/{c-b},1))"
filt=f"[1:a]atrim=0:82.3,asetpts=PTS-STARTPTS,loudnorm=I=-21:TP=-3:LRA=11,aresample=48000,volume='if(lt(t,11.1),0.82,if(lt(t,26.1),0.65,if(lt(t,69.73),0.9,1)))':eval=frame,volume='{expression}':eval=frame,afade=t=in:d=0.25,afade=t=out:st=80.5:d=1.8,apad,atrim=duration=85.833333[m];[0:a][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.9:level=false:latency=1[a]"
subprocess.run(['ffmpeg','-v','error','-y','-i',str(base),'-i',str(source),'-filter_complex',filt,'-map','0:v','-map','[a]','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-movflags','+faststart',str(out)],check=True)
def run(*args):return subprocess.check_output(args)
def pcm(p):return array.array('h',run('ffmpeg','-v','error','-i',str(p),'-vn','-ac','1','-ar','48000','-f','s16le','-'))
def vh(p):return run('ffmpeg','-v','error','-i',str(p),'-map','0:v','-c','copy','-f','hash','-')
assert vh(out)==vh(original)
x,y=pcm(out),pcm(original);assert len(x)==len(y);assert max(map(abs,x))<32760;assert max(map(abs,x[round(83.35*48000):]))<10
def reference_pcm(filtergraph):return array.array('h',run('ffmpeg','-v','error','-i',str(base),'-i',str(source),'-filter_complex',filtergraph,'-map','[a]','-ac','1','-ar','48000','-f','s16le','-'))
raw=reference_pcm(filt);normal=reference_pcm(filt.replace(",volume='"+expression+"':eval=frame",''))
for a,b in [(1,10),(12,21),(24,28),(31,60),(72,80)]:
 residual=math.sqrt(sum((raw[i]-normal[i])**2 for i in range(a*48000,b*48000))/((b-a)*48000));assert residual==0,(a,b,residual);print('Outside cues',a,b,'residual RMS',round(residual,3))
for h in hits:assert max(abs(x[i]-y[i]) for i in range(round((h-.16)*48000),round((h+.04)*48000)))>100
print('PASS: original arrangement/speed preserved; differences confined to3 brief cue windows,unchanged picture,no clipping,silent CTA')
