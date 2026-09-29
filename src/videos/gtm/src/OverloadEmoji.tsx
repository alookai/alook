import React from 'react';
import {overloadStart,overloadLength,overloadMotion} from './overload-emoji';
export function OverloadEmoji({t}:{t:number}){const age=t-overloadStart;if(age<0||age>=overloadLength)return null;const m=overloadMotion(age);return <div style={{position:'absolute',left:960,top:410,zIndex:200,opacity:m.opacity,pointerEvents:'none'}}>
 {Array.from({length:10},(_,i)=>{const a=i*Math.PI/5,r=80+105*m.burst;return <i key={i} style={{position:'absolute',left:Math.cos(a)*r,top:Math.sin(a)*r,width:8,height:i%2?20:10,borderRadius:4,background:['#FF9915','#f16547','#ecc44e'][i%3],opacity:1-m.burst*.85,transform:`rotate(${i*36+m.burst*110}deg) scale(${1-m.burst*.45})`}}/>;})}
 <div style={{position:'absolute',left:-120,top:-120,width:240,height:240,display:'grid',placeItems:'center',fontFamily:'Apple Color Emoji,Segoe UI Emoji,sans-serif',fontSize:190,lineHeight:1,filter:'drop-shadow(0 8px 10px #422e1930)',transform:`translateY(${-16*m.burst}px) rotate(${m.rotation}deg) scale(${m.scale})`}}>🤯</div>
 </div>;}
