#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "pretooluse-delegation-warn", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "pretooluse-delegation-warn"}, {"kind": "keyserve-key", "ref": "deepseek.env#DEEPSEEK_API_KEY"}]};
import os from 'node:os';
import path from 'node:path';
import { implApproved, IMPLEMENTATION_DENIAL } from './lib/claude-approval.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

const raw = await readStdinWithTimeout();
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
  const home = process.env.ORGIAST_HOME || os.homedir();
  const substantial = tool === 'Write' || tool === 'MultiEdit' || (tool === 'Edit' && String(j.tool_input?.new_string || '').length > 400);
  if (!substantial) process.exit(0);
  const approval = implApproved(home, j.session_id);
  const result = approval
    ? { additionalContext: `user 承認 [CLAUDE-IMPL-OK] により許可（期限 ${approval.until}）` }
    : { permissionDecision: 'deny', permissionDecisionReason: `🔒 委譲ハードブロック(§1.18): Claude 単独実装は禁止。${IMPLEMENTATION_DENIAL}` };
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...result } }));
} catch {}
