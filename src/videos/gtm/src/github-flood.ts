import {sourceTimeAt} from './review-timing';
export const githubFlood=[
 [246,'Alex','One more thing — can you check permissions?'],
 [254,'Sam','What happens when an invite expires?'],
 [262,'Nina','Can we support bulk invites too?'],
 [269,'Omar','The API needs a rate limit.'],
 [276,'Mei','Can you update the empty state?'],
 [282,'Leo','Any tests for existing members?'],
 [288,'Amara','What about workspace roles?'],
 [293,'Diego','Could you check the deployment logs?'],
 [298,'Priya','We also need an audit trail.'],
 [302,'Evan','Lin, can you take a look at this?'],
].map(([frame,name,text])=>({at:sourceTimeAt(Number(frame)/30),name:String(name),text:String(text),role:'Reviewer'}));
