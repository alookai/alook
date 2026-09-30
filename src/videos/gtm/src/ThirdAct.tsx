import {inviteRowMotion} from './invite-motion';
import React from 'react';
import { invitationLines } from './meeting-story';
import { IdentityBadge } from './IdentityBadge';
import { interpolate, Easing } from 'remotion';
import { Product, type ChatLine, GeneratedAvatar, seed, avatarSource, ProviderLogo } from './Product';
import { InviteFriendRow } from '@/components/community/social/invite-dialog';
import { CommunityPreviewProfileOwner } from '@/stores/community/profile-preview';
import { Input } from '@/components/ui/input';
import { profiles } from './Product';
const linear=(t:number,a:number,b:number)=>Math.max(0,Math.min(1,(t-a)/(b-a)));
const p=(t:number,a:number,b:number)=>interpolate(t,[a,b],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.bezier(.4,0,.2,1)});
const bots=[
 {name:'Nova',backend:'claude',label:'Claude Code',discriminator:'4096',at:55},
 {name:'Remy',backend:'opencode',label:'OpenCode',discriminator:'3072',at:57},
 {name:'Pip',backend:'cursor',label:'Cursor',discriminator:'5120',at:59},
];
export const collaborationLines:ChatLine[]=[
 ...invitationLines.map((line,i)=>({...line,at:1+i})),
 {at:51,clock:'2026-09-15T06:31:00Z',name:'Lin',text:'The invite flow still needs email, code review, and tests.'},
 {at:72,clock:'2026-09-15T06:32:00Z',name:'Lin',text:'@Nova#4096, draft the email. @Remy#3072, review Milo’s code. @Pip#5120, test the flow.'},
 {at:74,clock:'2026-09-15T06:33:00Z',name:'Nova',text:'@Milo#2048, the invitation email is ready to use.'},
 {at:76,clock:'2026-09-15T06:34:00Z',name:'Remy',text:'@Milo#2048, reject expired invitation links.'},
 {at:78,clock:'2026-09-15T06:35:00Z',name:'Milo',text:'Email added. Expired links are handled. @Pip#5120, ready for testing.'},
 {at:80,clock:'2026-09-15T06:36:00Z',name:'Pip',text:'Join, resend, expired links—all pass.'},
 {at:82,clock:'2026-09-15T06:37:00Z',name:'Alex',text:'Looks good. Ready to share with the team.'},
];
const pointerPath="M4 3 L4 34 L13 27 L21 44 L28 41 L20 24 L33 24 Z";
function MultiInvite({t}:{t:number}){
 const open=1,close=p(t,61,61.7);
 const click= t<56?55:t<58?57:59;
 const py=t<54?220+(270-220)*p(t,51.8,54):270+85*p(t,56.2,56.8)+85*p(t,58.2,58.8);
 const px=t<54?700+(1027-700)*p(t,51.8,54):1027;
 return <CommunityPreviewProfileOwner profiles={profiles}>
  <div className="invite-sequence">
   {t>=51&&<div className="video-invite-dialog multi-invite-dialog" style={{transform:`translateY(${(1-open)*-800-close*800}px)`}}>
    <h2>Invite friends to Studio</h2><Input placeholder="Search for friends"/>
    <div className="multi-invite-rows" style={{overflow:'hidden'}}>{bots.map((bot,i)=><div className="multi-invite-row" key={bot.name} style={{opacity:inviteRowMotion(t,i).opacity,transform:`translateX(${inviteRowMotion(t,i).x}px)`}}>
     <InviteFriendRow friend={{id:bot.name,userId:bot.name,name:bot.name,discriminator:bot.discriminator,avatar:avatarSource(bot.name),avatarVersion:0,status:'online',sub:''}} tokenReady inviting={false} invited={t>=bot.at} onInvite={()=>{}}/>
     <span className="multi-backend"><IdentityBadge name={bot.name}/></span>
    </div>)}</div>
   </div>}
   {t>=51.8&&t<60&&<svg className="invite-pointer" width="35" height="45" viewBox="0 0 38 48" style={{left:px,top:py,transform:`scale(${Math.abs(t-click)<.14?.8:1})`}}><path d={pointerPath} fill="#22312d" stroke="white" strokeWidth="3"/></svg>}
   {bots.map((bot,i)=>{
    const f=p(t,bot.at,bot.at+1.2);
    return t>=bot.at&&t<bot.at+1.2?<div className="invited-bot-flight" key={bot.name} style={{left:473+(28-473)*f,top:284+i*85+(93-284-i*85)*f-Math.sin(f*Math.PI)*100,transform:`translate(-50%,-50%) scale(${1-f*.6})`}}><GeneratedAvatar seed={seed(bot.name)} size={64}/></div>:null;
   })}
  </div>
 </CommunityPreviewProfileOwner>;
}
export function ThirdAct({t,endingEntry}:{t:number;endingEntry?:number}){
 const segments=[{start:63,end:66,name:'Nova',tail:', draft the email. '},{start:66,end:69,name:'Remy',tail:', review Milo’s code. '},{start:69,end:71.7,name:'Pip',tail:', test the flow.'}];
 let text='';
 for(const s of segments){
  if(t<s.start)break;
  if(t<s.start+.8){text+='@'+s.name.slice(0,Math.floor(linear(t,s.start,s.start+.8)*(s.name.length-1)));break;}
  text+='@'+s.name+s.tail.slice(0,Math.max(1,Math.floor(linear(t,s.start+.8,s.end)*s.tail.length)));
 }
 return <div className="act2-product" style={{left:90,top:42,transform:"scale(0.96)"}}>
  <Product realtimeMotion={endingEntry!==undefined} t={endingEntry===undefined?t:83.9666666667+Math.min(endingEntry,3.5)} lines={endingEntry===undefined?collaborationLines:[...collaborationLines,{at:85.7666666667,name:"Lin",text:"Alook is sooo good.",clock:"2026-09-15T06:38:00Z"}]} composerText={endingEntry!==undefined&&endingEntry<1.8?"Alook is sooo good.".slice(0,Math.floor(linear(endingEntry,.4,1.6)*18)):t>=62.5&&t<72?text:undefined}/>
  {t>=51&&t<62&&<MultiInvite t={t}/>}
 </div>;
}
