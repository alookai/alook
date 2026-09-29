import json, subprocess, zipfile
from pathlib import Path
root=Path('out/font-options')
fonts=json.loads((root/'fonts.json').read_text())
for i,font in enumerate(fonts,1):
 f=f"crop=900:200:790:530,pad=1000:270:50:60:color=0xfaf6ed,drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='{i:02d}  {font}':x=50:y=15:fontsize=28:fontcolor=0x263c36"
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(root/f'{i:02d}.png'),'-vf',f,'-frames:v','1',str(root/f'crop-{i:02d}.png')],check=True)
for start in (1,6):
 args=['ffmpeg','-v','error','-y']
 for i in range(start,start+5):args+=['-i',str(root/f'crop-{i:02d}.png')]
 args+=['-filter_complex','vstack=inputs=5','-frames:v','1',str(root/f'fonts-{start:02d}-{start+4:02d}.png')]
 subprocess.run(args,check=True)
with zipfile.ZipFile(root/'alook-10-font-options.zip','w',zipfile.ZIP_DEFLATED) as archive:
 for i,font in enumerate(fonts,1):archive.write(root/f'{i:02d}.png',f'{i:02d}-{font}.png')
