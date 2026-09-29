import React from 'react';
import {desktopFiles,vortexMotion} from './local-vortex';
function Icon({kind,id}:{kind:string;id:string}){
 return <svg width="80" height="80" viewBox="0 0 64 64" style={{overflow:'visible',filter:'drop-shadow(0 2px 2px #203e5038)'}}>
 <defs><linearGradient id={id} x2="0" y2="1"><stop stopColor="#9ee5ff"/><stop offset="1" stopColor="#399dda"/></linearGradient></defs>
 {kind==='folder'?<><path d="M3 16 Q3 11 8 11 H25 L31 17 H56 Q61 17 61 22 V51 Q61 55 56 55 H8 Q3 55 3 50Z" fill="#439dcb"/><path d="M3 25 Q3 20 8 20 H56 Q61 20 61 25 V51 Q61 55 56 55 H8 Q3 55 3 50Z" fill={`url(#${id})`} stroke="#a9e4fb" strokeWidth=".8"/></>:<><path d="M13 4 H39 L53 18 V57 Q53 60 50 60 H14 Q11 60 11 57 V7 Q11 4 13 4Z" fill="#fffefc" stroke="#deded8"/><path d="M39 4 V18 H53" fill="#e3e9ed"/>{kind==='sheet'?<><rect x="17" y="24" width="30" height="25" rx="2" fill="#d3e8d8"/><path d="M17 31H47M17 39H47M27 24V49M37 24V49" stroke="#73a285"/><rect x="17" y="24" width="30" height="7" fill="#498667"/></>:<>{[26,32,38,44].map((y,i)=><path key={y} d={`M18 ${y}H${i===3?36:45}`} stroke="#a9b2b6" strokeWidth="2"/>)}</>}{kind==='pdf'&&<rect x="6" y="42" width="34" height="15" rx="3" fill="#cc594e"/>}{kind==='pdf'&&<text x="23" y="53" fontSize="10" fontWeight="700" textAnchor="middle" fill="white">PDF</text>}</>}
 </svg>;
}
export function DesktopFiles({t,ghosts=false}:{t:number;ghosts?:boolean}){
 if(ghosts&&(t<15.45||t>=17.1))return null;
 return <div style={{position:'absolute',inset:0,zIndex:ghosts?46:1,pointerEvents:'none'}}>
 {desktopFiles.filter(file=>!ghosts||file.x<500).map((file,i)=>{
 const m=ghosts?vortexMotion(t,file.x,file.y,i*.035):null;
 return <div key={file.name} data-desktop-file={file.name} style={{position:'absolute',left:(m?m.x:file.x)-60,top:(m?m.y:file.y)-40,width:120,display:'flex',flexDirection:'column',alignItems:'center',gap:3,textAlign:'center',opacity:m?m.opacity:1,transform:m?`rotate(${m.rotation}deg) scale(${m.scale})`:undefined,transformOrigin:'60px 40px',filter:m&&m.q>.8?`blur(${(m.q-.8)*5}px)`:undefined}}><Icon kind={file.kind} id={`${ghosts?'ghost':'original'}-${i}`}/><div style={{opacity:m?Math.max(0,Math.min(1,(.68-m.q)/.15)):1,fontFamily:'-apple-system,Arial,sans-serif',fontSize:16,lineHeight:'19px',fontWeight:600,color:'#fff',textShadow:'0 1px 3px #202326,0 0 3px #202326',whiteSpace:'nowrap',background:ghosts?'#243d4bd9':undefined,borderRadius:4,padding:ghosts?'1px 4px':undefined}}>{file.name}</div></div>;
 })}
 </div>;
}
