#!/usr/bin/env node

/**
 * Generates system prompt and hook config for batch-call optimization.
 *
 * CLI:
 *   node tools/batch-call-prompt.mjs          # both prompt and gate config
 *   node tools/batch-call-prompt.mjs --prompt-only   # prompt only
 *   node tools/batch-call-prompt.mjs --gate-only     # gate config only
 */

/**
 * Returns the system prompt text for batch-call optimization.
 * @returns {string}
 */
export function generatePrompt() {
  return `## ツール呼出のバッチ化
コスト削減のため、複数の独立したツール呼出を1回のバッチ呼出にまとめられないか毎回検討すること:
- 連続する Read は 1 回にまとめられないか（例: 3ファイル → Read 1回）
- 同種の Grep は正規表現を結合し 1 回のパターンで済ませる
- ファイル一覧は Glob 1 回で取得しプログラム側で絞り込む`;
}

/**
 * Returns the gate hook config (settings.json block) for batch-call optimization.
 * @returns {string}
 */
export function generateGateConfig() {
  return `{
  "hooks": {
    "PostToolCall": {
      "command": "node tools/batch-call-gate.mjs --check"
    }
  }
}`;
}

/**
 * CLI handler.
 * @param {string[]} args
 */
export function runCli(args = process.argv.slice(2)) {
  const promptOnly = args.includes('--prompt-only');
  const gateOnly = args.includes('--gate-only');

  const showPrompt = !gateOnly || (gateOnly && promptOnly);
  const showGate = !promptOnly || (promptOnly && gateOnly);

  if (showPrompt) {
    console.log('# システムプロンプト文案');
    console.log();
    console.log(generatePrompt());
    console.log();
  }

  if (showGate) {
    console.log('# settings.json hook 設定');
    console.log();
    console.log('CLAUDE.md に以下を追記してください:');
    console.log();
    console.log('```json');
    console.log(generateGateConfig());
    console.log('```');
    console.log();
  }

  if (!promptOnly && !gateOnly) {
    console.log('---');
    console.log('両方の出力を表示しました。--prompt-only でプロンプト文案のみ、--gate-only でゲート設定のみを出力します。');
  }
}

// Auto-run when executed as main script
import path from 'node:path';
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'))) {
  runCli();
}