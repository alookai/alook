import subprocess,sys
path=sys.argv[1]
w,h=320,180
raw=subprocess.check_output(['ffmpeg','-v','error','-i',path,'-frames:v','91','-vf',f'scale={w}:{h}','-pix_fmt','rgb24','-f','rawvideo','-'])
frames=[raw[i:i+w*h*3] for i in range(0,len(raw),w*h*3)]
assert len(frames)==91
for line,(start,top,bottom) in enumerate([(20,34,66),(44,72,104),(68,110,142)]):
    counts=[]
    for f in range(line*24,91):
        b=frames[f]
        count=sum(b[i+1]>175 and b[i+2]>110 for i in range(top*w*3,bottom*w*3,3))
        counts.append((f,count))
    drops=[(f,c) for (previous,p),(f,c) in zip(counts,counts[1:]) if p>200 and c<p*.8]
    assert not drops,f'Line{line+1} flashes during entrance: {drops}'
    counts=[(f,c) for f,c in counts if f>=start]
    reference=sorted(c for _,c in counts)[len(counts)//2]
    bad=[(f,c) for f,c in counts if c<reference*.85]
    assert not bad,f'Line{line+1} partially missing: {bad}, normal area{reference}'
print('PASS: every settled-title frame retains all visible lines, no flash/dropout.')
