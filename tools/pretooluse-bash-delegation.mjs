#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyBashCommand } from './usage-stats.mjs';

try {
  let raw = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) raw += chunk;
  const j = JSON.parse(raw), tool = String(j.tool_name || ''); if (!/^(Bash|PowerShell)$/.test(tool)) process.exit(0);
  const command = String(j.tool_input?.command || '');
  if (classifyBashCommand(command) !== 'inline-program') process.exit(0);
  const size = command.length, lines = command.split(/\r?\n/).length;
  if (size < 900 && lines < 25) process.exit(0);
  const home = process.env.ORGIAST_HOME || os.homedir(), repo = process.env.ORGIAST_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let mode = 'warn'; try { mode = String(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'cost-enforce.json'), 'utf8')).mode); } catch {}
  const override = fs.existsSync(path.join(home, '.claude', 'cost-enforce-override'));
  const example = `node "${path.join(repo, 'tools', 'codex-do.mjs')}" "この解析・実装を実行し、結果を検証可能な形で返す"`;
  if (mode === 'block' && !override && size >= 1500) {
    const reason = `🔒 委譲ハードブロック(§1.18): 約${size}文字の使い捨てインラインプログラムを停止しました。${example} へ委譲してください。例外が必要なら ~/.claude/cost-enforce-override を作成してください。委譲率が上がれば自動解除されます。`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  } else {
    const msg = `⚠️ 委譲規律(§1.18): 使い捨ての解析スクリプト(約${size}文字)を手打ちしています。\n**再利用可能な集計なら \`node tools/usage-stats.mjs <sub>\` を使う**、一回性の実装なら \`node tools/codex-do.mjs "…"\` へ委譲してください。\n実行例: \`${example}\``;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } }));
  }
} catch {}
