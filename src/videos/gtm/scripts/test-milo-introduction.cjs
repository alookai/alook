const fs=require('node:fs'),assert=require('node:assert/strict'),vm=require('node:vm'),ts=require('typescript');
const context={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/meeting-story.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const miloIntroduction=context.exports.invitationLines[0].text.replace('@Milo#2048','@Milo');
const source=fs.readFileSync('src/MacOpening.tsx','utf8');
const expression=source.match(/composerText=\{([^}]+)\}/)[1];
const at=t=>vm.runInNewContext(expression,{t,miloIntroduction});
assert.equal(miloIntroduction,'You can talk to @Milo. He runs locally and has my context.');
assert.equal(at(30),'');
assert.equal(at(36),miloIntroduction);
assert.equal(at(37.49),miloIntroduction);
assert.equal(at(37.5),undefined);
let previous='';
for(let t=30;t<=36;t+=.01){const text=at(t);assert.ok(miloIntroduction.startsWith(text));assert.ok(text.startsWith(previous));previous=text;}
console.log('PASS: local + context message types in order, completes before send, and matches posted copy.');
