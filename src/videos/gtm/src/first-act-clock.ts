export const firstActSourceTimes = [0, .65, .76, 1.5, 1.8, 2, 2.2, 2.45, 2.5, 2.8, 3, 3.3, 3.38, 3.55, 3.6, 3.86, 4.3];
export const firstActPlaybackTimes = [0, .6, 1, 2, 2.5, 3.1, 3.5, 3.85, 4.1, 4.65, 5.25, 5.8, 6.25, 6.6, 7.1, 7.7, 7.8];
export function firstActPlayback(t:number){
 const i=Math.max(0,Math.min(firstActSourceTimes.length-2,firstActSourceTimes.findIndex((end,j)=>j>0&&t<=end)-1));
 if(t>=4.3)return 7.8+(t-4.3);
 return firstActPlaybackTimes[i]+(t-firstActSourceTimes[i])/(firstActSourceTimes[i+1]-firstActSourceTimes[i])*(firstActPlaybackTimes[i+1]-firstActPlaybackTimes[i]);
}
