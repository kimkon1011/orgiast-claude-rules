import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {getDiscordMembers,matchMember} from '../../../tools/discord-member-directory.mjs';
const dir=path.dirname(new URL(import.meta.url).pathname);const save=(n,v)=>fs.writeFileSync(path.join(dir,n),JSON.stringify(v,null,2)+'\n');
const home='/mnt/c/Users/uers';const searches=[];
for(const query of ['百瀬','momose','kanau','m.kanau@orgiast.jp']) searches.push({query,members:await getDiscordMembers({query,home,refresh:true,persistCache:false})});
const candidates=[...new Map(searches.slice(0,3).flatMap(x=>x.members||[]).filter(m=>[m.nick,m.global_name,m.username].some(x=>/百瀬|momose|kanau/i.test(x||''))).map(m=>[m.id,m])).values()];save('discord-candidates.json',{searches,candidates,fullList:'HTTP 403 (search API available)'});if(candidates.length!==1||candidates[0].id!=='1382566741464449124')throw Error('ambiguous');
console.log('recipient',matchMember('m.kanau@orgiast.jp',searches.at(-1).members));
const token=process.env.DISCORD_BOT_TOKEN?.trim()||fs.readFileSync(home+'/.claude/orgiast-discord-bot-token.txt','utf8').trim();const headers={Authorization:`Bot ${token}`,'Content-Type':'application/json'};
const r=await fetch('https://discord.com/api/v10/users/@me/channels',{method:'POST',headers,body:JSON.stringify({recipient_id:candidates[0].id})});if(!r.ok)throw Error('DM channel HTTP '+r.status);const channel=await r.json();let before='',messages=[];
for(let page=0;page<10;page++){const r=await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages?limit=100${before?'&before='+before:''}`,{headers});if(!r.ok)throw Error('history HTTP '+r.status);const rows=await r.json();messages.push(...rows);if(rows.length<100||rows.at(-1).timestamp<'2026-10-01')break;before=rows.at(-1).id;}
const history=messages.filter(x=>x.timestamp>='2026-10-01').map(x=>({id:x.id,timestamp:x.timestamp,content:x.content,bot:x.author?.bot}));save('dm-history-before.json',{channelId:channel.id,messages:history});console.log('recent DM',JSON.stringify(history));
const root='/mnt/c/Users/uers/Downloads/CLAUDE.md配布/aujust-sales-automation';const require=createRequire(root+'/package.json');require('dotenv').config({path:root+'/.env.local',quiet:true});const db=require('@supabase/supabase-js').createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const {data:done,error}=await db.from('app_feedback').select('id,status,title,submitter,submitter_email,admin_note,resolved_ref').eq('status','done').eq('submitter_email','m.kanau@orgiast.jp');if(error)throw error;save('done-sales.json',done);
const {data:rejected,error:e}=await db.from('app_feedback').select('id,status,submitter,admin_note,updated_at').eq('id','6f5aa1a0-65a9-4481-9957-105e7e29a55f').single();if(e||rejected.status!=='rejected')throw Error('rejected readback');save('rejected-readback.json',rejected);
fs.mkdirSync(path.join(dir,'.claude'),{recursive:true});save('.claude/feedback-issue-ledger.json',{items:done.map(x=>({message_id:x.id,app_name:'営業アプリ',title:x.title,submitter:x.submitter_email,url:'https://aujust-sales-automation.vercel.app/feedback'}))});
console.log('done count',done.length,'rejected',rejected.status);
