import {multiInviteCamera} from './invite-motion';
import {firstActPlayback} from './first-act-clock';
import {openingCursorAt} from './opening-cursor';
import {firstDeckClock} from './first-deck';
import {networkViewport} from './social-network';
import {PullRequestWindow} from './PullRequestWindow';
import {DesktopFiles} from './DesktopFiles';
import {vortexMotion} from './local-vortex';
import {messageMotion,playbackAge} from './message-motion';
import { invitationLines } from './meeting-story';
import React from 'react';
import { Presentation } from 'lucide-react';
import { wideComputerCamera, computerCameraTransform } from './computer-camera';
import { relayRequests, relayInputAt } from './opening-relay';
import { Img, staticFile, interpolate, Easing } from 'remotion';
import {ClosingLaptop} from './ClosingLaptop';
import {BrandPreview} from './BrandPreview';
import {SocialNetwork} from './SocialNetwork';
import {SocialEntry} from './SocialEntry';
import { DeckTransition, deckCamera } from './DeckTransition';
import { FourthAct } from './FourthAct';
import { ThirdAct } from './ThirdAct';
import { CodexWindow } from './CodexWindow';
import { InviteSequence } from './InviteSequence';
import { MachineImport } from './MachineImport';
import { Product, avatarSource, GeneratedAvatar, seed, ProviderLogo } from './Product';
const miloIntroduction=invitationLines[0].text.replace('@Milo#2048','@Milo');
const step=(t:number,a:number,b:number)=>interpolate(t,[a,b],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.bezier(.55,0,.2,1)});
const shots=[[0,...wideComputerCamera],[0.45,...wideComputerCamera],[0.65,1340,420,1.85],[1.8,1340,420,1.85],[2,720,465,1.8],[2.45,720,465,1.8],[2.65,720,380,2],[3.38,720,380,2],[3.55,1340,450,1.8],[4.3,1340,450,1.8],[4.45,1340,450,1.85],[5.4,1340,450,1.85],[5.55,720,465,1.8],[6,720,465,1.8],[6.2,720,380,2],[6.93,720,380,2],[7.1,1340,450,1.8],[7.85,1340,450,1.8],[8,1340,450,1.85],[8.95,1340,450,1.85],[9.1,720,465,1.8],[9.55,720,465,1.8],[9.75,720,380,2],[10.48,720,380,2],[10.65,1340,450,1.8],[11.4,1340,450,1.8],
[11.8,...wideComputerCamera],[17.1,...wideComputerCamera],
[18.2,1344,410,2.1],[19.5,1344,410,2.1],
[21.35,650,240,2.3],[21.85,650,240,2.3],
[23.2,1150,440,2.1],[23.8,1150,440,2.1],
[25.05,1150,495,2.1],[26,1150,495,2.1],
[27.7,1150,495,2.1],[29.2,1000,600,2.45],
[37.5,1000,600,2.45],[38,1060,270,2.15],[38.9,1060,270,2.15],
[39.4,1060,350,2.15],[41.9,1060,350,2.15],[42.4,1060,450,2.15],
[43.9,1060,450,2.15],[44.4,1060,550,2.15],[50.99,1060,550,2.15],[51,...multiInviteCamera],[52,...multiInviteCamera],
[52.5,...multiInviteCamera],[53.1,...multiInviteCamera],
[54.7,1150,410,2.1],[55.5,1150,410,2.1],
[56.8,1150,490,2.1],[57.5,1150,490,2.1],
[58.8,1150,570,2.1],[60.5,1150,570,2.1],
[61.7,1150,570,2.1],[62.5,1000,600,2.45],
[72,1000,600,2.45],[72.7,1060,575,2.15],[84,1060,575,2.15],
[88.6,1060,575,2.15],[89.6,550,325,2.3],[92.5,550,325,2.3],
[93.6,1060,270,2.15],[95.8,1060,270,2.15],[96.4,1060,350,2.15],
[98.8,1060,350,2.15],[99.4,1060,450,2.15],[104,1060,450,2.15]];
export function MacOpening({t:sourceT,endingTime,endingEntry,socialTime,networkCamera=0,settledLogo=false,relayCount=relayRequests.length,cameraTime,githubZoom=1}:{t:number;relayCount?:number;cameraTime?:number;githubZoom?:number;endingTime?:number;endingEntry?:number;socialTime?:number;networkCamera?:number;settledLogo?:boolean}) {
 const firstDeck=sourceT>=120;
 const rawDeckAge=firstDeck?sourceT-120:sourceT>=104?sourceT-104:-1;
 const deckAge=firstDeck?firstDeckClock(rawDeckAge):rawDeckAge;
 const t=firstDeck?12:sourceT;
 const prDesktop=t<12||(firstDeck&&deckAge<3.35);
 const activeShots=t>=84&&t<104?[
 [84,1060,550,2.15],[84.4,1060,550,2.15],[85,550,325,2.3],[86,550,325,2.3],
 [86.8,1060,350,2.15],[94.4,1060,350,2.15],[95.4,940,520,2.8],[98.5,940,520,2.8],[99.7,1060,550,2.15],[104,1060,550,2.15]
 ]:shots.map(([at,sx,sy,sz])=>[at,sx,sy,sz*(sx===1340?githubZoom:1)]);
 const shotTime=cameraTime??t;
 let i=activeShots.findIndex(s=>s[0]>shotTime);if(i<1)i=activeShots.length-1;
 const a=activeShots[i-1],b=activeShots[i],q=step(shotTime,a[0],b[0]);let [x,y,z]=deckAge>=0?deckCamera(deckAge,firstDeck):[a[1]+(b[1]-a[1])*q,a[2]+(b[2]-a[2])*q,a[3]+(b[3]-a[3])*q];
 if(endingTime!==undefined){
  const back=step(endingTime,.1,1),closeView=step(endingTime,6.94,8.9);
  x=1060+(960-1060)*back;
  y=575+(421-575)*back+(540-421)*closeView;
  z=2.15+(1.16-2.15)*back+(1-1.16)*closeView;
  x+=(960-x)*networkCamera;y+=(371.3333333333-y)*networkCamera;z+=(1.68-z)*networkCamera;
 }
 const codex=1,leave=0, connect=step(t,12.5,13.5), app=step(t,20,21.2), resume=0, opened=step(t,12.4,13.4), suction=step(t,15.45,17.1);
 const deckSwap=deckAge<0?0:step(deckAge-2,.35,1.35)*(1-step(deckAge-2,firstDeck?17.5:7.5,firstDeck?18.5:8.5));
 const chatT=t-8;
 const typed=relayInputAt(t);
 const openingCursor=t<12?openingCursorAt(relayCount===1?Math.min(t,4.3):t,relayCount===1?firstActPlayback:undefined):undefined;
 const vortex=vortexMotion(t,295.5,295),vortexActive=t>=15.45;
 return <div className="mac-opening" style={{transform:computerCameraTransform(x,y,z)}}>
  <ClosingLaptop t={endingTime===undefined||endingTime<6.7?-1:10.8+(endingTime-6.7)*3.7/2.2}><div className="mac-display" style={{height:680}}>

   <div className="mac-wallpaper"/>
   <DesktopFiles t={t}/>
   <div className="mac-menu"><b>●</b><b>{deckAge>1.05&&deckAge<(firstDeck?19.3:9.3)?'Keynote':t>=51?'Alook':opened>.5?'Alook':'Codex'}</b><span>File</span><span>Edit</span><span>View</span><div/><b>Lin’s MacBook</b><span>Tue 9:41 AM</span></div>
   <div className="mac-app-layer" style={{position:'absolute',inset:0,zIndex:30,overflow:'hidden',transformOrigin:'center center',transform:`translateX(${-deckSwap*1500}px) scale(${1-deckSwap*.06})`}}>
   <div className={`mac-codex rush-codex ${prDesktop?"pr-codex":""}`} style={{zIndex:t>=15.45&&t<17.1?20:undefined,transformOrigin:vortexActive?"center center":"top left",opacity:vortexActive?vortex.opacity:1,filter:vortexActive?`blur(${Math.max(0,vortex.q-.8)*8}px)`:undefined,transform:vortexActive?`translate(${vortex.x-462.5}px,${vortex.y-338}px) rotate(${vortex.rotation}deg) scale(${.6*vortex.scale})`:`translate(0px,${(1-codex)*850+connect*45}px) scale(${1-connect*.4})`}}><CodexWindow typed={typed} t={relayCount===1?Math.min(t,4.3):t} title="Add team invites" openingRelay/></div>
   {prDesktop&&<div style={{position:'absolute',left:760,top:58,width:555,height:558,zIndex:25}}><PullRequestWindow t={t} relayCount={relayCount}/></div>}
   {t>=12.4&&t<21.2&&<div className="import-stage" style={{transformOrigin:'bottom left',transform:`translateY(${(1-opened)*550-app*800}px) scale(${.15+opened*.85})`}}><MachineImport t={t}/></div>}
   {t>=20&&t<51&&<div className="act2-product" style={{left:90+resume*520,top:42,transform:`translateY(${(1-app)*760}px) scale(${0.96-resume*.36})`}}><Product sourceTime={t} t={Math.min(chatT,37)} composerText={t>=29.2&&t<37.5?miloIntroduction.slice(0,Math.floor(miloIntroduction.length*Math.max(0,Math.min(1,(t-30)/6)))):undefined} lines={invitationLines}/>{t>=21.2&&t<28&&<InviteSequence t={t}/>}</div>}
   {deckAge<0&&t>=12&&t<16&&<svg className="mac-pointer" width={t<12?24:38} height={t<12?31:48} viewBox="0 0 38 48" style={{left:t<12?1000-step(t,11.5,12)*100:t<13?1000-step(t,11.5,12.15)*280:720+step(t,14,15.2)*489,top:t<12?500:t<13?500+step(t,11.5,12.15)*145:645-step(t,14,15.2)*266,transform:`scale(${(t>=12.15&&t<12.35)||(t>=15.2&&t<15.4)?.8:1})`}}><path d="M4 3 L4 34 L13 27 L21 44 L28 41 L20 24 L33 24 Z" fill="#22312d" stroke="white" strokeWidth="3"/></svg>}
   {openingCursor&&<svg data-opening-cursor className="mac-pointer" width="24" height="31" viewBox="0 0 38 48" style={{left:openingCursor.x-2.53,top:openingCursor.y-1.94,zIndex:90,transformOrigin:'2.53px 1.94px',transform:`scale(${openingCursor.pressed?.86:1})`}}><path d="M4 3 L4 34 L13 27 L21 44 L28 41 L20 24 L33 24 Z" fill="#22312d" stroke="white" strokeWidth="3"/></svg>}
   {t>=51&&t<84&&<ThirdAct t={t} endingEntry={endingEntry}/>}{t>=84&&(deckAge<8.8?<FourthAct t={Math.min(t,104)}/>:<ThirdAct t={51}/>)}
   </div>
   <DesktopFiles t={t} ghosts/>
   {deckAge>=0&&<DeckTransition age={rawDeckAge} first={firstDeck}/>}
   <div className="mac-dock" style={{zIndex:deckAge>=0?120:undefined}}><div className="dock-ppt" style={{transform:`scale(${deckAge>=1.05&&deckAge<1.25?.85:1})`}}><Presentation size={29} strokeWidth={1.65}/>{deckAge>=.65&&deckAge<1.6&&<span className="dock-tooltip">Keynote</span>}</div><div>•••</div><div style={{position:'relative',transform:`scale(${firstDeck&&deckAge>=19.3&&deckAge<19.5?.85:1})`}}><ProviderLogo provider="codex" className="runtime-logo"/>{firstDeck&&deckAge>=18.85&&deckAge<19.7&&<span className="dock-tooltip">Codex</span>}</div><div className="dock-alook" style={{transform:`scale(${(deckAge<0&&t>=12.15&&t<12.35)||(!firstDeck&&deckAge>=9.3&&deckAge<9.5)?.85:1})`}}><Img src={staticFile("alook.svg")} style={{width:40,height:40}}/>{!firstDeck&&deckAge>=8.85&&deckAge<9.7&&<span className="dock-tooltip">Alook</span>}</div></div>
   {endingTime!==undefined&&(socialTime!==undefined||endingTime>=1.05)&&<div style={{position:'absolute',inset:0,zIndex:200,background:'#faf6ed',transform:`translateX(${socialTime!==undefined?0:(1-step(endingTime,1.05,1.55))*1400}px)`}}>
    <div style={{position:'absolute',left:networkViewport.x,top:networkViewport.y,width:1920,height:1080,transform:`scale(${networkViewport.scale})`,transformOrigin:'0 0'}}>{socialTime!==undefined?<SocialNetwork t={socialTime}/>:<BrandPreview t={endingTime-1.3} settledLogo={settledLogo}/>}</div>
   </div>}
   {endingEntry!==undefined&&endingEntry<4.8&&<SocialEntry t={endingEntry}/>}
  </div></ClosingLaptop>
 </div>
}
