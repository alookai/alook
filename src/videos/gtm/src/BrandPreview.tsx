import React from 'react';
import { AbsoluteFill, Easing, interpolate, getInputProps } from 'remotion';
import { AlookLogoAnimation } from './official-logo-animation';
export function BrandPreview({t,settledLogo=false}:{t:number;settledLogo?:boolean}) {
 const move=(start:number,end:number)=>interpolate(t,[start,end],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.bezier(.65,0,.25,1)});

 const {brandFont='Avenir Next'}=getInputProps() as {brandFont?:string};
 const side=move(1.35,2);
 const reveal=move(1.85,2.25);

 return <AbsoluteFill style={{background:'#faf6ed',overflow:'hidden',color:'#243e35',fontFamily:'DM Sans'}}>
   <AbsoluteFill>
    <div style={{position:'absolute',left:690-side*735,top:270-side*150,width:540+side*300,height:540+side*300}}>
     <div style={{width:1080,height:1080,position:'absolute',transform:`scale(${(540+side*300)/1080})`,transformOrigin:'0 0'}}>
      <AlookLogoAnimation background="transparent" frameOverride={settledLogo?299:Math.min(299,Math.max(0,(t-.1)*120))}/>
     </div>
    </div>
    <div style={{position:'absolute',left:745,top:285,width:700,height:280,clipPath:`inset(0 ${(1-reveal)*100}% 0 0)`}}>
     <div style={{fontFamily:'Caveat',fontSize:260,fontWeight:700,lineHeight:1,transform:`translateX(${(1-reveal)*-45}px)`}}>Alook</div>
    </div>
    <div style={{position:'absolute',left:760,top:590,width:1080,textAlign:'left',fontFamily:brandFont,fontSize:76,fontWeight:500,fontStyle:'italic',letterSpacing:-1.3,lineHeight:1.2,color:'#263c36',opacity:move(2.15,2.45)}}>Open-source Discord<br/><span style={{whiteSpace:'nowrap'}}>for human–agent collaboration.</span></div>
   </AbsoluteFill>
  </AbsoluteFill>;
}
