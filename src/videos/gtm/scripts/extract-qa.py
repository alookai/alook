import json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parents[1]
video=root/'out/alook-gtm-v8.mp4'
folder=root/'out/final-qa'
folder.mkdir(exist_ok=True)
times=[0.7,4,7.5,10,12.4,17,21,26,28,31,35,38,41.5,44,48,50,53,54.5,56.5,60.7,63,65.9,67.5,70,74.5,76,79.5,82.8,84,87,90]
for second in times:
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-ss',str(second),'-i',str(video),'-frames:v','1','-y',str(folder/f'{second:05.1f}.png')],check=True)
metadata=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(video)]))
(folder/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
assert abs(float(metadata['format']['duration'])-92)<.1
streams=metadata['streams']
assert any(s.get('codec_name')=='h264' and s.get('width')==1920 and s.get('height')==1080 for s in streams)
assert any(s.get('codec_type')=='audio' for s in streams)
print(f'Extracted {len(times)} frames from final MP4; 1920x1080 H.264 / audio / 92s verified.')
