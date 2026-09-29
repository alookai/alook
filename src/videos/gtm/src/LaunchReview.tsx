import React from 'react';
import {AbsoluteFill, Audio, staticFile, Sequence, useCurrentFrame} from 'remotion';
import {Film} from './Film';
import {EndCard, endingDuration} from './EndCard';
import {filmDuration} from './review-timing';
import {FirstActPreview} from './FirstActPreview';
import {OpeningQuestion} from './OpeningQuestion';
import {storyCards, cleanFrameState, cleanStoryFrames} from './clean-review-timing';
export {cleanReviewFrames} from './clean-review-timing';

function Story({offset=0}:{offset?:number}){
 const t=useCurrentFrame()/30+offset;
 return <AbsoluteFill style={{background:'#faf6ed',overflow:'hidden'}}>
  <Film explain={false} narration={false} playbackTime={t}/>
 </AbsoluteFill>;
}

export const launchDuration=filmDuration+endingDuration;
export function LaunchReview(){return <><Audio src={staticFile('sfx/launch-sfx.wav')}/><Sequence durationInFrames={Math.round(filmDuration*30)}><Story/></Sequence><Sequence from={Math.round(filmDuration*30)}><EndCard/></Sequence></>;}

function CleanStory(){
 const frame=useCurrentFrame();
 const state=cleanFrameState(frame);
 return <>
  <Film explain={false} narration={false} playbackTime={state.sourceFrame/30}/>
  {state.cardIndex!==null&&<OpeningQuestion time={state.cardFrame/30} textLines={storyCards[state.cardIndex].lines} hold={(storyCards[state.cardIndex].holdFrames??0)/30}/>}
 </>;
}
export function CleanReview(){return <>
 <Sequence durationInFrames={510}><FirstActPreview/></Sequence>
 <Sequence from={510} durationInFrames={cleanStoryFrames}><CleanStory/></Sequence>
 <Sequence from={510+cleanStoryFrames}><EndCard/></Sequence>
 </>;}
