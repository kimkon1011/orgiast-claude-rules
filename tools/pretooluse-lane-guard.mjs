#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "pretooluse-lane-guard", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "pretooluse-lane-guard"}, {"kind": "command", "ref": "node tools/lane-doctor.mjs --probe"}, {"kind": "repo-file", "ref": "tools/codex-do.mjs"}, {"kind": "keyserve-key", "ref": "deepseek.env#DEEPSEEK_API_KEY"}]};
import { isPastLogSearchToolUse } from './lib/user-facing.mjs';
import { implApproved, affirmativeMarker, IMPLEMENTATION_DENIAL } from './lib/claude-approval.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectTranscript } from './fable-session-guard.mjs';
import { classifyBashCommand } from './usage-stats.mjs';
import { laneDoctorQuick, readJson, freshProbe } from './lane-doctor.mjs';
import { isEntry } from './is-entry.mjs';
import { laneAdvice } from './cost-routing-gate.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';


const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const delegated = /pr-merge\.mjs|lane-doctor\.mjs|lane-repair-log\.mjs|codex-do\.mjs|autopilot-tick\.mjs|llm-ask\.mjs|batch-(?:enqueue|run)\.mjs|(?:^|\s)gemini\s|(?:^|\s)codex\s|wsl[^\r\n]*\bcodex\b|claude\s+-p|node[^\r\n]*usage-stats\.mjs/i;
export const operator = /line-pc-act\.ps1|line-send\.ps1|make-desktop-launcher\.mjs|notify-kim\.mjs|discord-dm\.mjs|fleet-mail\.mjs/i;
export const gateRequired = /(?:^|[\\/])auto-progress\.mjs(?:["']|\s|$)/i;
export function isGateRequiredCommand(command) {
  const source = String(command || '').trim();
  if (!source || /[;|<>`$\r\n]/.test(source)) return false;
  // A cwd prefix is the only compound form allowed; the invoked command remains a single node process.
  const invocation = source.replace(/^cd\s+(?:"[^"]+"|'[^']+'|[^&]+?)\s*&&\s*/i, '');
  return /^node(?:\.exe)?\s+(?:"[^"]*[\\/]auto-progress\.mjs"|'[^']*[\\/]auto-progress\.mjs'|[^\s"']*auto-progress\.mjs)(?:\s|$)/i.test(invocation)
    && gateRequired.test(invocation);
}
// Close, record, and verify. These are not the implementation the lane budget exists to delegate.
const LIGHT_SCRIPT = /(?:^|[\\/])tools[\\/](?:[^\\/]+[\\/])*(?:session-claims|close-session|kim-inbox|drive-upload|next-session-rotate|next-session-launch)\.mjs$/i;
const NODE_CODE = /^(?:-e|--eval|-p|--print|-r|--require|--import|--loader|--experimental-loader)$/i;
const NODE_CODE_EQ = /^(?:--(?:eval|print|require|import|loader|experimental-loader)=|-r\S)/i;
const GIT_READ = /^(?:status|diff|log|show)$/i;
function shellTokens(text) {
  return [...String(text).matchAll(/"([^"\n]*)"|'([^'\n]*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
}
function splitAnd(source) {
  const parts = []; let current = '', quote = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) { current += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '&' && source[i + 1] === '&') { parts.push(current.trim()); current = ''; i++; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
function hasStrayAmp(source) {
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch !== '&') continue;
    if (source[i + 1] === '&') { i++; continue; }
    return true;
  }
  return false;
}
function gitReadSubcommand(args) {
  const rest = [...args];
  while (rest.length) {
    const arg = rest[0];
    if (/^(?:-C|-c|--git-dir|--work-tree)$/i.test(arg)) { if (rest.length < 2) return ''; rest.splice(0, 2); continue; }
    if (/^-C\S/.test(arg) || /^--(?:git-dir|work-tree)=/.test(arg)) { rest.shift(); continue; }
    if (/^--no-(?:pager|optional-locks|replace-objects|ext-diff)$/i.test(arg)) { rest.shift(); continue; }
    break;
  }
  return rest[0] || '';
}
function isLightNode(args) {
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (NODE_CODE.test(arg) || NODE_CODE_EQ.test(arg)) return false;
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (/^-/.test(arg)) continue;
    positionals.push(arg);
  }
  // Exact --test/--check only. --test-reporter alone must not exempt a script execution.
  const verifyAt = args.findIndex(arg => /^--(?:test|check)$/i.test(arg));
  if (verifyAt >= 0) return args.slice(0, verifyAt).every(arg => /^-/.test(arg));
  return positionals.length > 0 && LIGHT_SCRIPT.test(positionals[0]);
}
function isSingleLightInvocation(invocation) {
  const tokens = shellTokens(invocation);
  if (!tokens.length) return false;
  const [bin, ...args] = tokens;
  if (/^git(?:\.exe)?$/i.test(bin)) return GIT_READ.test(gitReadSubcommand(args));
  if (/^node(?:\.exe)?$/i.test(bin)) return isLightNode(args);
  if (/^rclone(?:\.exe)?$/i.test(bin)) return /^(?:copy|copyto)$/i.test(args[0] || '') && args.length >= 3 && args.some(arg => /^(?:--drive-root-folder-id(?:=|$)|[A-Za-z][A-Za-z0-9_-]+:)/.test(arg));
  return false;
}
export function isLightLaneCommand(command) {
  const source = String(command || '').trim().replace(/^&\s+/, '');
  // One light invocation, or a short && chain of them. Compounds, substitutions, and redirections stay counted.
  if (!source || /[;|<>`\r\n]/.test(source) || /\$\(/.test(source) || /\$\{/.test(source) || hasStrayAmp(source)) return false;
  const parts = splitAnd(source);
  if (!parts.length || parts.length > 6) return false;
  let start = 0;
  if (/^cd\s+/i.test(parts[0])) {
    if (!/^cd\s+(?:"[^"\n]+"|'[^'\n]+'|\S+)$/i.test(parts[0]) || parts.length === 1) return false;
    start = 1;
  }
  return parts.slice(start).every(isSingleLightInvocation);
}
function isOperatorWrapper(command, home) {
  // Accept a single script invocation, never a compound shell command.
  if (/[;|<>`$\r\n]/.test(command)) return false;
  const match = command.trim().match(/^(?:(?:powershell|pwsh)(?:\.exe)?\s+(?:(?:-STA|-NoProfile|-NonInteractive|-NoLogo|-ExecutionPolicy\s+Bypass)\s+)*(?:-File\s+)?|&\s*)?(?:"([^"\n]+\.ps1)"|'([^'\n]+\.ps1)'|([^\s"'&]+\.ps1))(?:\s+[^&]*)?$/i);
  if (!match) return false;
  let file = (match[1] || match[2] || match[3]).replace(/\\/g, '/');
  if (file.startsWith('~/')) file = path.join(home, file.slice(2));
  file = path.normalize(file);
  if (!/(?:^|\/)scratchpad\//i.test(file.replace(/\\/g, '/'))) return false;
  try { return /line-pc-act\.ps1/i.test(fs.readFileSync(file, 'utf8')); } catch { return false; }
}
function output(value) { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...value } })); }
function editPath(input) { return String(input.file_path || input.path || ''); }
function isDocEdit(name, input, home) {
  if (!/^(?:Edit|Write|MultiEdit)$/.test(name)) return false;
  const target = editPath(input).replace(/\\/g, '/'), claude = path.join(home, '.claude').replace(/\\/g, '/');
  return target.startsWith(claude) || /(?:memory|scratchpad)/i.test(target) || /\.md$/i.test(target);
}
export async function main() {
  const raw = await readStdinWithTimeout();
  try {
    const input = JSON.parse(raw.replace(/^\uFEFF/, '')), home = process.env.ORGIAST_HOME || os.homedir();
    if (/subagents/i.test(String(input.transcript_path || ''))) return;
    try { inspectTranscript(input.transcript_path); } catch { return; }
    if (implApproved(home, input.session_id)) return;
    const name = String(input.tool_name || ''), tool = input.tool_input || {}, command = String(tool.command || tool.script || '');
    if (isPastLogSearchToolUse(name, tool)) return;
    if (/^(?:Bash|PowerShell)$/.test(name) && isGateRequiredCommand(command)) return;
    if (/^(?:Bash|PowerShell)$/.test(name) && (operator.test(command) || isOperatorWrapper(command, home))) return;
    if (/^(?:Bash|PowerShell)$/.test(name) && (delegated.test(command) || isLightLaneCommand(command) || (command.length < 300 && ['read-only', 'git'].includes(classifyBashCommand(command))))) return;
    if (isDocEdit(name, tool, home)) return;
    const dir = path.join(home, '.claude', 'session-lane'), file = path.join(dir, `${input.session_id || 'unknown'}.json`);
    let state = { lane: 'unknown', toolCalls: 0 }; try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) }; } catch {}
    state.toolCalls = Number(state.toolCalls || 0) + 1;
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`); } catch {}
    if (state.userFacing === true && ['consult', 'unknown'].includes(state.lane)) return;
    let config = { warnAt: 4, blockAt: 8, mode: 'block' }; try { config = { ...config, ...JSON.parse(fs.readFileSync(path.join(home, '.claude', 'lane-guard.json'), 'utf8').replace(/^\uFEFF/, '')) }; } catch {}
    if (state.toolCalls < Number(config.warnAt)) return;
    const advice = state.primary || laneAdvice(state.lane, repo, { category: state.category, home }).primary;
    const reason = `このターンで Claude 本体が直接 ${state.toolCalls} 回ツールを叩いている。残りは ${advice} に丸ごと渡し、結果だけ受け取れ。例外は user 指示に [LANE-OK]、または user プロンプトに [CLAUDE-IMPL-OK]`;
    const laneOk = state.laneOk === true && affirmativeMarker(state.prompt, '[LANE-OK]') &&
      Date.parse(state.at) <= Date.now() && Date.parse(state.at) + 3600000 > Date.now();
    const blockable = ['implement', 'edit-small', 'verify', 'bulk'].includes(state.lane);
    if (blockable && state.toolCalls >= Number(config.blockAt) && !laneOk) {
      const decision = laneHealthDecision(home);
      output(decision);
    } else output({ additionalContext: `⚠️ ${reason}` });
  } catch {}
}
export function laneHealthDecision(home, now = Date.now()) {
  let health;
  try { health = readJson(path.join(home, '.claude', 'lane-health.json'), null) || laneDoctorQuick({ home, now }); }
  catch { return { permissionDecision: 'deny', permissionDecisionReason: 'レーン状態を読めません。先に node tools/lane-doctor.mjs --probe を実行せよ。' }; }
  if (health.implementOrder?.[0] === 'codex') return { permissionDecision: 'deny', permissionDecisionReason: 'Codex は生きている。node tools/codex-do.mjs --prompt-file <指示> --cwd <対象> へ渡せ' };
  if (Array.isArray(health.implementOrder) && health.implementOrder.length) return { permissionDecision: 'deny', permissionDecisionReason: `Codex が使えない時は ${health.implementOrder[0]} へ。生存レーン: ${health.implementOrder.join(', ')}。例: node tools/codex-do.mjs --prompt-file <指示> --cwd <対象>（内蔵フォールバックで deepseek/glm/gemini へ流れる）` };
  if (Array.isArray(health.implementOrder) && freshProbe(health.probedAt, now)) return { permissionDecision: 'deny', permissionDecisionReason: IMPLEMENTATION_DENIAL };
  return { permissionDecision: 'deny', permissionDecisionReason: '生存レーンが未確認。先に node tools/lane-doctor.mjs --probe を実行せよ。' };
}
if (isEntry(import.meta.url)) await main();
