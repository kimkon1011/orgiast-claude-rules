import fs from 'node:fs';
import path from 'node:path';
import {Writable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {Client} from 'basic-ftp';
import {ROOT,read,write,hash,decode} from './lib.mjs';
import {assertOutputPath,SITES} from './static-core.mjs';
import {get} from './site-fetch.mjs';
const {readEnvValue}=await import(pathToFileURL('C:/Users/USER/.claude/nightly-repo/tools/env-kv.mjs').href);
const ownershipFile='.site-en-manifest.json';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function verifyOwnership(file,exists,remoteHash,owned){assertOutputPath(file);if(exists&&(!owned||owned.sha256!==remoteHash))throw Error('Existing foreign or externally changed file: '+file);}
export function chooseRoot(candidates){const matches=candidates.filter(c=>c.matches.length>=2);if(matches.length!==1)throw Error('Document root not uniquely verified by two static files');return matches[0].root;}
export function assertSnapshot(before,after){if(!same(before,after))throw Error('Protected expo-apply snapshot changed');}
async function download(client,p){const chunks=[];await client.downloadTo(new Writable({write(chunk,enc,done){chunks.push(chunk);done();}}),p);return Buffer.concat(chunks);}
function safeName(name){if(!name||/[\\/\x00-\x1f]/.test(name)||name==='.'||name==='..')throw Error('Unsafe remote entry');return name;}
async function snapshot(client,dir){const out=[];for(const x of await client.list(dir)){safeName(x.name);if(x.isSymbolicLink)throw Error('Symlink in protected tree');if(x.isDirectory){out.push({name:x.name+'/',size:null});for(const row of await snapshot(client,dir+'/'+x.name))out.push({...row,name:x.name+'/'+row.name});}else out.push({name:x.name,size:x.size,sha256:hash(await download(client,dir+'/'+x.name))});}return out.sort((a,b)=>a.name.localeCompare(b.name));}
async function docroots(client,site,envRoot,report){
 const home=await get(SITES[site]+'/');if(home.status!==200)throw Error('Public home unavailable');
 const paths=[...new Set([...home.text.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map(m=>{try{return new URL(decode(m[1]),SITES[site]);}catch{return null;}}).filter(u=>u&&u.origin===SITES[site]&&/\.(?:css|js|ico|png|svg|jpe?g)$/i.test(u.pathname)).map(u=>u.pathname))].slice(0,16);
 const publicFiles=[];for(const p of paths){const r=await get(SITES[site]+p);if(r.status===200&&r.bytes.length)publicFiles.push({path:p,size:r.bytes.length,sha256:hash(r.bytes)});}
 const roots=[...new Set([envRoot,'/web','/web/'+new URL(SITES[site]).hostname.replace(/^www\./,''),'/web/www.'+new URL(SITES[site]).hostname.replace(/^www\./,''),'/public_html','/'].filter(Boolean).map(p=>p==='/'?'/':p.replace(/\/+$/,'')))];
 report.candidates=[];
 for(const root of roots){const item={root,matches:[],checks:[]};report.candidates.push(item);
  for(const pub of publicFiles){let size=null;try{size=await client.size(root.replace(/\/$/,'')+pub.path);}catch(e){if(e.code!==550)throw Error('FTP SIZE failed');}
   const row={path:pub.path,ftpSize:size,httpSize:pub.size,httpSha256:pub.sha256,match:false};item.checks.push(row);
   if(size===pub.size){const bytes=await download(client,root.replace(/\/$/,'')+pub.path);row.ftpSha256=hash(bytes);row.match=row.ftpSha256===pub.sha256;if(row.match)item.matches.push(pub.path);}
   if(item.matches.length>=2)break;
  }
 }
 return chooseRoot(report.candidates);
}
export function renderDeployReport(){
 const reports=[];for(const site of Object.keys(SITES))for(const mode of ['dry-run','apply']){const f='evidence/deploy-'+site+'-'+mode+'.json';if(fs.existsSync(path.join(ROOT,f)))reports.push(read(f));}
 let md='# Deploy Report\n\n'+reports.map(r=>`## ${r.site} — ${r.mode}\n\nTime: ${r.at}\n\nStatus: ${r.status}${r.error?' — '+r.error:''}\n\nVerified root: ${r.docroot||'not verified'}\n\n`+(r.candidates||[]).map(c=>`- ${c.root}: ${c.matches.length} exact byte-size and SHA256 matches (${c.matches.join(', ')})`).join('\n')+`\n\nFiles: ${r.plan?.length||0}; uploaded: ${r.uploaded?.length||0}. Protected expo-apply before/after: ${r.protectedMatch===true?'MATCH':r.protectedMatch===false?'MISMATCH':'not compared'}.\n\n`+(r.plan?.length?'|Path|Local bytes|Remote bytes|Action|\n|---|---:|---:|---|\n'+r.plan.map(p=>`|${p.file}|${p.size}|${p.remoteSize??'absent'}|${p.action}|`).join('\n')+'\n':'')+`\nFull root probes, protected snapshots and anomalous-directory listings: evidence/deploy-${r.site}-${r.mode}.json\n`).join('\n');
 const f='evidence/public-verification.json';if(fs.existsSync(path.join(ROOT,f))){const rows=read(f);md+='\n## Public GET verification\n\n|URL|HTTP|lang=en|noindex|Japanese rate|\n|---|---:|---|---|---:|\n'+rows.map(r=>`|${r.url}|${r.status}|${r.lang}|${r.noindex}|${r.rate?.toFixed(3)??'n/a'}%|`).join('\n')+'\n';}
 if(fs.existsSync(path.join(ROOT,'evidence/preflight-expo.json'))){const p=read('evidence/preflight-expo.json');md+=`\n## Protected expo-apply discrepancy\n\nThe pre-deployment GET at ${p.at} returned HTTP ${p.status}, not the expected 200. FTP listing in the independently verified public root also found no en/expo-apply directory. Empty before/after snapshots mean the protected directory remained absent, **not that a published expo-apply site was verified working**. No files were written into that protected path, and the unrelated pre-existing nested trees were only listed.\n`;}
 md+='\n## Verification limits\n\nBrowser access host was unavailable; the native Chrome window was minimized and could not be selected through the available API. No visual layout verification was completed. HTML/source checks and public HTTP GET verification are recorded separately. Original images may contain Japanese lettering; their pixels were not changed. No contact messages were submitted.\n';write('DEPLOY-REPORT.md',md);
}
export async function deploy(site,{apply=false,limit=Infinity,offset=0}={}){
 if(!SITES[site])throw Error('Unknown site');
 const report={site,mode:apply?'apply':'dry-run',at:new Date().toISOString(),status:'checking',uploaded:[]};
 const env='C:/Users/USER/.claude/'+site+'-ftp.env',value=k=>readEnvValue(env,k);
 const config={host:value('FTP_HOST'),user:value('FTP_USER'),password:value('FTP_PASS'),port:Number(value('FTP_PORT')||21),secure:value('FTP_SECURE')==='true'};
 if(!config.host||!config.user||!config.password)throw Error('FTP credentials unavailable for '+site);
 if(Object.values(config).some(v=>typeof v==='string'&&/[\r\n]/.test(v)))throw Error('Invalid FTP configuration');
 const client=new Client(30000);client.ftp.verbose=false;
 try{
  await client.access(config);const docroot=await docroots(client,site,value('FTP_DOCROOT'),report);report.docroot=docroot;console.log(site+': verified root '+docroot);
  // Only LIST, never change or remove suspicious pre-existing trees.
  report.anomalous=[];for(const dir of ['/web/orgiast.jp/en/en/expo-apply/wp','/web/orgiast.jp/en/en/expo-apply','/web/orgiast.jp/en/en']){try{report.anomalous.push({dir,entries:(await client.list(dir)).map(x=>({name:x.name,size:x.size,directory:x.isDirectory}))});}catch(e){if(e.code!==550)throw e;report.anomalous.push({dir,status:'not accessible (FTP 550)'});}}
  const listings=new Map();async function listing(dir){if(listings.has(dir))return listings.get(dir);if(dir!==docroot){const parent=await listing(path.posix.dirname(dir)),entry=parent.find(x=>x.name===path.posix.basename(dir));if(!entry){listings.set(dir,[]);return [];}if(!entry.isDirectory||entry.isSymbolicLink)throw Error('Non-directory or symlink ancestor: '+dir);}const rows=await client.list(dir);listings.set(dir,rows);return rows;}
  const base=docroot==='/'?'':docroot;
  const enEntries=await listing(base+'/en'),expo=enEntries.find(x=>x.name==='expo-apply');
  if(expo&&(!expo.isDirectory||expo.isSymbolicLink))throw Error('Invalid protected directory');
  report.expoPresentBefore=!!expo;
  report.protectedBefore=expo?await snapshot(client,base+'/en/expo-apply'):[];
  if(site==='rebooth'){const publicExpo=await get(SITES[site]+'/en/expo-apply/');report.expoHttpBefore=publicExpo.status;if(!expo&&publicExpo.status===200)throw Error('Public expo-apply exists but is not visible in verified FTP root');}
  const buildState=read('evidence/build-state.json'),pages=Object.values(buildState.pages).filter(p=>p.site===site),inventory=read('evidence/inventory-'+site+'.json');
  const excludedFile='evidence/'+site+'-excluded.json',excluded=fs.existsSync(path.join(ROOT,excludedFile))?read(excludedFile):[];
  if(!pages.length||inventory.some(p=>!pages.some(b=>b.url===p.url)&&!excluded.some(e=>e.url===p.url&&e.status==='failed'&&e.strings?.length)))throw Error('Incomplete build; every sitemap page must be generated or explicitly excluded');
  report.excluded=excluded.map(p=>p.url);
  const files=[...new Set([...pages.map(p=>p.file),'en/sitemap.xml'])].sort().slice(offset,offset+limit);
  report.offset=offset;report.limit=limit;
  const owned=fs.existsSync(path.join(ROOT,ownershipFile))?read(ownershipFile):{version:1,sites:{}};
  const prior=owned.sites[site];if(prior&&prior.docroot!==docroot)throw Error('Ownership manifest root mismatch');
  const ownership=prior||{docroot,files:{}};report.plan=[];
  for(const file of files){assertOutputPath(file);const local=path.join(ROOT,'dist',site,file),bytes=fs.readFileSync(local),sha256=hash(bytes),remote=base+'/'+file;
   if(file.endsWith('.html')&&pages.find(p=>p.file===file)?.sha256!==sha256)throw Error('Build hash mismatch: '+file);
   const entry=(await listing(path.posix.dirname(remote))).find(x=>x.name===path.posix.basename(remote));let remoteHash=null;
   if(entry){if(!entry.isFile||entry.isSymbolicLink)throw Error('Remote is not regular file');remoteHash=hash(await download(client,remote));}
   verifyOwnership(file,!!entry,remoteHash,ownership.files[file]);
   const row={file,size:bytes.length,remoteSize:entry?.size??null,sha256,action:entry?(remoteHash===sha256?'unchanged':'update-owned'):'new'};report.plan.push(row);console.log(`${row.action} ${file} local=${row.size} remote=${row.remoteSize??'absent'}`);
  }
  if(apply){for(const p of report.plan.filter(p=>p.action!=='unchanged')){
    assertOutputPath(p.file);const remote=base+'/'+p.file;await client.ensureDir(path.posix.dirname(remote));
    // Recheck existence immediately before every write, to catch a concurrent foreign upload.
    const now=(await client.list(path.posix.dirname(remote))).find(x=>x.name===path.posix.basename(remote));
    if(now)verifyOwnership(p.file,true,hash(await download(client,remote)),ownership.files[p.file]);
    ownership.files[p.file]={sha256:p.sha256,size:p.size,status:'pending'};owned.sites[site]=ownership;write(ownershipFile,owned);
    await client.uploadFrom(path.join(ROOT,'dist',site,p.file),remote);
    if(await client.size(remote)!==p.size||hash(await download(client,remote))!==p.sha256)throw Error('Uploaded content verification failed: '+p.file);
    ownership.files[p.file].status='verified';write(ownershipFile,owned);report.uploaded.push(p.file);if(report.uploaded.length%25===0)console.log(site+': uploaded '+report.uploaded.length);
   }}
  listings.clear();const afterExpo=(await listing(base+'/en')).find(x=>x.name==='expo-apply');report.expoPresentAfter=!!afterExpo;
  report.protectedAfter=afterExpo?await snapshot(client,base+'/en/expo-apply'):[];report.protectedMatch=same(report.protectedBefore,report.protectedAfter)&&report.expoPresentBefore===report.expoPresentAfter;if(!report.protectedMatch)throw Error('Protected expo-apply changed');assertSnapshot(report.protectedBefore,report.protectedAfter);
  report.anomalousAfter=[];for(const before of report.anomalous){try{report.anomalousAfter.push({dir:before.dir,entries:(await client.list(before.dir)).map(x=>({name:x.name,size:x.size,directory:x.isDirectory}))});}catch(e){if(e.code!==550)throw e;report.anomalousAfter.push({dir:before.dir,status:'not accessible (FTP 550)'});}}
  report.anomalousMatch=same(report.anomalous,report.anomalousAfter);if(!report.anomalousMatch)throw Error('Pre-existing nested directory listing changed');
  report.status=apply?'deployed and verified':'dry-run verified';console.log(site+': '+report.status+'; expo-apply before/after MATCH');
 }catch(e){report.status='FAILED';report.error=String(e.message).replaceAll(config.password,'[redacted]').replaceAll(config.user,'[redacted]').replaceAll(config.host,'[redacted]');throw Error(report.error);}
 finally{client.close();write('evidence/deploy-'+site+'-'+report.mode+'.json',report);write('evidence/deploy-history/'+report.at.replace(/[:.]/g,'-')+'-'+site+'-'+report.mode+'.json',report);renderDeployReport();
  if(site==='orgiast'){
   const f='evidence/orgiast-progress.json',p=fs.existsSync(path.join(ROOT,f))?read(f):{};p.updated_at=new Date().toISOString();p.deployRuns??=[];p.deployRuns.push({at:report.at,mode:report.mode,offset,limit,status:report.status,uploaded:report.uploaded,checked:report.plan?.map(r=>r.file)||[]});p.uploaded=[...new Set(p.deployRuns.flatMap(r=>r.uploaded))].length;write(f,p);
   console.log(`orgiast deploy: offset=${offset} limit=${limit} uploadedThisRun=${report.uploaded.length} uploadedTotal=${p.uploaded} status=${report.status}`);
  }
 }
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const a=process.argv.slice(2),opt=(k,d)=>a.includes(k)?a[a.indexOf(k)+1]:d;deploy(opt('--site',''),{apply:a.includes('--apply'),limit:Number(opt('--limit',50)),offset:Number(opt('--offset',0))}).catch(e=>{console.error('DEPLOY FAILED:',e.message);process.exitCode=1;});}
