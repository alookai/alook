export const overloadStart=306/30;
export const overloadLength=.9;
const ease=(v:number)=>{const q=Math.max(0,Math.min(1,v));return q*q*(3-2*q);};
export function overloadMotion(age:number){const entrance=ease(age/.15),exit=ease((age-.68)/.2);return {opacity:entrance*(1-exit),scale:(1+Math.sin(Math.min(1,Math.max(0,age/.3))*Math.PI)*.18)*entrance*(1-.12*exit),rotation:Math.sin(age*42)*7*Math.exp(-age*4),burst:ease((age-.07)/.36)};}
