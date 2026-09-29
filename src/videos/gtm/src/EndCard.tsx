import React from 'react';
import {AbsoluteFill,useCurrentFrame,useVideoConfig} from 'remotion';
import {MacOpening} from './MacOpening';
import {endingAddedTime,endingTrim,endingPhysicalTime,endingStoryTime,networkStart,networkEnd,socialEase} from './social-network';
export const endingDuration=Math.round((11.4+endingAddedTime-endingTrim+1)*30)/30;
export function EndCard(){
 const {fps}=useVideoConfig(),t=endingStoryTime(useCurrentFrame()/fps);
 return <AbsoluteFill className="film revision-two">
  <AbsoluteFill><div className="scene-viewport"><MacOpening t={83.9666666667} endingTime={endingPhysicalTime(t)} endingEntry={t} socialTime={t>=networkStart&&t<networkEnd?t-networkStart:undefined} networkCamera={socialEase(t,3.6,networkStart)*(1-socialEase(t,networkEnd,networkEnd+1.4))} settledLogo={t>=networkEnd}/></div></AbsoluteFill>
 </AbsoluteFill>;
}
