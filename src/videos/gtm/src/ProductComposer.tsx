import React, { useLayoutEffect, useState, useCallback } from 'react';
import { delayRender, continueRender } from 'remotion';
import { ComposerView } from '@/components/community/messages/composer-view';
import { useComposerController } from '@/components/community/messages/use-composer-controller';
import { rankMentionItems, EMPTY_MENTION_STATE } from '@/lib/community/mention-extension';
import type { Member } from '@/lib/community/models/people';
import { avatarSource } from './Product';

export function ProductComposer({channel,text}:{channel:string;text?:string}) {
 const members:Member[]=['Milo','Nova','Remy','Pip'].map(name=>({id:name,userId:name,name,discriminator:({Milo:'2048',Nova:'4096',Remy:'3072',Pip:'5120'} as Record<string,string>)[name],avatar:avatarSource(name),avatarVersion:0,status:'online',sub:'',role:'member'}));
 const [handle]=useState(()=>delayRender('Product composer editor'));
 const view=useComposerController({channel,context:'channel',members,sendContract:'accepted',onAcceptSend:()=>true,placeholder:`Message /${channel}`},null);
 const query=text?.match(/@([A-Za-z]*)$/)?.[1];
 useLayoutEffect(()=>{
  if(!view.editor)return;
  const content=(text??'').split(/(@Milo|@Nova|@Remy|@Pip)/).filter(Boolean).map(part=>['@Milo','@Nova','@Remy','@Pip'].includes(part)?{type:'mention',attrs:{id:part.slice(1),label:part.slice(1)+({Milo:'#2048',Nova:'#4096',Remy:'#3072',Pip:'#5120'} as Record<string,string>)[part.slice(1)]}}:{type:'text',text:part});
  view.editor.commands.setContent({type:'doc',content:[{type:'paragraph',content}]});
  continueRender(handle);
 },[view.editor,text,handle]);
 const getRect=useCallback(()=>{
  if(!view.editor)return null;
  const r=view.editor.view.coordsAtPos(Math.max(1,view.editor.state.doc.content.size-1));
  return new DOMRect(r.left,r.top,1,r.bottom-r.top);
 },[view.editor,text]);
 const mentionPopup=query!==undefined&&!['Milo','Nova','Remy','Pip'].includes(query)?{items:rankMentionItems(members,'channel',query),query,selectedIndex:query?0:2,command:()=>{},getRect}:EMPTY_MENTION_STATE;
 return <div className="product-composer-preview" data-typing={text!==undefined}><ComposerView {...view} mentionPopup={mentionPopup} mentionPresentation={{status:'ready'}} showSend={false}/></div>;
}
