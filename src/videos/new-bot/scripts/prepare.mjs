import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,copyFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
const web=path.resolve('../../web'),requireWeb=createRequire(path.join(web,'package.json'));
const css=readFileSync(path.join(web,'src/app/globals.css'),'utf8')+'\n@source "../../../videos/new-bot/src";\n';
const result=await postcss([requireWeb('@tailwindcss/postcss')({base:path.join(web,'src')})]).process(css,{from:path.join(web,'src/app/globals.css'),to:path.resolve('src/product.css')});
writeFileSync('src/product.css',result.css);

mkdirSync('public/people',{recursive:true});
copyFileSync(path.join(web,'public/landing/people/lin.webp'),'public/people/lin.webp');
copyFileSync(path.join(web,'public/alook.svg'),'public/alook.svg');
mkdirSync('public/fonts',{recursive:true});
for (const font of ['dm-sans-latin.woff2','caveat-latin.woff2','dm-mono-latin-400.woff2']) {
  copyFileSync(path.join(web,'src/app/fonts',font),path.join('public/fonts',font));
}
