import React from 'react';
import { Img, staticFile, interpolate } from 'remotion';
import { MachineCard } from '@/components/community/machines/machine-card';
import { DmSidebar } from '@/components/community/channels/dm-sidebar';
import { Button } from '@/components/ui/button';
import { avatarSource } from './Product';
import { ProfileCard } from '@/components/community/social/profile-card';
const noop=()=>{};
export function MachineImport({t,name="Milo"}:{t:number;name?:string}) {
 const born=interpolate(t,[17.35,18.3],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});
 return <div className="import-page"><div className="import-title"><Img src={staticFile('alook.svg')}/><b>Alook</b><span>● ● ●</span></div><div className="import-layout"><div className="import-sidebar"><DmSidebar dms={[]} activeDm={null} machinesActive onPickDm={noop} onShowFriends={noop} onShowMachines={noop} onShowBots={noop}/></div><div className="import-content"><h2>Machines</h2><p>Your computers running Alook.</p><MachineCard machine={{id:'lin-mac',hostname:'lin-macbook',displayName:'Lin’s MacBook',platform:'darwin',arch:'arm64',osRelease:'15.6',daemonVersion:'0.0.160',lastSeenAt:"2026-09-15T13:39:00Z",status:'online',availableRuntimes:[{id:'codex',status:'healthy',version:'0.146.0'}],createdAt:'2026-09-15T06:00:00Z',updatedAt:'2026-09-15T06:00:00Z'}} onDelete={noop} onReconnect={noop}/><div className="import-action"><div><b>{t<17?'Bring in your local agent':'Your agent is here'}</b><span>{t<17?'Codex on this computer':'Runs on Lin’s MacBook'}</span></div><Button style={{fontSize:21,height:46,padding:'0 24px',transform:`scale(${t>=15.25&&t<15.5?.94:1})`}}>{t<15.25?'Import':t<17?'Importing…':'Imported ✓'}</Button></div><div className="import-agent-profile" style={{transform:`scale(${born})`,opacity:born}}><ProfileCard embedded bp="desktop" x={0} y={0} onClose={noop} data={{name,discriminator:"2048",avatar:avatarSource(name),presence:"online",about:"Codex · Runs on Lin’s MacBook",identity:{kind:"bot",ownerProfile:{id:"Lin",handle:"Lin#1024"},ownedByViewer:true}}}/></div></div></div></div>
}
