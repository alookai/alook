const fs=require('fs'),ts=require('typescript'),assert=require('node:assert/strict');
require.extensions['.ts']=(m,p)=>m._compile(ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,p);
const {openingCursorAt:cursor,openingCursorKeys:keys,relayTargets:targets}=require('../src/opening-cursor.ts');
const {relayRequests}=require('../src/opening-relay.ts');const {sourceTimeAt,reviewSegments}=require('../src/review-timing.ts');
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
for(const k of keys.slice(1))assert.ok(dist(cursor(k.at-1e-7),cursor(k.at+1e-7))<.01,'Continuous at '+k.at);
for(const [i,r] of relayRequests.entries())for(const [t,name] of [[r.copy+.04,'copy'],[r.paste,'paste'],[r.send,'send'],[r.answerCopy+.04,'answerCopy'],[r.answerPaste,'answerPaste'],[r.post,'post']])assert.ok(dist(cursor(t),targets(i,t)[name])<.1,`Cycle${i+1} ${name} misses target`);
for(let f=1;f<333;f++)assert.ok(dist(cursor(sourceTimeAt(f/30)),cursor(sourceTimeAt((f-1)/30)))<170,'Frame travel too abrupt '+f);
assert.ok(dist(cursor(12),{x:900,y:500})<.01,'Deck cursor handoff');
assert.equal(fs.readFileSync('src/MacOpening.tsx','utf8').match(/data-opening-cursor/g).length,1);
for(const file of ['PullRequestWindow','CodexWindow'])assert.ok(!fs.readFileSync(`src/${file}.tsx`,'utf8').includes('viewBox="0 0 38 48"'),'No duplicate window cursor');
const hold=reviewSegments.find(s=>s.sourceFrom===130.2),brand=reviewSegments.find(s=>s.sourceFrom===139.2);
assert.ok(Math.abs(hold.to-hold.from-1.2)<1e-6);assert.ok(Math.abs(brand.to-brand.from-1.5)<1e-6);
console.log('PASS: cursor continuous, all12 click targets, frame travel bound, deck handoff, single pointer; PPT -0.5/+0.5s holds.');

const {firstActPlayback:clock,firstActPlaybackTimes:pt,firstActSourceTimes:st}=require('../src/first-act-clock.ts');
const sourceAt=p=>{const i=pt.findIndex((v,j)=>j>0&&p<=v)-1;return st[i]+(p-pt[i])/(pt[i+1]-pt[i])*(st[i+1]-st[i]);};
for(const [t,name] of [[relayRequests[0].copy,'request'],[relayRequests[0].answerCopy,'answer']]){
 assert.ok(dist(cursor(t,clock),targets(0,t)[name])<.1,'Selection endpoint must coincide with visible Copy menu');
 const before=sourceAt(clock(t)-1/30);
 assert.ok(dist(cursor(before,clock),cursor(t,clock))>3,'Selection must still move in the last frame before menu');
}
for(let f=1;f<234;f++)assert.ok(dist(cursor(sourceAt(f/30),clock),cursor(sourceAt((f-1)/30),clock))<170,'Current first-act cursor jump at '+f);
console.log('PASS: current playback clock, no stationary frame before either Copy menu, continuous cursor.');
