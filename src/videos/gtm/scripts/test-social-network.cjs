const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const c={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/social-network.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,c);
const {socialPeople:p,socialLinks:links,networkMotion:motion,botPosition:bot,endingPhysicalTime:physical,networkEnd}=c.exports;
assert.equal(p.length,11);assert.equal(new Set(p.map(x=>x.name)).size,11);
for(const person of p)assert.ok(fs.existsSync(`src/assets/people/${person.name}.png`));
const reached=new Set([0]);for(let i=0;i<p.length;i++)for(const[a,b]of links){if(reached.has(a))reached.add(b);if(reached.has(b))reached.add(a)}assert.equal(reached.size,p.length);
assert.equal(p[0].name,'Lin');assert.ok(p[1].at<p[2].at&&p[2].at<p[3].at);
for(const person of p)for(let i=0;i<person.bots.length;i++){const position=bot(person.at+3,i,person.bots.length,person.at,165);assert.ok(Math.abs(Math.hypot(position.x,position.y)-165)<.001);assert.equal(position.opacity,1)}
for(let t=0;t<9;t+=.0333)for(const n of Object.values(motion(t)))assert.ok(Number.isFinite(n));
assert.ok(motion(6.3).scale<motion(2).scale);assert.ok(motion(8.5).rotation>motion(7.5).rotation);assert.equal(motion(9).opacity,0);
assert.equal(physical(5),0);assert.ok(Math.abs(physical(networkEnd)-2.1)<1e-9);assert.ok(Math.abs(physical(networkEnd+2.4)-6.7)<1e-9);
const rolling=bot(.6,0,4,0,108);assert.equal(rolling.y,108);assert.ok(rolling.x>0&&rolling.roll>0);
for(const count of [2,3,4])for(let t=0;t<9;t+=1/120){const radius=count===4?108:102,points=Array.from({length:count},(_,i)=>bot(t,i,count,0,radius)).filter(p=>p.opacity>0);for(const p of points)assert.ok(Math.hypot(p.x,p.y)>95);for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)assert.ok(Math.hypot(points[i].x-points[j].x,points[i].y-points[j].y)>62,'Bot discs overlap');}
console.log('PASS: 11 photo assets, connected social graph, appearance order, stable bot orbits, finite motion, collapse and ending timing');
const {networkEntry:entry,networkViewport:view,networkCenter:center}=c.exports;
assert.equal(entry.x,view.x+center.x*view.scale);
assert.equal(entry.y,view.y+motion(0).centerY*view.scale);
assert.equal(entry.size,128*motion(0).scale*view.scale);
assert.equal(motion(0).centerY,motion(7.25).centerY);
assert.equal(motion(9).centerY,540);
console.log('PASS: exact avatar handoff center/size; fixed graph center until spin and centered logo collapse.');
