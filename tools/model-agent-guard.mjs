#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFablePolicy, fableAllowedForSubagent } from './fable-policy.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
try {
  if (!raw) process.exit(0);
  const input = JSON.parse(raw);
  if (!/^(Agent|Task)$/.test(String(input.tool_name || ''))) process.exit(0);
  const toolInput = input.tool_input || {};
  if (/fable/i.test(`${toolInput.model || ''} ${toolInput.subagent_type || ''}`)) {
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

  const prompt = String(toolInput.prompt || '');
  const readOnlyType = /^(Explore|biz-reader)$/i.test(String(toolInput.subagent_type || ''));
  const readOnlyPrompt = /調査|探索|検索|読んで|一覧/.test(prompt) && !/実装|コードを書|新規作成|リファクタ|refactor|バグ|fix|implement|関数を追加|ファイルを作成|コンポーネント|エンドポイント|マイグレーション|migration/i.test(prompt);
  const implementation = /実装|コードを書|新規作成|リファクタ|refactor|バグ|fix|implement|関数を追加|ファイルを作成|コンポーネント|エンドポイント|マイグレーション|migration/i.test(prompt);
  if (!implementation || /codex/i.test(prompt) || readOnlyType || readOnlyPrompt) process.exit(0);

  const home = process.env.ORGIAST_HOME || os.homedir();
  let mode = 'warn';
  try { mode = String(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'cost-enforce.json'), 'utf8')).mode || 'warn'); } catch {}
  if (fs.existsSync(path.join(home, '.claude', 'cost-enforce-override'))) mode = 'warn';
  const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const command = `node "${path.join(repo, 'tools', 'codex-do.mjs')}" "指示"`;
  if (mode === 'block') {
    const reason = `実装をサブエージェント(従量課金)に投げるのは §1.18 違反。\`${command}\` (定額枠)へ。どうしても必要なら ~/.claude/cost-enforce-override を作成。`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  } else {
    const context = `⚠️ §1.18: 実装を従量課金のサブエージェントへ投げようとしています。定額枠の Codex に \`${command}\` で委譲し、監督は設計・レビュー・verifyを担当してください。`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }));
  }
} catch {}
process.exit(0);
