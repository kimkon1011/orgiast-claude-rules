#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

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

export function readBudgetStatus({ spawnImpl = spawnSync } = {}) {
  const guard = fileURLToPath(new URL('./gemini-budget-guard.mjs', import.meta.url));
  const result = spawnImpl(process.execPath, [guard, '--dry-run'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result?.error || result?.status !== 0) throw result?.error || new Error(String(result?.stderr || `exit ${result?.status}`).trim());
  return JSON.parse(result.stdout);
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
