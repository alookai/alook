import {multiInviteCamera} from './invite-motion';
import {firstDeckClock,teammateSlideAt} from './first-deck';
import React from 'react';
import { wideComputerCamera } from './computer-camera';
import {interpolate, Easing, Img, staticFile} from 'remotion';
import {PanelLeft, Plus, Play, Table2, ChartColumn, Type, Shapes, Image, MessageSquare, Paintbrush, Sparkles, File, ChevronDown, AlignLeft, AlignCenter, AlignRight, AlignJustify, Bold, Italic, Underline, List, Presentation, UsersRound, ZoomIn} from 'lucide-react';
import {slideTyping} from './slide-typing';
import {ProviderLogo} from '@/components/provider-logo';
import {providerQuestionAt} from './provider-question';
import {Laptop} from 'lucide-react';
import {providerSlideItems, providerEntrance} from './provider-slide';
import './deck-transition.css';
const linear=(t:number,a:number,b:number)=>Math.max(0,Math.min(1,(t-a)/(b-a)));
const move=(t:number,a:number,b:number)=>interpolate(t,[a,b],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.bezier(.55,0,.2,1)});
export function deckCamera(elapsed:number,first:boolean){
 const age=elapsed-2;
 if (elapsed<2) {
  const keys=[[0,...(first?wideComputerCamera:[1060,550,2.15])],[.65,...wideComputerCamera],[2,...wideComputerCamera]];
  let i=keys.findIndex(k=>k[0]>elapsed);if(i<1)i=keys.length-1;
  const a=keys[i-1],b=keys[i],q=move(elapsed,a[0],b[0]);return a.slice(1).map((n,j)=>n+(b[j+1]-n)*q);
 }
 const keys=first ? [
 [0,...wideComputerCamera],[.8,...wideComputerCamera],[1.6,960,410,1.6],
 [5.7,960,410,1.6],[6.7,960,410,1.6],
 [7.5,965,435,1.7],[10.5,965,435,1.7],
 [12.8,838.5,515.5,2.1],[13.15,838.5,515.5,2.1],
 [14,965,445,1.75],[16.3,965,445,1.75],[16.85,...wideComputerCamera],[17.5,...wideComputerCamera],[18.5,...wideComputerCamera],
 ] : [[0,...wideComputerCamera],[.8,...wideComputerCamera],[1.6,960,410,1.6],[6.3,960,410,1.6],[6.85,...wideComputerCamera],[7.5,...wideComputerCamera],[8.5,...multiInviteCamera]];
 let i=keys.findIndex(k=>k[0]>age);if(i<1)i=keys.length-1;
 const a=keys[i-1],b=keys[i],q=move(age,a[0],b[0]);return a.slice(1).map((n,j)=>n+(b[j+1]-n)*q);
}
function Tool({icon:Icon,label,selected=false}:{icon:React.ComponentType<{size?:number;strokeWidth?:number}>,label:string,selected?:boolean}){
 return <div className={'deck-tool'+(selected?' selected':'')}><div><Icon size={21} strokeWidth={1.55}/></div><span>{label}</span></div>;
}
function Field({children}:{children:React.ReactNode}){return <div className="deck-field">{children}<ChevronDown size={11}/></div>}
function ProviderQuestion({age,mini=false}:{age:number;mini?:boolean}){
 const state=providerQuestionAt(age);
 return <div className="deck-question"><div>What if my</div><div className="deck-question-provider">{state.text&&(state.backend==='local'?<Laptop className="deck-question-icon"/>:<ProviderLogo provider={state.backend} className="deck-question-icon"/>)}<span>{state.text}{!mini&&age>=1.6&&state.typing&&<span className="deck-insertion"/>}</span></div><div>could join my team?</div></div>;
}
function SlideText({age,first,mini=false}:{age:number,first:boolean,mini?:boolean}){
 if(first)return <ProviderQuestion age={age} mini={mini}/>;
 const {lines,active}=slideTyping(age,first);
 const caret=age>=1.5&&(age<5.2||Math.floor((age-5.2)*2)%2===0);
 return <><div className={'deck-text'+(first?'':' deck-statement')+(mini?' mini':'')}>
 {!mini&&<div className="deck-selection">{['tl','tc','tr','ml','mr','bl','bc','br'].map(p=><i key={p} className={p}/>)}</div>}
 {lines.map((line,i)=><div key={i} className={'deck-text-line line-'+i}><span>{line}{!mini&&active===i&&<span data-caret-line={i} className="deck-insertion" style={{visibility:caret?'visible':'hidden'}}/>}</span></div>)}
 </div>{!first&&<div className="deck-providers"><div className="deck-provider-row">{providerSlideItems.map((item,i)=>{const q=providerEntrance(age,i);return <div key={item.backend} className="deck-provider" style={{opacity:q,transform:`translateX(${(1-q)*100}px)`}}><ProviderLogo provider={item.backend} className="deck-footer-provider-icon"/><span>{item.label}</span></div>;})}</div></div>}</>;
}
function Inspector({brand=false}:{brand?:boolean}){return <aside className="deck-inspector">
 <div className="deck-inspector-tabs"><span>Style</span><b>Text</b><span>Arrange</span></div>
 <div className="deck-style-picker"><b>Title</b><ChevronDown size={15}/></div>
 <div className="deck-subtabs"><b>Style</b><span>Layout</span><span>More</span></div>
 <section><label>Font</label><Field>{brand?'Caveat':'Helvetica Neue'}</Field><div className="deck-control-row"><Field>Bold</Field><div className="deck-size">48 pt <span>⌃<br/>⌄</span></div></div>
 <div className="deck-control-row"><div className="deck-segmented"><Bold size={14}/><Italic size={14}/><Underline size={14}/></div><div className="deck-color"><i/> <ChevronDown size={10}/></div></div></section>
 <section><label>Text Color</label><Field>Text Fill</Field><div className="deck-color-wide"><i/><ChevronDown size={11}/></div></section>
 <section><label>Alignment</label><div className="deck-align"><b><AlignLeft size={17}/></b><AlignCenter size={17}/><AlignRight size={17}/><AlignJustify size={17}/></div></section>
 <section><div className="deck-control-row"><label>Spacing</label><ChevronDown size={12}/></div><div className="deck-control-row"><span>Lines</span><div className="deck-size">1.15 <span>⌃<br/>⌄</span></div></div></section>
 <section><div className="deck-control-row"><label>Bullets & Lists</label><List size={15}/></div><Field>No Bullets</Field></section>
 </aside>}
export function DeckTransition({age:elapsed,first}:{age:number;first:boolean}){
 const age=(first?firstDeckClock(elapsed):elapsed)-2;
 const intro=first&&elapsed<6.5;
 const enter=move(age,.35,1.35),exit=move(age,first?17.5:7.5,first?18.5:8.5);
 const brand=first&&age>=6.7;
 return <>

 <div className="deck-editor" style={{transform:`translate(${(1-enter+exit)*1400}px,${(1-enter+exit)*22}px) scale(${.90+enter*.10-exit*.10})`}}>
 <div className="deck-titlebar"><div className="deck-traffic"><i/><i/><i/></div><div className="deck-document"><Presentation size={13}/><b>Alook</b><ChevronDown size={10}/><span>— Edited</span></div><UsersRound size={16}/></div>
 <div className="deck-toolbar"><div className="deck-tools-group"><Tool icon={PanelLeft} label="View"/><div className="deck-zoom">75% <ChevronDown size={10}/></div><Tool icon={Plus} label="Add Slide"/></div><div className="deck-tools-group"><Tool icon={Play} label="Play"/></div><div className="deck-tools-group middle"><Tool icon={Table2} label="Table"/><Tool icon={ChartColumn} label="Chart"/><Tool icon={Type} label="Text"/><Tool icon={Shapes} label="Shape"/><Tool icon={Image} label="Media"/><Tool icon={MessageSquare} label="Comment"/></div><div className="deck-tools-group"><Tool icon={Paintbrush} label="Format" selected/><Tool icon={Sparkles} label="Animate"/><Tool icon={File} label="Document"/></div></div>
 <div className="deck-workspace"><nav className="deck-navigator">{first&&<div className={'deck-slide-item'+(!intro?' inactive':'')}><span>1</span><div className="deck-thumbnail"><div className="deck-thumbnail-scaled"><TeammateSlide elapsed={intro?elapsed:6} mini/></div></div></div>}{!intro&&<div className={'deck-slide-item'+(brand?' inactive':'')}><span>{first?2:1}</span><div className="deck-thumbnail"><div className="deck-thumbnail-scaled"><SlideText age={age} first={first} mini/></div></div></div>}{brand&&<div className="deck-slide-item"><span>3</span><div className="deck-thumbnail"><div className="deck-thumbnail-scaled"><BrandSlide age={age} mini/></div></div></div>}</nav>
 <main className="deck-canvas-area"><div className="deck-ruler">{Array.from({length:17},(_,i)=><span key={i}>{i%2===0?i*50:''}</span>)}</div><div className="deck-slide">{intro?<TeammateSlide elapsed={elapsed}/>:brand?<BrandSlide age={age}/>:<SlideText age={age} first={first}/>}</div><div className="deck-status">{first?(intro?'Slide 1 of 1':brand?'Slide 3 of 3':'Slide 2 of 2'):'Slide 1 of 1'} <span><ZoomIn size={11}/> 75%</span></div></main><Inspector brand={brand}/></div>
 </div>{first&&<BrandDrag age={age}/>}
 {(elapsed>=(first?0:.6)&&elapsed<2.35)&&<Pointer x={900+(568-900)*linear(elapsed,.6,1.05)} y={500+144*linear(elapsed,.6,1.05)} pressed={elapsed>=1.05&&elapsed<1.25}/>}
 {age>=(first?16.85:6.85)&&age<(first?17.75:7.75)&&<Pointer x={630+((first?672:724)-630)*linear(age,first?16.85:6.85,first?17.3:7.3)} y={420+224*linear(age,first?16.85:6.85,first?17.3:7.3)} pressed={age>=(first?17.3:7.3)&&age<(first?17.5:7.5)}/>}
 </>;
}

function BrandSlide({age,mini=false}:{age:number;mini?:boolean}) {
 const heading='Introducing…'.slice(0,Math.floor(12*linear(age,7.55,9.05)));
 const word='Alook'.slice(0,Math.floor(5*linear(age,13.2,14.2)));
 return <div className="deck-brand-slide">
  <div className="deck-brand-heading">{heading}{!mini&&age>=7.5&&age<9.3&&<span className="deck-insertion"/>}</div>
  <div className="deck-brand-lockup">
   <div className="deck-brand-logo">{age>=12.8&&<Img src={staticFile('alook.svg')}/>}</div>
   <div className="deck-brand-word">{word}{!mini&&age>=13.2&&age<14.4&&<span className="deck-insertion"/>}</div>
  </div>
 </div>;
}
function Pointer({x,y,pressed=false}:{x:number;y:number;pressed?:boolean}) {
 return <svg className="deck-drag-pointer" width="24" height="31" viewBox="0 0 38 48" style={{left:x,top:y,transform:pressed?'scale(.88)':'none',transformOrigin:'4px 3px'}}><path d="M4 3 L4 34 L13 27 L21 44 L28 41 L20 24 L33 24 Z" fill="#22312d" stroke="white" strokeWidth="3"/></svg>
}
function BrandDrag({age}:{age:number}) {
 const drag=move(age,10.5,12.8);
 // Coordinates inside the Mac display; same 100px logo slot as the slide.
 const x=720+(546-720)*drag,y=640+(392.5-640)*drag,size=40+60*drag;
 return <>

  {age>=9.8&&age<13.15&&<>
   {age>=10.5&&age<12.8&&<Img src={staticFile('alook.svg')} className="deck-drag-logo" style={{left:x-size/2,top:y-size/2,width:size,height:size}}/>}
   <Pointer x={x+9} y={y+6} pressed={age>=10.45&&age<12.85}/>
  </>}
 </>;
}

function TeammateSlide({elapsed,mini=false}:{elapsed:number;mini?:boolean}){
 const state=teammateSlideAt(elapsed);
 return <div className="deck-question" style={{top:125,fontSize:51,lineHeight:1.22}}>{state.text}{!mini&&state.typing&&<span className="deck-insertion"/>}</div>;
}
