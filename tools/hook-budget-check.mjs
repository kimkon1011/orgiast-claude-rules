#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

import { addItem } from './kim-inbox.mjs';
import { EVENTS } from './hook-dispatch-registry.mjs';

export function summarizeDispatchMetrics(records, { now = Date.now(), cutoff = 50, averageMs = 3000, criticalCutoff = 5 } = {}) {
  const events = Object.fromEntries(EVENTS.map(event => [event, { calls: 0, truncationsPerHour: 0, criticalUnfinishedPerHour: 0, totalDurationMs: 0, totalHookMs: 0, skipped: 0 }]));
  for (const record of records) {
    const at = Date.parse(record.at);
    if (!Number.isFinite(at) || at > now || at <= now - 3600000 || !events[record.event]) continue;
    const item = events[record.event];
    item.calls++;
    item.criticalUnfinishedPerHour += (record.hooks || []).filter(h =>
      ['hook-timeout', 'hook-error', 'dispatch-budget'].includes(h.criticalUnfinished)).length;
    item.truncationsPerHour += Number(record.timedOut) || 0;
    item.totalDurationMs += Number(record.durationMs) || 0;
    item.totalHookMs += (record.hooks || []).reduce((sum, h) => sum + (Number(h.durationMs) || 0), 0);
    item.skipped += Number(record.skipped) || 0;
  }
  for (const item of Object.values(events)) {
    item.averageDurationMs = item.calls ? item.totalDurationMs / item.calls : 0;
    item.averageHookMsPerCall = item.calls ? item.totalHookMs / item.calls : 0;
    item.over = item.truncationsPerHour >= cutoff || item.averageHookMsPerCall > averageMs;
  }
  const criticalUnfinishedPerHour = Object.values(events).reduce((sum, item) => sum + item.criticalUnfinishedPerHour, 0);
  return { events, criticalUnfinishedPerHour, over: criticalUnfinishedPerHour >= criticalCutoff || Object.values(events).some(item => item.over) };
}
export async function readDispatchMetrics(home, now = Date.now()) {
  const records = [];
  // A rolling hour may span midnight: stream both daily files, ignoring partial lines.
  for (const day of new Set([now, now - 3600000].map(at => new Date(at).toISOString().slice(0, 10)))) {
    const file = path.join(home, '.claude', 'hook-metrics', `${day}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    try {
      for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
        try { const record = JSON.parse(line); if (Date.parse(record.at) > now - 3600000) records.push(record); } catch {}
      }
    } catch {} finally { stream.destroy(); }
  }
  return records;
}
export async function checkDispatchBudget(home, { now = Date.now(), notify = addItem, records, ...thresholds } = {}) {
  const summary = summarizeDispatchMetrics(records || await readDispatchMetrics(home, now), { now, ...thresholds });
  if (!summary.over) return summary;
  const dir = path.join(home, '.claude', 'hook-metrics');
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, `alert-${new Date(now).toISOString().slice(0, 10)}.json`);
  try { fs.writeFileSync(marker, JSON.stringify({ at: new Date(now).toISOString(), pending: true }), { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') return summary; throw error; }
  const text = ['hook 過負荷・未完了を検知しました（直近1時間）。', `critical 未完了 合計 ${summary.criticalUnfinishedPerHour}件/時（閾値 ${thresholds.criticalCutoff ?? 5}件）`, ...Object.entries(summary.events).filter(([, item]) => item.over || item.criticalUnfinishedPerHour)
    .map(([event, item]) => `${event}: critical 未完了 ${item.criticalUnfinishedPerHour}件/時、打ち切り ${item.truncationsPerHour}回/時、1呼出あたりhook合計平均 ${(item.averageHookMsPerCall / 1000).toFixed(2)}秒、間引き ${item.skipped}本`)].join('\n');
  try {
    const item = await notify(home, { kind: 'info', source: 'hook-budget-check', from: 'hook-dispatch', text, signal: AbortSignal.timeout(2000) });
    fs.writeFileSync(marker, JSON.stringify({ at: new Date(now).toISOString(), itemId: item?.id }));
    summary.notified = true;
  } catch (error) { fs.rmSync(marker, { force: true }); summary.notifyError = error.message; }
  return summary;
}

const SELF = 'hook-budget-check.mjs';

export function projectSlug(dir) {
  return String(dir || '').replace(/[^A-Za-z0-9]/g, '-');
}

export function hookNameFromCommand(command) {
  const value = String(command || '');
  const matches = [...value.matchAll(/(?:^|[\\/"'\s])([^\\/"'\s]+\.(?:mjs|ps1))(?=["'\s]|$)/gi)];
  return matches.at(-1)?.[1] || value.trim().slice(0, 40);
}

function walk(value, timestamp, output) {
  if (!value || typeof value !== 'object') return;
  if (value.hookEvent === 'SessionStart'
    && typeof value.durationMs === 'number'
    && Number.isFinite(value.durationMs)
    && typeof value.command === 'string'
    && value.command.trim() !== '') {
    output.push({
      command: value.command,
      durationMs: value.durationMs,
      exitCode: value.exitCode ?? null,
      toolUseID: String(value.toolUseID || ''),
      timestamp,
    });
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child, timestamp, output);
}

export function extractSessionStartHooks(records) {
  const output = [];
  const values = typeof records === 'string' ? records.split(/\r?\n/) : records;
  for (const record of values || []) {
    let parsed = record;
    if (typeof record === 'string') {
      if (!record.includes('"hookEvent":"SessionStart"') && !/"hookEvent"\s*:\s*"SessionStart"/.test(record)) continue;
      try { parsed = JSON.parse(record); } catch { continue; }
    }
    walk(parsed, parsed?.timestamp, output);
  }
  return output;
}

export function groupBatches(hooks) {
  const batches = new Map();
  hooks.forEach((hook, index) => {
    const id = hook.toolUseID || `__missing_${index}`;
    if (!batches.has(id)) batches.set(id, { toolUseID: hook.toolUseID || '', hooks: [], latestTimestamp: '', lastIndex: index, missingTimestamp: false });
    const batch = batches.get(id);
    batch.hooks.push(hook);
    batch.lastIndex = index;
    if (!hook.timestamp) batch.missingTimestamp = true;
    else if (!batch.latestTimestamp || hook.timestamp > batch.latestTimestamp) batch.latestTimestamp = hook.timestamp;
  });
  return [...batches.values()].sort((a, b) => {
    if (a.missingTimestamp !== b.missingTimestamp) return a.missingTimestamp ? 1 : -1;
    return a.latestTimestamp.localeCompare(b.latestTimestamp) || a.lastIndex - b.lastIndex;
  });
}

function settingsGroups(settings) {
  return Array.isArray(settings?.hooks?.SessionStart) ? settings.hooks.SessionStart : [];
}

export function summarize(batch, settings = {}, thresholdSec = 30) {
  const hooks = (batch?.hooks || []).map((hook) => ({ ...hook, name: hook.name || hookNameFromCommand(hook.command) }));
  const serialSumMs = hooks.reduce((sum, hook) => sum + hook.durationMs, 0);
  const remaining = new Set(hooks.map((_, index) => index));
  const criticalPathMs = hooks.length ? Math.max(...hooks.map((hook) => hook.durationMs)) : 0;
  const unmeasured = [];
  const truncated = [];
  for (const group of settingsGroups(settings)) {
    for (const configured of Array.isArray(group?.hooks) ? group.hooks : []) {
      const name = hookNameFromCommand(configured?.command);
      if (!name || name === SELF) continue;
      const index = hooks.findIndex((hook, i) => remaining.has(i) && hook.name === name);
      const timeoutSec = Number(configured.timeout) || 10;
      if (index < 0) unmeasured.push({ name, timeoutSec, async: configured?.async === true });
      else {
        remaining.delete(index);
        if (hooks[index].durationMs >= timeoutSec * 1000) truncated.push({ name, durationMs: hooks[index].durationMs, timeoutSec });
      }
    }
  }
  return {
    status: hooks.length ? 'ok' : 'no-data', source: batch?.source || '', serialSumMs, criticalPathMs,
    // timeout超過(truncated)は「起動時間の予算超過」ではなく設定の不整合なので over には入れない。
    // 毎回鳴らすと狼少年化して誰も見なくなるため、台帳と --json に残して警告文に添えるだけにする。
    over: hooks.length > 0 && criticalPathMs > Number(thresholdSec) * 1000,
    strongWarning: hooks.length > 0 && criticalPathMs >= 60000,
    slowest: [...hooks].sort((a, b) => b.durationMs - a.durationMs).map(({ name, durationMs, exitCode }) => ({ name, durationMs, exitCode })),
    unmeasured, truncated,
  };
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

export function renderWarning(summary, thresholdSec = 30) {
  const lines = [`⚠️ 起動時フック critical path ${seconds(summary.criticalPathMs)}（閾値 ${thresholdSec}s / VSCode上限 60s）`];
  if (summary.slowest.length) lines.push(`遅い順: ${summary.slowest.map((hook) => `${hook.name} ${seconds(hook.durationMs)}`).join(' / ')}`);
  if (summary.unmeasured.length) {
    const synchronous = summary.unmeasured.filter((hook) => !hook.async).length;
    lines.push(`未計測 ${summary.unmeasured.length}本（async 除く ${synchronous}本）は合計に含まれない＝実測値は下限`);
  }
  if (summary.truncated?.length) {
    lines.push(`timeout超過: ${summary.truncated.map((hook) => `${hook.name} ${seconds(hook.durationMs)} (timeout ${hook.timeoutSec}s)`).join(' / ')} → timeout 値を実測に合わせるか裏回しにする（切られて出力が失われている疑い）`);
  }
  lines.push('直し方: 重いフックは ~/.claude/hooks/bg-launch.mjs 経由の裏回し、または cache-first 化。詳細は memory feedback-sessionstart-hook-budget-breaks-vscode-init');
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
}

export function appendLedger(ledger, entry, limit = 200) {
  const history = Array.isArray(ledger?.history) ? ledger.history : [];
  return { updatedAt: entry.at, history: [...history, entry].slice(-limit) };
}

function parseArgs(argv) {
  const result = { threshold: 30, json: false, verbose: false, ledger: null, writeLedger: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--transcript' || arg === '--project' || arg === '--threshold' || arg === '--ledger') result[arg.slice(2)] = argv[++i];
    else if (arg === '--json') result.json = true;
    else if (arg === '--verbose') result.verbose = true;
    else if (arg === '--no-ledger') result.writeLedger = false;
    else if (arg === '--help') result.help = true;
  }
  result.threshold = Number(result.threshold) || 30;
  return result;
}

function newestFirst(files, excluded) {
  return files.filter((file) => path.basename(file, '.jsonl') !== excluded).map((file) => {
    try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).map(({ file }) => file);
}

function transcriptCandidates(home, options, input) {
  if (options.transcript) return [path.resolve(options.transcript)];
  const root = path.join(home, '.claude', 'projects');
  const dir = options.project || input.cwd;
  if (dir) {
    const slugDir = path.join(root, projectSlug(dir));
    try {
      const found = newestFirst(fs.readdirSync(slugDir).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(slugDir, name)), input.session_id);
      if (found.length) return found;
    } catch {}
  }
  try {
    const files = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
      const dirPath = path.join(root, entry.name);
      try { return fs.readdirSync(dirPath).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dirPath, name)); } catch { return []; }
    });
    return newestFirst(files, input.session_id);
  } catch { return []; }
}

async function readHooks(file) {
  const output = [];
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.includes('"hookEvent":"SessionStart"') && !/"hookEvent"\s*:\s*"SessionStart"/.test(line)) continue;
    output.push(...extractSessionStartHooks([line]));
  }
  return output;
}

function usage() {
  return 'Usage: node tools/hook-budget-check.mjs [--transcript <path>] [--project <dir>] [--threshold <sec>] [--json] [--verbose] [--ledger <path>] [--no-ledger] [--help]';
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) { console.log(usage()); return; }
    let input = {};
    try { const raw = await readStdinWithTimeout(100); input = raw.trim() ? JSON.parse(raw) : {}; } catch {}
    const home = process.env.ORGIAST_HOME || os.homedir();
    const dispatchBudget = await checkDispatchBudget(home);
    let transcript;
    let noDataTranscript;
    let batches = [];
    for (const candidate of transcriptCandidates(home, options, input)) {
      if (!fs.existsSync(candidate)) continue;
      noDataTranscript ||= candidate;
      const candidateBatches = groupBatches(await readHooks(candidate));
      if (candidateBatches.length || options.transcript) {
        transcript = candidate;
        batches = candidateBatches;
        break;
      }
    }
    transcript ||= noDataTranscript;
    const batch = batches.length ? { ...batches.at(-1), source: transcript } : { hooks: [], source: transcript || (options.transcript ? path.resolve(options.transcript) : '') };
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8').replace(/^\uFEFF/, '')); } catch {}
    const summary = summarize(batch, settings, options.threshold);
    const at = new Date().toISOString();
    if (options.writeLedger) {
      try {
        const ledgerPath = options.ledger ? path.resolve(options.ledger) : path.join(home, '.claude', 'hook-budget.json');
        let ledger = {};
        try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch {}
        const { truncated, ...entry } = summary;
        const next = appendLedger(ledger, { at, ...entry });
        fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
        fs.writeFileSync(ledgerPath, `${JSON.stringify(next, null, 2)}\n`);
      } catch {}
    }
    if (options.json) console.log(JSON.stringify({ at, ...summary, dispatchBudget }));
    else if (summary.over) console.log(renderWarning(summary, options.threshold));
    else if (options.verbose && summary.status !== 'no-data') console.log(`起動時フック critical path ${seconds(summary.criticalPathMs)}（閾値 ${options.threshold}s）`);
  } catch {}
}

// 素の URL 比較は不可: ~/orgiast-claude-rules が Downloads へのジャンクションの環境で
// 判定が外れ、フックが無言で何もしなくなる（is-entry.mjs のコメント参照）。
if (isEntry(import.meta.url)) await main();
