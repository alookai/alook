#!/usr/bin/env node
import {createInterface}from'node:readline';
import {appendFileSync,existsSync,readFileSync,writeFileSync}from'node:fs';
import {join}from'node:path';
let sessionId;
let pending=[];
const send=f=>process.stdout.write(JSON.stringify(f)+'\n');
const response=(f,body,session)=>send({type:'control_response',...(session?{session_id:session}:{}),response:{subtype:'success',request_id:f.request_id,...(body===undefined?{}:{response:body})}});
const init=()=>send({type:'system',subtype:'init',session_id:sessionId,model:'native-fixture',cwd:process.cwd(),tools:['Bash'],mcp_servers:[],permissionMode:'bypassPermissions',slash_commands:[],capabilities:['msg_lifecycle_v1','plan_mode_v1']});
const finish=f=>{
 send({type:'command_lifecycle',session_id:sessionId,command_uuid:f.uuid,state:'started'});
 send({type:'stream_event',session_id:sessionId,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'native:'+f.message.content[0].text}}});
 send({type:'result',subtype:'success',session_id:sessionId,is_error:false,duration_ms:1,duration_api_ms:1,num_turns:1,result:'done',total_cost_usd:0,usage:{input_tokens:1,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0}});
 send({type:'command_lifecycle',session_id:sessionId,command_uuid:f.uuid,state:'completed'});
};
const timer=setInterval(()=>{if(existsSync(join(process.cwd(),'release')))for(const f of pending.splice(0))finish(f)},10);
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 const f=JSON.parse(line);const r=f.request;
 if(f.type==='control_request'){
  if(r.type==='daemon.initialize')response(f,{daemon_protocol_version:2,daemon_version:'1.1.81-fixture',capabilities:['multi_session_v2','daemon_queries_v1','daemon_keep_alive_v1','daemon_async_session_teardown_v1']});
  else if(r.type==='daemon.open_session'){
   const args=r.worker_args;const index=args.indexOf('--session-id');const resume=args.indexOf('--resume');
   sessionId=args[index>=0?index+1:resume+1];
   const saved=join(process.cwd(),'qoder-history');
   if(resume>=0&&(!existsSync(saved)||readFileSync(saved,'utf8')!==sessionId)){send({type:'control_response',response:{subtype:'error',request_id:f.request_id,error:'session history not found'}});continue;}
   writeFileSync(saved,sessionId);appendFileSync(join(process.cwd(),'qoder-opens'),String(process.pid)+'\n');response(f,undefined,sessionId);
  }else if(r.subtype==='initialize'){response(f,{commands:[],agents:[],output_style:'default',available_output_styles:[],capabilities:['msg_lifecycle_v1','plan_mode_v1']},sessionId);init();}
  else if(r.type==='daemon.get_models')response(f,{models:[{value:'native-fixture',displayName:'Native Fixture',description:'local',efforts:['high'],isDefault:true}]});
  else if(r.type==='daemon.close_session')response(f,undefined,sessionId);
  else if(r.type==='daemon.shutdown'){response(f);clearInterval(timer);setTimeout(()=>process.exit(0),10);}
  else if(r.subtype==='interrupt'){
   for(const p of pending.splice(0))send({type:'command_lifecycle',session_id:sessionId,command_uuid:p.uuid,state:'cancelled'});
   response(f,{},sessionId);
  } else response(f,{},f.session_id);
 }else if(f.type==='user'){
  appendFileSync(join(process.cwd(),'qoder-inputs'),f.message.content[0].text+'\n');
  if(f.message.content[0].text.includes('hold')||pending.length)pending.push(f);else finish(f);
 }
}
clearInterval(timer);
