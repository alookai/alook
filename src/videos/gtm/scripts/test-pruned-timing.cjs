const assert=require('node:assert/strict');
const ts=require('typescript'),fs=require('fs'),vm=require('vm');
const ctx={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/review-timing.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,ctx);
const {reviewSegments:s,filmDuration}=ctx.exports;
assert.equal(s[0].from,0);assert.equal(filmDuration,2470/30);
s.forEach((v,i)=>{assert.ok(v.to>v.from&&v.sourceTo>v.sourceFrom);if(i)assert.equal(v.from,s[i-1].to);assert.ok(Math.abs(v.to*30-Math.round(v.to*30))<1e-8);});
const at=(v)=>{const a=s.find(a=>v>=a.sourceFrom&&v<a.sourceTo);assert.ok(a);return a.from+(v-a.sourceFrom)/(a.sourceTo-a.sourceFrom)*(a.to-a.from);};
for(const [a,b] of [[121.05,121.25],[139.3,139.5],[12.15,12.35],[15.2,15.4],[105.05,105.25],[113.3,113.5],[55,55.14],[57,57.14],[59,59.14]])assert.ok((at(b)-at(a))*30>=(a>104?.8:1.7),`Click lost at ${a}`);
assert.ok(Math.abs(s.at(-1).to-s.at(-1).from-4.8)<1e-8);
console.log('PASS: frame-aligned contiguous timeline, preserved click windows and accelerated collaboration messages; story82.333s.');

assert.ok(at(93.6)-at(84)<=4.4+1e-8,'Family setup limited to 4.4s');
assert.ok(at(96.2)-at(95.4)>=1.19,'Remembering phase gets at least 1.2s');
assert.ok(Math.abs(at(98.5)-at(96.2)-1)<1e-8,'Remembered holds exactly one second');

const frame=v=>Math.ceil(at(v)*30-1e-8);
assert.deepEqual([frame(89.5)-frame(86.8),frame(94)-frame(89.5)],[frame(39)-frame(37.5),frame(42)-frame(39)],'Family arrivals match work at frame precision');
console.log('PASS: work and family both use 29 then 56 frames between message arrivals.');
