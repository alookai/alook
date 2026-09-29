import {githubFlood} from './github-flood';
import {prScrollAt} from './opening-cursor';
import React from 'react';
import {Img,interpolate,staticFile} from 'remotion';
import {GitPullRequest, MessageSquare, FileDiff, ChevronLeft, ChevronRight, RotateCw, LockKeyhole} from 'lucide-react';
import {firstRelayReply,relayRequests} from './opening-relay';
import {avatarSource} from './Product';
import {messageMotion,playbackAge} from './message-motion';
export const prReplyAt=relayRequests[0].post;
export function PullRequestWindow({t,relayCount=relayRequests.length}:{t:number;relayCount?:number}){
 const requests=relayRequests.slice(0,relayCount);
 const active=requests.find(r=>t>=r.compose&&t<r.post);
 const pasted=active&&t>=active.answerPaste;
 const allComments=requests.flatMap(r=>[{at:r.at,name:'Alex',role:'Reviewer',text:r.text},{at:r.post,name:'Lin',role:'Author',text:r.reply}]).filter(c=>t>=c.at);
 const comments=[...allComments,...githubFlood.filter(c=>t>=c.at)];
 const scroll=prScrollAt(t,relayCount);
 const relay=requests.find(r=>t>=r.copy-.2&&t<r.copyEnd+.1);
 return <div className="pr-browser">
  <div className="pr-browser-tabs"><span className="pr-traffic"><i/><i/><i/></span><span className="pr-tab"><GitPullRequest size={13}/> Add team invites · Pull Request #42 <span>×</span></span><b>+</b></div>
  <div className="pr-address"><ChevronLeft size={15}/><ChevronRight size={15}/><RotateCw size={13}/><div><LockKeyhole size={11}/> github.com/fieldnotes/web/pull/42</div></div>
  <div className="pr-page">
   <div className="pr-repo"><strong style={{color:"#1f2328",fontSize:15}}>GitHub</strong><span>fieldnotes / <b>web</b></span><small>Public</small></div>
   <h2>Add team invites <span>#42</span></h2>
   <div className="pr-meta"><b><GitPullRequest size={13}/> Open</b><span><strong>Lin</strong> wants to merge 1 commit into <code>main</code></span></div>
   <div className="pr-nav"><b><MessageSquare size={14}/> Conversation</b><span><FileDiff size={14}/> Files changed <i>2</i></span></div>
   <div className="pr-thread-viewport"><div className="pr-thread" style={{translate:`0 ${-scroll}px`}}>
    {comments.map((c,index)=>{const motion=messageMotion(playbackAge(t,t-c.at));const copying=relay&&c.name==='Alex'&&c.text===relay.text&&t>=relay.copy;return <div key={c.at} className="pr-entry" style={{opacity:motion.opacity,translate:`0 ${motion.y}px`}}>
     <Img src={staticFile(`people/${c.name}.png`)}/><div className="pr-comment"><header><b>{c.name}</b><span>{c.name==='Alex'?'requested changes':'commented'}</span><em>{c.role}</em></header><p><span style={{background:copying?'#b9dcff':undefined}}>{c.text}</span></p>
     {copying&&<div className={`pr-copy-menu ${t>=relay.copy+.04?"chosen":""}`}>Copy <span>⌘C</span></div>}

     </div>
    </div>})}
    {active&&<div className="pr-entry pr-compose"><Img src={avatarSource('Lin')}/><div className="pr-comment"><header><b>Lin</b><span>commenting</span><em>Author</em></header><div className="pr-editor-tabs"><b>Write</b><span>Preview</span></div><div className="pr-reply-input">{pasted?active.reply:'Leave a comment'}</div>{!pasted&&<div className={`pr-copy-menu ${t>=active.compose+.1?"chosen":""}`} style={{top:80}}>Paste <span>⌘V</span></div>}<footer><b>Comment</b></footer></div></div>}
   </div></div>
  </div>
 </div>;
}
