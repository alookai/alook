export const desktopFiles = [
 {name:'Website',kind:'folder',x:112,y:595},
 {name:'Launch brief.pdf',kind:'pdf',x:260,y:595},
 {name:'Budget.xlsx',kind:'sheet',x:410,y:595},
 {name:'Assets',kind:'folder',x:1234,y:278},
 {name:'Notes.txt',kind:'text',x:1234,y:465},
] as const;
export function vortexMotion(t:number,x:number,y:number,delay=0){
 const q=Math.max(0,Math.min(1,(t-15.45-delay)/(1.65-delay)));
 const lift=Math.min(1,q/.18),travel=Math.max(0,Math.min(1,(q-.3)/.7));
 const u=travel*travel*(3-2*travel),isFile=y>500;
 const shrink=Math.max(0,(travel-.55)/.45);
 const scale=1-shrink*shrink,rotation=isFile?-12*Math.sin(Math.PI*u):220*Math.pow(travel,4);
 let px=x+(1209-x)*u,py=y-(isFile?78*lift:0)+(379-y+(isFile?78:0))*u-100*Math.sin(Math.PI*u);
 if(!isFile){const angle=rotation*Math.PI/180,halfW=(Math.abs(Math.cos(angle))*835+Math.abs(Math.sin(angle))*440)*.6*scale/2,halfH=(Math.abs(Math.sin(angle))*835+Math.abs(Math.cos(angle))*440)*.6*scale/2;px=Math.max(halfW+10,Math.min(1335.128-halfW-10,px));py=Math.max(42+halfH+10,Math.min(680-halfH-10,py));}
 return {q,x:px,y:py,scale,rotation,opacity:(isFile?Math.min(1,q*14):1)*(1-Math.pow(shrink,3))};
}
