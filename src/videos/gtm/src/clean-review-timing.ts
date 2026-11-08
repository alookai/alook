import {filmDuration} from "./review-timing";
import timeline from "./current-timeline.json";
export const cardFrames = timeline.cardFrames;
export const storyCards = timeline.storyCards;
export const storyCardFrames=(card:typeof storyCards[number])=>cardFrames+(card.holdFrames??0);
export const cleanStoryFrames=Math.round(filmDuration*timeline.fps)-timeline.storySourceStartFrame+storyCards.reduce((total,card)=>total+storyCardFrames(card)-(card.resumeFrame-card.sourceFrame),0);
export const cleanReviewFrames=timeline.firstActFrames+cleanStoryFrames+timeline.endingFrames;
export function cleanFrameState(frame:number){
 let inserted=0;
 for(let i=0;i<storyCards.length;i++){
  const start=storyCards[i].sourceFrame-timeline.storySourceStartFrame+inserted;
  if(frame<start)break;
  if(frame<start+storyCardFrames(storyCards[i]))return {sourceFrame:Math.min(storyCards[i].sourceFrame+frame-start,storyCards[i].resumeFrame),cardIndex:i,cardFrame:frame-start};
  inserted+=storyCardFrames(storyCards[i])-(storyCards[i].resumeFrame-storyCards[i].sourceFrame);
 }
 return {sourceFrame:frame+timeline.storySourceStartFrame-inserted,cardIndex:null,cardFrame:0};
}
