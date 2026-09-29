import {filmDuration} from './review-timing';
import {endingDuration} from './EndCard';
export const cardFrames=105;
export const storyCards=[
 {sourceFrame:907,resumeFrame:927,lines:[[{text:'Your ',strong:false},{text:'local',strong:true},{text:' agent',strong:false}],[{text:'Now on ',strong:false},{text:'Alook',strong:true}]]},
 {sourceFrame:1251,resumeFrame:1251,lines:[[{text:'Same bot',strong:false}],[{text:'In ',strong:false},{text:'every room',strong:true}]]},
 {sourceFrame:1740,resumeFrame:1771,holdFrames:31,lines:[[{text:'Many bots',strong:true}],[{text:'One place',strong:false}]]},
];
export const storyCardFrames=(card:typeof storyCards[number])=>cardFrames+(card.holdFrames??0);
export const cleanStoryFrames=Math.round(filmDuration*30)-333+storyCards.reduce((total,card)=>total+storyCardFrames(card)-(card.resumeFrame-card.sourceFrame),0);
export const cleanReviewFrames=510+cleanStoryFrames+Math.round(endingDuration*30);
export function cleanFrameState(frame:number){
 let inserted=0;
 for(let i=0;i<storyCards.length;i++){
  const start=storyCards[i].sourceFrame-333+inserted;
  if(frame<start)break;
  if(frame<start+storyCardFrames(storyCards[i]))return {sourceFrame:Math.min(storyCards[i].sourceFrame+frame-start,storyCards[i].resumeFrame),cardIndex:i,cardFrame:frame-start};
  inserted+=storyCardFrames(storyCards[i])-(storyCards[i].resumeFrame-storyCards[i].sourceFrame);
 }
 return {sourceFrame:frame+333-inserted,cardIndex:null,cardFrame:0};
}
