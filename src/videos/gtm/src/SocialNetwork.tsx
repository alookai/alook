import React from 'react';
import {AbsoluteFill,Img,staticFile} from 'remotion';
import {GeneratedAvatar,seed} from './Product';
import {AlookLogoAnimation} from './official-logo-animation';
import {socialPeople,socialLinks,socialEase,networkMotion,botPosition,clamp01,networkCenter} from './social-network';

function regionBoundary(index:number){
 const count=12,phase=[.35,2.1,4.25,5.7][index];
 const points=Array.from({length:count},(_,i)=>{const angle=i*Math.PI*2/count,r=1+.14*Math.sin(3*angle+phase)+.075*Math.cos(5*angle-phase)+.065*Math.sin(angle+phase*1.7);return {x:Math.cos(angle)*r,y:Math.sin(angle)*r};});
 const point=(i:number)=>points[(i+count)%count],format=(n:number)=>n.toFixed(4);
 let path=`M${format(points[0].x)},${format(points[0].y)}`;
 for(let i=0;i<count;i++){const a=point(i-1),b=point(i),c=point(i+1),d=point(i+2);path+=` C${format(b.x+(c.x-a.x)/6)},${format(b.y+(c.y-a.y)/6)} ${format(c.x-(d.x-b.x)/6)},${format(c.y-(d.y-b.y)/6)} ${format(c.x)},${format(c.y)}`;}
 return path+' Z';
}

function NetworkGraph({t}:{t:number}){
 return <>
  <svg width="4400" height="4000" viewBox="-2200 -2000 4400 4000" style={{position:'absolute',left:-2200,top:-2000,overflow:'visible'}}>
   {[
    {x:-1000,y:-660,rx:860,ry:570,angle:-13,color:'#FE4365'},
    {x:830,y:-880,rx:680,ry:760,angle:-29,color:'#8A5A9E'},
    {x:-790,y:540,rx:850,ry:720,angle:-25,color:'#45ADA8'},
    {x:910,y:630,rx:1050,ry:600,angle:-18,color:'#6A8CAF'},
   ].map((region,i)=><path key={region.color} d={regionBoundary(i)} transform={`translate(${region.x*.5} ${region.y*.5}) rotate(${region.angle}) scale(${region.rx*.5} ${region.ry*.5})`} fill={region.color} opacity={.095*socialEase(t,2.2+i*.22,4.2+i*.22)}/>) }
  </svg>
  <svg width="4400" height="4000" viewBox="-2200 -2000 4400 4000" style={{position:'absolute',left:-2200,top:-2000,overflow:'visible'}}>
   {socialLinks.map(([a,b],i)=>{
    const p=socialPeople[a],q=socialPeople[b],born=Math.max(p.at,q.at)+.6;
    const opacity=socialEase(t,born,born+.55)*(1-socialEase(t,7.6,8.2));
    const bend=(i%2?1:-1)*90,cx=(p.x+q.x)/2,cy=(p.y+q.y)/2+bend;
    const cycle=Math.max(0,t-born)*.43+i*.13,phase=cycle%1,u=Math.floor(cycle)%2?1-phase:phase;
    const x=(1-u)*(1-u)*p.x+2*(1-u)*u*cx+u*u*q.x,y=(1-u)*(1-u)*p.y+2*(1-u)*u*cy+u*u*q.y;
    return <g key={i} opacity={opacity}><path d={`M${p.x},${p.y} Q${cx},${cy} ${q.x},${q.y}`} fill="none" stroke="#84998a" strokeWidth="3"/><g transform={`translate(${x},${y})`}><rect x="-25" y="-15" width="50" height="30" rx="12" fill={i%2?'#d49a56':'#476f5b'}/><circle cx="-10" r="3" fill="#fffdf5"/><circle r="3" fill="#fffdf5"/><circle cx="10" r="3" fill="#fffdf5"/></g></g>;
   })}
  </svg>
  {socialPeople.map((person,index)=>{
   const appear=index===0?1:socialEase(t,person.at,person.at+.65),radius=index===0?108:102;
   return <div key={person.name} style={{position:'absolute',left:person.x,top:person.y+55*(1-appear),opacity:appear,transform:`scale(${.65+.35*appear})`}}>

    <div style={{position:'absolute',left:-64,top:-64,width:128,height:128,borderRadius:'50%',overflow:'hidden',border:'5px solid #fffdf5',boxShadow:'0 3px 16px #243e351a'}}><Img src={staticFile(`people/${person.name}.png`)} style={{width:'100%',height:'100%',objectFit:'cover'}}/></div>
    {person.bots.map((name,i)=>{const p=botPosition(index===0?t+1.2:t,i,person.bots.length,person.at,radius,index===0?390:180);return <div key={name} style={{position:'absolute',left:p.x-31,top:p.y-31,opacity:p.opacity,transform:`scale(${p.scale}) rotate(${p.roll}deg)`}}><div style={{border:'4px solid #fffdf5',borderRadius:'50%',width:62,height:62,overflow:'hidden',background:'#fffdf5'}}><GeneratedAvatar seed={seed(name)} size={54}/></div></div>;})}
   </div>;
  })}
 </>;
}
export function SocialNetwork({t}:{t:number}){
 const motion=networkMotion(t),trail=socialEase(t,7.3,8.2),logo=socialEase(t,8.1,8.65);
 return <AbsoluteFill style={{background:'#faf6ed',overflow:'hidden',fontFamily:'DM Sans'}}>
  {[{offset:-13,opacity:.07*trail},{offset:-6,opacity:.12*trail},{offset:0,opacity:1}].filter(layer=>layer.opacity>0).map((layer,i)=><div key={i} style={{position:'absolute',left:networkCenter.x,top:motion.centerY,opacity:motion.opacity*layer.opacity,transform:`scale(${motion.scale}) rotate(${motion.rotation+layer.offset}deg)`,filter:motion.blur>.1?`blur(${motion.blur}px)`:undefined}}><NetworkGraph t={t}/></div>)}
  {t>=8.1&&<div style={{position:'absolute',left:690,top:270,width:540,height:540,opacity:logo}}><div style={{width:1080,height:1080,transform:'scale(.5)',transformOrigin:'0 0'}}><AlookLogoAnimation background="transparent" frameOverride={Math.min(299,156+clamp01((t-8.1)/.9)*143)}/></div></div>}
 </AbsoluteFill>;
}
