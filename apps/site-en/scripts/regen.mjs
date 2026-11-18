import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT,read,write,canonical} from './lib.mjs';
import {SITES} from './static-core.mjs';
import {inventory} from './site-fetch.mjs';
import {build} from './build-static.mjs';
import {deploy} from './deploy-ftp.mjs';
export const changedPages=(pages,state)=>pages.filter(p=>!Object.hasOwn(state,canonical(p.url))||state[canonical(p.url)]!==p.lastmod);
export async function regen({sites=Object.keys(SITES),apply=false}={}){
 for(const site of sites){const f='.regen-state.'+site+'.json',state=fs.existsSync(path.join(ROOT,f))?read(f):{},pages=await inventory(site),changed=changedPages(pages,state);console.log(site+': '+changed.length+' changed/new pages');for(const p of changed)console.log(p.url);
  if(!apply||!changed.length)continue;
  await build({sites:[site],selected:changed});write('evidence/inventory-'+site+'.json',pages);await deploy(site,{apply:true});
  // Never mark a failed build/deployment as up-to-date. No cron registration here.
  write(f,Object.fromEntries(pages.map(p=>[canonical(p.url),p.lastmod])));
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const a=process.argv.slice(2);regen({sites:a.includes('--site')?[a[a.indexOf('--site')+1]]:Object.keys(SITES),apply:a.includes('--apply')}).catch(e=>{console.error('REGEN FAILED:',e.message);process.exitCode=1;});}
