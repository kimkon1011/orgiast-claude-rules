import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {sweep,sweepExitCode}=await import(pathToFileURL(process.argv[2]));
const home=fs.mkdtempSync(path.join(os.tmpdir(),'fzs-repro-'));
try {
 fs.mkdirSync(path.join(home,'.claude'));
 const appName='fixture';
 const registryFile=path.join(home,'registry.json');
 fs.writeFileSync(registryFile,JSON.stringify({apps:[{appName,intake:'relay',refs:{url:'T_URL',secret:'T_SECRET'}}]}));
 fs.writeFileSync(path.join(home,'.claude','feedback-issue-ledger.json'),JSON.stringify({items:[{app_name:appName,message_id:'resolved',repo:'o/r',number:42}]}));
 let attempts=0;
 const result=await sweep({home,registryFile,config:{T_URL:'https://fixture.invalid',T_SECRET:'dummy'},dryRun:true,
 fetchImpl:async()=>({ok:true,json:async()=>({ok:true,items:[]})}),
 gh:()=>++attempts===1?{status:1}:{status:0,stdout:'{"state":"CLOSED"}'}});
 console.log(JSON.stringify(result,null,2));process.exitCode=sweepExitCode(result);
} finally {fs.rmSync(home,{recursive:true,force:true});}
