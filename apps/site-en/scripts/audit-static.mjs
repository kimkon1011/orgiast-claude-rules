import fs from 'node:fs';
import path from 'node:path';
import {ROOT,read,write,hash,hasJa} from './lib.mjs';
import {allSegments,residual} from './static-core.mjs';
const state=read('evidence/build-state.json'),rows=[],glosses=new Set();
for(const p of Object.values(state.pages)){
 const html=fs.readFileSync(path.join(ROOT,'dist',p.site,p.file),'utf8');
 if(hash(html)!==p.sha256)throw Error('Local build hash differs: '+p.url);
 const source=fs.readFileSync(path.join(ROOT,'evidence/live',p.site,hash(p.url)+'.html'),'utf8');
 const sourceText=allSegments(source).map(s=>s.text).join('\n');
 const leftovers=[];
 for(const s of allSegments(html)){
  if(!hasJa(s.text)||s.text==='日本語')continue;
  const rest=s.text.replace(/金\s*功勇/g,'').replace(/Re:Booth\s*\((?:Re:|Re|RE)ブース\)/g,'Re:Booth').replace(/#[\p{L}\p{N}_]+/gu,'').replace(/[（(]([^()（）]+)[）)]/g,(all,g)=>{
   if(hasJa(g)){glosses.add(g);if(sourceText.includes(g)&&/[A-Za-z]/.test(s.text))return '';}
   return all;
  });
  if(hasJa(rest))leftovers.push(s.text);
 }
 rows.push({site:p.site,url:p.url,file:p.file,residual:residual(html),untranslated:[...new Set(leftovers)]});
}
const summary=Object.fromEntries(['rebooth','orgiast'].map(site=>{const p=rows.filter(p=>p.site===site).sort((a,b)=>b.residual.rate-a.residual.rate),inventory=read('evidence/inventory-'+site+'.json');return [site,{generated:p.length,inventory:inventory.length,missing:inventory.filter(i=>!p.some(b=>b.url===i.url)).map(i=>i.url),maximum:p[0]?.residual.rate,maximumUrl:p[0]?.url,overFive:p.filter(p=>p.residual.rate>5).map(p=>p.url),untranslated:p.filter(p=>p.untranslated.length)}];}));
write('evidence/task03-build-audit.json',{at:new Date().toISOString(),summary,pages:rows});write('evidence/task03-glosses.json',[...glosses]);
console.log(JSON.stringify(summary,null,2));
if(Object.values(summary).some(s=>s.missing.length||s.untranslated.length))process.exitCode=1;
