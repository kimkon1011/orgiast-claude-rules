import fs from 'node:fs';
import path from 'node:path';
import {ROOT,read,write,canonical} from './lib.mjs';
import {get} from './site-fetch.mjs';
import {residual,SITES} from './static-core.mjs';
import {renderDeployReport} from './deploy-ftp.mjs';
const checks={rebooth:['/en/','/en/about/','/en/company/','/en/contact/'],orgiast:['/en/','/en/company/','/en/services/','/en/contactus/']};
const rows=[];
for(const [site,paths]of Object.entries(checks))for(const p of paths){const url=SITES[site]+p,r=await get(url);rows.push({url,status:r.status,lang:/<html\b[^>]*\blang="en"/i.test(r.text),noindex:/<meta\s+name="robots"\s+content="noindex,nofollow"/i.test(r.text),rate:residual(r.text).rate});}
const expo=await get(SITES.rebooth+'/en/expo-apply/');rows.push({url:SITES.rebooth+'/en/expo-apply/',status:expo.status,lang:null,noindex:null,rate:null});write('evidence/public-verification.json',rows);renderDeployReport();
const state=read('evidence/build-state.json');
for(const site of Object.keys(SITES)){
 const pages=Object.values(state.pages).filter(p=>p.site===site).sort((a,b)=>b.residual.rate-a.residual.rate);
 console.log(`${site}: generated ${pages.length} pages; maximum Japanese residual ${pages[0]?.residual.rate.toFixed(3)}% at ${pages[0]?.url}`);
 const f='evidence/deploy-'+site+'-apply.json',r=fs.existsSync(path.join(ROOT,f))?read(f):null;console.log(`${site}: apply=${!!r}; status=${r?.status||'not run'}; expo-apply before/after=${r?.protectedMatch?'MATCH':'not verified'}; files=${r?.protectedBefore?.length??'n/a'}`);
 if(r?.status==='deployed and verified')write('.regen-state.'+site+'.json',Object.fromEntries(read('evidence/inventory-'+site+'.json').map(p=>[canonical(p.url),p.lastmod])));
}
console.log('Forms: FORM_ENDPOINT empty; unconnected; mailto:seisaku-team@orgiast.jp and 0120-487-121.');
for(const r of rows)console.log(`${r.url} HTTP ${r.status}; lang=en ${r.lang}; noindex ${r.noindex}; Japanese ${r.rate===null?'n/a':r.rate.toFixed(3)+'%'}`);
const failed=rows.slice(0,-1).filter(r=>r.status!==200||!r.lang||!r.noindex);if(failed.length)process.exitCode=1;
const before=read('evidence/preflight-expo.json');console.log(`Protected expo-apply public status: before=${before.status}, after=${expo.status}. ${expo.status===200?'HTTP 200 verified.':'Existing 404 remains; not repaired because protected content is outside scope.'}`);if(before.status!==expo.status)process.exitCode=1;
