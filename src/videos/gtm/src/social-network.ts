export const networkViewport={x:88,y:14,scale:.6037};
export const networkCenter={x:960,y:650};
export const networkEntry={x:networkViewport.x+networkCenter.x*networkViewport.scale,y:networkViewport.y+networkCenter.y*networkViewport.scale,size:128*1.65*networkViewport.scale};
export const socialPeople = [
 {name:'Lin',x:0,y:0,at:0,bots:['Milo','Nova','Remy','Pip']},
 {name:'Alex',x:-640,y:-330,at:1.4,bots:['Scout','Echo','Juniper']},
 {name:'Sam',x:650,y:260,at:1.9,bots:['Clover','Moss']},
 {name:'Nina',x:-1260,y:300,at:2.6,bots:['Fern','Kite','Ruby']},
 {name:'Omar',x:-450,y:-950,at:2.8,bots:['Orbit','Taro']},
 {name:'Mei',x:1190,y:-440,at:3.0,bots:['Lumi','Nori','Finch']},
 {name:'Leo',x:230,y:970,at:3.2,bots:['Brook','Atlas']},
 {name:'Amara',x:-1550,y:-730,at:3.4,bots:['Maple','Coco']},
 {name:'Diego',x:570,y:-1310,at:3.6,bots:['Sol','Peach','Dot']},
 {name:'Priya',x:1550,y:590,at:3.8,bots:['Sage','Comet']},
 {name:'Evan',x:-830,y:1030,at:4.0,bots:['Reed','Wren','Otto']},
].map(person=>({...person,x:person.x*.5,y:person.y*.5}));
export const socialLinks = [[0,1],[0,2],[1,3],[1,4],[2,5],[2,6],[3,7],[4,8],[5,9],[6,10],[8,5],[3,10],[4,7]];
export const clamp01=(n:number)=>Math.max(0,Math.min(1,n));
export const socialEase=(t:number,a:number,b:number)=>{const p=clamp01((t-a)/(b-a));return p*p*(3-2*p);};
export function networkMotion(t:number){
 const pull=socialEase(t,.15,4.9),collapse=socialEase(t,7.25,8.95);
 return {centerY:networkCenter.y-(networkCenter.y-540)*collapse,scale:(1.65-1.05*pull)*(1-.77*collapse),rotation:1080*Math.pow(clamp01((t-7.25)/1.7),2.5),blur:12*collapse,opacity:1-socialEase(t,8.3,8.85)};
}
export function botPosition(t:number,index:number,count:number,at:number,radius:number,entry=390){
 const gap=2*Math.PI*radius/count,speed=600;
 const age=Math.max(0,t-at-.1),brakeAt=(entry+(count-1)*gap)/speed;
 const braking=Math.min(.6,Math.max(0,age-brakeAt));
 const travel=age<=brakeAt?age*speed:brakeAt*speed+speed*braking-(speed-80)*braking*braking/1.2+Math.max(0,age-brakeAt-.6)*80;
 const distance=travel-index*gap;
 if(distance<entry)return {x:entry-distance,y:radius,opacity:socialEase(distance,0,45),scale:1,roll:720*(1-clamp01(distance/entry))};
 const angle=Math.PI/2+(distance-entry)/radius;
 return {x:Math.cos(angle)*radius,y:Math.sin(angle)*radius,opacity:1,scale:1,roll:0};
}
export const networkStart=4.8;
export const networkLength=9;
export const networkEnd=networkStart+networkLength;
export const endingAddedTime=networkEnd-2.1;
export const endingTrim=2.2;
export function endingPhysicalTime(t:number){return t<networkEnd?0:t-endingAddedTime+(t>=networkEnd+2.4?endingTrim:0);}

export function endingStoryTime(t:number){return t<2.6?t:t<14.45?t+1:t<15.45?15.45:t;}
