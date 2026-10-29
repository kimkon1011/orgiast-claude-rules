#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"lane-repair-first-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"lane-repair-first-gate"},{"kind":"command","ref":"node tools/lane-doctor.mjs --probe"},{"kind":"command","ref":"node tools/lane-repair-log.mjs --lane <名> --tried \"<試した手段>\" --result unfixable"}]};
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneHome, readJson } from './lane-doctor.mjs';
import { pendingRepairs } from './lib/lane-repair-state.mjs';
import { redactAll } from './lib/redact.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
// Tokenize a single invocation, retaining quoted arguments. No shell expansion,
// pipelines, redirection or command chaining may inherit a diagnostic exemption.
export function repairCommand(command) {
  const tokens = [];
  let rest = String(command || '').trim();
  if (!rest || /[`$\r\n]/.test(rest)) return false;
  while (rest) {
    const match = rest.match(/^(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"';&|<>]+))(?:\s+|$)/);
    if (!match || match[3] && /[(){}\[\]]/.test(match[3])) return false;
    tokens.push(match[1] ?? match[2] ?? match[3]);
    rest = rest.slice(match[0].length);
  }
  const [cmd, ...args] = tokens;
  if (/^(?:node|node.exe)$/.test(cmd)) {
    const allowed = ['lane-doctor.mjs', 'lane-repair-log.mjs', 'llm-ask.mjs', 'codex-do.mjs', 'env-kv.mjs', 'keyserve-status.mjs'];
    return allowed.some(file => path.resolve(args[0] || '') === path.join(repo, 'tools', file));
  }
  if (/^(?:git|git.exe)$/.test(cmd)) return /^(?:status|log|diff|show|rev-parse|ls-files)$/.test(args[0]) && !args.some(a => /^(?:--(?:out|ext|text)|--no-index|--config|-c)/.test(a));
  if (/^gh(?:.exe)?$/.test(cmd)) return /^(?:pr|issue|run|auth)$/.test(args[0]) && /^(?:view|list|status|diff|checks)$/.test(args[1]);
  if (/^wsl(?:.exe)?$/.test(cmd)) {
    const invocation = args.indexOf('--');
    if (invocation >= 0) {
      const child = args.slice(invocation + 1);
      return child[0] === 'codex' && (child[1] === 'exec' || child[1] === 'login' || child[1] === '--version')
        || child.join(' ') === 'npm install -g @openai/codex';
    }
    if (/^--install (?:-d|--distribution) Ubuntu --no-launch$/.test(args.join(' '))) return true;
    return args.length > 0 && args.every(a => ['-l', '--list', '-q', '--quiet', '--status', '--version', '--verbose', '-v'].includes(a));
  }
  if (/^(?:keyserve|env-kv)$/.test(cmd)) return /^(?:status|list|get|help)$/.test(args[0]);
  return false;
}
export function evaluateRepairFirst(input, { home = laneHome(), now = Date.now() } = {}) {
  const name = input.tool_name || '';
  if (!/^(?:Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell)$/.test(name)) return { decision: 'pass' };
  if (/^(?:Bash|PowerShell)$/.test(name) && repairCommand(input.tool_input?.command || input.tool_input?.script)) return { decision: 'pass' };
  const pending = pendingRepairs(readJson(path.join(home, '.claude/lane-health.json')), home, now);
  if (!pending.length) return { decision: 'pass' };
  return { decision: 'block', reason: `[LANE-REPAIR-FIRST] 修復を最優先: ${pending.map(s => `${s.lane}: ${s.reason} ${s.error || ''}`).join('; ')}。先に node tools/lane-doctor.mjs --probe。Codex probe_failed は直接 wsl codex exec の終了コードで切り分ける。修復手段を試し、node tools/lane-repair-log.mjs --lane <名> --tried "<試した手段>" --result fixed|unfixable に記録（6時間有効）。` };
}
export async function main() {
  const home = laneHome();
  try {
    const result = evaluateRepairFirst(JSON.parse(await readStdinWithTimeout()), { home });
    if (result.decision === 'block') { console.error(result.reason); process.exitCode = 2; }
  } catch (e) {
    try {
      const file = path.join(home, '.claude/gate-errors.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), gate: GATE_CONTRACT.name, verdict: 'fail-open', error: redactAll(e.message).slice(0, 400) }) + '\n', { mode: 0o600 });
    } catch { /* Gate crashes must not prevent diagnosis. */ }
  }
}
if (isEntry(import.meta.url)) await main();
