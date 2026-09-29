import React from 'react';
import { Product, type ChatLine } from './Product';
import { invitationLines } from './meeting-story';
export const familyLines:ChatLine[]=[
 {at:86.8,name:'Sam',text:'Lin, can you organize Mom’s birthday dinner?'},
 {at:89.5,name:'Lin',text:'@Milo#2048, help me plan it. Six people, Saturday at 7. Mom likes Italian.'},
 {at:94,name:'Milo',text:'I’ll shortlist Italian places for six on Saturday at 7.',memory:'Mom’s birthday dinner · Six people · Saturday 7 PM · Italian',memoryAt:95.4},
 {at:100,name:'Sam',text:'Thanks, Milo!'},
];
export function FourthAct({t}:{t:number}) {
 const home=t>=85.5;
 return <div className="act2-product" style={{left:90,top:42,transform:'scale(0.96)'}}>
  <Product t={t} home={home} lines={home?familyLines:invitationLines}/>
  {t>=85&&t<85.5&&<svg width="35" height="45" viewBox="0 0 38 48" style={{position:'absolute',zIndex:80,left:26,top:136,transform:t>=85.3?'scale(.8)':'none'}}><path d="M4 3 L4 34 L13 27 L21 44 L28 41 L20 24 L33 24 Z" fill="#22312d" stroke="white" strokeWidth="3"/></svg>}
 </div>;
}
