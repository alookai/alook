import React from 'react';
import { AbsoluteFill, Easing, interpolate } from 'remotion';
const smooth=(t:number,a:number,b:number)=>interpolate(t,[a,b],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.bezier(.55,0,.25,1)});
export function ClosingLaptop({t,children}:{t:number;children:React.ReactNode}) {
 const close=smooth(t,10.8,13.2);
 const orbit=smooth(t,11.2,14.5);
 const zoom=1+.6*smooth(t,10.8,14.5);
 const metal='linear-gradient(125deg,#dba666 0%,#D49A56 47%,#d7a05d 100%)';
 const face:React.CSSProperties={position:'absolute',inset:0,backfaceVisibility:'hidden',borderRadius:28};
 return <AbsoluteFill style={{background:'#f8f5ef',overflow:'hidden',perspective:close===0?'none':8000/Math.max(.0001,Math.min(1,close*5)),perspectiveOrigin:`50% ${693-153*orbit}px`,color:'#243e35',fontFamily:'DM Sans'}}>
  <div style={{position:'absolute',left:960,top:773-233*orbit,transformStyle:'preserve-3d',transform:`scale(${zoom}) rotateX(${-6.5-83.5*orbit}deg)`}}>
   <div style={{transformStyle:'preserve-3d',transform:`translateZ(${-360*orbit}px)`}}>
    <div style={{position:'absolute',left:-687.564,top:0,width:1375.128,height:720,transformOrigin:'50% 0',transform:'rotateX(90deg)',transformStyle:'preserve-3d'}}>
     <div style={{...face,background:'#966b3b',transform:'translateZ(-18px)',boxShadow:'0 22px 45px #20252224'}}/>
     <div style={{...face,background:metal,border:'2px solid #b38347'}}>
      <div style={{position:'absolute',left:110,right:110,top:48,height:360,borderRadius:20,background:'#555b5c',padding:12,display:'grid',gridTemplateColumns:'repeat(14,1fr)',gridTemplateRows:'repeat(6,1fr)',gap:8}}>
       {Array.from({length:84},(_,i)=><div key={i} style={{background:'linear-gradient(#353b3d,#252b2d)',borderRadius:6,border:'1px solid #858988',boxShadow:'0 2px 1px #0005'}}/>)}
      </div>
      <div style={{position:'absolute',left:470,top:445,width:435,height:215,border:'2px solid #b38347',borderRadius:14,background:'#ca9250'}}/>
      <div style={{position:'absolute',left:620,bottom:0,width:200,height:9,borderRadius:'10px 10px 0 0',background:'#8b6135'}}/>
     </div>
    </div>
    <div style={{position:'absolute',left:-687.564,top:0,width:1375.128,height:18,background:'linear-gradient(#d8a261,#a07340)',borderRadius:'0 0 14px 14px',transform:'translateZ(720px)',backfaceVisibility:'hidden'}}/>
    <div style={{position:'absolute',left:-687.564,top:-720,width:1375.128,height:720,transformOrigin:'50% 100%',transform:`rotateX(${6.5-96.5*close}deg)`,transformStyle:'preserve-3d'}}>
     {close>0&&<div style={{...face,background:'#232827',border:'3px solid #c08a4a',transform:'translateZ(0px)',padding:17}}>
      <div style={{position:'absolute',left:17,top:17,width:1335.128,height:680,borderRadius:13,background:'#fffdf5',overflow:'hidden'}}>{children}</div>
     </div>}

     <div style={{...face,background:'#FF9915',color:'#ffffff',border:'3px solid #c28b42',transform:'rotateX(180deg) translateZ(5px)',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'inset 0 0 0 2px #ecd0ac80'}}>
      <div style={{transform:'scale(.86)'}}>
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:36}}>
     <div style={{fontFamily:'Caveat',fontSize:54,fontWeight:600,lineHeight:1.1,marginBottom:0}}>Start sharing</div>
     <div style={{fontSize:132,fontWeight:600,lineHeight:1.15,letterSpacing:-5}}>alook.ai</div>
     <div style={{display:'flex',alignItems:'center',gap:18,fontSize:34,fontWeight:400,marginTop:30}}><svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg><span>github.com/alookai/alook</span></div>
    </div>
      </div>
     </div>
    </div>
   </div>
  </div>
  {close===0&&<div style={{position:'absolute',left:272.436,top:53,width:1375.128,height:720,background:'#232827',border:'3px solid #c08a4a',borderRadius:28,padding:17}}>
      <div style={{position:'absolute',left:17,top:17,width:1335.128,height:680,borderRadius:13,background:'#fffdf5',overflow:'hidden'}}>{children}</div>
  </div>}
 </AbsoluteFill>;
}
