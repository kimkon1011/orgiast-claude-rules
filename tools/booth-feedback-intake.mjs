#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseEnvText } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';
import { decideRun, firstBlockBounds, sectionFrom } from './auto-session.mjs';
import { runTaskLedger } from './task-ledger.mjs';

const MARKER = '<!-- NEXT-SESSION v1 -->';

export function readLedger(text) {
  try {
    const parsed = JSON.parse(String(text));
    if (parsed?.version === 1 && parsed.items && typeof parsed.items === 'object' && !Array.isArray(parsed.items)) return parsed;
  } catch {}
  return { version: 1, items: {} };
}

function oneLine(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return typeof limit === 'number' ? text.slice(0, limit) : text;
}

export function formatTodo(item, sheetUrl, number) {
  const key = oneLine(item.key);
  const title = oneLine(item.title) || '無題';
  const body = oneLine(item.body, 100);
  const detail = body ? `${body}。` : '';
  const lane = feedbackLane(item.kind);
  const marker = lane === 'immediate' ? '【即実行・不具合】' : lane === 'tonight' ? '【当日夜に実行・要望】' : '【種別不明】';
  const hold = lane === 'hold' ? '**着手可否は kim 判断待ち**。' : '';
  return `${number}. **[FB:${key}] ${marker} ${title}**（ブース制作アプリ 不具合要望 / ${oneLine(item.ts) || '日時不明'} / ${oneLine(item.source) || '取得元不明'}）— ${detail}${hold}シート: ${oneLine(sheetUrl)}`;
}

export function feedbackLane(kind) {
  const value = oneLine(kind);
  return value === '不具合' ? 'immediate' : value === '要望' ? 'tonight' : 'hold';
}

export function immediateThrottleReason(launches, now = new Date()) {
  const current = now.getTime();
  const times = (Array.isArray(launches) ? launches : []).map((entry) => Date.parse(entry?.at)).filter(Number.isFinite);
  if (times.filter((at) => current - at >= 0 && current - at < 60 * 60 * 1000).length >= 2) return 'hourly-limit';
  if (times.filter((at) => current - at >= 0 && current - at < 24 * 60 * 60 * 1000).length >= 6) return 'daily-limit';
  return '';
}

function todoSectionRange(block) {
  const section = sectionFrom(block, '残TODO');
  if (!section) return null;
  const start = block.indexOf(section);
  return { start, end: start + section.length, section };
}

export function injectFeedbackTodos(md, items, sheetUrl) {
  const source = String(md ?? '');
  const fresh = items.filter((item) => item?.key && !source.includes(`[FB:${item.key}]`));
  if (!fresh.length) return { text: source, injected: [] };
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const bounds = firstBlockBounds(source);
  const block = source.slice(bounds.start, bounds.end);
  const range = todoSectionRange(block);
  if (range) {
    const sectionLines = range.section.split(/\r?\n/);
    const heading = sectionLines.shift();
    const lines = fresh.map((item, index) => formatTodo(item, sheetUrl, index + 1)).join(newline);
    let existingNumber = fresh.length;
    const existing = sectionLines.map((line) => line.replace(/^(\s*)\d+([.)、]\s+)/, (_, indent, suffix) => `${indent}${++existingNumber}${suffix}`)).join(newline);
    const changedSection = `${heading}${newline}${lines}${existing ? `${newline}${existing}` : ''}`;
    const changedBlock = block.slice(0, range.start) + changedSection + block.slice(range.end);
    return { text: source.slice(0, bounds.start) + changedBlock + source.slice(bounds.end), injected: fresh };
  }
  const lines = fresh.map((item, index) => formatTodo(item, sheetUrl, index + 1)).join(newline);
  const addition = `## 残TODO（自動取込）${newline}${lines}`;
  const separator = block && !block.endsWith('\n') && !block.endsWith('\r') ? newline + newline : block.endsWith(newline + newline) ? '' : newline;
  const changedBlock = block + separator + addition + (bounds.end < source.length ? newline : '');
  return { text: source.slice(0, bounds.start) + changedBlock + source.slice(bounds.end), injected: fresh };
}

export async function fetchJson(url, options = {}, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'follow', signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`JSONでない応答: ${oneLine(text, 200)}`); }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

function defaultIo() {
  return {
    read: (file) => fs.readFileSync(file, 'utf8'),
    write: (file, text) => fs.writeFileSync(file, text, 'utf8'),
    now: () => new Date(),
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
    append: (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, text, 'utf8'); },
    exists: (file) => fs.existsSync(file),
    pidAlive: (pid) => { try { process.kill(Number(pid), 0); return Number(pid) > 0; } catch { return false; } },
    spawn: (...args) => spawn(...args),
    notify: async (url, content) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try { await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }), signal: controller.signal }); } finally { clearTimeout(timer); }
    },
  };
}

function readOptionalEnv(io, file) {
  try { return parseEnvText(io.read(file)); } catch { return {}; }
}

// 不具合通知の宛先は「不具合要望向けと明示された webhook」だけに限る。
// /WEBHOOK/i の総当たりにすると、コスト警告など無関係な channel へ不具合報告を投げてしまう
// (webhook は宛先 channel を内包するので、名前を取り違えると誤爆が外に出る)。
const FEEDBACK_WEBHOOK_KEYS = ['BOOTH_FEEDBACK_WEBHOOK', 'DISCORD_FEEDBACK_WEBHOOK', 'FEEDBACK_RELAY_WEBHOOK'];

export function webhookFrom(env = {}, relayEnv = {}) {
  for (const key of FEEDBACK_WEBHOOK_KEYS) {
    if (env[key]) return env[key];
    if (relayEnv[key]) return relayEnv[key];
  }
  return '';
}

function runningReason(claudeDir, io, now) {
  for (const [file, staleMs] of [
    [path.join(claudeDir, 'auto-session', '.lock'), 6 * 60 * 60 * 1000],
    [path.join(claudeDir, 'booth-feedback-immediate.lock'), 30 * 60 * 1000],
  ]) {
    let lock = {};
    try { lock = JSON.parse(io.read(file)); } catch {}
    const exists = io.exists ? io.exists(file) : Boolean(lock.startedAt);
    const age = lock.startedAt ? now.getTime() - Date.parse(lock.startedAt) : Infinity;
    const decision = file.includes('auto-session')
      ? decideRun({ lockExists: exists, lockPid: lock.pid, lockAgeMs: age, pidAlive: io.pidAlive?.(lock.pid) ?? false, disabled: false })
      : { run: !exists || age >= staleMs, reason: `immediate-lock:${lock.pid || 'unknown'}` };
    if (!decision.run) return decision.reason;
  }
  return '';
}

export async function runIntake({ args = [], home = process.env.ORGIAST_HOME || os.homedir(), io = defaultIo(), fetchImpl = fetch, taskLedger = runTaskLedger } = {}) {
  const claudeDir = path.join(home, '.claude');
  let env = {};
  try { env = parseEnvText(io.read(path.join(claudeDir, 'booth-feedback.env'))); } catch {}
  if (!env.BOOTH_FEEDBACK_URL || !env.BOOTH_FEEDBACK_TOKEN) {
    io.stderr('booth-feedback: BOOTH_FEEDBACK_URL/TOKEN 未設定のため取得しません(~/.claude/booth-feedback.env)');
    return 0;
  }
  const resolveIndex = args.indexOf('--resolve');
  const isResolve = resolveIndex >= 0;
  const json = args.includes('--json');
  try {
    if (isResolve) {
      const key = args[resolveIndex + 1];
      if (!key) throw new Error('--resolve に key が必要です');
      const statusIndex = args.indexOf('--status');
      const noteIndex = args.indexOf('--note');
      const status = statusIndex >= 0 ? args[statusIndex + 1] : 'done';
      const note = noteIndex >= 0 ? args[noteIndex + 1] : '';
      const result = await fetchJson(env.BOOTH_FEEDBACK_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: env.BOOTH_FEEDBACK_TOKEN, action: 'resolveFeedback', key, status, note }),
      }, fetchImpl);
      if (!result?.ok) throw new Error(result?.error || 'API が ok:false を返しました');
      const ledgerFile = path.join(claudeDir, 'booth-feedback-ledger.json');
      let ledgerText = '';
      try { ledgerText = io.read(ledgerFile); } catch {}
      const ledger = readLedger(ledgerText);
      ledger.items[key] = { ...(ledger.items[key] ?? {}), lastStatus: status, resolvedAt: io.now().toISOString() };
      io.write(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
      io.stdout(json ? JSON.stringify({ ok: true, key, status, result }) : `booth-feedback: resolved ${key} -> ${status}`);
      return 0;
    }

    const endpoint = new URL(env.BOOTH_FEEDBACK_URL);
    endpoint.searchParams.set('token', env.BOOTH_FEEDBACK_TOKEN);
    endpoint.searchParams.set('action', 'feedback');
    const data = await fetchJson(endpoint, {}, fetchImpl);
    if (!data?.ok) throw new Error(data?.error || 'API が ok:false を返しました');
    const items = Array.isArray(data.items) ? data.items : [];
    if (args.includes('--list')) {
      io.stdout(json ? JSON.stringify(data) : items.map((item) => `[${item.kind || '不明'}] ${item.key} ${item.title || '無題'} (${item.ts || '日時不明'})`).join('\n') || 'booth-feedback: open=0');
      return 0;
    }
    const ledgerFile = path.join(claudeDir, 'booth-feedback-ledger.json');
    let ledgerText = '';
    try { ledgerText = io.read(ledgerFile); } catch {}
    const ledger = readLedger(ledgerText);
    const nextFile = path.join(claudeDir, 'next-session.md');
    let before = '';
    try { before = io.read(nextFile); } catch {}
    const validItems = items.filter((item) => item?.key);
    const existingInText = validItems.filter((item) => before.includes(`[FB:${item.key}]`));
    const missingFromText = validItems.filter((item) => !before.includes(`[FB:${item.key}]`));
    const reinjectedItems = missingFromText.filter((item) => ledger.items[item.key]?.injectedAt);
    const reinjectedKeys = new Set(reinjectedItems.map((item) => item.key));
    const candidates = missingFromText;
    const result = injectFeedbackTodos(before, candidates, data.sheetUrl || '');
    const reinjected = result.injected.filter((item) => reinjectedKeys.has(item.key)).length;
    const newlyInjected = result.injected.length - reinjected;
    const already = existingInText.length;
    const duplicateInText = candidates.length - result.injected.length;
    const dryRun = args.includes('--dry-run');
    if (dryRun) {
      const output = { open: items.length, new: newlyInjected, reinjected, injected: result.injected.length, skippedAlreadyInjected: already, skippedExistingText: duplicateInText, preview: result.text === before ? '' : result.text };
      io.stdout(json ? JSON.stringify(output) : `booth-feedback: open=${items.length} new=${newlyInjected} reinjected=${reinjected} would-inject=${result.injected.length}\n${output.preview}`);
      return 0;
    }
    if (result.text !== before) io.write(nextFile, result.text);
    for (const item of result.injected) {
      try {
        await taskLedger({
          command: 'upsert', taskId: `FB-${item.key}`, 起票元: 'booth-feedback', 件名: item.title || '無題',
          依頼元: item.source || '不明', 状態: '未着手', 次アクション: item.kind === '不具合' ? '即実行' : '当日夜に実行', 期限: '',
        }, { homeDir: home });
      } catch (error) {
        io.stderr(`booth-feedback: task-ledger upsert 失敗 (key=${oneLine(item.key)}): ${oneLine(error?.message || error, 160)}`);
      }
    }
    const now = io.now().toISOString();
    for (const item of items) {
      const previous = ledger.items[item.key] ?? {};
      ledger.items[item.key] = { ...previous, firstSeen: previous.firstSeen || now, title: item.title || previous.title || '', lastStatus: item.status || previous.lastStatus || '' };
    }
    for (const item of result.injected) {
      if (reinjectedKeys.has(item.key)) {
        ledger.items[item.key].injectedAt = now;
        ledger.items[item.key].reinjectedCount = (Number(ledger.items[item.key].reinjectedCount) || 0) + 1;
      } else {
        ledger.items[item.key].injectedAt ||= now;
      }
    }
    const counts = { immediate: 0, tonight: 0, hold: 0 };
    for (const item of validItems) counts[feedbackLane(item.kind)] += 1;
    const newImmediate = result.injected.filter((item) => feedbackLane(item.kind) === 'immediate' && !reinjectedKeys.has(item.key));
    let immediateNote = '';
    if (newImmediate.length) {
      ledger.immediateLaunches = Array.isArray(ledger.immediateLaunches) ? ledger.immediateLaunches : [];
      const current = io.now();
      const lockReason = runningReason(claudeDir, io, current);
      const throttleReason = immediateThrottleReason(ledger.immediateLaunches, current);
      const reason = lockReason || throttleReason;
      if (reason) {
        for (const item of newImmediate) ledger.items[item.key].immediateThrottledAt = now;
        immediateNote = `immediate-throttled reason=${reason}`;
        io.stderr(`booth-feedback: immediate-throttled reason=${reason} keys=${newImmediate.map((item) => item.key).join(',')}`);
      } else {
        const lockFile = path.join(claudeDir, 'booth-feedback-immediate.lock');
        io.write(lockFile, `${JSON.stringify({ pid: process.pid, startedAt: now, keys: newImmediate.map((item) => item.key) }, null, 2)}\n`);
        try {
          const launcher = path.join(import.meta.dirname, 'auto-session-launcher.mjs');
          const child = io.spawn(process.execPath, [launcher], { detached: true, stdio: 'ignore', windowsHide: true });
          child.unref();
          for (const item of newImmediate) {
            ledger.items[item.key].immediateLaunchedAt = now;
          }
          // 1回の detached spawn が1 launch。複数行を同時検知してもレート枠は1回だけ消費する。
          ledger.immediateLaunches.push({ at: now, key: newImmediate[0].key });
          immediateNote = `immediate-launched keys=${newImmediate.map((item) => item.key).join(',')}`;
          const webhook = webhookFrom(env, readOptionalEnv(io, path.join(claudeDir, 'feedback-relay.env')));
          if (webhook && io.notify) {
            const first = newImmediate[0];
            try { await io.notify(webhook, `🐛 不具合報告を受けて無人セッションを起動: ${oneLine(first.title) || '無題'}（${oneLine(first.source) || '案件不明'}）`); } catch {}
          } else {
            // 通知先が無いこと自体をログに残す。黙って飛ばないと「通知されている」と誤解する。
            immediateNote += ' notify=skipped:no-webhook';
          }
        } catch (error) {
          for (const item of newImmediate) ledger.items[item.key].immediateThrottledAt = now;
          immediateNote = `immediate-throttled reason=spawn-failed:${oneLine(error?.message || error, 120)}`;
          io.stderr(`booth-feedback: ${immediateNote}`);
        }
      }
    }
    io.write(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
    const summary = { open: items.length, new: newlyInjected, reinjected, injected: result.injected.length, ...counts, skippedAlreadyInjected: already, skippedExistingText: duplicateInText };
    const line = `${now} booth-feedback: open=${items.length} new=${newlyInjected} reinjected=${reinjected} injected=${result.injected.length} immediate=${counts.immediate} tonight=${counts.tonight} hold=${counts.hold} (skipped: already-injected ${already + duplicateInText}${immediateNote ? `; ${immediateNote}` : ''})`;
    try { io.append?.(path.join(claudeDir, 'logs', 'booth-feedback-intake.log'), `${line}\n`); } catch {}
    io.stdout(json ? JSON.stringify(summary) : line.slice(now.length + 1));
    return 0;
  } catch (error) {
    io.stderr(`booth-feedback: ${isResolve ? '更新' : '取得'}に失敗 (${oneLine(error?.message || error, 240)})`);
    return isResolve ? 1 : 0;
  }
}

if (isEntry(import.meta.url)) {
  const code = await runIntake({ args: process.argv.slice(2) });
  process.exitCode = code;
}
