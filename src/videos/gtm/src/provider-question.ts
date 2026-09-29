export const questionProviders = [
 {backend:'codex',label:'Codex'},
 {backend:'claude',label:'Claude Code'},
 {backend:'cursor',label:'Cursor'},
 {backend:'local',label:'local agent'},
];
export function providerQuestionAt(age:number){
 const elapsed=Math.max(0,age-1.6);
 const index=Math.min(3,Math.floor(elapsed/.85));
 const item=questionProviders[index];
 const phase=(elapsed-index*.85)/.85;
 const amount=index===3?Math.min(1,phase/.6):phase<.32?phase/.32:phase<.7?1:Math.max(0,(1-phase)/.3);
 return {...item,text:item.label.slice(0,Math.floor(item.label.length*amount+1e-8)),typing:index===3?phase<.6:phase<.32||phase>=.7};
}
