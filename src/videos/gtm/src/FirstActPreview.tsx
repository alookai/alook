import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { firstActSourceTimes, firstActPlaybackTimes } from './first-act-clock';
import { OpeningQuestion } from './OpeningQuestion';
import { MacOpening } from './MacOpening';
import { sourceTimeAt } from './review-timing';
import { OverloadEmoji } from './OverloadEmoji';

export function FirstActPreview({lineInterval=.8}: {lineInterval?: number}) {
  const elapsed = useCurrentFrame() / 30;
  const extraHold = Math.max(0, lineInterval - .5) * 2;
  const sceneElapsed = elapsed - Math.min(extraHold, Math.max(0, elapsed - 3.1));
  const seconds = sceneElapsed + 1.5 - Math.min(.6, Math.max(0, sceneElapsed - 2.5));
  const floodClock = interpolate(seconds - 11.8,
    [0, .85, 1.55, 2.15, 2.65, 3.05, 3.4, 3.68, 3.9, 4.08, 4.25, 5.2, 5.5],
    [8.2, 254/30, 262/30, 269/30, 276/30, 282/30, 288/30, 293/30, 298/30, 302/30, 10.2, 11.09, 11.09],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const source = seconds >= 11.8 ? sourceTimeAt(floodClock) : interpolate(seconds - 4,
    firstActPlaybackTimes,
    firstActSourceTimes,
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return <AbsoluteFill className="film revision-two">
    <div className="scene-viewport"><MacOpening t={source} relayCount={1} githubZoom={1.6} cameraTime={seconds < 11.8 ? undefined : interpolate(seconds,
      [11.8, 15.65, 16.25], [11.4, 11.4, 11.8],
      {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}/></div>
    {seconds >= 11.8 && <OverloadEmoji t={floodClock}/>}
    {elapsed < 3.2 + extraHold && <OpeningQuestion time={elapsed} lineInterval={lineInterval}/>}
  </AbsoluteFill>;
}
