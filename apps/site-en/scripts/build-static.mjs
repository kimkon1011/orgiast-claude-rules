import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT,read,write,hash,escape,hasJa} from './lib.mjs';
import {SITES,outputPath,enUrl,allSegments,translateHtml,rewriteLinks,injectMetaTags,replaceForms,residual} from './static-core.mjs';
import {inventory,get} from './site-fetch.mjs';
import {completeTranslations,translationMap} from './static-translate.mjs';
const stateFile='evidence/build-state.json';
export async function build({sites=Object.keys(SITES),selected=null,index=false,resume=false,phase=0,limit=Infinity,offset=0,rebuild=false}={}){
 const state=fs.existsSync(path.join(ROOT,stateFile))?read(stateFile):{pages:{}};
 const endpoint=fs.readFileSync(path.resolve(ROOT,'../expo-apply/config.js'),'utf8').match(/export const FORM_ENDPOINT\s*=\s*['"]([^'"]*)/)?.[1]||'';
 const results=[],failures=[];
 for(const site of sites){
  const inventoryFile='evidence/inventory-'+site+'.json';
  const available=selected?selected.filter(p=>p.site===site):resume&&fs.existsSync(path.join(ROOT,inventoryFile))?read(inventoryFile):await inventory(site);if(!selected)write(inventoryFile,available);
  const pages=available.filter(p=>!phase||p.phase===phase).slice(offset).filter(p=>{
   const old=state.pages[site+':'+p.url],file=old&&path.join(ROOT,'dist',site,old.file);
   return rebuild||!resume||!old||old.noindex===index||old.lastmod!==p.lastmod||!fs.existsSync(file)||hash(fs.readFileSync(file))!==old.sha256;
  }).slice(0,limit);
  console.log(site+': selected '+pages.length+' of '+available.length+' inventory pages');
  for(const stage of [1,2]){
   if(phase&&phase!==stage)continue;const pending=pages.filter(p=>p.phase===stage),live=[];
   for(const p of pending){const file='evidence/live/'+site+'/'+hash(p.url)+'.html';let html;
    if(resume&&fs.existsSync(path.join(ROOT,file)))html=fs.readFileSync(path.join(ROOT,file),'utf8');
    else {const r=await get(p.url);if(r.status!==200)throw Error('Source HTTP '+r.status+' '+p.url);html=r.text;write(file,html);}
    html=replaceForms(html,endpoint);live.push({...p,html,file});if(live.length%25===0||live.length===pending.length)console.log(site+' phase '+stage+': fetched '+live.length+'/'+pending.length);
   }
   let map;try{map=await completeTranslations(site,live.flatMap(p=>allSegments(p.html).map(s=>s.text)));}catch(e){if(!e.message.includes('untranslated/invalid strings'))throw e;failures.push(e.message);map=translationMap(site).map;}
   for(const p of live){if(allSegments(p.html).some(s=>hasJa(s.text)&&!map.has(s.text))){console.log('Deferred unresolved page: '+p.url);continue;}let html=translateHtml(p.html,map);html=rewriteLinks(html,p.url);html=injectMetaTags(html,p.url,!index);
    const file=outputPath(p.url);write('dist/'+site+'/'+file,html);const row={site,url:p.url,lastmod:p.lastmod,file,sha256:hash(html),sourceHash:hash(p.html),noindex:!index,residual:residual(html),built_at:new Date().toISOString()};state.pages[site+':'+p.url]=row;results.push(row);
   }
   write(stateFile,state);
  }
  const all=Object.values(state.pages).filter(p=>p.site===site);write('dist/'+site+'/en/sitemap.xml','<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+all.map(p=>'<url><loc>'+escape(enUrl(p.url))+'</loc>'+(p.lastmod?'<lastmod>'+escape(p.lastmod)+'</lastmod>':'')+'</url>').join('\n')+'\n</urlset>\n');
 }
 const all=Object.values(state.pages);write('BUILD-REPORT.md','# Build Report\n\nGenerated: '+new Date().toISOString()+'\n\nFull rendered HTML; only text/attributes, links, language metadata and contact fallback changed. Japanese rate includes the required 日本語 switch and retained proper-name glosses; script/style/URL bytes and text embedded in images are excluded.\n\n|Site|Pages|Maximum Japanese rate|Page|\n|---|---:|---:|---|\n'+Object.keys(SITES).map(site=>{const a=all.filter(p=>p.site===site).sort((a,b)=>b.residual.rate-a.residual.rate);return `|${site}|${a.length}|${a[0]?.residual.rate.toFixed(3)||0}%|${a[0]?.url||''}|`;}).join('\n')+'\n');
 console.log(fs.readFileSync(path.join(ROOT,'BUILD-REPORT.md'),'utf8'));if(failures.length)throw Error(failures.join('; '));return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const args=process.argv.slice(2),opt=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;build({sites:opt('--site','')?[opt('--site')]:Object.keys(SITES),index:args.includes('--index'),resume:args.includes('--resume'),rebuild:args.includes('--rebuild'),phase:Number(opt('--phase',0)),limit:Number(opt('--limit',25)),offset:Number(opt('--offset',0))}).catch(e=>{console.error('BUILD FAILED:',e.message);process.exitCode=1;});}
