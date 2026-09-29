import React, { useLayoutEffect, useRef, useState } from "react";
import { ListTodo, Check } from "lucide-react";
import { interpolate, Easing } from "remotion";
import { createPortal } from "react-dom";
import { Message } from "@/components/community/messages/message";
import { IdentityBadge } from "./IdentityBadge";
import type { RenderMsg } from "@/lib/community/models/message";

export function VideoMessage({ m, memory, memoryAge }: { m: RenderMsg; memory?: string; memoryAge?: number }) {
  const root = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const header = root.current?.querySelector(".items-baseline");
    const name = header?.querySelector("button");
    if (!name) return;
    const mount = document.createElement("span");
    mount.style.cssText = "display:inline-flex;align-self:center;flex-shrink:0";
    name.after(mount);
    setSlot(mount);
    return () => mount.remove();
  }, []);
  const age=memoryAge??-1;
  const reveal=interpolate(age,[0,.5],[0,1],{extrapolateLeft:"clamp",extrapolateRight:"clamp",easing:Easing.bezier(.2,.8,.2,1)});
  return <div ref={root} className={memory&&age>=0?"video-memory-active":undefined} style={{position:"relative", "--memory-reveal":reveal, "--memory-ring":`${Math.sin(Math.min(1,Math.max(0,age)/1.2)*Math.PI)*7}px`} as React.CSSProperties}>
    <Message m={m} onOpenThread={() => {}} />
    {memory&&age>=0&&<div className="video-memory-note" style={{transform:`translateY(${(1-reveal)*10}px) scale(${.88+.12*reveal})`,clipPath:`inset(0 ${100*(1-reveal)}% 0 0 round 10px)`}}>
      <header><ListTodo size={15}/><b>{age<.8?'Remembering…':'Remembered'}</b>{age>=.8&&<Check size={15}/>}</header>
      <p>{memory}</p>
    </div>}
    {slot && createPortal(
      <IdentityBadge name={m.authorId ?? m.authorName ?? ""} />,
      slot,
    )}
  </div>;
}
