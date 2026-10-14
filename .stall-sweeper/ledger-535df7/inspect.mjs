import {readFileSync,writeFileSync} from 'node:fs';
const env={};
for(const line of readFileSync('/mnt/d/Claude/event-shop/.env.local','utf8').split(/\r?\n/)){const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m)env[m[1]]=m[2].trim().replace(/^["']|["']$/g,'');}
const report={checkedAt:new Date().toISOString(),operations:'read-only',checks:[]};
async function read(path){const r=await fetch(env.SUPABASE_URL+'/rest/v1/'+path,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY},signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('Supabase HTTP '+r.status);return r.json();}
try{const rows=await read('reply_edit_ledger?select=lead_id,message_id,sent_at,edit_percent,category&limit=1000');report.ledger=rows;report.suspects=rows.filter(r=>r.sent_at?.startsWith('2026-10-09')||r.edit_percent===96);report.checks.push({name:'live ledger read',ok:true});}catch(e){report.checks.push({name:'live ledger read',ok:false,error:e.message,cause:e.cause?.code});}
writeFileSync(new URL('./inspection.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
