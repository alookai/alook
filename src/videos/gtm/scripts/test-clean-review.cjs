const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const context={exports:{},require:(id)=>id==='./review-timing'?{filmDuration:1963/30}:{endingDuration:657/30}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/clean-review-timing.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const {cleanFrameState:state,cleanReviewFrames,cleanStoryFrames,storyCards,cardFrames,storyCardFrames}=context.exports;
assert.equal(cleanReviewFrames,3092);
assert.equal(state(0).sourceFrame,333);
assert.equal(state(cleanStoryFrames-1).sourceFrame,1962);
for(let f=1;f<cleanStoryFrames;f++){
 const delta=state(f).sourceFrame-state(f-1).sourceFrame;
 assert.ok(delta===0||delta===1,'No scene skipped or replayed');
}
let inserted=0;
for(let i=0;i<storyCards.length;i++){
 const start=storyCards[i].sourceFrame-333+inserted;
 assert.equal(state(start-1).cardIndex,null);
 for(let f=0;f<storyCardFrames(storyCards[i]);f++){
  assert.equal(state(start+f).cardIndex,i);
  assert.equal(state(start+f).sourceFrame,Math.min(storyCards[i].sourceFrame+f,storyCards[i].resumeFrame));
 }
 assert.equal(state(start+storyCardFrames(storyCards[i])).cardIndex,null);
 inserted+=storyCardFrames(storyCards[i])-(storyCards[i].resumeFrame-storyCards[i].sourceFrame);
}
const story=fs.readFileSync('src/LaunchReview.tsx','utf8');
assert.ok(!story.includes('launchBeats'));
assert.ok(!story.includes('scale('));
assert.ok(!fs.readFileSync('src/EndCard.tsx','utf8').includes('Share your agents with'));
console.log('PASS: 3092 frames; all demo frames preserved in order; all three cards cover their scene boundaries; explanatory headers and shrink wrapper absent.');
assert.ok(storyCards.every(card=>card.lines.length===2));
assert.equal(storyCards[0].lines.flat().filter(p=>p.strong).map(p=>p.text).join('|'),'local|Alook');
assert.equal(storyCards[1].lines.flat().filter(p=>p.strong).map(p=>p.text).join('|'),'every room');
console.log('PASS: two lines per card; only requested words emphasized.');

assert.equal(storyCards[2].lines.flat().map(p=>p.text).join(' '),'Many bots One place');
assert.equal(storyCards[2].sourceFrame,1740);

assert.ok(storyCards.every(card=>card.lines.every(line=>!/[.!?]$/.test(line.map(p=>p.text).join('')))));
assert.ok(fs.readFileSync('src/OpeningQuestion.tsx','utf8').includes("text: 'agent?'"));

assert.equal(storyCards[0].sourceFrame,907);
assert.equal(storyCards[0].resumeFrame,927);
assert.ok(storyCards[0].resumeFrame-storyCards[0].sourceFrame<54,'Underlying transition ends before orange exits');
const componentContext={exports:{},require};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/OpeningQuestion.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,componentContext);
const card=({lineInterval=.5,...props})=>componentContext.exports.OpeningQuestion({...props,lineInterval});
const positions=t=>card({time:t}).props.children[1].props.children.props.children.map(line=>parseFloat(line.props.style.translate));
assert.equal(positions(0)[0],1920);
assert.equal(positions(.5)[1],1920);
assert.equal(positions(1)[2],1920);
assert.ok(positions(.49)[0]<positions(.49)[1]-1000);
assert.ok(positions(.99)[1]<positions(.99)[2]-1000);
assert.ok(positions(1.65).every(x=>Math.abs(x)<40));
assert.equal(card({time:2.4}).props.children[0].props.style.translate,'0px 0');
console.log('PASS: successive line entrances separated by exactly 15 frames; all opening lines settle before 0.75-second reading hold.');

const slowPositions=t=>card({time:t,lineInterval:1}).props.children[1].props.children.props.children.map(line=>parseFloat(line.props.style.translate));
assert.equal(slowPositions(1)[1],1920);
assert.equal(slowPositions(2)[2],1920);
assert.ok(slowPositions(2.65).every(x=>Math.abs(x)<40));
assert.equal(card({time:3.4,lineInterval:1}).props.children[0].props.style.translate,'0px 0');
console.log('PASS: 1s preview onset separation30 frames, same .75s final-line hold.');

const mediumPositions=t=>card({time:t,lineInterval:.8}).props.children[1].props.children.props.children.map(line=>parseFloat(line.props.style.translate));
assert.equal(mediumPositions(.8)[1],1920);
assert.equal(mediumPositions(1.6)[2],1920);
assert.ok(mediumPositions(2.25).every(x=>Math.abs(x)<40));
console.log('PASS: .8s preview line separation24 frames, question mark present.');

const review={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/review-timing.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,review);
const cardStart=2107, last=state(cardStart-510-1), first=state(cardStart-510);
const before=review.exports.sourceTimeAt(last.sourceFrame/30);
assert.ok(before>=59 && before<61,'All invites finished; modal has not begun closing');
assert.equal(first.cardIndex,2);
assert.equal(storyCardFrames(storyCards[2]),136);
assert.equal(state(2243-510).sourceFrame,1771,'Original next-scene clock preserved');
assert.equal(state(2242-510).cardIndex,2);
console.log('PASS: card covers completed invites before modal closes; later scene clock unchanged.');
const inviteCardAt=f=>card({time:f/30,textLines:storyCards[2].lines,hold:31/30,lineInterval:.8});
for(let f=0;f<=112;f++)assert.equal(inviteCardAt(f).props.children[0].props.style.translate,'0px 0','Modal closes behind fully opaque card');
console.log('PASS: opaque card covers modal close and holds through extended title interval.');
