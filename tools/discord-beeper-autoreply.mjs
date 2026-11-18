#!/usr/bin/env node
// Discord only. No UI Automation, read receipts, request acceptance or approval receipts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as beeper from './beeper-api.mjs';
import { isEntry } from './is-entry.mjs';
import {
  DEFAULT_MAX_REPLY_AGE, classifyReply, contentFor, createLlm, ensureTaskPriority, decisionReport, sentReport,
  isWithinAllowedTimeWindow, recordSentReply, flushUnreportedSentLogs, recordDecisionPending, readSentLog,
  retryForbiddenAnswer, FORBIDDEN_REPLY_PTN, inventedAmounts, CANT_READ_REPLY_PTN
} from './discord-autoreply.mjs';
import { addItem as addKimInboxItem } from './kim-inbox.mjs';
import { resolveDiscordLink } from './discord-beeper-link.mjs';
import { collectReadableContent } from './lib/autoreply-attachments.mjs';
import { extractSearchTerms, searchRelated } from './lib/autoreply-related.mjs';
import { LEARN_SYSTEM, learningJson, appendUnique } from './lib/autoreply-learning.mjs';
import { beeperFetch as beeperFetchFn } from './beeper-api.mjs';

export const DISCORD_ACCOUNT = 'discordgo.715210673642012733';
const HOUR = 3600000;
const LEARN_WINDOW = 72 * HOUR;
const LEARN_QUEUE_LIMIT = 500;
const AUTOREPLY_PREFIX = '【kimのClaudeによる代理回答】';
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
// 通話通知など、返信すべきでない合成メッセージ
const SYNTHETIC_PTN = /started a call|Use the Discord app to answer|不在着信|missed call/i;
export function isSyntheticMessage(m) {
  if (!m || m.isSender) return false;
  return m.type === 'TEXT' && SYNTHETIC_PTN.test(plainText(m.text || ''));
}
export function selectReplyTarget(pending) {
  return pending.filter(m => !m.isSender && !m.isDeleted && !m.isHidden
    && m.type === 'TEXT' && plainText(m.text) && !isSyntheticMessage(m)).sort(compare).at(-1);
}
export function hasSendFailure(message) {
  return Boolean(message && (message.sendError || message.failed || message.isFailed
    || message.sendFailed || /^(failed|error|send_failed)$/i.test(message.status || '')
    || /^(failed|error|send_failed)$/i.test(message.sendStatus || '')));
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
  return Boolean(chat.isMessageRequest === true || chat.isRequest === true || chat.messageRequest === true
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
async function learningHistory(api, chatId, since) {
  const messages = new Map(), cursors = new Set();
  let cursor;
  for (let page = 0; page < 20; page++) {
    const data = await api.listMessages(chatId, { limit: 50, cursor, direction: 'before' });
    if (!Array.isArray(data.items)) throw new Error('Beeper message response invalid');
    const items = data.items.filter(m => !m.accountID || m.accountID === DISCORD_ACCOUNT);
    for (const m of items) messages.set(m.id, m);
    const covered = validMessages(items).some(m => timestamp(m) <= since);
    if (covered || !data.hasMore) return { messages, covered, complete: true };
    if (!data.oldestCursor || cursors.has(data.oldestCursor)) break;
    cursor = data.oldestCursor;
    cursors.add(cursor);
  }
  return { messages, covered: false, complete: false };
}

function loadState(file) {
  const stored = read(file);
  const state = stored ? JSON.parse(stored) : { version: 1, chats: {}, hourly: [], hourlyByChat: {} };
  state.learnQueue ??= [];
  if (state.version !== 1 || !state.chats || Array.isArray(state.chats)
    || !Array.isArray(state.hourly) || !Array.isArray(state.learnQueue)) throw new Error('state.json invalid');
  state.hourlyByChat ??= {};
  return state;
}

function enqueueLearning(state, { channelId, replyId, question, content, ts, senderName }) {
  if (state.learnQueue.some(entry => entry.replyId === replyId)) return;
  state.learnQueue.push({ chatId: channelId, replyId, question, answer: content, ts, senderName,
    evaluatedKimIds: [], learned: false });
  state.learnQueue.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  state.learnQueue.splice(0, Math.max(0, state.learnQueue.length - LEARN_QUEUE_LIMIT));
}

function acquire(dir) {
  const file = path.join(dir, 'lock');
  const pid = process.pid;
  const host = os.hostname();
  const ts = Date.now();
  const owner = JSON.stringify({ pid, host, ts, token: crypto.randomUUID() });
  let holder = null;

  try {
    fs.writeFileSync(file, owner, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let stale = false;
    let h = { pid: 'unknown', host: 'unknown', ts: null };
    try {
      const stat = fs.statSync(file);
      const raw = fs.readFileSync(file, 'utf8');
      let existing;
      try { existing = JSON.parse(raw); h = existing; } catch { /* corrupted JSON */ }
      if (existing && existing.host === host && Number.isInteger(existing.pid) && existing.pid > 0) {
        try { process.kill(existing.pid, 0); } catch (e2) { if (e2.code === 'ESRCH') stale = true; }
      }
      if (!stale && Date.now() - stat.mtimeMs > 15 * 60000) stale = true;
      if (!stale) {
        holder = { pid: h?.pid ?? 'unknown', host: h?.host ?? 'unknown', ts: h?.ts ?? null, ageSec: Math.round((Date.now() - stat.mtimeMs) / 1000) };
        return { release: null, holder };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { release: null, holder: { pid: 'unknown', host: 'unknown', ageSec: 0 } };
    }
    // Steal: unlink and retry wx
    try { fs.unlinkSync(file); } catch { return { release: null, holder: holder || { pid: 'race', host: 'race', ageSec: 0 } }; }
    try { fs.writeFileSync(file, owner, { flag: 'wx' }); }
    catch (e2) { if (e2.code === 'EEXIST') return { release: null, holder: { pid: 'race', host: 'race', ageSec: 0 } }; throw e2; }
  }

  const heartbeat = setInterval(() => {
    try {
      const content = fs.readFileSync(file, 'utf8');
      if (content === owner) { const d = new Date(); fs.utimesSync(file, d, d); }
    } catch { /* lock stolen or gone */ }
  }, 30000);
  heartbeat.unref();

  return {
    release: () => {
      clearInterval(heartbeat);
      try { if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); } catch { /* already gone */ }
    },
    holder: null,
  };
}
export async function runOnce(options = {}) {
  const home = options.home || os.homedir(), dryRun = Boolean(options.dryRun), api = options.api || beeper;
  const now = options.now ? (typeof options.now === 'function' ? options.now() : options.now) : Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_REPLY_AGE;
  const dir = path.join(home, '.claude', 'discord-beeper-autoreply');
  const stateFile = path.join(dir, 'state.json');
  const result = { ok: true, dryRun, scanned: 0, replied: 0, decisions: [], wouldSend: [], skipped: 0, errors: [] };
  let release, state;
  const save = () => { if (!dryRun) atomic(stateFile, state); };
  const addItemImpl = options.addItemImpl || addKimInboxItem;

  try {
    if (!dryRun) {
      fs.mkdirSync(dir, { recursive: true });
      const acq = acquire(dir);
      if (acq.holder) {
        result.locked = true;
        result.holder = acq.holder;
      } else {
        release = acq.release;
        fs.rmSync(path.join(dir, 'locked-stuck.json'), { force: true });
        await flushUnreportedSentLogs(home, { addItemImpl });
      }
    }
    if (result.locked) {
      // Track continuous locked duration — notify kim-inbox after 30min.
      const stuckFile = path.join(dir, 'locked-stuck.json');
      try {
        const stuckRaw = read(stuckFile);
        const stuck = stuckRaw ? JSON.parse(stuckRaw) : null;
        const stuckMs = stuck ? now - new Date(stuck.firstLockedAt).getTime() : 0;
        if (!stuck || !Number.isFinite(stuckMs) || stuckMs < 0) {
          atomic(stuckFile, { firstLockedAt: new Date(now).toISOString(), notified: false });
        } else if (stuckMs > 30 * 60000 && !stuck.notified) {
          await addItemImpl(home, {
            kind: 'info',
            text: `Beeper autoreply lock が ${result.holder.ageSec || '?'} 秒間取得できません（連続 ${Math.round(stuckMs / 60000)} 分）: holder=${JSON.stringify(result.holder)}。acquire の自動奪取条件（同一 host で pid 不在 または mtime 15分超）を待機中。`,
            source: 'discord-beeper-autoreply',
            dedupeKey: `beeper-autoreply-stuck-lock:${stuck.firstLockedAt}`,
          });
          atomic(stuckFile, { firstLockedAt: stuck.firstLockedAt, notified: true });
        }
      } catch { /* best-effort */ }
      return result;
    }
    const pauseReason = read(path.join(dir, 'PAUSE'));
    if (fs.existsSync(path.join(dir, 'PAUSE'))) {
      result.paused = true;
      if (pauseReason.trim() !== 'hourly reply limit') return result;
    }
    state = loadState(stateFile);
    const finishSend = async (chat, found, entry) => {
      const { question = '', content, senderName } = entry;
      const sent = {
        where: 'dm', ts: found.timestamp, channelId: chat.id, channelName: chat.title || chat.id,
        senderName: senderName || 'User', question, content, link: messageLink(chat, found), replyId: found.id
      };
      state.chats[chat.id] = { ...entry, status: 'sent', replyId: found.id };
      enqueueLearning(state, sent);
      save();
      await recordSentReply(home, sent, { addItemImpl });
    };

    const accounts = await api.getAccounts();
    if (!Array.isArray(accounts)) throw new Error('Beeper account response invalid');
    if (!accounts.some(a => a.accountID === DISCORD_ACCOUNT && a.network?.toLowerCase() === 'discord')) throw new Error('kim Discord account unavailable');
    const selfIDs = new Set(accounts.filter(a => a.user?.isSelf).map(a => a.user.id));
    const chats = (await chatsFor(api)).filter(c => isDiscordChat(c, accounts));
    const llm = options.llm || createLlm({ home, fetchImpl: options.fetchImpl || fetch });
    let attempts = 0;

    for (const chat of result.paused ? [] : chats) {
      result.scanned++;
      let latest, question = '', link = `会話名: ${chat.title || chat.id}`;
      const prior = state.chats[chat.id];
      if (prior?.status !== 'sending' && (chat.preview?.isSender
        || (prior?.status !== 'skipped' && prior?.id && chat.preview?.id === prior.id))) { result.skipped++; continue; }
      
      const decide = async (reason, status = 'decision') => {
        const row = { chatID: chat.localChatID || chat.id, chat: chat.title, messageId: latest?.id || null, reason, link, classification: '判断待ち' };
        result.decisions.push(row);
        state.chats[chat.id] = { ...(latest ? mark(latest) : prior), status, reason };
        if (dryRun || (!latest && prior?.status === status && prior?.reason === reason)) return;
        await recordDecisionPending(home, {
          where: 'dm',
          senderName: latest?.senderName || chat.title || 'User',
          channelName: chat.title || chat.id,
          channelId: chat.id,
          messageId: latest?.id,
          question: `${question || ''}\n判断理由: ${reason}`,
          link
        }, { addItemImpl });
      };

      try {
        if (prior?.status !== 'sending' && isMessageRequest(chat) && chat.preview?.isSender === false
          && chat.preview.id && Number.isFinite(timestamp(chat.preview))) {
          latest = chat.preview; question = plainText(latest.text); link = messageLink(chat, latest);
          if (now - timestamp(latest) > maxAgeMs || timestamp(latest) > now) { result.skipped++; continue; }
          if (prior?.status !== 'skipped' && (prior?.id === latest.id || (prior?.timestamp && compare(latest, prior) <= 0))) { result.skipped++; continue; }
          await decide('メッセージリクエスト・未承認'); continue;
        }
        const history = await historyFor(api, chat), all = history.items;
        latest = all.at(-1);
        const lastSelf = all.findLast(m => m.isSender);
        if (prior?.status === 'sending') {
          const found = all.find(m => m.isSender && plainText(m.text) === prior.content && timestamp(m) >= timestamp(prior));
          if (found && !hasSendFailure(found)) {
            if (!dryRun) await finishSend(chat, found, prior);
          } else {
            latest = prior; question = prior.question || ''; link = prior.link || messageLink(chat, prior);
            await decide('前回の送信結果が未確定。Discord で確認してください', 'uncertain');
          }
          continue;
        }
        if (prior?.status === 'uncertain' && (!lastSelf || compare(lastSelf, prior) <= 0)) { result.skipped++; continue; }
        if (!latest || latest.isSender) { result.skipped++; continue; }
        if (now - timestamp(latest) > maxAgeMs || timestamp(latest) > now) {
          result.skipped++; continue;
        }
        link = messageLink(chat, latest);
        const pending = all.filter(m => !m.isSender && !isSyntheticMessage(m) && (!lastSelf || compare(m, lastSelf) > 0)
          && (!prior?.timestamp || prior.status === 'skipped' || compare(m, prior) > 0));
        question = pending.map(m => {
          let text = `${m.senderName || ''}: ${plainText(m.text)}`;
          if (m.attachments?.length) {
            const names = m.attachments.map(a => a.fileName || a.name || a.mimeType || 'ファイル').join(', ');
            text += `\n（画像/ファイル添付あり: ${names}）`;
          }
          return text;
        }).join('\n');
        // 返信すべき本物メッセージがない（合成メッセージのみなど）場合はスキップ
        if (pending.length === 0) { result.skipped++; continue; }
        if (prior?.status !== 'skipped' && (prior?.id === latest.id || (prior?.timestamp && compare(latest, prior) <= 0))) { result.skipped++; continue; }
        if (isMessageRequest(chat)) { await decide('メッセージリクエスト・未承認'); continue; }
        if (!addressedToKim(chat, pending, all, selfIDs)) { result.skipped++; continue; }
        if (history.complete && chat.type === 'single' && !lastSelf) { await decide('初対面または会話履歴を確認できません'); continue; }
        if (chat.isReadOnly || chat.participants?.items?.some(p => p.isSelf && p.cannotMessage)) { await decide('送信不可の会話'); continue; }

        if (!isWithinAllowedTimeWindow(now)) { result.skipped++; continue; }

        state.hourlyByChat[chat.id] = (state.hourlyByChat[chat.id] || []).filter(t => t > now - HOUR);
        if (state.hourlyByChat[chat.id].length >= 3) { result.skipped++; continue; }

        const targetIds = new Set(pending.map(m => m.id));
        if (latest && !latest.isSender) targetIds.add(latest.id);
        const collected = await collectReadableContent({
          messages: [...new Map([latest, ...pending, ...all.slice(-25)].map(m => [m.id, m])).values()],
          downloadAttachment: a => (api.downloadAttachment || beeper.downloadAttachment)(a, { fetchImpl: options.fetchImpl || fetch }),
          fetchImpl: options.fetchImpl, readGoogleUrl: options.readGoogleUrl, home,
          targetIds,
        });
        if (collected.failures.length) {
          await decide(`添付取得失敗: ${collected.failures.map(f => `${f.name}: ${f.reason}`).join('; ')}`);
          continue;
        }
        // Search related conversations for context
        const docTexts = collected.documents.map(d => d.text);
        const related = await searchRelated({
          terms: await extractSearchTerms(question, docTexts, llm),
          question,
          llm,
          beeperFetch: options.beeperFetch || ((endpoint, init) => beeperFetchFn(endpoint, { ...init, fetchImpl: options.fetchImpl, timeoutMs: 5000 })),
          excludeMessageIds: new Set(pending.map(m => m.id)),
          sinceDays: 180, maxItems: 10, maxBytes: 10000,
          excludeChatIds: chat.id,
        }).catch(() => []);
        // Read corrections from server version's file for DM reply input
        const correctionsFile = path.join(home, '.claude', 'discord-autoreply', 'corrections.jsonl');
        const readCorrections = () => {
          try {
            return read(correctionsFile).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
          } catch { return []; }
        };
        const classifyInput = {
          channelName: chat.title, context: all.filter(m => !isSyntheticMessage(m)).slice(-25).map(m => ({ author: m.senderName, content: plainText(m.text), isSelf: m.isSender })),
          message: { content: question },
          knowledge: read(path.join(home, '.claude', 'discord-autoreply', 'knowledge.md')),
          rules: read(path.join(home, '.claude', 'discord-autoreply', 'rules.md')),
          corrections: readCorrections().filter(row => row.outcome !== 'expired').slice(-30),
          ...(related.length ? { related } : {}),
          ...(collected.images.length ? { images: collected.images } : {}),
          ...(collected.documents.length ? { documents: collected.documents } : {}),
        };
        let decision = await classifyReply(llm, classifyInput);
        // 「読めない」系の誤回答ガード
        if (decision.answer?.trim() && CANT_READ_REPLY_PTN.test(decision.answer)) {
          await decide('添付の中身を読まない回答のため kim の確認が必要');
          continue;
        }
        // 禁止表現（代表への確認を約束する文/転送/確認待ち等）が含まれていたら1回だけ再生成
        if (decision.answer?.trim() && FORBIDDEN_REPLY_PTN.test(decision.answer)) {
          const origNeedsKim = decision.needs_kim_decision;
          const retry = await retryForbiddenAnswer(llm, decision, classifyInput);
          if (retry) {
            decision = retry;
            decision.needs_kim_decision = origNeedsKim || decision.needs_kim_decision;
            decision.needs_reply = true;
          } else {
            decision.answer = ''; // 2回目も禁止→判断待ちのみへ
          }
        }
        // 禁止表現再生成失敗で空本文なら送らず kim-inbox ask へ回す
        if (!decision.answer?.trim()) {
          decision.needs_kim_decision = true;
        }
        // 会話に無い金額を含む回答は送信しない
        if (decision.answer?.trim()) {
          const sourceText = [
            classifyInput.message?.content || '',
            ...(classifyInput.context || []).map(x => x.content || ''),
            classifyInput.knowledge || '',
            classifyInput.rules || '',
            ...collected.documents.map(d => d.text),
            ...(classifyInput.related || []).map(r => `[${r.chat}] ${r.sender}: ${r.text}`),
          ].join('\n');
          const invented = inventedAmounts(decision.answer, sourceText);
          if (invented.length > 0) {
            await decide('会話に無い金額を含むため kim の判断が必要');
            continue;
          }
        }
        if (decision.needs_kim_decision) {
          const kimAnswer = decision.answer?.trim();
          if (kimAnswer) {
            decision.answer = kimAnswer + '\n\n（kim 本人が確認後、訂正する場合があります）';
            const row = { chatID: chat.localChatID || chat.id, chat: chat.title, messageId: latest?.id || null, reason: 'kim の判断が必要（暫定回答あり）', link, classification: '判断待ち' };
            result.decisions.push(row);
            if (!dryRun) await recordDecisionPending(home, {
              where: 'dm', senderName: latest?.senderName || chat.title || 'User',
              channelName: chat.title || chat.id, channelId: chat.id,
              messageId: latest?.id, question, link,
            }, { addItemImpl });
          } else {
            await decide('kim の判断が必要'); continue;
          }
        }
        if (!decision.needs_reply) { state.chats[chat.id] = { ...mark(latest), status: 'fyi' }; save(); result.skipped++; continue; }

        // 空本文ガード（念のため）
        if (!decision.answer?.trim()) {
          await decide('kim の判断が必要');
          continue;
        }

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
        // 返信先は pending の最新（本物メッセージ）、合成メッセージは避ける
        const replyTarget = selectReplyTarget(pending);
        try { sent = await api.sendMessage(chat.id, content, replyTarget ? { replyToMessageID: replyTarget.id } : {}); }
        catch { await decide('送信結果が不明。再送せず Discord で確認してください', 'uncertain'); continue; }
        if (sent?.chatID && sent.chatID !== chat.id) { await decide('送信結果の会話IDが一致しません', 'uncertain'); continue; }

        if (hasSendFailure(sent)) { await decide('送信失敗の印を検出。再送せず Discord で確認してください', 'uncertain'); continue; }

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

        if (hasSendFailure(found)) { await decide('送信失敗の印を検出。再送せず Discord で確認してください', 'uncertain'); continue; }

        await finishSend(chat, found, { ...mark(latest), content, question, senderName: latest.senderName });
        result.replied++;
      } catch (error) {
        await decide(`読み取り・分類を確認できません: ${error.code || error.name || 'Error'}`);
        result.errors.push(`chat ${chat.localChatID || chat.id}: ${error.code || error.name || 'Error'}`);
      }
    }

    if (dryRun) return { ...result, ok: result.errors.length === 0 };

    // Keep deletion detection independent of follow-up classification.
    const correctionsFile = path.join(home, '.claude', 'discord-autoreply', 'corrections.jsonl');
    const recorded = correctionIds(correctionsFile);
    const recordCorrection = row => {
      if (recorded.has(row.msgId)) return;
      fs.mkdirSync(path.dirname(correctionsFile), { recursive: true });
      fs.appendFileSync(correctionsFile, JSON.stringify(row) + '\n');
      recorded.add(row.msgId);
    };
    const DELETION_LEARN_DAYS = 7;
    const DELETION_LEARN_HOURS = 24;

    for (const [chatId, entry] of Object.entries(state.chats)) {
      if (entry.status !== 'sent' || !entry.replyId || entry.learnedDeletion) continue;
      const entryTs = Date.parse(entry.timestamp);
      if (!Number.isFinite(entryTs) || now - entryTs > DELETION_LEARN_DAYS * 86400000) {
        entry.learnedDeletion = true;
        continue;
      }
      try {
        const { messages, covered: historyCovered } = await learningHistory(api, chatId, entryTs);
        const all = validMessages([...messages.values()]);
        const autoReplyMsg = messages.get(entry.replyId);
        // Deleted if: (a) isDeleted flag is set, or (b) history covers the
        // timestamp but the message is not found.
        const isDeleted = autoReplyMsg
          ? autoReplyMsg.isDeleted === true
          : historyCovered;
        if (!isDeleted) {
          // Not deleted — skip learning (or history didn't cover the timestamp)
          if (historyCovered) entry.learnedDeletion = true;
          continue;
        }
        // Auto-reply was deleted. Find kim's first non-auto-reply message
        // sent after the auto-reply (deletion time unavailable, so use
        // auto-reply's send time as lower bound), within 24h.
        const kimCorrection = all.find(m =>
          m.isSender
          && !plainText(m.text).startsWith(AUTOREPLY_PREFIX)
          && timestamp(m) > entryTs
          && timestamp(m) - entryTs <= DELETION_LEARN_HOURS * 3600000
        );
        if (!kimCorrection) {
          // No correction found yet — keep checking on next run
          continue;
        }
        // Save to corrections.jsonl
        recordCorrection({
          msgId: entry.replyId,
          chatId,
          question: entry.question || '',
          autoAnswer: entry.content || '',
          kimAnswer: plainText(kimCorrection.text),
          outcome: 'deleted_and_corrected',
          confirmed: true,
          ts: new Date(now).toISOString(),
          where: 'dm',
        });
        entry.learnedDeletion = true;
        result.learned ??= { corrected: 0, confirmed: 0, expired: 0, deletedAndCorrected: 0 };
        result.learned.deletedAndCorrected = (result.learned.deletedAndCorrected || 0) + 1;
        // Notify kim-inbox
        if (!dryRun) {
          await addItemImpl(home, {
            kind: 'info',
            source: 'discord-beeper-autoreply',
            text: `自動返信の訂正を学習: ${entry.senderName || chatId}`,
            dedupeKey: `deletion-learn:${entry.replyId}`,
          });
        }
      } catch {
        // Learning failure must not stop the reply cycle
        continue;
      }
    }
    const oldestByChat = new Map(), histories = new Map();
    for (const entry of state.learnQueue) {
      const ts = Date.parse(entry.ts);
      if (entry.learned || recorded.has(entry.replyId) || now - ts >= LEARN_WINDOW) continue;
      oldestByChat.set(entry.chatId, Math.min(ts, oldestByChat.get(entry.chatId) ?? Infinity));
    }

    for (const entry of state.learnQueue) {
      if (entry.learned) continue;
      if (recorded.has(entry.replyId)) {
        entry.learned = true;
        continue;
      }
      const row = {
        ts: new Date(now).toISOString(), where: 'dm', chatId: entry.chatId, msgId: entry.replyId,
        question: entry.question, autoAnswer: entry.answer, kimAnswer: null, rule: null
      };
      const sentAt = Date.parse(entry.ts);
      try {
        let outcome = 'expired';
        if (now - sentAt < LEARN_WINDOW) {
          if (!histories.has(entry.chatId)) {
            histories.set(entry.chatId, await learningHistory(api, entry.chatId, oldestByChat.get(entry.chatId)));
          }
          const { messages, complete } = histories.get(entry.chatId);
          if (!complete) continue;
          outcome = null;
          const evaluated = new Set(entry.evaluatedKimIds);
          for (const kim of validMessages([...messages.values()])) {
            if (!kim.isSender || timestamp(kim) <= sentAt || timestamp(kim) > now || evaluated.has(kim.id)) continue;
            const kimAnswer = plainText(kim.text);
            if (!kimAnswer || kimAnswer.startsWith(AUTOREPLY_PREFIX) || hasSendFailure(kim)) continue;
            const learned = learningJson(await llm({ category: 'classification', system: LEARN_SYSTEM,
              input: { question: entry.question, autoAnswer: entry.answer, kimAnswer } }));
            if (!learned.is_correction && !learned.is_confirmation) {
              entry.evaluatedKimIds.push(kim.id);
              continue;
            }
            row.kimAnswer = kimAnswer;
            if (learned.is_correction) {
              const dir = path.dirname(correctionsFile);
              fs.mkdirSync(dir, { recursive: true });
              appendUnique(path.join(dir, 'rules.md'), learned.rule);
              appendUnique(path.join(dir, 'knowledge.md'), learned.fact);
              await addItemImpl(home, {
                kind: 'info', source: 'discord-beeper-autoreply',
                text: `自動返信の訂正を学習: ${entry.senderName || entry.chatId}`,
                dedupeKey: `dm-learn:${entry.replyId}`
              });
              row.rule = learned.rule;
            }
            outcome = learned.is_correction ? 'corrected' : 'confirmed';
            break;
          }
        }
        if (!outcome) continue;
        recordCorrection({ ...row, outcome });
        entry.learned = true;
        result.learned ??= { corrected: 0, confirmed: 0, expired: 0, deletedAndCorrected: 0 };
        result.learned[outcome]++;
      } catch (error) {
        result.errors.push(`dm learning ${entry.replyId}: ${error.code || error.name || 'Error'}`);
      }
    }
    save();
  } catch (error) { result.ok = false; result.errors.push(error.message); }
  finally {
    if (release || result.locked) {
      try { fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ ts: new Date(now).toISOString(), ...result }) + '\n'); }
      finally { release?.(); }
    }
  }
  if (result.errors.length) result.ok = false;
  return result;
}

function correctionIds(file) {
  const ids = new Set();
  for (const line of read(file).split(/\r?\n/).filter(Boolean)) {
    try { ids.add(JSON.parse(line).msgId); } catch { /* Ignore malformed rows. */ }
  }
  return ids;
}

async function learnBackfill(home, args, options) {
  const daysIndex = args.indexOf('--days');
  const days = Number(args[daysIndex + 1]);
  if (daysIndex < 0 || !Number.isSafeInteger(days) || days < 1) throw new Error('--days must be a positive integer');
  const dryRun = args.includes('--dry-run');
  const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
  const since = now - days * 24 * HOUR;
  const dir = path.join(home, '.claude', 'discord-beeper-autoreply');
  const file = path.join(dir, 'state.json');
  let release;
  if (!dryRun) {
    fs.mkdirSync(dir, { recursive: true });
    const lock = acquire(dir);
    if (!lock.release) return { ok: false, locked: true, holder: lock.holder };
    release = lock.release;
  }
  try {
    const state = loadState(file);
    const recorded = correctionIds(path.join(home, '.claude', 'discord-autoreply', 'corrections.jsonl'));
    const initialIds = new Set(state.learnQueue.map(entry => entry.replyId));
    const api = options.api || beeper;
    const histories = new Map();
    const logs = readSentLog(home).filter(row => row.where === 'dm' && row.channelId
      && Date.parse(row.ts) >= since && Date.parse(row.ts) <= now);
    const resolvedIds = new Set(logs.map(row => row.replyId).filter(Boolean));
    // Resolve repeated answer text against newer log rows first.
    logs.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    for (const row of logs) {
      let { replyId, ts } = row;
      if (!replyId && row.content) {
        if (!histories.has(row.channelId)) {
          const { messages } = await learningHistory(api, row.channelId, since);
          histories.set(row.channelId, validMessages([...messages.values()]));
        }
        const logTime = Date.parse(ts);
        const found = histories.get(row.channelId)
          .filter(m => m.isSender && !hasSendFailure(m) && !resolvedIds.has(m.id) && plainText(m.text) === plainText(row.content))
          .sort((a, b) => Math.abs(timestamp(a) - logTime) - Math.abs(timestamp(b) - logTime))[0];
        if (!found) continue;
        replyId = found.id;
        ts = found.timestamp;
        resolvedIds.add(replyId);
      }
      if (!replyId || recorded.has(replyId)) continue;
      enqueueLearning(state, { ...row, ts, replyId });
    }
    const count = state.learnQueue.filter(entry => !initialIds.has(entry.replyId)).length;
    if (!dryRun && count) atomic(file, state);
    return { ok: true, dryRun, count };
  } finally { release?.(); }
}

export async function main(args = process.argv.slice(2), options = {}) {
  ensureTaskPriority();
  const command = args[0]?.startsWith('--') ? 'once' : args[0] || 'once';
  const home = options.home || os.homedir();
  const print = options.print || (v => console.log(JSON.stringify(v)));

  if (command === 'learn-backfill') {
    const result = await learnBackfill(home, args, options);
    print(result);
    return result.ok ? 0 : 1;
  }

  if (command === 'sent') {
    const sinceIndex = args.indexOf('--since');
    const since = sinceIndex >= 0 ? args[sinceIndex + 1] : undefined;
    const logs = readSentLog(home, { since });
    print({ ok: true, count: logs.length, logs });
    return 0;
  }

  if (!['once', 'loop'].includes(command)) throw new Error('Use once|loop|sent|learn-backfill --days N [--dry-run]');
  const maxAgeHoursIndex = args.indexOf('--max-age-hours');
  let maxAgeMs;
  if (maxAgeHoursIndex >= 0) {
    const n = Number(args[maxAgeHoursIndex + 1]);
    if (!Number.isInteger(n) || n < 1 || n > 168) throw new Error('--max-age-hours must be an integer between 1 and 168');
    maxAgeMs = n * HOUR;
  }
  const deadline = Date.now() + 290000;
  do {
    const result = await runOnce({ ...options, home, dryRun: args.includes('--dry-run'), maxAgeMs });
    print(result);
    if (!result.ok) return 1;
    if (command === 'once' || result.paused || result.limited || Date.now() + 20000 >= deadline) return 0;
    await (options.sleepImpl || sleep)(20000);
  } while (Date.now() < deadline);
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main().catch(error => { console.error(error.message); return 1; });
