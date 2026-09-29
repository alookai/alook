import subprocess,json
from pathlib import Path
from PIL import Image,ImageDraw,ImageChops,ImageStat
r=Path(__file__).resolve().parents[1]/'out';v=r/'alook-ending-laptop-depth.mp4'
s=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(v)]))['streams'];assert len(s)==1;assert (s[0]['width'],s[0]['height'],int(s[0]['nb_frames']))==(1920,1080,666)
frames=[0,59,60,105,180,285,360,425,450,495,570,665];c=Image.new('RGB',(1200,1000),'#ddd');d=ImageDraw.Draw(c)
for i,f in enumerate(frames):
 p=r/f'end-laptop-depth-qa-{f}.png';subprocess.run(['ffmpeg','-v','error','-i',str(v),'-vf',f'select=eq(n\\,{f})','-frames:v','1','-y',str(p)],check=True);im=Image.open(p);im.thumbnail((400,225));x=i%3*400;y=i//3*250;c.paste(im,(x,y));d.text((x+5,y+228),f'{f/30:.3f}s / frame {f}',fill='black')
c.save(r/'end-laptop-depth-qa.jpg');print('PASS 666 frames, silent, 1080p; 12 encoded samples including final frame665')

a,b=[Image.open(r/f"end-laptop-depth-qa-{f}.png").convert("RGB").crop((0,0,1920,850)) for f in [59,60]]
error=sum(ImageStat.Stat(ImageChops.difference(a,b)).mean)/3
assert error<1
region=a.crop((100,300,1800,600))
white=sum(min(p)>250 for p in region.getdata())/(region.width*region.height)
assert white>.75, f"Closeup clipped: {white}"
print(f"Join error {error:.6f}; content canvas {white:.1%}")
