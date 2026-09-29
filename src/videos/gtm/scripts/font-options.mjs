import {openBrowser,selectComposition,renderStill} from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
const fonts=['Inter','Helvetica Neue','Avenir','Futura','Gill Sans','Optima','Trebuchet MS','Verdana','Lucida Grande','Tahoma'];
const serveUrl=path.resolve('out/font-preview-bundle');
const browser=await openBrowser('chrome');
try {
 const composition=await selectComposition({serveUrl,id:'AlookLaunchReview',puppeteerInstance:browser});
 for(let i=0;i<fonts.length;i+=2) await Promise.all(fonts.slice(i,i+2).map(async(font,j)=>{
  const number=String(i+j+1).padStart(2,'0');
  await renderStill({serveUrl,composition,puppeteerInstance:browser,frame:2439,inputProps:{brandFont:font},output:`out/font-options/${number}.png`,imageFormat:'png',overwrite:true});
  console.log(number,font);
 }));
 fs.writeFileSync('out/font-options/fonts.json',JSON.stringify(fonts));
} finally {await browser.close({silent:true});}
