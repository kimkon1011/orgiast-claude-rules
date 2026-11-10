#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { listMessages } from './beeper-api.mjs';
import { loadSecrets, resolveGroup } from './line-group-send.mjs';
import { latestOf, readOutbound, writeContextMarker } from './lib/send-context.mjs';
import { mintDwdToken } from './gmail-draft.mjs';
import { resolveDiscordBotToken } from './notify-kim.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';
import { getDiscordMembers, matchMember } from './discord-member-directory.mjs';

const cutoff = () => Date.now() - 30 * 86400000;
const trimHistory = rows => rows.filter(x => !x.at || Date.parse(x.at) >= cutoff()).slice(-Math.max(20, Math.min(rows.length, 100)));
const sbHeaders = s => ({ apikey: s.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${s.SUPABASE_SERVICE_ROLE_KEY}` });
const responseError = async (label, response) => {
  const body = await response.text().catch(() => '');
  return new Error(`${label} HTTP ${response.status}${body ? `: ${body}` : ''}`);
};
const defaultInternalSendersFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'internal-senders.json');
const normalize = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
const addressOf = value => (String(value ?? '').match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] || String(value ?? '').match(/[^\s<>,]+@[^\s<>,]+/)?.[0] || '').toLowerCase();

export function loadInternalSenders(file = defaultInternalSendersFile) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    lineDisplayNames: new Set((config.lineDisplayNames || []).map(normalize)),
    discordUserIds: new Set((config.discordUserIds || []).map(String)),
    emailAddresses: new Set((config.emailAddresses || []).map(normalize)),
    emailDomains: new Set((config.emailDomains || []).map(normalize)),
  };
}
export function classifyMessage(message, channel, config = loadInternalSenders()) {
  if (message.side === 'self') return { ...message, party: 'internal' };
  let internal = false;
  if (channel === 'line') internal = config.lineDisplayNames.has(normalize(message.sender));
  if (channel === 'discord') internal = Boolean(message.senderBot) || config.discordUserIds.has(String(message.senderId || ''));
  if (channel === 'gmail') {
    const address = addressOf(message.sender);
    internal = config.emailAddresses.has(address) || config.emailDomains.has(address.split('@')[1] || '');
  }
  return { ...message, party: internal ? 'internal' : 'external' };
}
export function labelHistory(messages) {
  return messages.map(message => `${message.at || ''} [${message.party === 'internal' ? '自社' : '相手'}] ${message.sender || ''}: ${String(message.text || '').replace(/\s+/g, ' ').slice(0, 2000)}`);
}

export async function fetchHistory(channel, target, { home = process.env.ORGIAST_HOME || os.homedir(), fetchImpl = gwsFetch, internalSenders = loadInternalSenders() } = {}) {
  if (channel === 'line') {
    const s = await loadSecrets({ home }); const id = await resolveGroup(s, target);
    const url = `${s.SUPABASE_URL}/rest/v1/channel_messages?select=id,created_at,sender_display_name,body,direction,external_message_id&channel=eq.line&external_thread_id=eq.${encodeURIComponent(id)}&order=created_at.desc&limit=100`;
    const r = await fetchImpl(url, { headers: sbHeaders(s) }); if (!r.ok) throw await responseError('LINE 履歴取得失敗', r);
    const incoming = (await r.json()).map(x => ({ id: x.external_message_id || x.id, at: x.created_at, side: x.direction || 'external', sender: x.sender_display_name, text: x.body }));
    const sent = readOutbound(id, home).map(x => ({ id: x.messageId, at: x.at, side: 'self', sender: 'オージャスト', text: x.text }));
    return { target: id, messages: trimHistory([...incoming, ...sent].sort((a,b) => Date.parse(a.at)-Date.parse(b.at))).map(x => classifyMessage(x, channel, internalSenders)) };
  }
  if (channel === 'beeper') {
    const r = await listMessages(target, { limit: 100 });
    return { target, messages: trimHistory((r.items || []).map(x => ({ id:x.id, at:x.timestamp, side:x.isSender?'self':'external', sender:x.senderName, text:x.text }))).map(x => classifyMessage(x, channel, internalSenders)) };
  }
  if (channel === 'discord') {
    const token = resolveDiscordBotToken(home); if (!token) throw new Error('Discord Bot トークンがありません');
    const headers={ Authorization:`Bot ${token}`, 'Content-Type':'application/json' };
    let channelId=target;
    let r;
    if (/^\d{15,22}$/.test(target)) {
      r = await fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(target)}/messages?limit=100`, { headers });
      if (r.status === 404) {
        const dm=await fetchImpl('https://discord.com/api/v10/users/@me/channels',{method:'POST',headers,body:JSON.stringify({recipient_id:target})});
        if(!dm.ok) throw await responseError('Discord DM チャンネル作成失敗',dm);
        channelId=(await dm.json()).id;
        r=await fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=100`,{headers});
      }
    } else {
      const members=await getDiscordMembers({query:target,home,fetchImpl});
      const member=members&&matchMember(target,members);
      if(!member) throw new Error(`Discord 宛先「${target}」を一意に特定できません`);
      const dm=await fetchImpl('https://discord.com/api/v10/users/@me/channels',{method:'POST',headers,body:JSON.stringify({recipient_id:member.id})});
      if(!dm.ok) throw await responseError('Discord DM チャンネル作成失敗',dm);
      channelId=(await dm.json()).id;
      r=await fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=100`,{headers});
    }
    if (!r.ok) throw await responseError('Discord 履歴取得失敗', r);
    return { target:channelId, messages: trimHistory((await r.json()).map(x => ({ id:x.id, at:x.timestamp, side:x.author?.bot?'self':'external', senderId:x.author?.id, senderBot:Boolean(x.author?.bot), sender:x.author?.global_name||x.author?.username, text:x.content })).reverse()).map(x => classifyMessage(x, channel, internalSenders)) };
  }
  if (channel === 'gmail') {
    const user = process.env.ORGIAST_GMAIL_USER || 'seisaku-team@orgiast.jp';
    const token = await mintDwdToken({ user, scope:'https://www.googleapis.com/auth/gmail.readonly', fetchImpl });
    const headers = { Authorization:`Bearer ${token}` }; let threadId = target;
    if (target.includes('@')) { const q = encodeURIComponent(`from:${target} OR to:${target}`); const lr = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=20`, { headers }); const list = await lr.json(); threadId = list.messages?.[0]?.threadId; }
    if (!threadId) throw new Error('Gmail スレッドが見つかりません');
    const r = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`, { headers }); if (!r.ok) throw await responseError('Gmail 履歴取得失敗', r);
    const data = await r.json(); const decode = p => p?.body?.data ? Buffer.from(p.body.data,'base64url').toString('utf8') : (p?.parts||[]).map(decode).join('\n');
    return { target: threadId, messages: trimHistory((data.messages||[]).map(x => { const h=Object.fromEntries((x.payload?.headers||[]).map(v=>[v.name.toLowerCase(),v.value])); return { id:x.id, at:new Date(Number(x.internalDate)).toISOString(), side:addressOf(h.from)===user.toLowerCase()?'self':'external', sender:h.from, text:decode(x.payload) }; })).map(x => classifyMessage(x, channel, internalSenders)) };
  }
  throw new Error(`未対応 channel: ${channel}`);
}

export function parseVerdict(raw) { const m=String(raw).match(/\{[\s\S]*\}/); if(!m) throw new Error(`LLM判定がJSONではありません: ${String(raw).replace(/\s+/g,' ').slice(0,200)}`); const j=JSON.parse(m[0]); return { ok:j.verdict==='OK', reason:String(j.reason||''), warnings:Array.isArray(j.warnings)?j.warnings:[] }; }
export function runLlm(history, text, { spawn = spawnSync } = {}) {
  const prompt = `次の宛先履歴と送信予定本文を検査し、JSONだけを返す。形式: {"verdict":"OK|NG","reason":"理由","warnings":["警告"]}。発言者ラベルは厳守する。[相手]の未回答の質問・要望だけを「相手の未回答」と扱い、[自社]の質問を相手の要望と解釈しない。①回答済み質問の聞き直し ②[相手]の未回答質問・要望への未回答 ③[自社]が既に聞いた質問を重ねて聞いていないか ④日付・金額・数量・手配状況・呼び方の食い違い ⑤自社既送信との重複・矛盾、のどれかがあればNG。\n履歴:\n${labelHistory(history).join('\n')}\n送信予定:\n${text}`;
  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), 'llm-ask.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'send-context-prompt-')), promptFile=path.join(dir,'prompt.txt');
  try {
    fs.writeFileSync(promptFile,prompt,'utf8');
    const failures=[];
    for(const provider of ['gemini','groq','deepseek']) {
      const r=spawn(process.execPath,[tool,'--provider',provider,'--prefer-provider','--no-fallback','--category','classification','--max','3000','--no-persist','--prompt-file',promptFile],{encoding:'utf8',windowsHide:true});
      if(r.status!==0) { failures.push(`${provider}: ${r.error?.message||r.stderr||r.stdout||`終了コード ${r.status}`}`); continue; }
      try { return parseVerdict(r.stdout); } catch(error) { failures.push(`${provider}: ${error.message}${r.stderr ? `: ${r.stderr.trim()}` : ''}`); }
    }
    throw new Error(`安価LLM判定失敗: ${failures.join(' | ')}`);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}

export async function main(argv=process.argv.slice(2), deps={}) {
  const val=n=>{const i=argv.indexOf(n);return i>=0?argv[i+1]:''}; const channel=val('--channel'), target=val('--target')||val('--group')||val('--thread')||val('--chat')||val('--channel-id'), file=val('--text-file');
  if(!['line','gmail','discord','beeper'].includes(channel)||!target||!file) throw new Error('使い方: node tools/send-context-check.mjs --channel line|gmail|discord|beeper --target <宛先IDまたはメール> --text-file <送る本文>');
  const text=fs.readFileSync(file,'utf8').trim(); const result=await (deps.fetchHistory||fetchHistory)(channel,target,{home:deps.home});
  for(const line of labelHistory(result.messages)) console.log(line.slice(0, 700));
  const verdict=(deps.runLlm||runLlm)(result.messages,text); console.log(JSON.stringify(verdict,null,2));
  if(!verdict.ok) return 2; const written=writeContextMarker({channel,target:result.target,text,latest:latestOf(result.messages),reason:verdict.reason,home:deps.home}); console.log(`承認マーカー: ${written.file}`); return 0;
}
if(isEntry(import.meta.url)) main().then(c=>{process.exitCode=c}).catch(e=>{console.error(e.message);process.exitCode=1});
