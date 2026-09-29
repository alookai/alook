const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm'),React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
let frame=0;
function load(path){const c={exports:{},require(name){if(name==='react')return React;if(name==='remotion')return {AbsoluteFill:({children,...p})=>React.createElement('div',p,children),useCurrentFrame:()=>frame,useVideoConfig:()=>({fps:30})};if(name==='./MacOpening')return {MacOpening:()=>React.createElement('main',null,'network')};if(name==='./social-network')return load('src/social-network.ts');throw Error(name);}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,c);return c.exports;}
const {EndCard,endingDuration}=load('src/EndCard.tsx');
const render=t=>{frame=Math.round(t*30);return renderToStaticMarkup(React.createElement(EndCard));};
assert.equal(endingDuration,20.9);
const fixed=render(4.8);
for(const t of [5,6,11.7])assert.equal(render(t),fixed,'Heading and scene wrapper must remain static throughout network');
assert.ok(fixed.includes('Share your agents with people you trust.'));
assert.ok(!fixed.includes('transform:'));
for(const t of [12.1,12.4,12.7]){const a=Number(render(t).match(/opacity:([\d.]+)/)[1]),b=Number(render(t+.1).match(/opacity:([\d.]+)/)[1]);assert.ok(a>b);assert.ok(!render(t).includes('transform:'));}
assert.ok(!render(14).includes('Share your agents'));
console.log('PASS: fixed header/wrapper geometry, opacity-only spin fade, unchanged ending duration.');
