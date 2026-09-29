const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
function load(p){const c={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,c);return c.exports;}
const {firstDeckClock:clock,teammateSlideAt:at,teammateStatement}=load('src/first-deck.ts');
assert.equal(at(3.5).text,'');let prior='';for(let t=3.5;t<6.5;t+=.01){assert.ok(at(t).text.startsWith(prior));prior=at(t).text;assert.equal(at(t).page,1);}
assert.equal(at(5.3).text,teammateStatement);assert.equal(at(6.5).page,2);assert.equal(at(11.7).page,3);
assert.equal(clock(3.5),3.5);assert.equal(clock(6.5),3.5);assert.equal(clock(11.7),8.7);assert.equal(clock(23.5),20.5);
const {reviewSegments:s,filmDuration}=load('src/review-timing.ts');
for(let i=1;i<s.length;i++)assert.equal(s[i].from,s[i-1].to);
const intro=s.find(x=>x.sourceFrom===123.5);assert.ok(Math.abs(intro.to-intro.from-3)<1e-9);assert.equal(filmDuration,1963/30);
console.log('PASS: page1 types monotonically, original pages become2/3, clock continuity and3-second insertion.');
