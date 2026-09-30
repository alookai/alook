import subprocess,sys
path=sys.argv[1]
w,h=320,180
for offset,count,lines,exit_frame in [(0,114,3,90),(1084,105,2,81),(1513,105,2,81),(2107,136,2,112)]:
    raw=subprocess.check_output(['ffmpeg','-v','error','-i',path,'-vf',f'trim=start_frame={offset}:end_frame={offset+count},setpts=PTS-STARTPTS,scale={w}:{h}','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','-'])
    frames=[raw[i:i+w*h*3] for i in range(0,len(raw),w*h*3)]
    assert len(frames)==count,(offset,len(frames),count)
    reference=frames[75]
    rows=[y for y in range(h) if sum(reference[i+1]>175 and reference[i+2]>110 for i in range(y*w*3,(y+1)*w*3,3))>4]
    bands=[]
    for y in rows:
        if not bands or y-bands[-1][-1]>4:bands.append([y])
        else:bands[-1].append(y)
    assert len(bands)==lines,(offset,bands)
    for line,band in enumerate(bands):
        top,bottom=max(0,band[0]-2),min(h,band[-1]+3)
        counts=[]
        for f in range(line*24,exit_frame+1):
            b=frames[f]
            area=sum(b[i+1]>175 and b[i+2]>110 for i in range(top*w*3,bottom*w*3,3))
            counts.append((f,area))
        drops=[f for (_,p),(f,c) in zip(counts,counts[1:]) if p>200 and c<p*.8]
        assert not drops,(offset,line,'entrance dropout',drops)
        held=[(f,c) for f,c in counts if f>=20+24*line]
        median=sorted(c for _,c in held)[len(held)//2]
        bad=[f for f,c in held if c<median*.85]
        assert not bad,(offset,line,'hold dropout',bad)
    print(f'PASS card at frame{offset}: every entrance/hold frame intact ({lines} lines).')
