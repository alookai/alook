import React from "react";
import { FirstActPreview } from "./FirstActPreview";
import { OpeningQuestion } from "./OpeningQuestion";
import { filmDuration } from "./review-timing";
import { Composition, Sequence } from "remotion";
import { EndCard, endingDuration } from "./EndCard";
import { Film } from "./Film";
import { CleanReview, cleanReviewFrames, LaunchReview, launchDuration } from "./LaunchReview";
import "./product.css";
import "./style.css";
const CompleteFilm=()=> <><Sequence durationInFrames={filmDuration*30}><Film/></Sequence><Sequence from={filmDuration*30}><EndCard/></Sequence></>;
export const Root = () => (
 <>
  <Composition id="AlookCleanReview" component={CleanReview} width={1920} height={1080} fps={30} durationInFrames={cleanReviewFrames}/>
  <Composition id="AlookFirstActPointEight" component={()=> <FirstActPreview lineInterval={.8}/>} width={1920} height={1080} fps={30} durationInFrames={510}/>
 <Composition id="AlookFirstActOneSecond" component={()=> <FirstActPreview lineInterval={1}/>} width={1920} height={1080} fps={30} durationInFrames={522}/>
 <Composition id="AlookFirstActPreview" component={FirstActPreview} width={1920} height={1080} fps={30} durationInFrames={510}/>
  <Composition id="AlookOpeningQuestion" component={OpeningQuestion} width={1920} height={1080} fps={30} durationInFrames={120}/>
  <Composition id="AlookLaunchReview" component={LaunchReview} width={1920} height={1080} fps={30} durationInFrames={Math.round(launchDuration*30)}/>
  <Composition
    id="AlookGTM"
    component={CompleteFilm}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={Math.round((filmDuration+endingDuration) * 30)}
  />
 <Composition id="AlookSocialEnding" component={EndCard} width={1920} height={1080} fps={30} durationInFrames={Math.round(endingDuration*30)}/>
 <Composition id="AlookEndCard" component={EndCard} width={1920} height={1080} fps={30} durationInFrames={Math.round(endingDuration*30)}/>
 </>
);
