export function slideTyping(age:number,first:boolean){
 const lines=first?['What if my','local agent','could join my team?']:['Start with one.','Bring more bots to collaborate.'];
 const total=lines.reduce((sum,line)=>sum+line.length,0);
 let remaining=Math.floor(total*Math.max(0,Math.min(1,(age-1.6)/3.6))),active=0;
 const typed=lines.map((line,i)=>{const count=Math.min(line.length,Math.max(0,remaining));remaining-=line.length;if(count>0)active=i;return line.slice(0,count);});
 return {active,lines:typed};
}
