#!/usr/bin/env node
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { channelRequest } from './lib/gws-proxy.mjs';
import { isEntry } from './is-entry.mjs';
import { findSecretaryBookingUrls, SECRETARY_BOOKING_URL_REASON } from './lib/secretary-booking-url.mjs';
import { assertNoHandback, stripHumanOnly } from './lib/handback-guard.mjs';
import { assertSendConsistency, afterSendCleanup } from './send-consistency-check.mjs';
import { prepareTemaSend } from './lib/unattended-tema.mjs';
export async function run(args=process.argv.slice(2), request=channelRequest, deps={}) {
 const value=f=>{const i=args.indexOf(f);return i<0?undefined:args[i+1];};
 const allowed=['--contacts','--history','--limit','--before','--chat','--to','--body-file','--send','--dry-run','--retry-key'];
 for(let i=0;i<args.length;i++){if(!allowed.includes(args[i]))throw Error('Unknown LINE argument');if(['--limit','--before','--chat','--to','--body-file','--retry-key'].includes(args[i])){if(!args[++i] || args[i].startsWith('--'))throw Error('Missing LINE argument');}}
 if(args.includes('--contacts')) return request('line',{query:{mode:'contacts'}});
 if(!value('--to') && args.includes('--dry-run') && value('--body-file') && !args.includes('--send')) { let text=fs.readFileSync(value('--body-file'),'utf8'); assertNoHandback(text, { env: process.env }); text=stripHumanOnly(text); if(findSecretaryBookingUrls(text).length) throw Error(SECRETARY_BOOKING_URL_REASON); return request('line',{body:{op:'validate',dryRun:true,text}}); }
 if(!value('--to')) return request('line',{query:{mode:'history',limit:value('--limit') || '20',...(value('--before')?{before:value('--before')}:{ }),...(value('--chat')?{chat:value('--chat')}:{})}});
 if(!value('--body-file'))throw Error('--body-file required');
 if(args.includes('--send')&&args.includes('--dry-run'))throw Error('--send and --dry-run are exclusive');
 const text=await prepareTemaSend(fs.readFileSync(value('--body-file'),'utf8'), { ...deps, to: value('--to'), channel: 'line', source: 'line-channel', dryRun: !args.includes('--send') });
 if(findSecretaryBookingUrls(text).length) throw Error(SECRETARY_BOOKING_URL_REASON);
 const contacts=await request('line',{query:{mode:'contacts'}}), query=value('--to');
 const matches=contacts.contacts.filter(c=>c.active&&(c.id===query||c.name===query));
 if(!matches.length && /^[UC][a-f0-9]{32}$/i.test(query)) matches.push({id:query,name:'LINE ID指定'});
 if(matches.length!==1)throw Error('LINE宛先を一意に確認できません');
 const retryKey=value('--retry-key')||randomUUID();
 console.log(`宛先: ${matches[0].name} (${matches[0].id})\n本文:\n${text}\n再試行キー: ${retryKey}`);
 const checkInput={channel:'line',to:matches[0].id,text,draftId:retryKey};
 const checked=args.includes('--send') ? await (deps.consistencyCheck ?? assertSendConsistency)(checkInput,deps) : null;
 const result=await request('line',{body:{op:'push',to:matches[0].id,text,dryRun:!args.includes('--send'),retryKey}});
 if(args.includes('--send') && result?.ok!==false) await (deps.cleanup ?? afterSendCleanup)({...checkInput,sentMessageId:result?.sentMessages?.[0]?.id || retryKey,scheduledSends:checked?.input?.scheduledSends},deps);
 return result;
}
if(isEntry(import.meta.url))run().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=e.code==='HANDBACK_BLOCKED'?4:1;});
