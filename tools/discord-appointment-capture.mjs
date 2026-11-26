#!/usr/bin/env node
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { getAccounts, listChats, listMessages, searchMessages } from './beeper-api.mjs'; import { isEntry } from './is-entry.mjs';
const HOME = process.env.ORGIAST_HOME || os.homedir(); const ROOT = path.join(HOME,'.claude','unsent-ledger');
const trigger = /アポ獲得|アポ取得日|日程確定|URL.{0,12}送付|メール.{0,12}送付お願い|打ち合わせメール未送信/i;
const textOf = m => String(m.text || m.body || m.content || '').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const tsOf = m => new Date(m.timestamp || m.date || m.createdAt || m.sentAt || 0).getTime();
export function parseTemplate(text) {
  const pick = (...labels) => { const re = new RegExp(`(?:${labels.join('|')})[：:]\\s*([^\\n]+)`,'i'); return text.match(re)?.[1]?.trim() || null; };
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null;
  return { client: pick('企業名','会社名','社名'), appointment: pick('アポ取得日','打合せ日時','お打ち合わせ日時','日程'), phone: pick('電話番号'), person: pick('ご担当者','担当者'), email, hearing: pick('ヒアリング内容') };
}
export function detectMessages(chats, histories, since) {
  const out=[]; for (const chat of chats) for (const m of histories.get(chat.id || chat.chatID) || []) { const text=textOf(m), ts=tsOf(m); if (ts >= since && trigger.test(text)) out.push({chat,message:m,text,ts}); } return out;
}
function llmExtract(text) { const r=spawnSync(process.execPath,[path.join(HOME,'.claude','nightly-repo','tools','llm-ask.mjs'),'--category','extraction','--prompt',`次のDiscord投稿から会社ごとに client,person,email,appointment,hearing をJSON配列で抽出。推測しない。\n${text}`],{encoding:'utf8',timeout:120000}); if(r.status!==0) throw new Error(`llm extraction failed: ${r.stderr.slice(0,300)}`); const match=r.stdout.match(/\[[\s\S]*\]/); return match?JSON.parse(match[0]):[]; }
function draft(item, appointment) { const past=appointment && Date.parse(appointment)<Date.now(); return `- 宛先: ${item.to[0]||'不明'}\n- CC: satou@orgiast.jp\n- 件名: ${item.subject}\n- 送信元: seisaku-team@orgiast.jp\n\n---\n\n${item.client} ${item.person||'ご担当者'}様\n\nお世話になっております。株式会社オージャストの金でございます。\n${past?'ご案内が遅れ、予定していたお打ち合わせを実施できませんでしたことを深くお詫び申し上げます。\n':''}オンラインお打ち合わせのご案内です。\n\n会議URL: （作成待ち）\n\n株式会社オージャスト 金 功勇\n\n※このメッセージは金の指示でAIが作成・送信しています。\n`; }
export async function capture({ days, backfill=false, api={getAccounts,listChats,listMessages,searchMessages}, now=Date.now(), root=ROOT, home=HOME }={}) {
  fs.mkdirSync(path.join(root,'inbox'),{recursive:true}); const cursorFile=path.join(root,'discord-cursor.json'); const cursor=fs.existsSync(cursorFile)?JSON.parse(fs.readFileSync(cursorFile,'utf8')):{};
  const since=backfill?now-(days||14)*86400000:(Date.parse(cursor.last_success_at)||now-2*3600000); const accounts=await api.getAccounts(); const discord=accounts.filter(a=>/discord/i.test(`${a.network||''} ${a.bridge?.id||''}`)); const ids=discord.map(a=>a.id||a.accountID).filter(Boolean);
  const chats=[]; let c; do { const page=await api.listChats({limit:100,cursor:c,direction:'before',accountIDs:ids}); chats.push(...(page.items||page.chats||[])); c=page.oldestCursor||page.nextCursor; } while(c && chats.length<5000);
  let found;
  if (backfill && api.searchMessages) {
    const hits=[]; for(const q of ['アポ獲得','アポ取得日','日程確定','URL 送付','メール 送付お願い','打ち合わせメール未送信']){const page=await api.searchMessages(q,{limit:100});for(const m of page.items||page.messages||[])hits.push(m);}
    const byId=new Map(chats.map(c=>[c.id||c.chatID,c])); found=[...new Map(hits.map(m=>[m.id,m])).values()].filter(m=>tsOf(m)>=since&&trigger.test(textOf(m))).map(m=>({chat:byId.get(m.chatID)||{id:m.chatID||'search',title:m.chatTitle||m.chatName||'Discord'},message:m,text:textOf(m),ts:tsOf(m)}));
  } else {
    const histories=new Map(), active=chats.filter(chat=>{const t=Date.parse(chat.lastActivity||chat.updatedAt||chat.lastMessage?.timestamp||chat.timestamp||'');return !Number.isFinite(t)||t>=since;}); let offset=0;
    async function worker(){while(offset<active.length){const chat=active[offset++], id=chat.id||chat.chatID; const page=await api.listMessages(id,{limit:100,direction:'before'}); histories.set(id,page.items||page.messages||[]);}} await Promise.all(Array.from({length:Math.min(8,active.length)},worker)); found=detectMessages(chats,histories,since);
  }
  const rows=[]; let created=0;
  for(const hit of found){ let companies=[parseTemplate(hit.text)]; if(!companies[0].client || !companies[0].email) { try { companies=llmExtract(hit.text); } catch { /* evidence row remains */ } }
    for(const [n,x] of companies.entries()){ if(!x.client) continue; const chatId=hit.chat.id||hit.chat.chatID, msgId=hit.message.id||hit.message.messageID; const id=`dc-${String(chatId).replace(/\W/g,'_')}-${String(msgId).replace(/\W/g,'_')}-${n+1}`; const draftPath=path.join(home,'gb-reports','unsent-ledger','drafts',`${id}.md`); const item={id,client:x.client,case:'Discord 架電アポ後のURL案内',to:x.email?[x.email]:[],cc:['satou@orgiast.jp'],subject:`【会議URLのご案内】${x.client}様 オンラインお打ち合わせ`,body_path:draftPath,reply_to_message_id:null,reply_to_note:'Discord 起点の新規メール',thread_id:null,gmail_draft_id:null,from:'seisaku-team@orgiast.jp',urgent:true,decided_date:new Date(hit.ts).toISOString().slice(0,10),stop_reason:'Discord で決定・URL案内未送',status:'未送信',evidence:[`Discord「${hit.chat.title||hit.chat.name||chatId}」 messageID=${msgId} ${new Date(hit.ts).toISOString()}`],match:{to:x.email||'',after:new Date(hit.ts).toISOString()},last_checked_at:null,sent_message_id:null,person:x.person||null};
      const inbox=path.join(root,'inbox',`${id}.json`); const exists=fs.existsSync(inbox)||fs.existsSync(path.join(root,'inbox','done',`${id}.json`)); if(!exists){ fs.mkdirSync(path.dirname(draftPath),{recursive:true}); fs.writeFileSync(draftPath,draft(item,x.appointment)); fs.writeFileSync(inbox,`${JSON.stringify(item,null,2)}\n`); created++; }
      rows.push({chat:hit.chat.title||hit.chat.name||chatId,date:new Date(hit.ts).toISOString(),client:x.client,decision:x.appointment||'URL・メール送付依頼',exists,gmail:'毎時台帳照合'});
    }}
  fs.writeFileSync(cursorFile,`${JSON.stringify({last_success_at:new Date(now).toISOString()},null,2)}\n`);
  if(backfill){ const file=path.join(home,'gb-reports','unsent-mail-discord-1126','backfill-14d.md'); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,['| チャット名 | 日時 | 社名 | 決まったこと | 台帳に既にあるか | Gmail 送信済みか |','|---|---|---|---|---|---|',...rows.map(r=>`| ${r.chat} | ${r.date} | ${r.client} | ${r.decision} | ${r.exists?'あり':'新規'} | ${r.gmail} |`),''].join('\n')); }
  return {chats:chats.length,matches:found.length,created,rows};
}
async function main(){const a=process.argv.slice(2);const d=Number(a[a.indexOf('--days')+1])||14;console.log(JSON.stringify(await capture({backfill:a.includes('--backfill'),days:d}),null,2));}
if(isEntry(import.meta.url))main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
