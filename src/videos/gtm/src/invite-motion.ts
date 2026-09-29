export const multiInviteCamera=[1150,410,2.1] as const;
export function inviteRowMotion(t:number,index:number){const p=Math.max(0,Math.min(1,(t-51-index*.3)/.7)),q=1-Math.pow(1-p,3);return {x:180*(1-q),opacity:q};}
