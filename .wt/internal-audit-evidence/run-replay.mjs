import fs from 'node:fs';
import {spawn} from 'node:child_process';
const state='/mnt/c/Users/uers/orgiast-main/.wt/internal-audit-evidence/live';
const until=Date.now()+15*60*1000;
while(!fs.existsSync(state+'/snapshot-first.json') || fs.existsSync(state+'/run.lock')){if(Date.now()>until)throw Error('first run not ready');await new Promise(r=>setTimeout(r,5000));}
const child=spawn(process.execPath,['tools/internal-audit.mjs','--snapshot',state+'/snapshot-first.json','--skip','gmail,drive,discord,admin','--min-severity','medium','--state-dir',state,'--out',state+'/reports/public-replay.md'],{cwd:'/mnt/c/Users/uers/orgiast-main/.wt/internal-audit',shell:false,stdio:'inherit'});
child.on('exit',code=>{fs.writeFileSync('/mnt/c/Users/uers/orgiast-main/.wt/internal-audit-evidence/public-replay-exit.json',JSON.stringify({exit:code}));process.exitCode=code;});
