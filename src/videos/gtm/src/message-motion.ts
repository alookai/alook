import {reviewSegments} from './review-timing';
export function playbackAge(sourceNow:number,sourceAge:number){
 const now=reviewSegments.find(s=>sourceNow>=s.sourceFrom&&sourceNow<s.sourceTo);
 const event=sourceNow-sourceAge;
 const then=reviewSegments.find(s=>event>=s.sourceFrom&&event<s.sourceTo);
 if(!now||!then)return Math.max(1,sourceAge);
 const at=(s:NonNullable<typeof now>,v:number)=>s.from+(v-s.sourceFrom)/(s.sourceTo-s.sourceFrom)*(s.to-s.from);
 return Math.max(0,at(now,sourceNow)-at(then,event));
}
export function messageMotion(age:number){
 const p=Math.max(0,Math.min(1,age/.42)),q=p-1;
 const progress=1+2.2*q*q*q+1.2*q*q;
 return {y:28*(1-progress),opacity:Math.max(0,Math.min(1,age/.07))};
}
