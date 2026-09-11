#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectTranscript } from './fable-session-guard.mjs';
import { classifyBashCommand } from './usage-stats.mjs';
import { codexHardBlockBypass } from './codex-cooldown.mjs';
import { laneAdvice } from './cost-routing-gate.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';


const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delegated = /codex-do\.mjs|llm-ask\.mjs|batch-(?:enqueue|run)\.mjs|(?:^|\s)gemini\s|(?:^|\s)codex\s|wsl[^\r\n]*\bcodex\b|claude\s+-p|node[^\r\n]*usage-stats\.mjs/i;
function output(value) { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...value } })); }
function editPath(input) { return String(input.file_path || input.path || ''); }
function isDocEdit(name, input, home) {
  if (!/^(?:Edit|Write|MultiEdit)$/.test(name)) return false;
  const target = editPath(input).replace(/\\/g, '/'), claude = path.join(home, '.claude').replace(/\\/g, '/');
  return target.startsWith(claude) || /(?:memory|scratchpad)/i.test(target) || /\.md$/i.test(target);
}
async function main() {
  const raw = await readStdinWithTimeout();
  try {
    const input = JSON.parse(raw.replace(/^\uFEFF/, '')), home = process.env.ORGIAST_HOME || os.homedir();
    if (/subagents/i.test(String(input.transcript_path || '')) || fs.existsSync(path.join(home, '.claude', 'cost-enforce-override'))) return;
    let model = ''; try { model = inspectTranscript(input.transcript_path).currentModel; } catch { return; }
    if (!/(?:fable|opus)/i.test(model)) return;
    const name = String(input.tool_name || ''), tool = input.tool_input || {}, command = String(tool.command || tool.script || '');
    if (/^(?:Bash|PowerShell)$/.test(name) && (delegated.test(command) || (command.length < 300 && ['read-only', 'git'].includes(classifyBashCommand(command))))) return;
    if (isDocEdit(name, tool, home)) return;
    const dir = path.join(home, '.claude', 'session-lane'), file = path.join(dir, `${input.session_id || 'unknown'}.json`);
    let state = { lane: 'unknown', toolCalls: 0 }; try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) }; } catch {}
    state.toolCalls = Number(state.toolCalls || 0) + 1;
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`); } catch {}
    let config = { warnAt: 4, blockAt: 8, mode: 'block' }; try { config = { ...config, ...JSON.parse(fs.readFileSync(path.join(home, '.claude', 'lane-guard.json'), 'utf8').replace(/^\uFEFF/, '')) }; } catch {}
    if (state.toolCalls < Number(config.warnAt)) return;
    const advice = state.primary || laneAdvice(state.lane, repo, { category: state.category, home }).primary;
    const reason = `このターンで Fable/Opus 本体が直接 ${state.toolCalls} 回ツールを叩いている。残りは ${advice} か Agent(model:"sonnet") に丸ごと渡し、結果だけ受け取れ。例外は user 指示に [LANE-OK]、または ~/.claude/cost-enforce-override`;
    const blockable = ['implement', 'edit-small', 'verify', 'bulk'].includes(state.lane);
    const bypass = codexHardBlockBypass(Date.now(), path.join(home, '.claude', 'provider-cooldown.json')).bypass;
    if (blockable && state.toolCalls >= Number(config.blockAt) && config.mode === 'block' && !state.laneOk && !bypass) output({ permissionDecision: 'deny', permissionDecisionReason: reason });
    else output({ additionalContext: `⚠️ ${reason}` });
  } catch {}
}
await main();
