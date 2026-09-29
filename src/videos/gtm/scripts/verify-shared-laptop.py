import subprocess,json
from pathlib import Path
from PIL import Image,ImageDraw,ImageChops,ImageStat
r=Path(__file__).resolve().parents[1]/'out';v=r/'alook-act5-to-ending-shared-laptop.mp4'
s=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(v)]))['streams'];assert len(s)==1;assert (s[0]['width'],s[0]['height'],int(s[0]['nb_frames']))==(1920,1080,1206)
frames=[0,180,450,599,600,625,645,666,710,840,940,990,1020,1060,1125,1205];c=Image.new('RGB',(1200,1500),'#ddd');d=ImageDraw.Draw(c)
for i,f in enumerate(frames):
 p=r/f'end-shared-laptop-qa-{f}.png';subprocess.run(['ffmpeg','-v','error','-i',str(v),'-vf',f'select=eq(n\\,{f})','-frames:v','1','-y',str(p)],check=True);im=Image.open(p);im.thumbnail((400,225));x=i%3*400;y=i//3*250;c.paste(im,(x,y));d.text((x+5,y+228),f'{f/30:.3f}s / frame {f}',fill='black')
c.save(r/'end-shared-laptop-qa.jpg');print('PASS 1206 frames, silent, 1080p; 16 encoded samples including final frame1205')

a,b=[Image.open(r/f"end-shared-laptop-qa-{f}.png").convert("RGB").crop((0,0,1920,930)) for f in [599,600]]
error=sum(ImageStat.Stat(ImageChops.difference(a,b)).mean)/3
assert error<1, f"Encoded boundary shifted: {error}"
print(f"Encoded join mean pixel error: {error:.6f}/255")

region=Image.open(r/"end-shared-laptop-qa-599.png").convert("RGB").crop((100,300,1800,600))
white=sum(min(pixel)>250 for pixel in region.getdata())/(region.width*region.height)
assert white>.75, f"Closeup content clipped by perspective: white fraction {white}"
print(f"Closeup content area intact: {white:.1%} white message canvas")
