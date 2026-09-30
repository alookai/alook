const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm'),React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
function load(p){const c={exports:{},require(name){if(name==='react')return React;if(name==='remotion')return {staticFile:p=>p,Img:props=>React.createElement('img',props),interpolate:(v,[a,b],[x,y])=>x+(y-x)*Math.max(0,Math.min(1,(v-a)/(b-a)))};if(name==='lucide-react')return new Proxy({},{get:()=>()=>null});if(name.includes('provider-logo'))return {ProviderLogo:()=>null};if(name==='./Product')return {avatarSource:n=>n+'.png'};return load('src/'+name.replace('./','')+'.ts');}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,c);return c.exports;}
const {PullRequestWindow}=load('src/PullRequestWindow.tsx'),{CodexWindow}=load('src/CodexWindow.tsx'),{relayRequests}=load('src/opening-relay.ts');
for(let i=0;i<relayRequests.length;i++){
 const t=relayRequests[i].post+.1;
 const pr=renderToStaticMarkup(React.createElement(PullRequestWindow,{t}));
 const codex=renderToStaticMarkup(React.createElement(CodexWindow,{t,typed:'',openingRelay:true}));
 for(const r of relayRequests.slice(0,i+1))for(const text of [r.text,r.reply]){assert.ok(pr.includes(text),'PR must retain '+text);assert.ok(codex.includes(text),'Codex must retain '+text);}
 for(const r of relayRequests.slice(i+1)){assert.ok(!pr.includes(r.text));assert.ok(!codex.includes(r.text));}
 assert.ok(codex.includes('Build team invites for the app.'));
}
console.log('PASS: all prior PR/Codex turns persist, future turns absent, initial context retained.');

for(const r of relayRequests){const html=renderToStaticMarkup(React.createElement(PullRequestWindow,{t:r.answerPaste}));assert.ok(html.includes('<header><b>Lin</b><span>commenting</span><em>Author</em></header>'));assert.ok(html.includes('class="pr-editor-tabs"'));assert.ok(!html.includes('<header><b>Write</b>'));}
console.log('PASS: Lin author header persists above separate editor tabs.');
for(const [i,r] of relayRequests.entries()){
 const html=renderToStaticMarkup(React.createElement(PullRequestWindow,{t:r.answerPaste}));
 const scroll=Number(html.match(/class="pr-thread" style="translate:0 -?([\d.]+)px/)[1]);
 assert.ok((i*2+1)*104+162-scroll<=278,'Composer and send control must fit when paste starts');
}
console.log('PASS: composer fits viewport before each paste.');
for(const r of relayRequests){
 const before=renderToStaticMarkup(React.createElement(PullRequestWindow,{t:r.copy+.01}));
 const hover=renderToStaticMarkup(React.createElement(PullRequestWindow,{t:r.copy+.06}));
 assert.ok(!before.includes('pr-copy-menu chosen'));
 assert.ok(hover.includes('pr-copy-menu chosen'));
 assert.ok(!hover.includes('pr-cursor'));
}
console.log('PASS: every PR Copy item highlights when pointer enters its row.');
for(const r of relayRequests){
 const html=renderToStaticMarkup(React.createElement(CodexWindow,{t:r.answerCopy+.01,typed:'',openingRelay:true}));
 assert.ok(html.includes('pr-agent-copy chosen'));
}
console.log('PASS: all Codex answer Copy menus show the selected row.');
const footer=renderToStaticMarkup(React.createElement(CodexWindow,{t:2,typed:'',openingRelay:true}));
assert.ok(footer.includes('gpt-latest'));assert.ok(footer.includes('>high<'));assert.ok(!footer.includes('GPT-5.4'));
console.log('PASS: Codex footer shows gpt-latest and high.');
const singleRelayFlood=renderToStaticMarkup(React.createElement(PullRequestWindow,{t:11.79,relayCount:1}));
assert.ok(singleRelayFlood.includes(relayRequests[0].text));
assert.ok(singleRelayFlood.includes(relayRequests[0].reply));
assert.ok(!singleRelayFlood.includes(relayRequests[1].text));
assert.ok(!singleRelayFlood.includes(relayRequests[1].reply));
for(const item of load('src/github-flood.ts').githubFlood)assert.ok(singleRelayFlood.includes(item.text));
console.log('PASS: single-relay preview retains first exchange and every flood comment, with no skipped second exchange.');
