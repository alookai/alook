const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),ts=require('typescript');
function load(file,require=()=>{}){const c={exports:{},require};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,c);return c.exports;}
const timing=load('src/review-timing.ts');
const {playbackAge,messageMotion}=load('src/message-motion.ts',()=>timing);
assert.ok(Math.abs(messageMotion(0).y-28)<1e-8);
assert.equal(messageMotion(0).opacity,0);
assert.equal(messageMotion(.1).opacity,1);
assert.ok(messageMotion(.3).y<0);
assert.equal(messageMotion(.42).y,0);
assert.equal(messageMotion(10).y,0);
for(let i=0;i<100;i++){const m=messageMotion(i/100);assert.ok(m.y>=-2&&m.y<=28.00001);assert.ok(m.opacity>=0&&m.opacity<=1);}
assert.ok(Math.abs(playbackAge(74.5,.5)-.2)<1e-8);
assert.equal(playbackAge(74,0),0);
assert.ok(playbackAge(94,94-1)>1);
const invite=timing.reviewSegments.find(s=>s.sourceFrom===51);
assert.ok(Math.abs(invite.to-invite.from-4.8)<1e-8);
console.log('PASS: real playback motion duration, subtle overshoot, exact settling, historical messages settled, invite speed preserved.');
