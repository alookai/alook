const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const load=p=>{const c={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,c);return c.exports;};
const {relayRequests:r,relayReplyAt,relaySentAt}=load('src/opening-relay.ts');
const {reviewSegments:s,filmDuration}=load('src/review-timing.ts');
const playback=t=>{const v=s.find(v=>t>=v.sourceFrom&&t<v.sourceTo);return v.from+(t-v.sourceFrom)/(v.sourceTo-v.sourceFrom)*(v.to-v.from);};
assert.equal(r.length,2);
for(const [i,v] of r.entries()){
 const events=['at','copy','copied','copyEnd','pasteMenu','pasteHover','paste','send','replyStart','replyEnd','answerCopy','compose','answerPaste','post'];
 for(let j=1;j<events.length;j++)assert.ok(v[events[j]]>v[events[j-1]]);
 assert.equal(relayReplyAt(v.replyEnd+.01),v.reply);
 assert.equal(relaySentAt(v.send+.01),v.text);
 assert.ok(playback(v.copy)-playback(v.at)<=.14,'No message reading hold');
 assert.ok(playback(v.answerCopy)-playback(v.replyEnd)<=.101,'No answer reading hold');
 assert.ok(playback(v.copyEnd)-playback(v.copy)>=.35,'Copy action stays visible');
 assert.ok(playback(v.paste)-playback(v.pasteMenu)>=.3,'Paste menu stays visible');
}
assert.equal(s.find(v=>v.sourceTo===12).to,11.1);assert.equal(filmDuration,1948/30);
s.forEach((v,i)=>{assert.ok(v.to>v.from);if(i)assert.equal(v.from,s[i-1].to);});
console.log('PASS: two complete ordered transfers, exact answers, action visibility and no reading holds, contiguous timeline.');
