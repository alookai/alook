export const providerSlideItems = [
 {backend:'codex',label:'Codex',name:'Milo'},
 {backend:'claude',label:'Claude Code',name:'Nova'},
 {backend:'opencode',label:'OpenCode',name:'Remy'},
 {backend:'cursor',label:'Cursor',name:'Pip'},
];
export function providerEntrance(age:number,index:number){
 const p=Math.max(0,Math.min(1,(age-5.2-index*.1)/.3));
 return 1-Math.pow(1-p,3);
}
