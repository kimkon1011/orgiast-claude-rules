import fs from 'node:fs';
import path from 'node:path';
import {ROOT,read,write,walk} from './lib.mjs';
import {validate,textIssues} from './validation.mjs';
const manifest=read('MANIFEST.json'),rows=[],summary={},seen=new Set(),planned=new Set();
for(const p of manifest.pages){
 const k=p.site+'/'+p.type;summary[k]??={fetched:0,translated:0,skipped:0,failed:0};
 summary[k].fetched+=!!p.source_file;
 const route=p.site+p.en_path_planned;if(planned.has(route))throw Error('Duplicate planned route '+route);planned.add(route);
 if(p.en_path_planned?.startsWith('/en/expo-apply'))throw Error('Protected route collision');
 if(p.status==='skipped'){summary[k].skipped++;rows.push({p,result:null});continue;}
 let result;
 try{if(!p.en_file||!p.source_file)throw Error(p.reason||'Missing source/output path');seen.add(path.resolve(ROOT,p.en_file));const source=read(p.source_file),en=read(p.en_file);result=validate(source,en);
 p.status=result.ok?'translated':'failed';p.reason=result.ok?'':result.issues.join('; ');
 }catch(e){result={ok:false,issues:[e.message]};p.status='failed';p.reason=e.message;}
 rows.push({p,result});summary[k][p.status]++;
}
const orphans=walk(path.join(ROOT,'en'),'.en.json').filter(f=>!seen.has(f));
const templateResults={};for(const site of ['rebooth','orgiast']){const t=read('template-strings.'+site+'.json');templateResults[site]={total:t.entries.length,failed:t.entries.filter(e=>!e.en||textIssues(e.ja,e.en).length).length,unverified:t.unverified};}
let md='# Translation validation report\n\nGenerated: '+new Date().toISOString()+'\n\n';
md+='Checks cover title, visible text, alt/title/placeholder/aria-label and submit labels. Japanese in comments/code/URLs is not counted. Raw residual rate is shown; 金功勇, first-use Re:ブース, and source-attested Japanese proper-name glosses in parentheses are permitted. Any other Japanese fails. Numeric comparison uses visible content and normalizes full-width digits/comma separators and equivalent 万/億/thousand/million quantities. a/img counts must match exactly. All other markup and protected attributes must be byte-identical. Source hashes must match. Failed text segments receive one corrective translation pass in translate.mjs; persistent failures are not publishable. These automated checks cannot certify semantic accuracy; source and evidence remain available for review.\n\n';
md+='| Site/type | Fetched | Translated | Skipped | Failed |\n|---|---:|---:|---:|---:|\n';
for(const [k,s]of Object.entries(summary))md+='| '+k+' | '+s.fetched+' | '+s.translated+' | '+s.skipped+' | '+s.failed+' |\n';
md+='\nTemplate checks: '+JSON.stringify(templateResults)+'\n\nOrphan English files: '+orphans.length+'\n\n';
md+='| Site/type/source ID | Status | Japanese residual | Unapproved chars | Extra numeric tokens (raw difference) | a (ja/en) | img (ja/en) | Reason |\n|---|---|---:|---:|---|---|---|---|\n';
const safe=s=>String(s??'').replace(/\|/g,'\\|').replace(/\r?\n/g,' ');
for(const {p,result:r}of rows)md+='| '+[p.site+'/'+p.type+'/'+(p.ja_id??p.ja_url),p.status,r?.japanese?.rate?.toFixed(3)??'—',r?.japanese?.unapproved??'—',r?.extra_numbers?.join(', ')||'—',r?.a?.join('/')||'—',r?.img?.join('/')||'—',p.reason].map(safe).join(' | ')+' |\n';
write('MANIFEST.json',manifest);write('CHECK-REPORT.md',md);write('evidence/check-results.json',{generated:new Date().toISOString(),summary,templateResults,orphans,rows});console.log(JSON.stringify({summary,templateResults,orphans},null,2));
if(rows.some(x=>x.p.status==='failed')||orphans.length||Object.values(templateResults).some(x=>x.failed))process.exitCode=1;

