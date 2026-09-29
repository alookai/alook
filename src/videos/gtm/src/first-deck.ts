export const teammateStatement='My team needs my agent sometimes';
export function firstDeckClock(elapsed:number){return elapsed<3.5?elapsed:Math.max(3.5,elapsed-3);}
export function teammateSlideAt(elapsed:number){
 const amount=Math.max(0,Math.min(1,(elapsed-3.55)/1.65));
 return {text:teammateStatement.slice(0,Math.floor(teammateStatement.length*amount)),typing:elapsed>=3.55&&elapsed<5.4,page:elapsed<6.5?1:elapsed<11.7?2:3};
}
