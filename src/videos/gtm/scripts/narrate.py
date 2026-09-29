import asyncio, json, pathlib, subprocess
import edge_tts
root = pathlib.Path(__file__).resolve().parents[1]
segments = json.loads((root/'src/narration.json').read_text())
async def main():
    (root/'public/audio-v2').mkdir(parents=True,exist_ok=True)
    for i, seg in enumerate(segments):
        seg['file']=f'audio-v2/{i}.mp3'
        p=root/'public'/seg['file']
        textfile=p.with_suffix('.txt')
        if not p.exists() or not textfile.exists() or textfile.read_text()!=seg['text']:
            for attempt in range(5):
                try:
                    await edge_tts.Communicate(seg['text'],'en-US-JennyNeural',rate='+1%').save(str(p))
                    break
                except Exception:
                    if attempt==4: raise
                    print(f'Retrying take {i}',flush=True)
                    await asyncio.sleep(2)
            textfile.write_text(seg['text'])
        seg['duration']=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',str(p)]))
        if i+1<len(segments):
            available=segments[i+1]['at']-seg['at']-.12
            if seg['duration']>available:
                ratio=seg['duration']/available
                if ratio>1.16: raise ValueError(f'Take {i} needs a wider window')
                adjusted=p.with_name(p.stem+'-fit.mp3')
                subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(p),'-af',f'atempo={ratio}', '-y',str(adjusted)],check=True)
                adjusted.replace(p)
                seg['duration']=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',str(p)]))
        print(i,seg['at'],seg['duration'],flush=True)
    (root/'src/voice-timing.json').write_text(json.dumps(segments,ensure_ascii=False,indent=2)+'\n')
asyncio.run(main())
