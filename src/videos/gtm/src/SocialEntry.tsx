import React,{useLayoutEffect,useRef,useState} from 'react';
import {Img,staticFile,delayRender,continueRender} from 'remotion';
import {socialEase,botPosition,networkEntry} from './social-network';
import {GeneratedAvatar,seed} from './Product';
export function SocialEntry({t}:{t:number}){
 const ref=useRef<HTMLDivElement>(null),[origin,setOrigin]=useState<{x:number;y:number;size:number}|null>(null);
 useLayoutEffect(()=>{
  if(t<3.6)return;
  const handle=delayRender('Locate Lin message avatar');let cancelled=false;
  const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  void(async()=>{await document.fonts.ready;for(let i=0;i<5;i++)await frame();
   const display=ref.current?.parentElement,photo=display?.querySelector('[data-message-text="Alook is sooo good."] img');
   if(!cancelled&&display&&photo){const d=display.getBoundingClientRect(),a=photo.getBoundingClientRect(),scale=d.width/display.clientWidth;setOrigin({x:(a.left+a.width/2-d.left)/scale,y:(a.top+a.height/2-d.top)/scale,size:a.width/scale});}
   await frame();continueRender(handle);
  })();return()=>{cancelled=true;continueRender(handle)};
 },[t]);
 const lift=socialEase(t,3.6,4.8),wash=socialEase(t,3.6,4.7),size=(origin?.size??38.4)+(networkEntry.size-(origin?.size??38.4))*lift;
 return <div ref={ref} style={{position:'absolute',inset:0,zIndex:201,pointerEvents:'none'}}>
  {t>=3.6&&<style>{'[data-message-text="Alook is sooo good."] button:has(img) {visibility:hidden}'}</style>}
  <div style={{position:'absolute',inset:0,background:'#faf6ed',opacity:wash}}/>
  {t>=3.6&&origin&&<div style={{position:'absolute',left:origin.x+(networkEntry.x-origin.x)*lift,top:origin.y+(networkEntry.y-origin.y)*lift-Math.sin(lift*Math.PI)*65,transform:'translate(-50%,-50%)'}}>
   <div style={{width:size,height:size,borderRadius:'50%',overflow:'hidden',border:`${4.98*lift}px solid #fffdf5`,boxShadow:`0 ${3*lift}px ${16*lift}px #243e351a`}}><Img src={staticFile('people/Lin.png')} style={{width:'100%',height:'100%',objectFit:'cover'}}/></div>
   {['Milo','Nova','Remy','Pip'].map((name,i)=>{const p=botPosition(t-3.6,i,4,0,108),scale=size/128;return <div key={name} style={{position:'absolute',left:size/2+p.x*scale,top:size/2+p.y*scale,opacity:p.opacity,transform:`translate(-50%,-50%) scale(${scale}) rotate(${p.roll}deg)`}}><div style={{width:62,height:62,border:'4px solid #fffdf5',borderRadius:'50%',overflow:'hidden',background:'#faf6ed'}}><GeneratedAvatar seed={seed(name)} size={54}/></div></div>})}
  </div>}
 </div>;
}
