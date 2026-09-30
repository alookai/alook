const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const c={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/provider-slide.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,c);
const {providerSlideItems:items,providerEntrance:enter}=c.exports;
assert.equal(items.map(x=>x.name).join(','),'Milo,Nova,Remy,Pip');
assert.equal(items.map(x=>x.backend).join(','),'codex,claude,opencode,cursor');
for(let i=0;i<4;i++){assert.equal(enter(5.2,i),0);assert.equal(enter(5.81,i),1);let last=0;for(let t=5.2;t<6;t+=.01){const p=enter(t,i);assert.ok(p>=last&&p<=1);last=p;}}
assert.ok(enter(5.35,0)>enter(5.35,1));assert.equal(enter(5.35,3),0);
console.log('PASS: four story providers, sequential monotonic entrances, all settled before camera exit');
