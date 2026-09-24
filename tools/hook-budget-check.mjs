#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

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
    const home = os.homedir();
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
    if (options.json) console.log(JSON.stringify({ at, ...summary }));
    else if (summary.over) console.log(renderWarning(summary, options.threshold));
    else if (options.verbose && summary.status !== 'no-data') console.log(`起動時フック critical path ${seconds(summary.criticalPathMs)}（閾値 ${options.threshold}s）`);
  } catch {}
}

// 素の URL 比較は不可: ~/orgiast-claude-rules が Downloads へのジャンクションの環境で
// 判定が外れ、フックが無言で何もしなくなる（is-entry.mjs のコメント参照）。
if (isEntry(import.meta.url)) await main();
