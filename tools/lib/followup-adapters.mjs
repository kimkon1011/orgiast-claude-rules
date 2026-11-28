#!/usr/bin/env node
/**
 * followup-ledger channel adapters: beeper / gmail / discord / manual / mock.
 * FOLLOWUP_ADAPTER=mock replaces every adapter with the mock implementation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBeeperTarget, listMessages, sendMessage } from '../beeper-api.mjs';
import { matchesBeeperText } from '../beeper-send.mjs';
import { searchGmail } from '../gmail-search.mjs';
import { resolveDiscordBotToken } from '../notify-kim.mjs';
import { assertSendConsistency, afterSendCleanup } from '../send-consistency-check.mjs';
import { checkBeeperReply, assertReplyCheck } from './pre-send-reply-check.mjs';
import { writePreSendPass } from './pre-send-marker.mjs';

import { prepareTemaSend } from './unattended-tema.mjs';

const DISCORD_API = 'https://discord.com/api/v10';
const USER_AGENT = 'orgiast-followup-ledger/1.0';

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readMockFile(file = process.env.FOLLOWUP_MOCK_FILE) {
  if (!file) throw new Error('FOLLOWUP_MOCK_FILE が未設定');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return { replies: {}, fail: {}, sent: [] };
    throw error;
  }
}

function writeMockFile(data, file = process.env.FOLLOWUP_MOCK_FILE) {
  if (!file) throw new Error('FOLLOWUP_MOCK_FILE が未設定');
  atomicJson(file, data);
}

// kim-inbox の mock は子プロセスを実行せず、呼出内容だけ残す。
export function recordMockSpawn(command, args, body = '', file = process.env.FOLLOWUP_MOCK_FILE) {
  const data = readMockFile(file);
  data.spawns = [...(data.spawns || []), { command, args, body }];
  writeMockFile(data, file);
}

function chatKey(row) {
  return String(row.chatId || row.chatID || '');
}

function normalizeBeeperMessage(m) {
  return {
    id: String(m.id || m.messageID || ''),
    at: m.timestamp || m.at || m.sentAt || '',
    from: m.senderName || m.senderID || m.from || '',
    text: String(m.text || m.body || ''),
    isSelf: Boolean(m.isSender || m.isSelf),
  };
}

/** Test/dry-run clock. Wall-clock stamps make recentSelfNudge flaky when FOLLOWUP_NOW is set. */
function mockNowIso(now) {
  if (now) {
    const d = new Date(now);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const raw = process.env.FOLLOWUP_NOW;
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

export function createMockAdapter({ file = process.env.FOLLOWUP_MOCK_FILE } = {}) {
  return {
    name: 'mock',
    async fetchReplies(row, sinceIso) {
      const data = readMockFile(file);
      const key = chatKey(row);
      if (data.fail?.[key]) return { ok: false, messages: [], error: String(data.fail[key]) };
      const since = sinceIso ? Date.parse(sinceIso) : 0;
      const messages = (data.replies?.[key] || [])
        .map((m) => ({
          id: String(m.id || ''),
          at: m.at || '',
          from: m.from || '',
          text: String(m.text || ''),
          isSelf: Boolean(m.isSelf),
          authorId: m.authorId || m.from || '',
        }))
        .filter((m) => !since || !m.at || Date.parse(m.at) >= since);
      return { ok: true, messages, error: null };
    },
    async send(row, text, opts = {}) {
      const data = readMockFile(file);
      const key = chatKey(row);
      if (data.fail?.[key]) return { ok: false, messageId: null, error: String(data.fail[key]) };
      const id = `mock-${Date.now()}-${(data.sent || []).length + 1}`;
      const entry = {
        id,
        chatId: key,
        text: String(text),
        // テスト時刻に合わせる: 呼び出し側の now → FOLLOWUP_NOW → 実時計
        at: mockNowIso(opts.now),
        to: row.to || '',
        channel: row.channel || 'mock',
      };
      data.sent = [...(data.sent || []), entry];
      if (!data.replies) data.replies = {};
      if (!data.replies[key]) data.replies[key] = [];
      data.replies[key].push({
        id,
        at: entry.at,
        from: 'self',
        text: entry.text,
        isSelf: true,
        authorId: 'self',
      });
      writeMockFile(data, file);
      return { ok: true, messageId: id, error: null };
    },
    async readBack(row, text, messageId) {
      const data = readMockFile(file);
      const key = chatKey(row);
      const found = (data.sent || []).find((s) => s.id === messageId)
        || (data.replies?.[key] || []).find((m) => m.id === messageId && m.isSelf);
      if (!found) return { ok: false, error: '送信未確認' };
      if (text && found.text && !String(found.text).includes(String(text).slice(0, 40))) {
        return { ok: false, error: '送信未確認' };
      }
      return { ok: true, error: null };
    },
  };
}

export function createBeeperAdapter(deps = {}) {
  const resolve = deps.resolveBeeperTarget || resolveBeeperTarget;
  const list = deps.listMessages || listMessages;
  // beeperSend（tools/beeper-send.mjs）は --queue-id / --receipt 必須の承認キュー向けで、
  // followup-ledger の定期催促には receipt を用意できない。レート上限・送信ログ付きの
  // beeperSend をここから呼べないため、現状は sendMessage 直呼びのままにする。
  const send = deps.sendMessage || sendMessage;
  const matchText = deps.matchesBeeperText || matchesBeeperText;
  return {
    name: 'beeper',
    async fetchReplies(row, sinceIso) {
      try {
        const target = resolve({ env: process.env });
        if (!target?.token || target.via === 'none') {
          return { ok: false, messages: [], error: 'Beeper到達不可: トークン無し' };
        }
        const result = await list(chatKey(row), { limit: 50 }, { env: process.env, token: target.token });
        const since = sinceIso ? Date.parse(sinceIso) : 0;
        const messages = (result.items || result.messages || [])
          .map(normalizeBeeperMessage)
          .filter((m) => !since || !m.at || Date.parse(m.at) >= since);
        return { ok: true, messages, error: null };
      } catch (error) {
        return { ok: false, messages: [], error: `Beeper到達不可: ${String(error.message || error).slice(0, 120)}` };
      }
    },
    async send(row, text) {
      try {
        text = await prepareTemaSend(text, { home: deps.home, to: chatKey(row), source: 'followup-adapters', temaRecord: row.temaCheck, addItemImpl: deps.addItemImpl });
        const target = resolve({ env: process.env });
        if (!target?.token || target.via === 'none') {
          return { ok: false, messageId: null, error: 'Beeper到達不可: トークン無し' };
        }
        assertReplyCheck(await (deps.preSendCheck ?? checkBeeperReply)({ chatID: chatKey(row), draft: text, api: deps.beeperApi, now: deps.now, imageNotes: deps.imageNotes }));
        const input={channel:'beeper',to:chatKey(row),text,draftId:row.draftId,draftReadAt:row.draftReadAt || row.lastCheckedAt};
        const checked=await (deps.consistencyCheck ?? assertSendConsistency)(input,deps.consistencyDeps);
        (deps.writePreSendPass ?? writePreSendPass)({ chatID: chatKey(row), text, home: deps.home });
        const result = await send(chatKey(row), text, {}, { env: { ...process.env, ...(deps.home ? { ORGIAST_HOME: deps.home } : {}) }, token: target.token });
        await (deps.cleanup ?? afterSendCleanup)({...input,sentMessageId:result?.id || result?.messageID || result?.pendingMessageID,scheduledSends:checked?.input?.scheduledSends},deps.consistencyDeps);
        return { ok: true, messageId: String(result?.id || result?.messageID || ''), error: null };
      } catch (error) {
        return { ok: false, messageId: null, error: `Beeper到達不可: ${String(error.message || error).slice(0, 120)}` };
      }
    },
    async readBack(row, text, messageId) {
      try {
        const target = resolve({ env: process.env });
        if (!target?.token || target.via === 'none') return { ok: false, error: '送信未確認' };
        const result = await list(chatKey(row), { limit: 20 }, { env: process.env, token: target.token });
        const items = (result.items || result.messages || []).map(normalizeBeeperMessage);
        const hit = items.find((m) => (messageId && m.id === messageId) || (m.isSelf && matchText(m.text, text)));
        return hit ? { ok: true, error: null } : { ok: false, error: '送信未確認' };
      } catch (error) {
        return { ok: false, error: `送信未確認: ${String(error.message || error).slice(0, 80)}` };
      }
    },
  };
}

export function createGmailAdapter(deps = {}) {
  const search = deps.searchGmail || searchGmail;
  return {
    name: 'gmail',
    async fetchReplies(row, sinceIso) {
      try {
        const to = String(row.to || '').trim();
        if (!to) return { ok: false, messages: [], error: 'Gmail: 依頼先メール不明' };
        const epoch = sinceIso && Number.isFinite(Date.parse(sinceIso))
          ? Math.floor(Date.parse(sinceIso) / 1000)
          : Math.floor(Date.now() / 1000) - 86400 * 30;
        const query = `from:${to} after:${epoch}`;
        const result = await search({
          user: process.env.FOLLOWUP_GMAIL_USER || 'seisaku-team@orgiast.jp',
          query,
          max: 20,
          withBody: true,
          bodyLimit: 2000,
        });
        const messages = (result.messages || result.items || []).map((m) => ({
          id: String(m.id || ''),
          at: m.internalDate
            ? new Date(Number(m.internalDate)).toISOString()
            : (m.at || m.date || ''),
          from: m.from || to,
          text: String(m.body || m.snippet || m.subject || ''),
          isSelf: false,
        }));
        return { ok: true, messages, error: null };
      } catch (error) {
        const msg = String(error.message || error);
        const auth = /auth|401|credential|token|認証/i.test(msg);
        return { ok: false, messages: [], error: auth ? 'Gmail認証切れ' : `Gmail取得失敗: ${msg.slice(0, 120)}` };
      }
    },
    async send() {
      return { ok: false, messageId: null, error: 'gmail送信は未対応: gmail-draft.mjs を使う' };
    },
    async readBack() {
      return { ok: false, error: 'gmail送信は未対応' };
    },
  };
}

export function createDiscordAdapter(deps = {}) {
  const resolveToken = deps.resolveDiscordBotToken || resolveDiscordBotToken;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const home = () => process.env.ORGIAST_HOME || os.homedir();
  return {
    name: 'discord',
    async fetchReplies(row, sinceIso) {
      try {
        const token = resolveToken(home());
        if (!token) return { ok: false, messages: [], error: 'Discordトークン無し' };
        const channelId = chatKey(row);
        if (!channelId) return { ok: false, messages: [], error: 'Discord chatID不明' };
        const params = new URLSearchParams({ limit: '50' });
        // Discord after= needs snowflake; when sinceIso given we still fetch recent and filter by time.
        const res = await fetchImpl(`${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages?${params}`, {
          headers: { Authorization: `Bot ${token}`, 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return { ok: false, messages: [], error: `Discord取得 HTTP ${res.status}` };
        const since = sinceIso ? Date.parse(sinceIso) : 0;
        const messages = (await res.json()).map((m) => ({
          id: String(m.id || ''),
          at: m.timestamp || '',
          from: m.author?.username || m.author?.global_name || '',
          authorId: String(m.author?.id || ''),
          text: String(m.content || ''),
          isSelf: Boolean(m.author?.bot),
        })).filter((m) => !since || !m.at || Date.parse(m.at) >= since);
        return { ok: true, messages, error: null };
      } catch (error) {
        return { ok: false, messages: [], error: `Discord到達不可: ${String(error.message || error).slice(0, 120)}` };
      }
    },
    async send(row, text) {
      try {
        text = await prepareTemaSend(text, { home: deps.home, to: chatKey(row), source: 'followup-adapters', temaRecord: row.temaCheck, addItemImpl: deps.addItemImpl });
        const token = resolveToken(home());
        if (!token) return { ok: false, messageId: null, error: 'Discordトークン無し' };
        const channelId = chatKey(row);
        const input={channel:'discord',to:channelId,text:String(text).slice(0,2000),draftId:row.draftId,draftReadAt:row.draftReadAt || row.lastCheckedAt};
        const checked=await (deps.consistencyCheck ?? assertSendConsistency)(input,{home:home(),fetchImpl,...deps.consistencyDeps});
        const res = await fetchImpl(`${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify({ content: String(text).slice(0, 2000) }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return { ok: false, messageId: null, error: `Discord送信 HTTP ${res.status}` };
        const body = await res.json();
        await (deps.cleanup ?? afterSendCleanup)({...input,sentMessageId:body.id,scheduledSends:checked?.input?.scheduledSends},{home:home(),...deps.consistencyDeps});
        return { ok: true, messageId: String(body.id || ''), error: null };
      } catch (error) {
        return { ok: false, messageId: null, error: `Discord送信失敗: ${String(error.message || error).slice(0, 120)}` };
      }
    },
    async readBack(row, text, messageId) {
      try {
        const token = resolveToken(home());
        if (!token) return { ok: false, error: '送信未確認' };
        const channelId = chatKey(row);
        const res = await fetchImpl(`${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages?limit=20`, {
          headers: { Authorization: `Bot ${token}`, 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return { ok: false, error: '送信未確認' };
        const items = await res.json();
        const hit = items.find((m) => (messageId && m.id === messageId)
          || (m.author?.bot && String(m.content || '').includes(String(text).slice(0, 40))));
        return hit ? { ok: true, error: null } : { ok: false, error: '送信未確認' };
      } catch (error) {
        return { ok: false, error: `送信未確認: ${String(error.message || error).slice(0, 80)}` };
      }
    },
  };
}

export function createManualAdapter() {
  return {
    name: 'manual',
    async fetchReplies() {
      return { ok: true, messages: [], error: null };
    },
    async send() {
      return { ok: false, messageId: null, error: '手動チャネル' };
    },
    async readBack() {
      return { ok: false, error: '手動チャネル' };
    },
  };
}

export function getAdapter(channel, deps = {}) {
  if (process.env.FOLLOWUP_ADAPTER === 'mock' || deps.forceMock) {
    return createMockAdapter({ file: deps.mockFile || process.env.FOLLOWUP_MOCK_FILE });
  }
  const c = String(channel || '').toLowerCase();
  if (c === 'beeper') return createBeeperAdapter(deps);
  if (c === 'gmail') return createGmailAdapter(deps);
  if (c === 'discord') return createDiscordAdapter(deps);
  if (c === 'manual') return createManualAdapter();
  return createManualAdapter();
}

export function adaptersDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}
