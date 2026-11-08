import timeline from "./current-timeline.json";
export const firstActSourceTimes = timeline.firstActSourceTimes;
export const firstActPlaybackTimes = timeline.firstActPlaybackTimes;
export function firstActPlayback(t:number){
 const i=Math.max(0,Math.min(firstActSourceTimes.length-2,firstActSourceTimes.findIndex((end,j)=>j>0&&t<=end)-1));
 const sourceEnd=firstActSourceTimes[firstActSourceTimes.length-1],playbackEnd=firstActPlaybackTimes[firstActPlaybackTimes.length-1];
 if(t>=sourceEnd)return playbackEnd+(t-sourceEnd);
 return firstActPlaybackTimes[i]+(t-firstActSourceTimes[i])/(firstActSourceTimes[i+1]-firstActSourceTimes[i])*(firstActPlaybackTimes[i+1]-firstActPlaybackTimes[i]);
}
