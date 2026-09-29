import json, subprocess
from pathlib import Path
from PIL import Image, ImageDraw
samples=[('alook-acts45-editor',[0,18,20.8,22.1,23.6,24.7,25.2,26.2,27.5,31.5,44,47.966667],48),('alook-acts12-editor',[0,19.9,21,22.1,23.6,24.7,25.2,26.2,27.6,28.1,32,48.966667],49)]
for name,times,duration in samples:
 path=Path('out')/(name+'.mp4')
 info=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height,nb_frames,duration','-of','json',str(path)]))['streams'][0]
 assert (info['width'],info['height'],int(info['nb_frames']))==(1920,1080,duration*30),info
 sheet=Image.new('RGB',(960,294*((len(times)+1)//2)),'#e9e9e9');draw=ImageDraw.Draw(sheet)
 for i,t in enumerate(times):
  still=Path('out')/f'{name}-qa-{i}.png'
  subprocess.run(['ffmpeg','-v','error','-y','-ss',str(t),'-i',str(path),'-frames:v','1',str(still)],check=True)
  im=Image.open(still).resize((480,270));x=(i%2)*480;y=(i//2)*294;sheet.paste(im,(x,y+24));draw.text((x+8,y+5),f'{t:.3f}s',fill='black')
 sheet.save(Path('out')/(name+'-qa.jpg'))
 print(name,'PASS',info)
