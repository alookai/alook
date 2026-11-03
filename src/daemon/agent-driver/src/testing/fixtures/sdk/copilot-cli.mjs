#!/usr/bin/env node
import {appendFileSync,existsSync,readFileSync,writeFileSync}from'node:fs';
import{join}from'node:path';
let sessionId,seq=0,buffer=Buffer.alloc(0),pending=[];
const send=value=>{const body=Buffer.from(JSON.stringify(value));process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);process.stdout.write(body);};
const reply=(f,result)=>send({jsonrpc:'2.0',id:f.id,result});
const event=(type,data={},agentId)=>send({jsonrpc:'2.0',method:'session.event',params:{sessionId,event:{id:'event-'+(++seq),timestamp:new Date().toISOString(),parentId:null,type,data,...(agentId?{agentId}:{})}}});
const flush=()=>{
 for(const input of pending.splice(0)){
  event('assistant.turn_start',{turnId:input.messageId});
  event('assistant.message_delta',{deltaContent:'native:'+input.prompt});
 }
 event('session.idle');
};
const timer=setInterval(()=>{if(pending.length&&existsSync(join(process.cwd(),'release')))flush();},10);
const handle=async f=>{
 const p=f.params??{};
 if(f.method==='connect'||f.method==='ping')reply(f,{protocolVersion:3});
 else if(f.method==='session.create'||f.method==='session.resume'){
  const history=join(process.cwd(),'copilot-history');sessionId=p.sessionId;
  if(f.method==='session.resume'&&(!existsSync(history)||readFileSync(history,'utf8')!==sessionId))send({jsonrpc:'2.0',id:f.id,error:{code:-32602,message:'session history not found'}});
  else{writeFileSync(history,sessionId);appendFileSync(join(process.cwd(),'copilot-opens'),String(process.pid)+'\n');reply(f,{sessionId,capabilities:{}});}
 } else if(f.method==='models.list')reply(f,{models:[{id:'native-fixture',name:'Native Fixture',supportedReasoningEfforts:['high']}]});
 else if(f.method==='session.send'){
  const messageId='input-'+(++seq);appendFileSync(join(process.cwd(),'copilot-inputs'),JSON.stringify({text:p.prompt,mode:p.mode})+'\n');
  if(p.prompt==='blocked extra'||p.prompt==='error extra'){
   if(p.prompt==='blocked extra')event('session.warning',{warningType:'policy_blocked',originatingMessageId:messageId,message:'Fixture extra refused'});
   else event('session.error',{originatingMessageId:messageId,message:'Fixture input failed'});
   reply(f,{messageId});return;
  }
  if(p.prompt==='policy blocked'){
   event('session.warning',{warningType:'policy_blocked',originatingMessageId:messageId,message:'Fixture policy denied input'});
   reply(f,{messageId});event('session.idle');return;
  }
  event('user.message',{messageId,content:p.prompt});
  event('session.idle',{},'child');
  pending.push({messageId,prompt:p.prompt});reply(f,{messageId});
  if(p.prompt==='hold auto switch'){
   event('session.warning',{warningType:'mcp',message:'Fixture non-terminal warning'});
   event('session.error',{errorType:'rate_limit',eligibleForAutoSwitch:true,originatingMessageId:messageId,message:'Fixture model switching'});
   event('auto_mode_switch.requested',{reason:'rate_limit'});
   appendFileSync(join(process.cwd(),'copilot-auto-switch'),'ready');
  }
  if(!p.prompt.includes('hold')&&pending.length===1)flush();
 } else if(f.method==='session.abort'){pending=[];reply(f,{});event('session.idle',{aborted:true});}
 else if(f.method==='session.detach')reply(f,{success:true});
 else if(f.method==='runtime.shutdown'){reply(f,{});clearInterval(timer);setTimeout(()=>process.exit(0),10);}
 else reply(f,{});
};
process.stdin.on('data',chunk=>{
 buffer=Buffer.concat([buffer,chunk]);
 while(true){const end=buffer.indexOf('\r\n\r\n');if(end<0)return;const length=Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0,end).toString())?.[1]);if(buffer.length<end+4+length)return;const data=buffer.subarray(end+4,end+4+length);buffer=buffer.subarray(end+4+length);void handle(JSON.parse(data.toString()));}
});
process.stdin.on('end',()=>{clearInterval(timer);process.exit(0)});
