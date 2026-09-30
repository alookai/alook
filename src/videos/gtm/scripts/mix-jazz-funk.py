from pathlib import Path
import subprocess,json,array,math
root=Path(__file__).resolve().parents[1]
base=root/'out/alook-gtm-full-2026-09-24-r17.mp4'
def run(*args):return subprocess.check_output(args)
def vhash(p):return run('ffmpeg','-v','error','-i',str(p),'-map','0:v','-c','copy','-f','hash','-')
def pcm(p):return array.array('h',run('ffmpeg','-v','error','-i',str(p),'-vn','-ac','1','-ar','48000','-f','s16le','-'))
reference=vhash(base);dry=pcm(base)
for name in ['03-dirty-thinkin']:
 source=root/f'public/bgm/jazz-funk/{name}.mp3';out=root/f'out/bgm-jazz-funk/{name}-v11.mp4'
 filt="[1:a]atrim=0:85.0,asetpts=PTS-STARTPTS,loudnorm=I=-21:TP=-3:LRA=11,aresample=48000,volume='if(lt(t,11.1),0.82,if(lt(t,26.1),0.65,if(lt(t,69.73),0.9,1)))':eval=frame,afade=t=in:d=0.25,afade=t=out:st=83.2:d=1.8,apad,atrim=duration=86.333333[m];[0:a]volume=5dB[sfx];[sfx][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.9:level=false:latency=1[a]"
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(base),'-i',str(source),'-filter_complex',filt,'-map','0:v','-map','[a]','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-movflags','+faststart',str(out)],check=True)
 meta=json.loads(run('ffprobe','-v','error','-show_streams','-of','json',str(out)));v=next(s for s in meta['streams'] if s['codec_type']=='video')
 assert v['nb_frames']=='2590' and v['avg_frame_rate']=='30/1' and abs(float(v['duration'])-86.333333)<.001
 assert vhash(out)==reference
 x=pcm(out);assert max(map(abs,x))<32760;assert max(map(abs,x[round(85.1*48000):]))<10
 for a,b in [(1,10),(15,20),(30,40),(55,60),(72,78)]:
  d=[x[i]-dry[i] for i in range(a*48000,b*48000)];assert math.sqrt(sum(n*n for n in d)/len(d))>50
 print('PASS',name,'unchanged picture,2590frames,no clipping,music present,CTA silent',flush=True)
