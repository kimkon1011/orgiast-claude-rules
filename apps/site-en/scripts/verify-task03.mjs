import fs from 'node:fs';
import path from 'node:path';
import {ROOT,read,write,hash,decode} from './lib.mjs';
import {get} from './site-fetch.mjs';
import {residual,SITES,enUrl} from './static-core.mjs';
import {renderDeployReport} from './deploy-ftp.mjs';
const checks={rebooth:['/en/','/en/about/','/en/why-choose-us/','/en/works-top/','/en/company/','/en/contact/','/en/privacy-policy/'],orgiast:['/en/','/en/company/','/en/services/','/en/contactus/','/en/policy/','/en/recruiting/']};
const state=read('evidence/build-state.json'),rows=[],cssCache=new Map();
for(const [site,types]of Object.entries({rebooth:[['works',2]],orgiast:[['event',1],['interview',1]]}))for(const [type,count]of types){
 const pages=Object.values(state.pages).filter(p=>p.site===site&&new RegExp('^/'+type+'/[^/]+/?$').test(new URL(p.url).pathname)).sort((a,b)=>a.url.localeCompare(b.url)).slice(0,count);
 if(pages.length!==count)throw Error('Missing individual pages for '+type);
 checks[site].push(...pages.map(p=>new URL(enUrl(p.url)).pathname));
}
for(const [site,paths]of Object.entries(checks))for(const p of paths){
 const url=SITES[site]+p,r=await get(url),css=[];
 for(const tag of r.text.match(/<link\b[^>]*>/gi)||[]){
  if(!/\brel\s*=\s*['"][^'"]*\bstylesheet\b/i.test(tag))continue;
  const href=tag.match(/\bhref\s*=\s*(['"])(.*?)\1/i)?.[2];if(!href)continue;
  const cssUrl=new URL(decode(href),url).href;
  if(!cssCache.has(cssUrl)){try{const sheet=await get(cssUrl);cssCache.set(cssUrl,{url:cssUrl,status:sheet.status,bytes:sheet.bytes.length,sha256:hash(sheet.bytes)});}catch{cssCache.set(cssUrl,{url:cssUrl,status:0});}}
  css.push(cssCache.get(cssUrl));
 }
 const local=path.join(ROOT,'dist',site,p.slice(1),'index.html');
 rows.push({url,status:r.status,lang:/<html\b[^>]*\blang=['"]en['"]/i.test(r.text),noindex:!!(r.text.match(/<meta\b[^>]*>/gi)||[]).find(t=>/\bname=['"]robots['"]/i.test(t)&&/\bcontent=['"][^'"]*\bnoindex\b/i.test(t)),rate:residual(r.text).rate,css,cssOk:css.length>0&&css.every(c=>c.status===200&&c.bytes>0),localHashMatch:fs.existsSync(local)&&hash(r.bytes)===hash(fs.readFileSync(local))});
 console.log(url+' '+r.status+' CSS '+rows.at(-1).cssOk);
}
const before=read('evidence/task03-before.json'),protectedRows=[];
for(const old of before){const r=await get(old.url);protectedRows.push({...old,before:old.status,after:r.status,match:old.status===r.status,checked_at:new Date().toISOString()});}
write('evidence/public-verification.json',rows);write('evidence/task03-after.json',protectedRows);renderDeployReport();
const table='|URL|status|lang=en|noindex|Japanese rate|CSS|Local SHA256|\n|---|---:|---|---|---:|---|---|\n'+rows.map(r=>`|${r.url}|${r.status}|${r.lang}|${r.noindex}|${r.rate.toFixed(3)}%|${r.cssOk?'200 ('+r.css.length+'/'+r.css.length+')':'FAILED'}|${r.localHashMatch?'MATCH':'MISMATCH'}|`).join('\n');
const protectedTable='|URL|Before|After|Match|\n|---|---:|---:|---|\n'+protectedRows.map(r=>`|${r.url}|${r.before}|${r.after}|${r.match}|`).join('\n');
fs.appendFileSync(path.join(ROOT,'DEPLOY-REPORT.md'),'\n## CODEX-TASK-03 complete public readback\n\nChecked: '+new Date().toISOString()+'\n\n'+table+'\n\n'+protectedTable+'\n\nCSS URLs, response sizes and hashes: evidence/public-verification.json. No forms were submitted.\n');
console.log(table+'\n\n'+protectedTable);
if(rows.some(r=>r.status!==200||!r.lang||!r.noindex||!r.cssOk||!r.localHashMatch)||protectedRows.some(r=>!r.match))process.exitCode=1;
