const fs=require('fs'),ts=require('typescript'),assert=require('node:assert/strict');require.extensions['.ts']=(m,p)=>m._compile(ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,p);
const {githubFlood:rows}=require('../src/github-flood.ts'),{socialPeople}=require('../src/social-network.ts'),{sourceTimeAt}=require('../src/review-timing.ts'),{prScrollAt}=require('../src/opening-cursor.ts');
assert.equal(rows.length,10);assert.ok(rows.every(r=>r.at>10.95&&r.name!=='Lin'));assert.equal(new Set(rows.map(r=>r.name)).size,10);
for(const r of rows){assert.ok(socialPeople.some(p=>p.name===r.name));assert.ok(fs.existsSync(`public/people/${r.name}.png`));}
let previous=0;for(let f=243;f<333;f++){const s=prScrollAt(sourceTimeAt(f/30));assert.ok(s>=previous);previous=s;}
assert.ok(previous>1100);assert.equal(rows.filter(r=>r.at<=sourceTimeAt(263/30)).length,3);
console.log('PASS:10 unanswered social people,existing avatar assets,post-reply burst,monotonic scroll.');

const camera=fs.readFileSync('src/MacOpening.tsx','utf8');assert.ok(camera.includes('[11.4,1340,450,1.8],\n[11.8,...wideComputerCamera]'));assert.equal(rows[0].at,11.4);assert.ok(rows.at(-1).at>11.75&&rows.at(-1).at<11.8);console.log('PASS: flood starts with camera pullback and continues until near wide-shot arrival.');
