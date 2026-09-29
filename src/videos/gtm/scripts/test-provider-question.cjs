const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const c={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/provider-question.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,c);
const {providerQuestionAt:at,questionProviders:items}=c.exports;
assert.equal(items.map(x=>x.label).join('|'),'Codex|Claude Code|Cursor|local agent');
for(let i=0;i<3;i++){const start=1.6+i*.85;assert.equal(at(start+.4*.85).text,items[i].label);assert.ok(at(start+.95*.85).text.length<items[i].label.length);assert.equal(at(start+.4*.85).typing,false);}
assert.equal(at(4.7).text,'local agent');assert.equal(at(6.6).text,'local agent');assert.equal(at(6.6).typing,false);
console.log('PASS: provider names type/hold/delete in order, local agent remains');
