#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "model-agent-guard", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "model-agent-guard"}, {"kind": "keyserve-key", "ref": "deepseek.env#DEEPSEEK_API_KEY"}]};
import { IMPLEMENT } from './cost-routing-gate.mjs';
import { implApproved } from './lib/claude-approval.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFablePolicy, fableAllowedForSubagent } from './fable-policy.mjs';
import { inspectTranscript } from './fable-session-guard.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

const raw = await readStdinWithTimeout();
try {
  if (!raw) process.exit(0);
  const input = JSON.parse(raw);
  if (!/^(Agent|Task)$/.test(String(input.tool_name || ''))) process.exit(0);
  const toolInput = input.tool_input || {};
  if (IMPLEMENT.test(String(toolInput.prompt || '')) &&
      !/^(Explore|Plan|claude-code-guide|biz-reader|statusline-setup)$/i.test(String(toolInput.subagent_type || '')) &&
      !implApproved(process.env.ORGIAST_HOME || os.homedir(), input.session_id)) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '実装サブエージェントは禁止(§1.17)。node tools/codex-do.mjs --prompt-file <指示> --cwd <対象> へ。例外は user の [CLAUDE-IMPL-OK]' } }));
    process.exit(0);
  }
  // model 省略は親を継承するため、Fable メインでは意図せず単価2倍の実働になる。
  if (!toolInput.model) {
    let currentModel = '';
    try { currentModel = inspectTranscript(input.transcript_path).currentModel; } catch {}
    if (/fable/i.test(currentModel)) {
      const reason = '省略すると Fable(単価2倍)を継承する。model を明示: 量産/編集/確認は "sonnet"、分類は "haiku"、設計判断のみ "opus"。実装は Codex へ';
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
      process.exit(0);
    }
  }
  const subagentType = String(toolInput.subagent_type || '');
  const exploratory = /^(Explore|general-purpose|Plan)$/i.test(subagentType);
  const expensiveOrImplicit = !toolInput.model || /(?:opus|fable)/i.test(String(toolInput.model));
  // Fable 指定は探索・専門agent・その他を問わず従来どおり deny(§1.16: サブエージェント=実装/量産なので
  // 単価2倍は使わない)。探索ブランチや専門agentの早期 return より先に判定しないと
  // Explore+fable が「安経路の案内」で、専門agent+fable が無干渉で通ってしまう。
  if (/fable/i.test(`${toolInput.model || ''} ${subagentType}`)) {
    const policy = loadFablePolicy({ dir: process.env.ORGIAST_FABLE_POLICY_DIR || undefined });
    if (fableAllowedForSubagent(policy)) {
      const context = `Fable5を許可: policyによりサブエージェントでの使用が許可されています`;
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }));
      process.exit(0);
    }
    const home = process.env.ORGIAST_HOME || os.homedir();
    try {
      const allow = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'fable-allow.json'), 'utf8'));
      const unexpired = Date.parse(allow.until) > Date.now();
      const sameSession = !allow.sessionId || allow.sessionId === input.session_id;
      if (unexpired && sameSession) {
        const context = `§1.16例外を適用: user明示指定によりFable5を許可(別課金枠・期限 ${allow.until})`;
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }));
        process.exit(0);
      }
    } catch {}
    let reason;
    if (policy.planIncluded === true) {
      reason = '§1.16(2026-09-03改定): Fable は定額内だが監督(メインループ)専用。サブエージェント=実装/量産なので単価2倍の Fable は使わない。model を省略(監督継承)か "sonnet"/"haiku" にするか、実装なら Codex(node tools/codex-do.mjs)へ委譲して再実行。';
    } else {
      reason = 'このアカウントでは Fable が定額内と未確認(tools/fable-policy.json)。組織ポリシー §1.16 で Fable5(claude-fable-5)は全用途禁止(別課金枠)。model を省略(監督継承)か "sonnet"(生成/量産)/"haiku"(分類)に変えて再実行。実装なら Codex(`node tools/codex-do.mjs`)へ。';
    }
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    process.exit(0);
  }
  // 専門agent(biz-reader/statusline-setup/claude-code-guide)は専用の指示・ガイドを信頼する。
  // プロンプトが「実装」っぽくても下流の実装委譲ブロックに落とさず無干渉にする。
  // (Fable 指定だけは上で deny 済み。model 無指定のまま無干渉で通す。)
  if (/^(biz-reader|statusline-setup|claude-code-guide)$/i.test(subagentType)) process.exit(0);
  if (exploratory && expensiveOrImplicit) {
    const home = process.env.ORGIAST_HOME || os.homedir();
    let mode = 'warn';
    try { mode = String(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'cost-enforce.json'), 'utf8')).mode || 'warn'); } catch {}
    const advice = '探索/調査は `gemini -p "<質問>" --include-directories <dir>`(OAuth無料枠) または `node tools/codex-do.mjs --review --prompt-file <file>`(定額)。Claudeサブエージェントは最後の手段。使うなら model:"haiku"。';
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...(mode === 'block' ? { permissionDecision: 'deny', permissionDecisionReason: advice } : { additionalContext: advice }) } }));
    process.exit(0);
  }

} catch {}
process.exit(0);
