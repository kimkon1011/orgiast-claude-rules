#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { pushKim } from './kim-push.mjs';
import { deliverKim, resolveDiscordBotToken, KIM_DISCORD_USER_ID } from './notify-kim.mjs';

const API = 'https://discord.com/api/v10';
const HOUR = 3_600_000;
const URGENT = /⚠️|🚨|警告|督促|リマインド|期限|障害|停止中|滞留|緊急|至急|要対応|判断待ち|\[判断依頼\]|承認してください|返信してください|確認してください/u;
const EMERGENCY = /🚨|緊急|至急/u;
const firstLine = text => String(text || '').split(/\r?\n/)[0];
const compareIds = (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
export const isUrgent = text => !firstLine(text).startsWith('別のパソコン') && URGENT.test(text);
function jst(time) { return new Date(new Date(time).getTime() + 9 * HOUR); }
function stamp(time) {
  const date = jst(time);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}
export function digestSlot(now) {
  const date = jst(now), hour = date.getUTCHours();
  return hour < 8 ? null : `${date.toISOString().slice(0, 10)}-${hour < 18 ? '08' : '18'}`;
}
export function urgentBody(messages, channelId) {
  const title = messages.length === 1 ? `【要対応】${firstLine(messages[0].content)}`
    : `【要対応 ${messages.length}件】${firstLine(messages[0].content)} ほか`;
  return [title.slice(0, 120), ...messages.map(m => `■ ${stamp(m.ts)}（JST）\n${m.content}\nhttps://discord.com/channels/@me/${channelId}/${m.id}`)].join('\n\n');
}
export function digestBody(pending) {
  const groups = new Map();
  for (const m of pending) {
    const group = groups.get(m.firstLine) || { count: 0, ts: m.ts };
    group.count++;
    if (Date.parse(m.ts) > Date.parse(group.ts)) group.ts = m.ts;
    groups.set(m.firstLine, group);
  }
  return [`【まとめ】前回から ${pending.length}件（同じ先頭行は件数でまとめ）`,
    ...[...groups].sort((a, b) => b[1].count - a[1].count).slice(0, 40)
      .map(([line, group]) => `・${line}（×${group.count}、最新 ${stamp(group.ts)}）`)].join('\n');
}

export async function runRelay(deps = {}) {
  const io = deps.fs || fs;
  const home = deps.home || process.env.ORGIAST_HOME || os.homedir();
  const now = typeof deps.now === 'function' ? deps.now() : (deps.now ?? Date.now());
  const dir = path.join(home, '.claude/state');
  const file = path.join(dir, 'kim-push-relay.json'), lock = path.join(dir, 'kim-push-relay.lock');
  const dryRun = deps.dryRun === true;
  let fd;
  try {
    // dry-run はロックも状態も書き換えない。
    try {
      if (now - io.statSync(lock).mtimeMs <= 15 * 60_000) return { ok: true, locked: true };
      if (!dryRun) io.unlinkSync(lock);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!dryRun) {
      io.mkdirSync(dir, { recursive: true });
      try { fd = io.openSync(lock, 'wx'); }
      catch (error) { if (error.code === 'EEXIST') return { ok: true, locked: true }; throw error; }
    }
    let state = {};
    try { state = JSON.parse(io.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    state = { channelId: null, lastMessageId: null, lastPushAt: null, failures: 0, pending: [], urgentQueue: [], pushLog: [], ...state };
    state.pushLog = state.pushLog.filter(t => now - Date.parse(t) < 24 * HOUR);
    const save = () => {
      if (dryRun) return;
      const temp = `${file}.${process.pid}.tmp`;
      io.writeFileSync(temp, JSON.stringify(state, null, 2));
      io.renameSync(temp, file);
    };
    const token = (deps.resolveDiscordBotToken || resolveDiscordBotToken)(home);
    if (!token) return { ok: false, reason: 'Discord Bot トークンがありません' };
    const request = async (route, body) => {
      const response = await (deps.fetch || globalThis.fetch)(`${API}${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Discord 取得失敗（HTTP ${response.status}）`);
      return response.json();
    };
    if (!state.channelId) {
      state.channelId = (await request('/users/@me/channels', { recipient_id: KIM_DISCORD_USER_ID })).id;
      if (!state.channelId) throw new Error('DM チャンネルを取得できません');
    }
    if (!state.lastMessageId) {
      const latest = await request(`/channels/${state.channelId}/messages?limit=1`);
      state.lastMessageId = latest[0]?.id || null;
      save();
      return { ok: true, initialized: true, bodies: [] };
    }
    // after は古い側からページを進める。100件を超える未読も同じキューへ保存する。
    let after = state.lastMessageId;
    for (;;) {
      const messages = await request(`/channels/${state.channelId}/messages?after=${after}&limit=100`);
      if (!Array.isArray(messages)) throw new Error('DM の応答形式が不正です');
      const sorted = messages.filter(m => BigInt(m.id) > BigInt(after)).sort(compareIds);
      for (const m of sorted) {
        if (m.author?.id !== KIM_DISCORD_USER_ID) {
          const content = String(m.content || '');
          const item = { id: m.id, ts: m.timestamp, content };
          if (isUrgent(content)) state.urgentQueue.push(item);
          else state.pending.push({ id: m.id, ts: m.timestamp, firstLine: firstLine(content) });
        }
        state.lastMessageId = m.id;
      }
      state.pending = state.pending.slice(-500);
      if (messages.length < 100 || !sorted.length) break;
      after = state.lastMessageId;
    }
    // 送信より先に取得位置とキューを永続化する。
    save();
    const bodies = [];
    const canPush = () => state.pushLog.filter(t => now - Date.parse(t) < HOUR).length < 12;
    const send = async body => {
      bodies.push(body);
      if (dryRun) return false;
      let result;
      try { result = await (deps.pushKim || pushKim)(body, { home }); }
      catch { result = { ok: false, reason: 'スマホ通知の実行に失敗しました' }; }
      if (result.ok) {
        state.lastPushAt = new Date(now).toISOString();
        state.pushLog.push(state.lastPushAt);
        state.failures = 0;
      } else {
        state.failures++;
        // 3回目を永続化してから代替通知する。失敗しても毎回のDM送信を避ける。
        save();
        if (state.failures === 3) {
          await (deps.deliverKim || deliverKim)(`スマホ通知の中継が3回連続で失敗: ${result.reason || '原因不明'}`, { home, silent: false });
        }
      }
      return result.ok;
    };
    const hour = jst(now).getUTCHours(), quiet = hour >= 23 || hour < 7;
    const urgent = state.urgentQueue.filter(m => !quiet || EMERGENCY.test(m.content));
    if (urgent.length && canPush()) {
      if (await send(urgentBody(urgent, state.channelId))) {
        const sent = new Set(urgent.map(m => m.id));
        state.urgentQueue = state.urgentQueue.filter(m => !sent.has(m.id));
      }
      save();
    }
    const slot = digestSlot(now);
    if (slot && slot !== state.lastDigestSlot && !quiet && state.pending.length && canPush()) {
      if (await send(digestBody(state.pending))) {
        state.pending = [];
        state.lastDigestSlot = slot;
      }
      save();
    }
    if (dryRun) (deps.log || console.log)(JSON.stringify({ bodies }, null, 2));
    return { ok: true, bodies, state };
  } catch {
    // 例外に URL や秘密値が混ざってもログに出さない。
    return { ok: false, reason: '通知中継の取得または状態保存に失敗しました' };
  } finally {
    if (fd !== undefined) { io.closeSync(fd); io.unlinkSync(lock); }
  }
}
export async function main(args = process.argv.slice(2), deps = {}) {
  if (args.some(arg => arg !== '--dry-run')) return 2;
  const result = await runRelay({ ...deps, dryRun: args.includes('--dry-run') });
  if (!result.ok) (deps.log || console.error)(result.reason);
  return result.ok ? 0 : 1;
}
if (isEntry(import.meta.url)) process.exitCode = await main();
