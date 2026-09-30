import React from 'react';
import { AbsoluteFill, Easing, interpolate } from 'remotion';

const lines = [
  [{text: 'Still ', strong: false}, {text: 'copy-pasting', strong: true}],
  [{text: 'between your ', strong: false}, {text: 'team', strong: true}],
  [{text: 'and your ', strong: false}, {text: 'agent?', strong: true}],
];
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

export type StoryCardLines = typeof lines;
export function OpeningQuestion({time, textLines=lines, lineInterval=.8, hold=0}: {time?: number; textLines?: StoryCardLines; lineInterval?: number; hold?: number}) {
  const extraHold = hold + Math.max(0, lineInterval - .5) * (textLines.length - 1);
  return <AbsoluteFill style={{color: '#ffffff', fontFamily: 'DM Sans', overflow: 'hidden'}}>
    <AbsoluteFill style={{background: '#FF9915', translate: time === undefined ? '0 0' : `${interpolate(time,
      [2.4 + extraHold, 3.1 + extraHold], [0, -1920], {...clamp, easing: Easing.bezier(.65, 0, .35, 1)})}px 0`}}/>
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center',
      translate: time === undefined ? '0 0' : `${interpolate(time,
        [2.48 + extraHold, 3.18 + extraHold], [0, -2100], {...clamp, easing: Easing.bezier(.7, 0, .45, 1)})}px 0`}}>
      <div style={{textAlign: 'center', width: 1800, whiteSpace: 'nowrap',
        fontSize: 208, letterSpacing: -10, lineHeight: 1.08, marginTop: -18}}>
        {textLines.map((parts, index) => <div key={index} style={{
          translate: time === undefined ? '0 0' : `${interpolate(time,
            [index * lineInterval, .65 + index * lineInterval], [1920, 0],
            {...clamp, easing: Easing.bezier(.16, 1, .3, 1)}) + interpolate(time,
              [.3 + index * lineInterval, 2.48 + extraHold], [0, -36], clamp)}px 0`}}>
          {parts.map((part, partIndex) => <span key={partIndex} style={{fontWeight: part.strong ? 750 : 400, opacity: part.strong ? 1 : .62}}>{part.text}</span>)}
        </div>)}
      </div>
    </AbsoluteFill>
  </AbsoluteFill>;
}
