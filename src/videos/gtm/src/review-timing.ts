import timeline from "./current-timeline.json";
export const reviewSegments = timeline.reviewSegments.map(({fromFrame,toFrame,sourceFrom,sourceTo}) => ({from:fromFrame/timeline.fps,to:toFrame/timeline.fps,sourceFrom,sourceTo}));
export const filmDuration = timeline.reviewSegments[timeline.reviewSegments.length-1].toFrame/timeline.fps;
export function sourceTimeAt(time:number){
 const segment=reviewSegments.find(s=>time<s.to)??reviewSegments[reviewSegments.length-1];
 return segment.sourceFrom+(time-segment.from)/(segment.to-segment.from)*(segment.sourceTo-segment.sourceFrom);
}
