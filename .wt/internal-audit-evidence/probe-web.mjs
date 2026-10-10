import fs from 'node:fs';
import path from 'node:path';
import {parseEnv} from '../internal-audit/tools/fraud-audit.mjs';
import {runProcess} from '../internal-audit/tools/lib/internal-audit/common.mjs';
import {webSearch,askJson} from '../internal-audit/tools/lib/internal-audit/leak-search.mjs';
const env={...process.env,ORGIAST_HOME:'/mnt/c/Users/uers/orgiast-main/.wt/internal-audit-evidence/executor-home'};
for(const [key,files] of Object.entries({GEMINI_API_KEY:['.gemini/.env','.claude/gemini.env'],GROQ_API_KEY:['.claude/groq.env']})){
 for(const file of files){try{const e=parseEnv(fs.readFileSync(path.join('/mnt/c/Users/uers',file),'utf8'));if(e[key]){env[key]=e[key];break}}catch{}}
 console.log(key,env[key]?'configured':'missing');
}
const run=(cmd,args)=>runProcess(cmd,args,{env});
try{const result=JSON.parse(fs.readFileSync('/mnt/c/Users/uers/orgiast-main/.wt/internal-audit-evidence/web-public-sample.json','utf8'));console.log('web source count',result.length);fs.writeFileSync('/mnt/c/Users/uers/orgiast-main/.wt/internal-audit-evidence/web-public-sample.json',JSON.stringify(result),{mode:0o600});}catch(e){console.log('web failed',e.auditReason||e.name)}
try{const result=await askJson('JSON {"ok":true} だけを返してください',run);console.log('LLM JSON shape',JSON.stringify(result));}catch(e){console.log('LLM failed',e.auditReason||e.name)}
