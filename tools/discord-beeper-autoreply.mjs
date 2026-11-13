#!/usr/bin/env node
// Discord only. No UI Automation, read receipts, request acceptance or approval receipts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as beeper from './beeper-api.mjs';
import { isEntry } from './is-entry.mjs';
import {
  classifyReply, contentFor, createLlm, ensureTaskPriority, decisionReport, sentReport,
  isWithinAllowedTimeWindow, recordSentReply, flushUnreportedSentLogs, recordDecisionPending, readSentLog
} from './discord-autoreply.mjs';
import { addItem as addKimInboxItem } from './kim-inbox.mjs';
import { resolveDiscordLink } from './discord-beeper-link.mjs';

export const DISCORD_ACCOUNT = 'discordgo.715210673642012733';
const HOUR = 3600000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
const atomic = (file, value) => {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
};
export function plainText(text = '') {
  return String(text).replace(/<br\s*\/?\s*>|<\/p>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
}
const timestamp = m => Date.parse(m.timestamp);
const compare = (a, b) => timestamp(a) - timestamp(b)
  || (BigInt(/^\d+$/.test(a.sortKey) ? a.sortKey : '0') > BigInt(/^\d+$/.test(b.sortKey) ? b.sortKey : '0') ? 1
    : BigInt(/^\d+$/.test(a.sortKey) ? a.sortKey : '0') < BigInt(/^\d+$/.test(b.sortKey) ? b.sortKey : '0') ? -1 : 0);
const validMessages = items => items.filter(m => !m.isDeleted && !m.isHidden && m.id && typeof m.isSender === 'boolean' && Number.isFinite(timestamp(m))).sort(compare);
const mark = m => ({ id: m.id, timestamp: m.timestamp, sortKey: m.sortKey });
export function isDiscordChat(chat, accounts) {
  return chat.accountID === DISCORD_ACCOUNT && ['single', 'group'].includes(chat.type)
    && accounts.some(a => a.accountID === DISCORD_ACCOUNT && a.network?.toLowerCase() === 'discord');
}
export function isMessageRequest(chat) {
  return Boolean(chat.isMessageRequest || chat.isRequest || chat.messageRequest || chat.capabilities?.messageRequest
    || chat.participants?.items?.some(p => p.isPending));
}
// Only explicit native IDs, never the numeric Beeper-local chat/message IDs.
export function messageLink(chat, message) {
  return resolveDiscordLink(chat, message);
}
function addressedToKim(chat, pending, all, selfIDs) {
  if (chat.type === 'single') return true;
  return pending.some(m => m.mentions?.some(id => selfIDs.has(id))
    || [...selfIDs].some(id => (m.text || '').includes(id))
    || /金功勇|金社長|@kim\b/i.test(plainText(m.text))
    || (m.linkedMessageID && all.some(x => x.id === m.linkedMessageID && x.isSender)));
}
async function chatsFor(api) {
  const chats = new Map(), seen = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const data = await api.listChats({ accountIDs: [DISCORD_ACCOUNT], limit: 200, cursor, direction: cursor ? 'before' : undefined });
    if (!Array.isArray(data.items)) throw new Error('Beeper chat response invalid');
    for (const chat of data.items) chats.set(chat.id, chat);
    if (!data.hasMore) return [...chats.values()];
    if (!data.oldestCursor || seen.has(data.oldestCursor)) throw new Error('Beeper chat pagination incomplete');
    seen.add(data.oldestCursor); cursor = data.oldestCursor;
  }
  throw new Error('Beeper chat pagination limit');
}
async function historyFor(api, chat) {
  const items = new Map(), seen = new Set();
  let cursor;
  for (let page = 0; page < 20; page++) {
    const data = await api.listMessages(chat.id, { limit: 50, cursor, direction: 'before' });
    if (!Array.isArray(data.items)) throw new Error('Beeper message response invalid');
    for (const m of data.items) {
      if (m.accountID && m.accountID !== DISCORD_ACCOUNT) throw new Error('Beeper message account mismatch');
      items.set(m.id, m);
    }
    if (isMessageRequest(chat) || !data.hasMore || data.items.some(m => m.isSender)) return { items: validMessages([...items.values()]), complete: true };
    if (!data.oldestCursor || seen.has(data.oldestCursor)) break;
    seen.add(data.oldestCursor); cursor = data.oldestCursor;
  }
  return { items: validMessages([...items.values()]), complete: false };
}
function acquire(dir) {
  const file = path.join(dir, 'lock');
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname() }), { flag: 'wx' }); }
  catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  return () => fs.unlinkSync(file);
}
export async function runOnce(options = {}) {
  const home = options.home || os.homedir(), dryRun = Boolean(options.dryRun), api = options.api || beeper;
  const now = options.now ? (typeof options.now === 'function' ? options.now() : options.now) : Date.now();
  const dir = path.join(home, '.claude', 'discord-beeper-autoreply');
  const stateFile = path.join(dir, 'state.json');
  const result = { ok: true, dryRun, scanned: 0, replied: 0, decisions: [], wouldSend: [], skipped: 0, errors: [] };
  let release, state;
  const save = () => { if (!dryRun) atomic(stateFile, state); };
  const addItemImpl = options.addItemImpl || addKimInboxItem;

  try {
    if (!dryRun) {
      fs.mkdirSync(dir, { recursive: true });
      release = acquire(dir);
      if (!release) return { ...result, locked: true };
      await flushUnreportedSentLogs(home, { addItemImpl });
    }
    if (fs.existsSync(path.join(dir, 'PAUSE'))) return { ...result, paused: true };
    const stored = read(stateFile);
    state = stored ? JSON.parse(stored) : { version: 1, chats: {}, hourly: [], hourlyByChat: {} };
    if (state.version !== 1 || !state.chats || Array.isArray(state.chats) || !Array.isArray(state.hourly)) throw new Error('state.json invalid');
    state.hourlyByChat ??= {};

    const accounts = await api.getAccounts();
    if (!Array.isArray(accounts)) throw new Error('Beeper account response invalid');
    if (!accounts.some(a => a.accountID === DISCORD_ACCOUNT && a.network?.toLowerCase() === 'discord')) throw new Error('kim Discord account unavailable');
    const selfIDs = new Set(accounts.filter(a => a.user?.isSelf).map(a => a.user.id));
    const chats = (await chatsFor(api)).filter(c => isDiscordChat(c, accounts));
    const llm = options.llm || createLlm({ home, fetchImpl: options.fetchImpl || fetch });
    let attempts = 0;

    for (const chat of chats) {
      result.scanned++;
      let latest, question = '', link = `会話名: ${chat.title || chat.id}`;
      const prior = state.chats[chat.id];
      if (prior?.status !== 'sending' && (chat.preview?.isSender
        || (prior?.id && chat.preview?.id === prior.id))) { result.skipped++; continue; }
      
      const decide = async (reason, status = 'decision') => {
        const row = { chatID: chat.localChatID || chat.id, chat: chat.title, messageId: latest?.id || null, reason, link, classification: '判断待ち' };
        result.decisions.push(row);
        state.chats[chat.id] = { ...(latest ? mark(latest) : prior), status, reason };
        if (!latest && prior?.status === status && prior?.reason === reason) return;
        await recordDecisionPending(home, {
          where: 'dm',
          senderName: latest?.senderName || chat.title || 'User',
          channelName: chat.title || chat.id,
          channelId: chat.id,
          messageId: latest?.id,
          question: question || reason,
          link
        }, { addItemImpl });
      };

      try {
        if (prior?.status !== 'sending' && isMessageRequest(chat) && chat.preview?.isSender === false
          && chat.preview.id && Number.isFinite(timestamp(chat.preview))) {
          latest = chat.preview; question = plainText(latest.text); link = messageLink(chat, latest);
          if (prior?.id === latest.id || (prior?.timestamp && compare(latest, prior) <= 0)) { result.skipped++; continue; }
          await decide('メッセージリクエスト・未承認'); continue;
        }
        const history = await historyFor(api, chat), all = history.items;
        latest = all.at(-1);
        const lastSelf = all.findLast(m => m.isSender);
        if (prior?.status === 'sending') {
          const found = all.find(m => m.isSender && plainText(m.text) === prior.content && timestamp(m) >= timestamp(prior));
          if (found) {
            state.chats[chat.id] = { ...prior, status: 'sent', replyId: found.id };
            await recordSentReply(home, {
              where: 'dm',
              ts: new Date(now).toISOString(),
              channelId: chat.id,
              channelName: chat.title || chat.id,
              senderName: prior.senderName || 'User',
              question: prior.question || '',
              content: prior.content,
              link: messageLink(chat, found),
              replyId: found.id
            }, { addItemImpl });
          } else {
            latest = prior; question = prior.question || ''; link = prior.link || messageLink(chat, prior);
            await decide('前回の送信結果が未確定。Discord で確認してください', 'uncertain');
          }
          continue;
        }
        if (prior?.status === 'uncertain' && (!lastSelf || compare(lastSelf, prior) <= 0)) { result.skipped++; continue; }
        if (!latest || latest.isSender) { result.skipped++; continue; }
        link = messageLink(chat, latest);
        const pending = all.filter(m => !m.isSender && (!lastSelf || compare(m, lastSelf) > 0)
          && (!prior?.timestamp || compare(m, prior) > 0));
        question = pending.map(m => `${m.senderName || ''}: ${plainText(m.text)}`).join('\n');
        if (prior?.id === latest.id || (prior?.timestamp && compare(latest, prior) <= 0)) { result.skipped++; continue; }
        if (isMessageRequest(chat)) { await decide('メッセージリクエスト・未承認'); continue; }
        if (!addressedToKim(chat, pending, all, selfIDs)) { result.skipped++; continue; }
        if (!history.complete || (chat.type === 'single' && !lastSelf)) { await decide('初対面または会話履歴を確認できません'); continue; }
        if (chat.isReadOnly || chat.participants?.items?.some(p => p.isSelf && p.cannotMessage)) { await decide('送信不可の会話'); continue; }
        if (!pending.some(m => plainText(m.text)) || pending.some(m => m.attachments?.length)) { await decide('添付資料・本文の確認が必要'); continue; }

        if (!isWithinAllowedTimeWindow(now)) { result.skipped++; continue; }

        state.hourlyByChat[chat.id] = (state.hourlyByChat[chat.id] || []).filter(t => t > now - HOUR);
        if (state.hourlyByChat[chat.id].length >= 3) { result.skipped++; continue; }

        const decision = await classifyReply(llm, {
          channelName: chat.title, context: all.slice(-25).map(m => ({ author: m.senderName, content: plainText(m.text), isSelf: m.isSender })),
          message: { content: question },
          knowledge: read(path.join(home, '.claude', 'discord-autoreply', 'knowledge.md')),
          rules: read(path.join(home, '.claude', 'discord-autoreply', 'rules.md')),
        });
        if (decision.needs_kim_decision) { await decide('kim の判断が必要'); continue; }
        if (!decision.needs_reply) { state.chats[chat.id] = { ...mark(latest), status: 'fyi' }; save(); result.skipped++; continue; }

        const content = contentFor(decision.answer);
        state.hourly = state.hourly.filter(t => t > now - HOUR);
        if (attempts >= 5 || state.hourly.length >= 30) {
          if (state.hourly.length >= 30 && !dryRun && !fs.existsSync(path.join(dir, 'PAUSE'))) {
            fs.writeFileSync(path.join(dir, 'PAUSE'), 'hourly reply limit\n', { flag: 'wx' });
          }
          result.limited = true; continue;
        }

        const current = await historyFor(api, chat), newest = current.items.at(-1);
        if (!newest || newest.id !== latest.id || newest.isSender || newest.text !== latest.text) { result.skipped++; continue; }
        const fresh = await api.getChat(chat.id);
        if (fresh.id !== chat.id || !isDiscordChat(fresh, accounts) || isMessageRequest(fresh) || fresh.isReadOnly || fresh.draft) {
          await decide('送信直前の会話条件が変わりました'); continue;
        }

        if (dryRun) { result.wouldSend.push({ chatID: chat.localChatID || chat.id, messageId: latest.id, content, link }); attempts++; continue; }
        if (fs.existsSync(path.join(dir, 'PAUSE'))) { result.paused = true; break; }

        state.chats[chat.id] = { ...mark(latest), status: 'sending', content, question, senderName: latest.senderName, link };
        const sendStarted = now;
        state.hourly.push(sendStarted);
        state.hourlyByChat[chat.id].push(sendStarted);
        attempts++; save();

        let sent;
        try { sent = await api.sendMessage(chat.id, content, { replyToMessageID: latest.id }); }
        catch { await decide('送信結果が不明。再送せず Discord で確認してください', 'uncertain'); continue; }
        if (sent?.chatID && sent.chatID !== chat.id) { await decide('送信結果の会話IDが一致しません', 'uncertain'); continue; }

        let found;
        try {
          for (let retry = 0; retry < 3; retry++) {
            const readback = await api.listMessages(chat.id, { limit: 50, direction: 'before' });
            found = readback.items?.find(m => m.isSender && !m.isDeleted && plainText(m.text) === content
              && (!m.accountID || m.accountID === DISCORD_ACCOUNT) && timestamp(m) >= sendStarted - 5000
              && !current.items.some(previous => previous.id === m.id)
              && (sent?.id ? m.id === sent.id : true));
            if (found) break;
            if (retry < 2) await (options.sleepImpl || sleep)(1000);
          }
        } catch { /* Receipt is uncertain; never resend. */ }
        if (!found) { await decide('送信後の本文読み戻しに失敗。再送せず Discord で確認してください', 'uncertain'); continue; }

        state.chats[chat.id] = { ...mark(latest), status: 'sent', replyId: found.id, content };
        await recordSentReply(home, {
          where: 'dm',
          ts: new Date(sendStarted).toISOString(),
          channelId: chat.id,
          channelName: chat.title || chat.id,
          senderName: latest.senderName || 'User',
          question,
          content,
          link: messageLink(chat, found),
          replyId: found.id
        }, { addItemImpl });
        result.replied++;
      } catch (error) {
        await decide(`読み取り・分類を確認できません: ${error.code || error.name || 'Error'}`);
        result.errors.push(`chat ${chat.localChatID || chat.id}: ${error.code || error.name || 'Error'}`);
      }
    }
    save();
  } catch (error) { result.ok = false; result.errors.push(error.message); }
  finally {
    if (release) {
      try { fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ ts: new Date(now).toISOString(), ...result }) + '\n'); }
      finally { release(); }
    }
  }
  if (result.errors.length) result.ok = false;
  return result;
}

export async function main(args = process.argv.slice(2), options = {}) {
  ensureTaskPriority();
  const command = args[0]?.startsWith('--') ? 'once' : args[0] || 'once';
  const home = options.home || os.homedir();
  const print = options.print || (v => console.log(JSON.stringify(v)));

  if (command === 'sent') {
    const sinceIndex = args.indexOf('--since');
    const since = sinceIndex >= 0 ? args[sinceIndex + 1] : undefined;
    const logs = readSentLog(home, { since });
    print({ ok: true, count: logs.length, logs });
    return 0;
  }

  if (!['once', 'loop'].includes(command)) throw new Error('Use once|loop|sent [--dry-run]');
  const deadline = Date.now() + 290000;
  do {
    const result = await runOnce({ ...options, home, dryRun: args.includes('--dry-run') });
    print(result);
    if (!result.ok) return 1;
    if (command === 'once' || result.paused || result.limited || Date.now() + 20000 >= deadline) return 0;
    await (options.sleepImpl || sleep)(20000);
  } while (Date.now() < deadline);
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main().catch(error => { console.error(error.message); return 1; });
