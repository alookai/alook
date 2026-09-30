import React from 'react';
import { IdentityBadge } from './IdentityBadge';
import { interpolate } from 'remotion';
import { InviteFriendRow } from '@/components/community/social/invite-dialog';
import { CommunityPreviewProfileOwner } from '@/stores/community/profile-preview';
import { Input } from '@/components/ui/input';
import { profiles, avatarSource } from './Product';
export function InviteSequence({t,names=["Milo","Alex"]}:{t:number;names?:string[]}) {
 const p=(a:number,b:number)=>interpolate(t,[a,b],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});
 const open=p(21.8,22.3),close=p(27,27.7);
 const moves=t<22?[247,28]:(t<24||names.length===1)?[247+p(22.3,23.3)*780,28+p(22.3,23.3)*285]:[1027,313+p(24,25)*73];
 return <CommunityPreviewProfileOwner profiles={profiles}><div className="invite-sequence">{t>=21.8&&<div className="video-invite-dialog" style={{transform:`translateY(${(1-open)*-800+close*-800}px)`}}><h2>Invite friends to Studio</h2><Input placeholder="Search for friends"/><div className="video-invite-rows">{names.map((name,i)=><div className="single-invite-row" key={name}><InviteFriendRow friend={{id:name,userId:name,name,discriminator:name==="Milo"?"2048":name==="Nova"?"4096":"1024",avatar:avatarSource(name),avatarVersion:0,status:'online',sub:''}} tokenReady inviting={false} invited={t>=(i===0?23.5:25.2)} onInvite={()=>{}}/><span className="single-backend"><IdentityBadge name={name}/></span></div>)}</div><p>{t>=25.2?`Invitations sent to ${names.join(' and ')}.`:'Invite people and agents you trust.'}</p></div>}{t<(names.length===1?24:26.1)&&<svg className="invite-pointer" width="35" height="45" viewBox="0 0 38 48" style={{left:moves[0],top:moves[1],transform:`scale(${(t>=21.5&&t<21.7)||(t>=23.5&&t<23.7)||(t>=25.2&&t<25.4)?.8:1})`}}><path d="M4 3 L4 34 L13 27 L21 44 L28 41 L20 24 L33 24 Z" fill="#22312d" stroke="white" strokeWidth="3"/></svg>}</div></CommunityPreviewProfileOwner>
}
