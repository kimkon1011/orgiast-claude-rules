#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

export const GATE_CONTRACT = {"name":"gemini-api-budget-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"gemini-api-budget-gate"}]};

const CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const STATUS_MAX_AGE_MS = 36 * 60 * 60 * 1000;

function geminiMonth(now) {
  return new Date(new Date(now).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function readJson(file, fsImpl) {
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
}

function usableStatus(value, { now, maxAgeMs }) {
  const checkedAt = Date.parse(value?.checkedAt);
  return value && ['ok', 'warn', 'stop'].includes(value.level)
    && value.month === geminiMonth(now)
    && Number.isFinite(checkedAt)
    && new Date(now).getTime() - checkedAt >= 0
    && new Date(now).getTime() - checkedAt <= maxAgeMs;
}

function compactStatus(value, now = new Date()) {
  return {
    level: value.level,
    pct: Number.isFinite(value.pct) ? value.pct : null,
    month: value.month || geminiMonth(now),
    checkedAt: value.checkedAt || new Date(now).toISOString(),
  };
}

function writeJson(file, value, fsImpl) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fsImpl.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    fsImpl.renameSync(temp, file);
  } finally { try { fsImpl.unlinkSync(temp); } catch {} }
}

function auxiliaryStop(dir, { now, fsImpl }) {
  const nowMs = new Date(now).getTime();
  const cooldown = readJson(path.join(dir, 'provider-cooldown.json'), fsImpl);
  const gemini = cooldown?.gemini;
  if (Number(gemini?.until) > nowMs && /billing|budget/i.test(String(gemini?.reason || ''))) {
    return compactStatus({ level: 'stop', pct: null }, now);
  }
  return null;
}

function shellSegments(command) {
  const segments = [];
  let start = 0, quote = '';
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote && command[i - 1] !== '\\') quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ';' || char === '|' || char === '&' || char === '\n' || char === '\r') {
      segments.push(command.slice(start, i));
      while (command[i + 1] === char) i++;
      start = i + 1;
    }
  }
  segments.push(command.slice(start));
  return segments;
}

function unquote(value) {
  const text = value.trim();
  return ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'")) ? text.slice(1, -1) : text;
}

export function geminiApiInvocation(command) {
  for (const segment of shellSegments(String(command || ''))) {
    const match = segment.trim().match(/^(?:&\s+)?((?:"[^"]+"|'[^']+'|\S+))(?:\s+([\s\S]*))?$/);
    if (!match) continue;
    const executable = unquote(match[1]).replace(/\\/g, '/');
    if (!/(?:^|\/)gemini-api(?:\.exe)?$/i.test(executable)) continue;
    return { args: String(match[2] || '').trim() };
  }
  return null;
}

export function isSafeInvocation(args) {
  const tokens = String(args || '').match(/"[^"]*"|'[^']*'|\S+/g)?.map(unquote) || [];
  if (tokens.some(token => ['--dry-run', '--help', '-h', '--usage', '--schema'].includes(token))) return true;
  const first = tokens[0] || '';
  if (['whoami', 'version', 'explore'].includes(first)) return true;
  return first === 'models' && tokens.length === 1;
}

export function readBudgetStatus({ spawnImpl = spawnSync, fsImpl = fs, home = os.homedir(), now = new Date() } = {}) {
  const dir = path.join(home, '.claude');
  const cacheFile = path.join(dir, 'gemini-api-budget-gate-cache.json');
  const cached = readJson(cacheFile, fsImpl);
  if (usableStatus(cached, { now, maxAgeMs: CACHE_MAX_AGE_MS })) return cached;

  const status = readJson(path.join(dir, 'gemini-budget-status.json'), fsImpl);
  if (usableStatus(status, { now, maxAgeMs: STATUS_MAX_AGE_MS })) {
    const compact = compactStatus(status, now);
    writeJson(cacheFile, compact, fsImpl);
    return compact;
  }

  const auxiliary = auxiliaryStop(dir, { now, fsImpl });
  if (auxiliary) {
    writeJson(cacheFile, auxiliary, fsImpl);
    return auxiliary;
  }

  const guard = fileURLToPath(new URL('./gemini-budget-guard.mjs', import.meta.url));
  const result = spawnImpl(process.execPath, [guard, '--dry-run'], { encoding: 'utf8', windowsHide: true, timeout: 40000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result?.error || result?.status !== 0) throw result?.error || new Error(String(result?.stderr || `exit ${result?.status}`).trim());
  const fresh = compactStatus(JSON.parse(result.stdout), now);
  writeJson(cacheFile, fresh, fsImpl);
  return fresh;
}

export function judge(input, { statusProvider = readBudgetStatus, warn = message => console.error(message) } = {}) {
  if (!['Bash', 'PowerShell'].includes(input?.tool_name)) return { decision: 'allow' };
  const invocation = geminiApiInvocation(input?.tool_input?.command);
  if (!invocation || isSafeInvocation(invocation.args)) return { decision: 'allow' };
  let status;
  try { status = statusProvider(); }
  catch (error) {
    warn(`gemini-api budget gate: 予算状態を取得できないため許可します: ${error?.message || error}`);
    return { decision: 'allow' };
  }
  if (status?.level !== 'stop') return { decision: 'allow' };
  const pct = Number.isFinite(status.pct) ? status.pct.toFixed(1) : '不明';
  return { decision: 'deny', reason: `Gemini 予算が停止中（今月 ${pct}%）。代替: node tools/llm-ask.mjs --provider openrouter ... 。予算判断は kim-inbox へ` };
}

export function hookMain(raw, options) {
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const result = judge(input, options);
  if (result.decision === 'deny') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
}

if (isEntry(import.meta.url)) hookMain(await readStdinWithTimeout());
