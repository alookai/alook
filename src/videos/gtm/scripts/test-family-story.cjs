const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),ts=require('typescript');
function load(file){const ctx={exports:{},require:()=>({})};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,ctx);return ctx.exports;}
const lines=load('src/FourthAct.tsx').familyLines;
assert.deepEqual(Array.from(lines,l=>l.name),['Sam','Lin','Milo','Sam']);
assert.ok(lines.every((l,i)=>!i||l.at>lines[i-1].at));
for(const word of ['Six people','Saturday','Italian']){assert.ok(lines[1].text.includes(word));assert.ok(lines[2].memory.includes(word));}
assert.ok(lines[2].memoryAt>lines[2].at&&lines[2].memoryAt<lines[3].at);
for(const file of ['src/FourthAct.tsx','src/meeting-story.ts','src/ThirdAct.tsx'])assert.ok(!/meet.google.com|Back from the review|in a meeting until/.test(fs.readFileSync(file,'utf8')));
const lid=fs.readFileSync('src/ClosingLaptop.tsx','utf8');
assert.ok(lid.includes('alook.ai</div>'));assert.ok(!lid.includes('↗'));
console.log('PASS: Sam→Lin delegation→Milo memory; preferences aligned; obsolete meeting removed; plain URL CTA.');
