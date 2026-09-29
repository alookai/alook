import {githubFlood} from './github-flood';
import {relayRequests} from './opening-relay';
import {reviewSegments} from './review-timing';
import {playbackAge,messageMotion} from './message-motion';
export function openingPlayback(t:number){const s=reviewSegments.find(s=>t>=s.sourceFrom&&t<=s.sourceTo)!;return s.from+(t-s.sourceFrom)/(s.sourceTo-s.sourceFrom)*(s.to-s.from);}
export function prScrollAt(t:number,relayCount=relayRequests.length){let scroll=0;for(const [i,r] of Array.from(relayRequests.slice(0,relayCount).entries()))for(const e of [{at:r.at,to:Math.max(0,(i*2+1)*104-270)},{at:r.compose,to:Math.max(0,(i*2+1)*104+172-270)}])if(t>=e.at){const q=Math.min(1,playbackAge(t,t-e.at)/.08);scroll+=(e.to-scroll)*q*q*(3-2*q);}for(const [i,r] of Array.from(githubFlood.entries()))if(t>=r.at){const q=Math.min(1,playbackAge(t,t-r.at)/.12);scroll+=((relayCount*2+1+i)*104-270-scroll)*q*q*(3-2*q);}return scroll;}
export function codexScrollAt(t:number){let scroll=0;for(const [i,r] of Array.from(relayRequests.entries()))if(t>=r.send){const q=Math.min(1,playbackAge(t,t-r.send)/.5);scroll+=(110+(i+1)*210-245-scroll)*q*q*(3-2*q);}return scroll;}
export type CursorPoint={x:number;y:number};
export function relayTargets(i:number,t:number){const r=relayRequests[i],row=301+i*208-prScrollAt(t)+messageMotion(playbackAge(t,t-r.at)).y,compose=301+(i*2+1)*104-prScrollAt(t),answer=109+39+12+110+i*210-codexScrollAt(t);return {
 request:{x:1028,y:row+53},requestStart:{x:839,y:row+53},copy:{x:1001,y:row+73},
 input:{x:320,y:473},paste:{x:267,y:435},send:{x:681,y:510},
 answer:{x:625,y:answer+113},answerStart:{x:222,y:answer+113},answerCopy:{x:584,y:answer+166},
 compose:{x:915,y:compose+80},answerPaste:{x:1001,y:compose+96},post:{x:1252,y:compose+122}
 };}
type Target=keyof ReturnType<typeof relayTargets>;
type Key={at:number;i:number;target:Target};
const keys:Key[]=[];
relayRequests.forEach((r,i)=>{keys.push(
 ...(i===0?[{at:0,i,target:'requestStart' as Target}]:[]),
 {at:r.at,i,target:'requestStart'},{at:r.copy,i,target:'request'},
 {at:r.copy+.04,i,target:'copy'},{at:r.copyEnd,i,target:'copy'},
 {at:r.pasteMenu,i,target:'paste'},{at:r.paste,i,target:'paste'},
 {at:r.send,i,target:'send'},{at:r.send+.02,i,target:'send'},
 {at:r.replyStart+.15,i,target:'answerStart'},{at:r.answerCopy,i,target:'answer'},
 {at:r.answerCopy+.04,i,target:'answerCopy'},{at:r.answerCopy+.07,i,target:'answerCopy'},
 {at:r.compose+.025,i,target:'compose'},{at:r.compose+.1,i,target:'answerPaste'},
 {at:r.answerPaste,i,target:'answerPaste'},{at:r.post,i,target:'post'},
 );});
export const openingCursorKeys=keys;
export function openingCursorAt(t:number,playback=openingPlayback){let n=keys.findIndex(k=>k.at>t);if(n<0)n=keys.length;const a=keys[Math.max(0,n-1)],b=keys[Math.min(n,keys.length-1)];const start=relayTargets(a.i,a.at)[a.target],end=relayTargets(b.i,b.at)[b.target];const duration=playback(b.at)-playback(a.at);const q=duration?Math.max(0,Math.min(1,(playback(t)-playback(a.at))/duration)):1,e=b.target==='request'||b.target==='answer'?q:q*q*(3-2*q);const exit=Math.max(0,Math.min(1,(playback(t)-playback(11.7))/(playback(12)-playback(11.7)))),ex=exit*exit*(3-2*exit);return {x:(start.x+(end.x-start.x)*e)*(1-ex)+900*ex,y:(start.y+(end.y-start.y)*e)*(1-ex)+500*ex,pressed:relayRequests.some(r=>[r.copied,r.paste,r.send,r.answerCopy+.05,r.answerPaste,r.post].some(at=>t>=at&&playbackAge(t,t-at)<.08))};}
