import fs from 'node:fs';
import path from 'node:path';
import {ROOT,read,write,hash,walk} from './lib.mjs';
const audit=read('evidence/task03-build-audit.json');
const owned=read('.site-en-manifest.json');
const history=walk(path.join(ROOT,'evidence/deploy-history')).map(f=>JSON.parse(fs.readFileSync(f,'utf8'))).filter(r=>r.mode==='apply');
const summary={};
for(const site of ['rebooth','orgiast']){
 const pages=audit.pages.filter(p=>p.site===site),expected=[...pages.map(p=>p.file),'en/sitemap.xml'],runs=history.filter(r=>r.site===site);
 const uploaded=[...new Set(runs.flatMap(r=>r.uploaded))],checked=new Set(runs.filter(r=>r.status==='deployed and verified').flatMap(r=>r.plan.map(p=>p.file)));
 const failures=expected.filter(f=>!checked.has(f)||owned.sites[site]?.files[f]?.status!=='verified'||owned.sites[site].files[f].sha256!==hash(fs.readFileSync(path.join(ROOT,'dist',site,f))));
 summary[site]={generated:pages.length,files:expected.length,uploadedThisTask:uploaded.length,verified:expected.filter(f=>!failures.includes(f)).length,failures:failures.length,failedPaths:failures,protectedMatch:runs.length>0&&runs.every(r=>r.protectedMatch===true),nestedDirectoriesMatch:runs.length>0&&runs.every(r=>r.anomalousMatch===true),maximumJapaneseRate:audit.summary[site].maximum};
}
write('evidence/task03-summary.json',summary);
if(Object.values(summary).some(s=>s.failures||!s.protectedMatch||!s.nestedDirectoriesMatch)||Object.values(audit.summary).some(s=>s.missing.length))throw Error('Incomplete task: inspect summary');
let build='\n## CODEX-TASK-03 final audit\n\nChecked: '+new Date().toISOString()+'\n\nThe starting report had rebooth 201 pages and orgiast 0 pages. The current orgiast sitemap was independently fetched again and matched all 375 inventory URLs (evidence/task03-sitemap-audit.json). Builds were resumed in bounded batches; validated translations were reused and rejected outputs were never published.\n\n';
build+='|Site|Inventory|Generated|Maximum Japanese rate|Maximum page|Above 5%|\n|---|---:|---:|---:|---|---:|\n'+Object.entries(audit.summary).map(([s,v])=>`|${s}|${v.inventory}|${v.generated}|${v.maximum.toFixed(3)}%|${v.maximumUrl}|${v.overFive.length}|`).join('\n')+'\n\n';
const high=Object.values(audit.summary).flatMap(v=>v.overFive);
build+=high.length?'Pages over 5% and one-time retranslation outcomes are recorded in evidence/task03-residual-retry.json.\n':'No page exceeded 5%; the conditional one-time retranslation was not triggered.\n';
build+='\nJapanese text remaining outside the language switch, source-attested Japanese glosses following English translations, hashtags and the required representative name:\n\n';
const remaining=Object.values(audit.summary).flatMap(s=>s.untranslated);
build+=remaining.length?remaining.map(p=>'- '+p.url+' — '+p.untranslated.join(' / ')).join('\n'):'None. Every page was scanned; complete text samples and per-page rates are in evidence/task03-build-audit.json. Source-attested glosses include some translated terminology as well as proper names; evidence/task03-glosses.json lists them separately. Image lettering is unchanged and excluded from text rates.';
fs.appendFileSync(path.join(ROOT,'BUILD-REPORT.md'),build+'\n');
let deploy='\n## CODEX-TASK-03 deployment totals\n\n|Site|Generated pages|Verified files|Uploaded this task|Final failures|expo-apply tree|Existing nested directories|\n|---|---:|---:|---:|---:|---|---|\n'+Object.entries(summary).map(([s,v])=>`|${s}|${v.generated}|${v.verified}|${v.uploadedThisTask}|${v.failures}|${v.protectedMatch?'MATCH':'FAIL'}|${v.nestedDirectoriesMatch?'MATCH':'FAIL'}|`).join('\n')+'\n\nRebooth already had 202 owned files deployed before this task; unchanged files were read back and skipped. File counts include one sitemap per site. Every uploaded file was downloaded from FTP and its size/SHA256 checked. No remote files were deleted. Detailed bounded-run records: evidence/deploy-history/.\n';
for(const site of ['rebooth','orgiast']){
 const r=history.filter(r=>r.site===site&&r.status==='deployed and verified').at(-1),root=r.candidates.find(c=>c.root===r.docroot);
 deploy+=`\n### ${site} public root: ${r.docroot}\n\n|Path|HTTP bytes|FTP bytes|HTTP SHA256|FTP SHA256|\n|---|---:|---:|---|---|\n`+root.checks.filter(c=>c.match).map(c=>`|${c.path}|${c.httpSize}|${c.ftpSize}|${c.httpSha256}|${c.ftpSha256}|`).join('\n')+'\n';
}
if(fs.existsSync(path.join(ROOT,'evidence/screens/results.json'))){const screens=read('evidence/screens/results.json');deploy+='\n### Browser screenshots\n\n|Site|Width|HTTP|Page width|Screenshot|\n|---|---:|---:|---:|---|\n'+screens.map(s=>`|${s.site}|${s.width}|${s.status}|${s.scrollWidth}|${s.file}|`).join('\n')+'\n\nCaptured with headless Chrome / Playwright, full page, after scrolling for lazy content. Browser diagnostics: evidence/screens/results.json. Image lettering remains Japanese. No form submission was performed.\n';}
fs.appendFileSync(path.join(ROOT,'DEPLOY-REPORT.md'),deploy);
console.log(JSON.stringify(summary,null,2));
