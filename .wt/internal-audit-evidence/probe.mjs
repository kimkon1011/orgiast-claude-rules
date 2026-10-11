import fs from 'node:fs';
import postgres from '../../node_modules/postgres/src/index.js';
import {parseEnv} from '../../tools/fraud-audit.mjs';
import {getDriveToken} from '../../tools/lib/drive-auth.mjs';
const env=parseEnv(fs.readFileSync('.env.local','utf8'));
const sql=postgres(env.PURCHASING_APP_DATABASE_URL,{max:1,ssl:'require',connect_timeout:15,onnotice:()=>{}});
try{
 const [r]=await sql`select access_token,access_expires_at from freee_tokens where id='default'`;
 console.log('freee token usable',!!r?.access_token && Date.parse(r.access_expires_at)>Date.now());
 if(r?.access_token && Date.parse(r.access_expires_at)>Date.now())for(const endpoint of ['partners','deals','wallet_txns','walletables','account_items']){
 const u=new URL('https://api.freee.co.jp/api/1/'+endpoint);u.searchParams.set('company_id','11975741');if(!['walletables','account_items'].includes(endpoint))u.searchParams.set('limit','1');if(endpoint==='deals')u.searchParams.set('type','expense');
 const resp=await fetch(u,{headers:{Authorization:'Bearer '+r.access_token},signal:AbortSignal.timeout(25000)});const j=await resp.json();const p=j[endpoint]?.[0];console.log(endpoint,resp.status,'keys',Object.keys(p||{}),'bank',Object.keys(p?.partner_bank_account_attributes||{}),'payment',Object.keys(p?.payments?.[0]||{}));
 if(endpoint==='partners'&&p){const d=await fetch(`https://api.freee.co.jp/api/1/partners/${p.id}?company_id=11975741`,{headers:{Authorization:'Bearer '+r.access_token},signal:AbortSignal.timeout(25000)});const z=(await d.json()).partner;console.log('partner detail',d.status,Object.keys(z||{}),'bank',Object.keys(z?.partner_bank_account_attributes||{}));}
 }
}catch(e){console.log('freee probe failed',e.code||e.name)}finally{await sql.end({timeout:5});}
const keyPath='/mnt/c/Users/uers/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json';
for(const scope of ['drive','gmail.readonly','admin.reports.audit.readonly'])try{
 const token=await getDriveToken({keyPath,scope:'https://www.googleapis.com/auth/'+scope,impersonate:'kim@orgiast.jp',signal:AbortSignal.timeout(25000)});
 const url=scope==='drive'?"https://www.googleapis.com/drive/v3/files?pageSize=1&q='me'%20in%20owners&fields=files(id,name,permissions(id,type,role,emailAddress,domain,allowFileDiscovery))":scope==='gmail.readonly'?'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1':'https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/drive?maxResults=1';
 const r=await fetch(url,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(25000)});const j=await r.json();console.log(scope,r.status,'keys',Object.keys(j), 'item keys',Object.keys(j.files?.[0]||j.messages?.[0]||j.items?.[0]||{}),'permission keys',Object.keys(j.files?.[0]?.permissions?.[0]||{}));
}catch(e){console.log(scope,/unauthorized_client/.test(e.message)?'unauthorized_client':e.code||e.name)}
try{const token=fs.readFileSync('/mnt/c/Users/uers/.claude/orgiast-discord-bot-token.txt','utf8').trim();for(const route of ['guilds/715211007307284530/messages/search?content=orgiast&limit=25','guilds/715211007307284530/channels','guilds/715211007307284530/members?limit=1']){const r=await fetch('https://discord.com/api/v10/'+route,{headers:{Authorization:'Bot '+token,'User-Agent':'DiscordBot (https://orgiast.jp, 1.0)'},signal:AbortSignal.timeout(25000)});const j=await r.json();console.log('discord',route.split('?')[0],r.status,'keys',Object.keys(Array.isArray(j)?j[0]||{}:j));}}catch(e){console.log('discord failed',e.code||e.name)}
