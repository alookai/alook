export const relayRequests = [
 {at:.75,text:'Please add a migration for team invites.',copy:1.5,copied:1.62,copyEnd:1.8,pasteMenu:2,pasteHover:2.1,paste:2.2,send:2.45,replyStart:2.5,replyEnd:2.8,answerCopy:3.3,compose:3.45,answerPaste:3.6,post:3.85,reply:'Added the invites migration. Tests pass.'},
 {at:4.45,text:'Does this leave production untouched?',copy:5.1,copied:5.22,copyEnd:5.4,pasteMenu:5.55,pasteHover:5.65,paste:5.75,send:6,replyStart:6.05,replyEnd:6.35,answerCopy:6.85,compose:7,answerPaste:7.15,post:7.4,reply:'Yes. Changes are local. Production is untouched.'},
];
export const relayInputAt = (t:number) => relayRequests.find(r=>t>=r.paste&&t<r.send)?.text ?? '';
export const relaySentAt = (t:number) => relayRequests.filter(r=>t>=r.send).at(-1)?.text ?? 'Build team invites for the app.';
export const firstRelayReply = relayRequests[0].reply;
export function relayReplyAt(t:number){
 const r=relayRequests.filter(r=>t>=r.send).at(-1);
 if(!r)return 'I’m working on team invites.';
 if(t<r.replyStart)return '';
 return r.reply.slice(0,Math.floor(r.reply.length*Math.min(1,(t-r.replyStart)/(r.replyEnd-r.replyStart))));
}
