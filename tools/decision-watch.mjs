#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { notifyKim, resolveDiscordBotToken } from './notify-kim.mjs';
import { acquireLock, resolveFleetLabel } from './fleet-mail.mjs';

export const CHANNEL = '1508437329247862794';
const API = 'https://discord.com/api/v10';
const HOURS_48 = 48 * 60 * 60 * 1000;
const isId = id => /^\d+$/.test(String(id ?? ''));
const compare = (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
export const isDecision = message => /\[判断依頼\]|【判断依頼】|\[要返信\]/u.test(message.content || '')
  && !String(message.content).includes('[kim-PC]');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function notificationBody(message, guild) {
  const lines = String(message.content || '').split(/\r?\n/);
  const author = message.author || {};
  const footer = `\nhttps://discord.com/channels/${guild}/${CHANNEL}/${message.id}\n（kim の Discord アカウントで開く）`;
  const header = `${lines[0].slice(0, 600)}\n投稿者: ${author.global_name || author.username || author.id || '不明'}\n投稿時刻: ${message.timestamp}\n`;
  const excerpt = lines.slice(1).filter(line => /選択肢|推奨|期限|^\s*(?:[-*]\s*)?(?:[A-DＡ-Ｄ][.．、:：)）]|[①-④]|[1-4][.．、)）])/u.test(line)).join('\n');
  return `${(header + excerpt).slice(0, 1800 - footer.length)}${footer}`;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let release;
  try {
    if (argv.some(arg => !['--once', '--dry-run'].includes(arg))) throw new Error('args');
    if ((deps.label ?? resolveFleetLabel(home)) !== 'kim-PC') return 0;
    const token = deps.token ?? resolveDiscordBotToken(home);
    if (!token) { stderr('decision-watch: Discord Bot トークン未設定のため終了'); return 0; }
    const dryRun = argv.includes('--dry-run');
    const dir = path.join(home, '.claude');
    const stateFile = path.join(dir, 'decision-watch-state.json');
    if (!dryRun) {
      release = acquireLock(path.join(dir, 'decision-watch.lock'));
      if (!release) return 0;
    }
    let state = { lastMessageId: null, seen: {}, failures: {} };
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    state.failures ??= {};
    if (!state.seen || (state.lastMessageId && !isId(state.lastMessageId))) throw new Error('state');
    const save = () => { if (!dryRun) writeJson(stateFile, state); };
    const get = async endpoint => {
      const response = await fetchImpl(`${API}${endpoint}`, {
        headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error('Discord GET failed');
      return response.json();
    };
    const initial = !state.lastMessageId;
    const messages = new Map();
    for (const [id, failure] of Object.entries(state.failures)) {
      if (failure.attempts < 3) messages.set(id, failure.message);
    }
    let cursor = state.lastMessageId;
    // 50件超の新着もページを進めて取得。初回だけ直近20件に限定する。
    for (let page = 0; page < 20; page++) {
      const batch = await get(`/channels/${CHANNEL}/messages?${cursor ? `after=${cursor}&limit=50` : 'limit=20'}`);
      if (!Array.isArray(batch) || batch.some(m => !isId(m.id))) throw new Error('messages');
      batch.sort(compare);
      for (const message of batch) {
        if ((!initial || Date.parse(message.timestamp) >= now() - HOURS_48) && isDecision(message)) messages.set(message.id, message);
      }
      const next = batch.at(-1)?.id;
      if (!next || (cursor && BigInt(next) <= BigInt(cursor))) break;
      cursor = next;
      if (initial || batch.length < 50) break;
    }
    let guild;
    for (const message of [...messages.values()].sort(compare)) {
      if (state.seen[message.id] || state.failures[message.id]?.attempts >= 3) continue;
      guild ??= message.guild_id || (await get(`/channels/${CHANNEL}`)).guild_id;
      if (!isId(guild)) throw new Error('guild');
      const body = notificationBody(message, guild);
      if (dryRun) { stdout(`[dry-run] id=${message.id}\n${body}`); continue; }
      // inboxはDMに失敗しても見せる。再試行で既読状態を上書きしない。
      const id = `mail-discord-${message.id}`;
      const inboxFile = path.join(dir, 'fleet-inbox', `${id}.json`);
      if (!fs.existsSync(inboxFile)) writeJson(inboxFile, {
        id, from: 'discord:#claude-code', to: 'kim-PC', kind: 'note', body,
        why: 'Discord の判断依頼。返信は本文のDiscordリンク先で行う。',
        createdAt: message.timestamp, status: 'delivered',
      });
      let result;
      try {
        result = await (deps.notify ?? notifyKim)(body, { home, token, fetchImpl, webhookFallback: false });
      } catch { result = { delivered: 'none' }; }
      if (result?.delivered === 'dm') {
        state.seen[message.id] = new Date(now()).toISOString();
        delete state.failures[message.id];
      } else {
        const attempts = (state.failures[message.id]?.attempts || 0) + 1;
        state.failures[message.id] = { attempts, ...(attempts < 3 ? { message } : {}) };
        if (attempts === 3) stderr(`decision-watch: id=${message.id} DM失敗3回のため再試行終了`);
      }
      save(); // 成功ごとに保存し、後続の失敗で再送しない。
    }
    state.lastMessageId = cursor;
    save();
  } catch {
    // APIレスポンス・例外には秘密が含まれ得るため固定文のみ出す。
    stderr('decision-watch: 実行失敗（引数・状態ファイル・Discord接続を確認）');
  } finally { if (release) { try { release(); } catch {} } }
  return 0;
}
if (isEntry(import.meta.url)) process.exitCode = await main();
