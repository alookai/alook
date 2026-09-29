const assert=require('node:assert/strict');
const ts=require('typescript');
const fs=require('node:fs');
const vm=require('node:vm');
const code=ts.transpileModule(fs.readFileSync('src/slide-typing.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const context={exports:{}};vm.runInNewContext(code,context);const {slideTyping}=context.exports;
for(const first of [true,false]){
 for(let frame=0;frame<240;frame++){
  const age=frame/30,state=slideTyping(age,first);
  assert.ok(state.active>=0&&state.active<3);
  state.lines.forEach((line,i)=>{if(i>state.active)assert.equal(line,'');});
  if(frame){const prev=slideTyping((frame-1)/30,first);state.lines.forEach((line,i)=>assert.ok(line.startsWith(prev.lines[i])));}
 }
 for(let f=55;f<148;f++){const a=slideTyping(f/30,first).lines.join('').length,b=slideTyping((f+4)/30,first).lines.join('').length;assert.ok(b>a,'Typing must keep advancing without pauses');}
 assert.equal(slideTyping(6,first).lines.join(' '),first?'What if my local agent could join my team?':'Start with one. Bring more bots to collaborate.');
}
console.log('PASS: 480 typing states, monotonic input, correct active line, exact complete copy.');

assert.equal(slideTyping(6,false).lines[1],'Bring more bots to collaborate.');
assert.equal(slideTyping(6,false).lines.length,2);
