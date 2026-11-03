#!/usr/bin/env node
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { channelRequest } from './lib/gws-proxy.mjs';
import { isEntry } from './is-entry.mjs';
export async function run(args=process.argv.slice(2), request=channelRequest) {
 const value=f=>{const i=args.indexOf(f);return i<0?undefined:args[i+1];};
 const allowed=['--contacts','--history','--limit','--before','--chat','--to','--body-file','--send','--dry-run','--retry-key'];
 for(let i=0;i<args.length;i++){if(!allowed.includes(args[i]))throw Error('Unknown LINE argument');if(['--limit','--before','--chat','--to','--body-file','--retry-key'].includes(args[i])){if(!args[++i] || args[i].startsWith('--'))throw Error('Missing LINE argument');}}
 if(args.includes('--contacts')) return request('line',{query:{mode:'contacts'}});
 if(!value('--to') && args.includes('--dry-run') && value('--body-file') && !args.includes('--send')) return request('line',{body:{op:'validate',dryRun:true,text:fs.readFileSync(value('--body-file'),'utf8')}});
 if(!value('--to')) return request('line',{query:{mode:'history',limit:value('--limit') || '20',...(value('--before')?{before:value('--before')}:{ }),...(value('--chat')?{chat:value('--chat')}:{})}});
 if(!value('--body-file'))throw Error('--body-file required');
 if(args.includes('--send')&&args.includes('--dry-run'))throw Error('--send and --dry-run are exclusive');
 const text=fs.readFileSync(value('--body-file'),'utf8');
 const contacts=await request('line',{query:{mode:'contacts'}}), query=value('--to');
 const matches=contacts.contacts.filter(c=>c.active&&(c.id===query||c.name===query));
 if(!matches.length && /^[UC][a-f0-9]{32}$/i.test(query)) matches.push({id:query,name:'LINE ID指定'});
 if(matches.length!==1)throw Error('LINE宛先を一意に確認できません');
 const retryKey=value('--retry-key')||randomUUID();
 console.log(`宛先: ${matches[0].name} (${matches[0].id})\n本文:\n${text}\n再試行キー: ${retryKey}`);
 return request('line',{body:{op:'push',to:matches[0].id,text,dryRun:!args.includes('--send'),retryKey}});
}
if(isEntry(import.meta.url))run().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
