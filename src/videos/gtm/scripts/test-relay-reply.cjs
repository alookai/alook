const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const c={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/opening-relay.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,c);
for(const r of c.exports.relayRequests){
 assert.equal(c.exports.relayReplyAt(r.send+.01),'');
 let n=0;for(let t=r.replyStart;t<r.replyEnd;t+=.001){const s=c.exports.relayReplyAt(t);assert.ok(r.reply.startsWith(s));assert.ok(s.length>=n);n=s.length;}
 assert.equal(c.exports.relayReplyAt(r.answerCopy),r.reply);
}
console.log('PASS: each response streams monotonically and holds fully before copy.');
