const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const context={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/launch-beats.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const {launchBeats}=context.exports;
for(const list of [launchBeats])for(let i=0;i<list.length;i++){
 const b=list[i];assert.ok(b.to-b.from>=2.4);assert.ok(b.from>=0&&b.to<=82.8);
 if(i)assert.ok(list[i-1].to<=b.from);
}
assert.ok(launchBeats.every(b=>b.lines[0].length<48));
assert.ok(launchBeats.some(b=>b.from>=58.6&&b.to<65&&b.lines[0].includes('Same Milo')));
assert.ok(launchBeats.some(b=>b.from>=53.6&&b.to<=58.6&&b.lines[0].includes('directly')));
assert.ok(launchBeats.at(-1).to<82.8,'Unmodified ending join');
console.log('PASS: readable holds; ordered beats; claims align with proof; full invitation visible; ending join preserved.');
