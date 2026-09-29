import {selectComposition,renderStill,openBrowser} from '@remotion/renderer';
import path from 'node:path';
const browser=await openBrowser('chrome',{browserExecutable:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const serveUrl=path.resolve('build');
const composition=await selectComposition({serveUrl,id:'AlookCleanReview',puppeteerInstance:browser});
for(const frame of [565,1110,1500]){
 await renderStill({serveUrl,composition,output:'out/clean-card-'+frame+'.png',frame,puppeteerInstance:browser,timeoutInMilliseconds:120000});
 console.log(frame);
}
await browser.close({silent:true});
