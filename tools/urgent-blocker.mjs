#!/usr/bin/env node
// 「人待ちで止まった急ぎの作業」を user が今使っている別セッションへ割り込み表示するための
// レジストリ（PC内の全セッションで共有）。2026-11-09 nishi の実害（LINE ログインの画像認証待ちで
// 6日停止し、user は別セッションを使っていて気付かず、社外からクレーム）の再発防止。
//
// 使い方:
//   node tools/urgent-blocker.mjs --add --session <id> --title "<何が止まっているか>" --ask "<人にしてほしい1操作・所要時間>" [--link <URL>]
//   node tools/urgent-blocker.mjs --resolve <id>
//   node tools/urgent-blocker.mjs --resolve --session <id>     # そのセッションの open を全て解決
//   node tools/urgent-blocker.mjs --answer <id> --text "<返事>"
//   node tools/urgent-blocker.mjs --reopen <id>
//   node tools/urgent-blocker.mjs --list [--open | --answered] [--json]
//   node tools/urgent-blocker.mjs --status
//   node tools/urgent-blocker.mjs --context                    # SessionStart / UserPromptSubmit の hook
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';

export const INTERRUPT_REPEAT_MS = 60 * 60 * 1000; // 同じ blocker を同じセッションへ出すのは60分に1回まで
const ID_PATTERN = /^ub-\d{14}-[a-f0-9]{4}$/;
const clean = value => String(value ?? '').replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
const stateFile = home => path.join(home, '.claude', 'urgent-blocker.json');
export const defaultHome = () => process.env.ORGIAST_HOME || os.homedir();

// 単一 JSON を全セッションから触るため、ロックで直列化する（kim-inbox と同じ wx 方式）。
function withLock(home, fn) {
  fs.mkdirSync(path.dirname(stateFile(home)), { recursive: true });
  const lock = `${stateFile(home)}.lock`;
  let fd;
  const deadline = performance.now() + 10_000;
  let delay = 10;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8'));
        if (pid > 0) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') fs.unlinkSync(lock); } }
      } catch { /* 所有者不明ならロックを奪わない */ }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(delay, remaining));
      delay = Math.min(delay * 2, 500);
    }
  }
  if (fd === undefined) throw new Error('urgent-blocker: 台帳が使用中です');
  try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

function validItem(item) {
  return item && ID_PATTERN.test(item.id) && typeof item.session === 'string' && typeof item.title === 'string'
    && typeof item.ask === 'string' && ['open', 'answered', 'resolved'].includes(item.status) && typeof item.createdAt === 'string';
}

export function readState(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(home), 'utf8').replace(/^﻿/, ''));
    return { items: Array.isArray(parsed.items) ? parsed.items.filter(validItem) : [] };
  } catch {
    // 破損・不在は空として扱い、hook を止めない（原子書き込みで破損はほぼ起きない）。
    return { items: [] };
  }
}

function writeState(home, state) {
  fs.mkdirSync(path.dirname(stateFile(home)), { recursive: true });
  const tmp = `${stateFile(home)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n', { mode: 0o600 }); fs.renameSync(tmp, stateFile(home)); }
  finally { fs.rmSync(tmp, { force: true }); }
}

export function addItem(home, { session, title, ask, link = '' }) {
  if (!String(session || '').trim()) throw new Error('--session が必要です');
  if (!String(title || '').trim()) throw new Error('--title が必要です');
  if (!String(ask || '').trim()) throw new Error('--ask が必要です');
  return withLock(home, () => {
    const state = readState(home);
    const createdAt = new Date().toISOString();
    let id;
    for (;;) {
      id = `ub-${createdAt.replace(/\D/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
      if (!state.items.some(i => i.id === id)) break;
    }
    const item = {
      id, session: clean(session), title: clean(title), ask: clean(ask),
      ...(String(link || '').trim() ? { link: clean(link) } : {}),
      status: 'open', createdAt, resolvedAt: null, shownSessions: {},
    };
    state.items.push(item);
    writeState(home, state);
    return item;
  });
}

function updateItem(home, id, update) {
  if (!ID_PATTERN.test(id)) throw new Error('ID が不正です');
  return withLock(home, () => {
    const state = readState(home);
    const item = state.items.find(i => i.id === id);
    if (!item) throw new Error('該当する blocker がありません');
    update(item);
    writeState(home, state);
    return item;
  });
}

function resolveItem(item) {
  item.status = 'resolved';
  item.resolvedAt = new Date().toISOString();
  delete item.lastShownPrompt;
}

export function resolveById(home, id) {
  return updateItem(home, id, item => {
    if (item.status !== 'resolved') resolveItem(item);
  });
}

function recordReply(item, { session, at, text }) {
  item.replies = [...(item.replies || []), { session, at, text }];
  item.status = 'answered';
  delete item.lastShownPrompt;
}

function answerById(home, id, reply, now) {
  const text = clean(reply);
  if (!text) throw new Error('--text が必要です');
  return updateItem(home, id, item => {
    if (item.status === 'resolved') throw new Error('解決済みの blocker には返事を記録できません');
    recordReply(item, { session: null, at: new Date(now()).toISOString(), text });
  });
}

function reopenById(home, id) {
  return updateItem(home, id, item => {
    if (item.status !== 'answered') throw new Error('返事済みの blocker のみ再開できます');
    item.replies?.pop();
    item.status = 'open';
    delete item.lastShownPrompt;
  });
}

export function resolveBySession(home, session) {
  if (!String(session || '').trim()) throw new Error('--session が必要です');
  return withLock(home, () => {
    const state = readState(home);
    const resolved = state.items.filter(i => i.session === session && i.status === 'open');
    for (const item of resolved) resolveItem(item);
    if (resolved.length) writeState(home, state);
    return resolved;
  });
}

export function listItems(home, { status } = {}) {
  const items = readState(home).items;
  return (status ? items.filter(i => i.status === status) : items).slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function hasOpenForSession(home, session) {
  if (!session) return false;
  return listItems(home, { status: 'open' }).some(i => i.session === session);
}

// cron 由来の自動プロンプト（先頭が【定期 や【続き・自動】など）は、人に割り込ませる相手がいないので対象外。
export function isMachinePrompt(prompt = '') {
  const text = String(prompt || '').trimStart();
  return /^(?:【定期|【続き・自動|【自動|\[(?:cron|scheduled task)\](?:\s|$)|<(?:cron-trigger|scheduled-task)(?:\s[^>]*|)>|<task-notification)/i.test(text);
}

// 割り込み対象を選ぶ（純関数）。登録元が今のセッション以外・60分以内に同じセッションへ出していない・
// cron プロンプトでないものだけ。shownSessions の更新は呼び出し側（markShown）が行う。
export function selectForInterrupt(items, { sessionId = '', now = Date.now(), prompt = '', repeatMs = INTERRUPT_REPEAT_MS } = {}) {
  if (!sessionId || isMachinePrompt(prompt)) return [];
  return items
    .filter(item => item.status === 'open' && item.session && item.session !== sessionId)
    .filter(item => {
      const shownAt = item.shownSessions?.[sessionId];
      if (!shownAt) return true;
      const at = Date.parse(shownAt);
      return !Number.isFinite(at) || now - at >= repeatMs;
    });
}

function markShown(items, sessionId, at, event) {
  for (const item of items) {
    item.shownSessions = { ...(item.shownSessions || {}), [sessionId]: at };
    if (event === 'UserPromptSubmit') item.lastShownPrompt = { session: sessionId, at };
  }
}

// hook（SessionStart / UserPromptSubmit）: 未解決の急ぎの人待ちを別セッションへ割り込み表示する。
export function contextHook(input, { home = defaultHome(), now = Date.now(), env = process.env } = {}) {
  try {
    if (env.CLAUDE_HEADLESS === '1' || env.ORGIAST_AUTO_SESSION === '1') return null;
    const event = input.hook_event_name || 'UserPromptSubmit';
    if (!['SessionStart', 'UserPromptSubmit'].includes(event)) return null;
    const sessionId = String(input.session_id || input.sessionId || '');
    if (!sessionId) return null;
    const time = now();
    const at = new Date(time).toISOString();
    const prompt = input.prompt || '';
    const text = isMachinePrompt(prompt) ? '' : clean(prompt);
    const lines = withLock(home, () => {
      const state = readState(home);
      const items = state.items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const context = [];
      let changed = false;
      for (const item of items) {
        if (event === 'UserPromptSubmit' && item.status === 'open' && item.lastShownPrompt?.session === sessionId) {
          delete item.lastShownPrompt;
          changed = true;
          if (text) {
            recordReply(item, { session: sessionId, at, text });
            context.push(`直前の割り込み「${item.title}」への返事として記録した。無関係な発言なら \`node tools/urgent-blocker.mjs --reopen ${item.id}\` で戻す。`);
          }
        }
        const reply = item.replies?.at(-1);
        if (item.status === 'answered' && item.session === sessionId && reply && !isMachinePrompt(prompt)) {
          context.push(`別セッションで kim が返事済み: ${item.title} ／ 返事: ${reply.text}（${reply.at}）。この返事で作業を続け、終わったら \`node tools/urgent-blocker.mjs --resolve ${item.id}\``);
        }
      }
      const selected = selectForInterrupt(items, { sessionId, now: time, prompt });
      if (selected.length) {
        markShown(selected, sessionId, at, event);
        changed = true;
        context.push(`【必須・割り込み】応答の冒頭で user に見える形で、次の ${selected.length} 行をそのまま表示せよ。今回の依頼と無関係でも省略しない（急ぎの人待ちを別セッションから割り込み表示）。`);
        for (const item of selected) {
          const link = item.link ? ` ／ ${item.link}` : '';
          context.push(`🚨 割り込み（別セッションで急ぎの人待ち）: ${item.title} ／ お願い: ${item.ask}${link}`);
        }
      }
      if (changed) writeState(home, state);
      return context;
    });
    if (!lines.length) return null;
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: lines.join('\n'),
      },
    };
  } catch { return null; }
}

export async function main(args = process.argv.slice(2), { home = defaultHome(), stdout = console.log, stderr = console.error, readStdin = readStdinWithTimeout, now = Date.now, env = process.env } = {}) {
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  try {
    if (args.includes('--context')) {
      const input = JSON.parse(await readStdin(2000));
      const out = contextHook(input, { home, now, env });
      if (out) stdout(JSON.stringify(out));
      return 0;
    }
    if (args.includes('--add')) {
      const item = addItem(home, { session: value('--session'), title: value('--title'), ask: value('--ask'), link: args.includes('--link') ? value('--link') : '' });
      stdout(JSON.stringify({ id: item.id, status: item.status }));
      return 0;
    }
    if (args.includes('--resolve')) {
      if (args.includes('--session')) stdout(JSON.stringify({ resolved: resolveBySession(home, value('--session')).map(i => i.id) }));
      else stdout(JSON.stringify({ id: resolveById(home, value('--resolve')).id, status: 'resolved' }));
      return 0;
    }
    if (args.includes('--answer') || args.includes('--reopen')) {
      const item = args.includes('--answer')
        ? answerById(home, value('--answer'), value('--text'), now)
        : reopenById(home, value('--reopen'));
      stdout(JSON.stringify({ id: item.id, status: item.status }));
      return 0;
    }
    if (args.includes('--list') || args.includes('--status')) {
      const status = args.includes('--open') || args.includes('--status') ? 'open'
        : args.includes('--answered') ? 'answered' : undefined;
      const items = listItems(home, { status });
      if (args.includes('--json')) stdout(JSON.stringify(items));
      else if (args.includes('--status')) stdout(`urgent-blocker: open ${items.length} 件${items.length ? `\n最古: ${items[0].id} ${items[0].title}` : ''}`);
      else stdout(items.map(i => `${i.id} ${i.status} ${i.session} ${i.title}`).join('\n') || '');
      return 0;
    }
    throw new Error('--add / --answer / --reopen / --resolve / --list / --status / --context を指定してください');
  } catch (error) {
    stderr(`urgent-blocker: ${String(error.message).replace(/[\r\n]+/g, ' ')}`);
    return args.includes('--context') ? 0 : 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
