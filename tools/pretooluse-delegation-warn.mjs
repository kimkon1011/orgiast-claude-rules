#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
try {
  if (!raw) process.exit(0);
  const j = JSON.parse(raw);
  const tool = String(j.tool_name || '');
  if (!/^(Write|Edit|MultiEdit)$/.test(tool)) process.exit(0);
  const fp = String(j.tool_input?.file_path || '');
  if (!fp) process.exit(0);
  const lower = fp.toLowerCase().replaceAll('/', '\\');
  const exclude = ['\\memory\\','\\.claude\\','rules-extracted','onboarding-compress','\\docs\\','node_modules','\\tools\\','\\.git\\','scratchpad','\\test\\','\\tests\\','\\__tests__\\','.test.','.spec.','.stories.'];
  if (exclude.some((x) => lower.includes(x))) process.exit(0);
  const codeExt = ['.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.go','.rs','.java','.gs','.vue','.svelte','.php','.rb','.cs','.kt','.swift','.ps1'];
  if (!codeExt.includes(path.extname(lower))) process.exit(0);
  const name = path.basename(fp);
  const home = process.env.ORGIAST_HOME || os.homedir();
  let mode = 'warn';
  try { mode = String(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'cost-enforce.json'), 'utf8')).mode); } catch {}
  const override = fs.existsSync(path.join(home, '.claude', 'cost-enforce-override'));
  const substantial = tool === 'Write' || tool === 'MultiEdit' || (tool === 'Edit' && String(j.tool_input?.new_string || '').length > 400);
  if (mode === 'block' && substantial && !override) {
    const deny = `🔒 委譲ハードブロック(§1.18): 直近1週間、安いAIへの委譲率が改善しなかったため、アプリ実装コード(${name})のまとまった直接編集を停止します。この実装は Codex(定額枠 \`codex exec\`)へ委譲し、結果を verify してください。どうしても直接編集が必要なら ~/.claude/cost-enforce-override ファイルを作成(または委譲率を上げれば自動解除)。`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: deny } }));
  } else {
    const msg = `⚠️ 委譲規律(§1.18): これはアプリ実装コード(${name})の直接編集です。監督(main loop)は大きな実装を手打ちせず、原則 Codex(定額枠)へ委譲してください。ごく短い修正(数行/typo/import)なら続行可。まとまった実装なら、この編集を止めて \`codex exec\` に投げ、結果を verify する方が安く速く正確です。`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } }));
  }
} catch {}
