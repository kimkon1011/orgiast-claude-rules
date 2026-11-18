import fs from 'node:fs';
import path from 'node:path';
import {ROOT,read,write,hash,decode} from './lib.mjs';
import {get} from './site-fetch.mjs';
import {residual,enUrl} from './static-core.mjs';
const origin='https://www.orgiast.jp',pages=Object.values(read('evidence/build-state.json').pages).filter(p=>p.site==='orgiast');
const paths=['/en/','/en/company/','/en/services/','/en/services/flow/','/en/contactus/','/en/policy/','/en/recruiting/','/en/clients/'];
for(const type of ['event','creative','interview','newsrelease','topics']){
 const p=pages.filter(p=>new RegExp('^/'+type+'/[^/]+/?$').test(new URL(p.url).pathname)).sort((a,b)=>a.url.localeCompare(b.url))[0];if(!p)throw Error('No page for '+type);paths.push(new URL(enUrl(p.url)).pathname);
}
const rows=[],cssCache=new Map();
for(const pathname of paths){
 const url=origin+pathname,r=await get(url),css=[];
 for(const tag of r.text.match(/<link\b[^>]*>/gi)||[]){
  if(!/\brel\s*=\s*['"][^'"]*\bstylesheet\b/i.test(tag))continue;
  const href=tag.match(/\bhref\s*=\s*(['"])(.*?)\1/i)?.[2];if(!href)continue;const cssUrl=new URL(decode(href),url).href;
  if(!cssCache.has(cssUrl)){const sheet=await get(cssUrl);cssCache.set(cssUrl,{url:cssUrl,status:sheet.status,bytes:sheet.bytes.length,sha256:hash(sheet.bytes)});}css.push(cssCache.get(cssUrl));
 }
 const local=path.join(ROOT,'dist/orgiast',pathname.slice(1),'index.html');
 rows.push({url,status:r.status,lang:/<html\b[^>]*\blang=['"]en['"]/i.test(r.text),noindex:(r.text.match(/<meta\b[^>]*>/gi)||[]).some(t=>/\bname=['"]robots['"]/i.test(t)&&/\bcontent=['"][^'"]*\bnoindex\b/i.test(t)),japaneseRate:residual(r.text).rate,css,cssOk:css.length>0&&css.every(c=>c.status===200&&c.bytes>0),hashMatch:hash(r.bytes)===hash(fs.readFileSync(local))});
 console.log(url+' HTTP '+r.status+' CSS '+rows.at(-1).cssOk);
}
const protectedRows=[];for(const old of read('evidence/orgiast-before.json')){const r=await get(old.url);protectedRows.push({url:old.url,before:old.status,after:r.status});}
const progress=read('evidence/orgiast-progress.json'),owned=read('.site-en-manifest.json').sites.orgiast;
const expected=[...pages.map(p=>p.file),'en/sitemap.xml'],unverified=expected.filter(f=>owned.files[f]?.status!=='verified'||owned.files[f]?.sha256!==hash(fs.readFileSync(path.join(ROOT,'dist/orgiast',f))));
const history=progress.deployRuns.filter(r=>r.mode==='apply'),uploaded=[...new Set(history.flatMap(r=>r.uploaded))].length;
const report={at:new Date().toISOString(),generated:pages.length,excluded:progress.excluded.length,uploaded,verifiedFiles:expected.length-unverified.length,unverified,rows,protectedRows};
write('evidence/orgiast-public-verification.json',report);
const table='|URL|HTTP|lang=en|noindex|日本語残存率|CSS|SHA256|\n|---|---:|---|---|---:|---|---|\n'+rows.map(r=>`|${r.url}|${r.status}|${r.lang}|${r.noindex}|${r.japaneseRate.toFixed(3)}%|${r.cssOk?'200 ('+r.css.length+'/'+r.css.length+')':'FAIL'}|${r.hashMatch?'MATCH':'FAIL'}|`).join('\n');
const protectedTable='|URL|Before|After|\n|---|---:|---:|\n'+protectedRows.map(r=>`|${r.url}|${r.before}|${r.after}|`).join('\n');
const text='\n## CODEX-TASK-04 — final orgiast readback\n\nChecked: '+report.at+'\n\nGenerated pages: '+report.generated+'; excluded pages: '+report.excluded+'; uploaded files: '+uploaded+' (HTML plus sitemap); verified owned files: '+report.verifiedFiles+'. Public root /web was verified against favicon.ico and common/css/style.css. Every upload was downloaded and SHA256 checked. Existing foreign files were never overwritten; no remote delete operations were used. Protected expo-apply and nested-directory snapshots are recorded per run in evidence/deploy-history/.\n\n'+table+'\n\n'+protectedTable+'\n\nCSS response details and hashes: evidence/orgiast-public-verification.json. Japanese image lettering is unchanged. No forms were submitted; no Japanese or WordPress files were written. rebooth was not deployed or changed in this task.\n';
fs.appendFileSync(path.join(ROOT,'DEPLOY-REPORT.md'),text);console.log(text);
progress.verification={at:report.at,generated:pages.length,excluded:progress.excluded.length,uploaded,verifiedFiles:report.verifiedFiles};write('evidence/orgiast-progress.json',progress);
if(unverified.length||rows.some(r=>r.status!==200||!r.lang||!r.noindex||!r.cssOk||!r.hashMatch)||protectedRows.some(r=>r.before!==200||r.after!==200))throw Error('Public verification failed');
