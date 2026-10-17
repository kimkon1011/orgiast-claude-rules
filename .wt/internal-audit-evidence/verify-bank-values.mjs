import fs from 'node:fs';import path from 'node:path';
import {parseEnv} from '../internal-audit/tools/fraud-audit.mjs';
import {getReadOnlyToken,COMPANY_ID} from '../internal-audit/tools/lib/internal-audit/collect-freee.mjs';
import {getJson} from '../internal-audit/tools/lib/internal-audit/common.mjs';
const root=process.argv[2];
const token=await getReadOnlyToken(parseEnv(fs.readFileSync('/mnt/c/Users/uers/orgiast-main/.env.local','utf8')).PURCHASING_APP_DATABASE_URL);
const accounts=new Set();
for(let offset=0;;offset+=100){const j=await getJson(`https://api.freee.co.jp/api/1/partners?company_id=${COMPANY_ID}&limit=100&offset=${offset}`,{headers:{Authorization:`Bearer ${token}`}});for(const p of j.partners){const n=String(p.partner_bank_account_attributes?.account_number||'').normalize('NFKC').replace(/\s/g,'');if(/^\d{7}$/.test(n))accounts.add(n);}if(j.partners.length<100)break;}
const files=['snapshot-first.json','state.json','reports/first-run.md','reports/public-replay.md'].map(f=>path.join(root,f)).filter(f=>fs.existsSync(f));let found=0;
const checks=files.map(file=>{const text=fs.readFileSync(file,'utf8');const runs=new Set(text.match(/\d{7,}/g)||[]);const matches=[...accounts].filter(n=>runs.has(n)).length;found+=matches;return{file:path.relative(root,file),fullBankNumberMatches:matches};});
console.log(JSON.stringify({bankNumbersChecked:accounts.size,checks,pass:found===0},null,2));process.exitCode=found?1:0;
