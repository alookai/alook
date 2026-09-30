import json,subprocess
from pathlib import Path
from PIL import Image,ImageDraw,ImageChops,ImageStat
r=Path(__file__).resolve().parents[1]/'out'
v=r/'alook-full-pruned.mp4'
streams=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(v)]))['streams']
assert len(streams)==1
assert (streams[0]['width'],streams[0]['height'],int(streams[0]['nb_frames']))==(1920,1080,2487)
frames=[0,60,150,235,323,395,440,515,570,605,677,775,934,1050,1091,1092,1150,1210,1374,1520,1584,1660,1733,1903,2040,2144,2145,2180,2220,2240,2260,2280,2330,2400,2486]
canvas=Image.new('RGB',(1600,250*((len(frames)+3)//4)),'#ddd');draw=ImageDraw.Draw(canvas)
for i,f in enumerate(frames):
 p=r/f'pruned-qa-{f}.png'
 subprocess.run(['ffmpeg','-v','error','-i',str(v),'-vf',f'select=eq(n\\,{f})','-frames:v','1','-y',str(p)],check=True)
 im=Image.open(p);im.thumbnail((400,225));x=i%4*400;y=i//4*250;canvas.paste(im,(x,y));draw.text((x+5,y+228),f'{f/30:.3f}s / frame {f}',fill='black')
canvas.save(r/'pruned-film-qa.jpg')
for a,b in [(1091,1092),(2144,2145)]:
 im1,im2=[Image.open(r/f'pruned-qa-{f}.png').convert('RGB').crop((0,0,1920,850)) for f in [a,b]]
 error=sum(ImageStat.Stat(ImageChops.difference(im1,im2)).mean)/3
 assert error<1,f'Join shifted {a}→{b}: {error}'
 print(f'Join {a}→{b}: mean pixel error {error:.6f}')
region=Image.open(r/'pruned-qa-2144.png').convert('RGB').crop((100,300,1800,600))
white=sum(min(p)>250 for p in region.getdata())/(region.width*region.height)
assert white>.75,f'Closeup clipped: {white}'
print('PASS:82.9s,2487frames,1080p,silent;35 encoded QA samples including final2486; joins and closeup intact.')
