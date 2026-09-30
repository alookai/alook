import json,subprocess,pathlib,sys
from PIL import Image,ImageDraw
root=pathlib.Path(sys.argv[2] if len(sys.argv)>2 else 'out/launch-qa');root.mkdir(exist_ok=True)
video=sys.argv[1] if len(sys.argv)>1 else 'out/alook-launch-review.mp4'
meta=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',video]))
s=next(s for s in meta['streams'] if s['codec_type']=='video')
assert (s['width'],s['height'],s['r_frame_rate'],int(s['nb_frames']))==(1920,1080,'30/1',2205)
times=[0.8,2,6.8,9.8,10.2,11.5,13.4,13.7,14.2,17.8,18.25,19.7,21.8,24,28.9,30,32.6,34.2,36,38.6,39,39.5,40.2,42,43.8,44.5,45.3,46.8,47.4,49,50.6,51,53,55.6,58,60.5,62.1,65,69,73.4666667]
for i,t in enumerate(times):
 subprocess.run(['ffmpeg','-v','error','-ss',str(t),'-i',video,'-frames:v','1','-update','1','-y',str(root/f'{i:02}.png')],check=True)
sheet=Image.new('RGB',(1600,7*250),(222,224,216));draw=ImageDraw.Draw(sheet)
for i,t in enumerate(times):
 im=Image.open(root/f'{i:02}.png').convert('RGB');im.thumbnail((400,225));x=i%4*400;y=i//4*250
 if y+250>sheet.height:
  bigger=Image.new('RGB',(1600,y+250),(222,224,216));bigger.paste(sheet,(0,0));sheet=bigger;draw=ImageDraw.Draw(sheet)
 sheet.paste(im,(x,y));draw.text((x+8,y+229),f'{t:.3f}s',fill=(0,0,0))
sheet.save(root/'contact.jpg');(root/'metadata.json').write_text(json.dumps(meta,indent=2))
print('PASS: 1080p/30fps, 2205 frames, 73.5s; 40 encoded samples including final frame extracted.')
