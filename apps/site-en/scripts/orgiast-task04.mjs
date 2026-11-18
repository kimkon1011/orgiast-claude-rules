import fs from 'node:fs';
import path from 'node:path';
import {ROOT,read,write,hash,hasJa,escape} from './lib.mjs';
import {allSegments,replaceForms,translateHtml,rewriteLinks,injectMetaTags,outputPath,enUrl,residual} from './static-core.mjs';
import {translationMap,completeTranslations} from './static-translate.mjs';
import {textIssues} from './validation.mjs';
import {inventory as fetchInventory,get} from './site-fetch.mjs';
const args=process.argv.slice(2),opt=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const mode=opt('--mode','audit'),offset=Number(opt('--offset',0)),limit=Number(opt('--limit',50));
const inv=read('evidence/inventory-orgiast.json'),state=read('evidence/build-state.json');
const progressFile='evidence/orgiast-progress.json';
const progress=fs.existsSync(path.join(ROOT,progressFile))?read(progressFile):{started_at:new Date().toISOString(),inventory:inv.length,runs:[],excluded:[]};
const endpoint=fs.readFileSync(path.resolve(ROOT,'../expo-apply/config.js'),'utf8').match(/export const FORM_ENDPOINT\s*=\s*['"]([^'"]*)/)?.[1]||'';
function source(p){return replaceForms(fs.readFileSync(path.join(ROOT,'evidence/live/orgiast',hash(p.url)+'.html'),'utf8'),endpoint);}
function scan(map){
 const pending=new Map();for(const p of inv)for(const s of allSegments(source(p)))if(hasJa(s.text)&&!map.has(s.text)){
  if(!pending.has(s.text))pending.set(s.text,{id:hash(s.text),ja:s.text,pages:[],attributes:[]});const row=pending.get(s.text);if(!row.pages.includes(p.url))row.pages.push(p.url);if(s.attribute&&!row.attributes.includes(s.attribute))row.attributes.push(s.attribute);
 }return [...pending.values()];
}
function saveProgress(){
 progress.updated_at=new Date().toISOString();progress.generated=Object.values(state.pages).filter(p=>p.site==='orgiast').length;
 progress.runs.push({mode,offset,limit,at:progress.updated_at});write(progressFile,progress);
 console.log(`orgiast ${mode}: inventory=${inv.length} generated=${progress.generated} unresolved=${progress.unresolved??'?'} excluded=${progress.excluded.length} offset=${offset} limit=${limit}`);
}
try{
 if(mode==='audit'){
  const map=translationMap('orgiast').map,current=scan(map),prior=read('evidence/pending-orgiast.json');
  if(!fs.existsSync(path.join(ROOT,'evidence/orgiast-unresolved.json'))){const rejections=read('evidence/rejections-orgiast.json');write('evidence/orgiast-unresolved.json',{at:new Date().toISOString(),originalCount:prior.length,original:prior.map(ja=>({ja,id:hash(ja),reason:rejections.filter(r=>r.ja===ja).at(-1)?.issues||['prior batch failure'],status:map.has(ja)?'validated after numeric parser correction':'pending'})),current});}
  progress.unresolved=current.length;write('evidence/orgiast-pending-current.json',current);
  const live=await fetchInventory('orgiast');write('evidence/orgiast-sitemap-audit.json',{at:new Date().toISOString(),count:live.length,missing:live.filter(p=>!inv.some(i=>i.url===p.url)),extra:inv.filter(p=>!live.some(i=>i.url===p.url))});
  const before=[];for(const url of ['https://www.orgiast.jp/','https://www.orgiast.jp/wp/wp-login.php']){const r=await get(url);before.push({url,status:r.status,at:new Date().toISOString()});}write('evidence/orgiast-before.json',before);
  console.log('Missing strings: '+current.length+'; source sitemap: '+live.length);
 }else if(mode==='repair'){
  const records=read(opt('--pending-file','evidence/orgiast-pending-current.json')).slice(offset,offset+limit);
  const map=await completeTranslations('orgiast',records.map(r=>r.ja),12,{batchSize:10,providers:['openrouter','mistral','deepseek'],budgetMs:390000,allowPartial:true});
  const current=scan(map);progress.unresolved=current.length;write('evidence/orgiast-pending-after.json',current);
  const initial=read('evidence/orgiast-unresolved.json');for(const r of initial.original){r.status=map.has(r.ja)?'resolved':'pending';if(map.has(r.ja))r.en=map.get(r.ja);}initial.remaining=current;write('evidence/orgiast-unresolved.json',initial);
 }else if(mode==='build'){
  const map=translationMap('orgiast').map;
  for(const p of inv.slice(offset,offset+limit)){
   const src=source(p),missing=allSegments(src).filter(s=>hasJa(s.text)&&!map.has(s.text));
   progress.excluded=progress.excluded.filter(e=>e.url!==p.url);
   if(missing.length){progress.excluded.push({url:p.url,status:'failed',reason:'Unresolved after provider retries',strings:[...new Set(missing.map(s=>s.text))]});delete state.pages['orgiast:'+p.url];continue;}
   const html=injectMetaTags(rewriteLinks(translateHtml(src,map),p.url),p.url,true),file=outputPath(p.url),sha256=hash(html),old=state.pages['orgiast:'+p.url];
   if(old?.sha256===sha256&&fs.existsSync(path.join(ROOT,'dist/orgiast',file))&&hash(fs.readFileSync(path.join(ROOT,'dist/orgiast',file)))===sha256)continue;
   write('dist/orgiast/'+file,html);state.pages['orgiast:'+p.url]={site:'orgiast',url:p.url,lastmod:p.lastmod,file,sha256,sourceHash:hash(src),noindex:true,residual:residual(html),built_at:new Date().toISOString()};
   write('evidence/build-state.json',state);
  }
  write('evidence/build-state.json',state);write('evidence/orgiast-excluded.json',progress.excluded);
  const pages=Object.values(state.pages).filter(p=>p.site==='orgiast');write('dist/orgiast/en/sitemap.xml','<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+pages.map(p=>'<url><loc>'+escape(enUrl(p.url))+'</loc>'+(p.lastmod?'<lastmod>'+escape(p.lastmod)+'</lastmod>':'')+'</url>').join('\n')+'\n</urlset>\n');
 }else if(mode==='report'){
  const map=translationMap('orgiast').map,rows=[];
  for(const p of Object.values(state.pages).filter(p=>p.site==='orgiast')){
   const html=fs.readFileSync(path.join(ROOT,'dist/orgiast',p.file),'utf8'),src=source(p);
   const issues=allSegments(src).filter(s=>hasJa(s.text)).flatMap(s=>textIssues(s.text,map.get(s.text)).map(issue=>({ja:s.text,issue})));
   rows.push({url:p.url,file:p.file,sha256:hash(html),hashMatch:hash(html)===p.sha256,lang:/<html\b[^>]*lang="en"/i.test(html),noindex:/name="robots" content="noindex,nofollow"/.test(html),residual:residual(html),issues});
  }
  const current=scan(map);progress.unresolved=current.length;write('evidence/orgiast-build-audit.json',{at:new Date().toISOString(),inventory:inv.length,generated:rows.length,excluded:progress.excluded,rows});
  let report=fs.readFileSync(path.join(ROOT,'BUILD-REPORT.md'),'utf8').split('\n## CODEX-TASK-04')[0];
  report+='\n## CODEX-TASK-04 — orgiast /en/\n\nChecked: '+new Date().toISOString()+'\n\nInventory: '+inv.length+'; generated: '+rows.length+'; excluded: '+progress.excluded.length+'. Includes topics and social-media reposts. All output is lang=en and noindex,nofollow. Maximum Japanese residual: '+Math.max(...rows.map(r=>r.residual.rate)).toFixed(3)+'%.\n\nTranslation retries use batches of at most 10 in openrouter → mistral → deepseek order, with implicit fallback disabled. Cached translations and unchanged output are reused. Each command accepts --offset/--limit. Original 81 strings and outcomes: evidence/orgiast-unresolved.json. Full audit: evidence/orgiast-build-audit.json.\n\n### Acceptance criteria\n\nOnly source-attested proper names, company names, hashtags, URLs, and image-alt proper names may retain Japanese; an English rendering/romanization with the original in parentheses is preferred. The required representative name 金功勇 and 日本語 language switch are retained. Ordinary Japanese sentences, including numeric IPO announcements, must be translated. Numeric Japanese compound units are checked by equivalent arithmetic values; source quantities are never corrected or supplemented. Source-attested parenthetical glosses accompany English translations. Residual rates include accessible text/attributes and retained glosses, exclude scripts/styles/URLs and image pixels.\n\n### Excluded pages\n\n'+(progress.excluded.length?progress.excluded.map(p=>'- '+p.url+' — '+p.reason).join('\n'):'None.')+'\n';
  write('BUILD-REPORT.md',report);
  if(rows.some(r=>!r.hashMatch||!r.lang||!r.noindex||r.issues.length)||rows.length+progress.excluded.length!==inv.length)throw Error('Build audit failed');
 }else throw Error('Unknown mode');
}finally{saveProgress();}
