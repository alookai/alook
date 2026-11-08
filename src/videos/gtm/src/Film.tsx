import React from "react";
import { sourceTimeAt } from "./review-timing";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { MacOpening } from "./MacOpening";
import voice from "./voice-timing.json";
export function Film({explain = true, narration = true, playbackTime}:{explain?:boolean;narration?:boolean;playbackTime?:number}) {
  const currentTime = useCurrentFrame() / 30;
  const frameTime = playbackTime ?? currentTime;
  const t = sourceTimeAt(frameTime);
  const openingCaptions = [
    {from: 0.2, to: 3.15, text: "Alex needs team invites."},
    {from: 3.15, to: 4.5, text: "Lin copies Alex’s request."},
    {from: 4.5, to: 6.85, text: "Then pastes it into Codex."},
    {from: 6.85, to: 11.7, text: "More requests. Copy. Paste. Repeat."},
    {from: 11.7, to: 15.2, text: "Open Alook. Import your local Codex."},
    {from: 15.2, to: 20.8, text: "Same agent. Now on Alook as Milo."},
    {from: 20.8, to: 28.5, text: "Invite Milo and Alex to the same server."},
    {from: 29.2, to: 37.5, text: "Lin introduces Milo to Alex."},
    {from: 37.5, to: 45.5, text: "Alex and Milo can talk directly."},
    {from:51,to:54,text:"Invite more of your bots."},
    {from:54,to:62,text:"Claude Code, OpenCode, Cursor. Together on Alook."},
    {from:62.5,to:72,text:"People and bots, working on the same task."},
    {from:72,to:80,text:"Write, review, build, and test—in one conversation."},
    {from:80,to:84,text:"Ready to share with the team."},
    {from:84,to:89.5,text:"The same Milo is in Home, too."},
    {from:89.5,to:95.4,text:"Lin asks Milo to help plan Mom’s birthday."},
    {from:95.4,to:104,text:"Milo remembers the dinner plans."},
  ];
  const openingCaption = openingCaptions.find(v => t >= v.from && t < v.to);
  return (
    <AbsoluteFill className="film revision-two">
      <div className="scene-viewport"><MacOpening t={t} /></div>
      {explain && openingCaption && <div className="caption"><span>{openingCaption.text}</span></div>}
      {narration && voice.map((v, i) => (
        <Sequence
          key={i}
          from={Math.round(v.at * 30)}
          durationInFrames={Math.ceil(v.duration * 30)}
        >
          <Audio src={staticFile(v.file)} volume={1.25} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
