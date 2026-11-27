#!/usr/bin/env node
/**
 * claude-with-settings.mjs — VS Code拡張UI設定をCLIフラグで再現するラッパー
 *
 * VS Code拡張の設定UI（ブラウザ拡張）で行っていた操作をCLIフラグに切り替え、
 * ブラウザスナップショットによるトークン消費を抑制する（X-0045）。
 *
 * 使い方:
 *   node tools/claude-with-settings.mjs --model sonnet -p "プロンプト"
 *   node tools/claude-with-settings.mjs --model opus --effort high --permission bypass -p "タスク"
 *
 * フラグ:
 *   --model <model>      モデル指定（sonnet/opus/haiku/fable）
 *   --effort <level>    努力レベル（low/medium/high/xhigh/max）
 *   --permission <mode> 権限モード（bypass/manual/acceptEdits/plan）
 *   -p/--print <prompt> プロンプト（省略時はインタラクティブ起動）
 */

import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const args = { claudeArgs: [] };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--model':
        args.model = argv[++i];
        break;
      case '--effort':
        args.effort = argv[++i];
        break;
      case '--permission':
        args.permission = argv[++i];
        break;
      case '-p':
      case '--print':
        args.prompt = argv[++i];
        args.print = true;
        break;
      default:
        args.claudeArgs.push(arg);
    }
  }
  return args;
}

function buildClaudeArgs(args) {
  const claudeArgs = [];
  if (args.model) claudeArgs.push('--model', args.model);
  if (args.effort) claudeArgs.push('--effort', args.effort);
  if (args.permission) {
    const modeMap = { bypass: 'bypassPermissions', manual: 'manual', acceptEdits: 'acceptEdits', plan: 'plan' };
    claudeArgs.push('--permission-mode', modeMap[args.permission] || args.permission);
  }
  if (args.print) claudeArgs.push('-p', args.prompt);
  claudeArgs.push(...args.claudeArgs);
  return claudeArgs;
}

const parsed = parseArgs(process.argv);
const claudeArgs = buildClaudeArgs(parsed);

console.error(`[claude-with-settings] 起動: claude ${claudeArgs.join(' ')}`);
console.error(`[claude-with-settings] 設定元: VS Code拡張UI → CLIフラグ（X-0045）`);
console.error(`[claude-with-settings] トークン削減: ~6,600→~150（97.7%削減）`);

const child = spawn('claude', claudeArgs, {
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});