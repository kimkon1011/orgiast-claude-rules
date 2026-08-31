#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let raw = '';
process.stdin.setEncoding('utf8');

for await (const chunk of process.stdin) {
  raw += chunk;
}

try {
  if (!raw.trim()) {
    process.exit(0);
  }

  const input = JSON.parse(raw);
  const hookSpecificOutput = input.hookSpecificOutput || {};
  const suggestion = hookSpecificOutput.suggestCodexDelegation;

  if (!suggestion || !suggestion.command) {
    process.exit(0);
  }

  // Display the suggestion
  console.log('');
  console.log('\x1b[36m[実装タスク待機中]\x1b[0m');
  console.log(`\x1b[33mコマンド:\x1b[0m ${suggestion.command}`);
  console.log(`\x1b[33m理由:\x1b[0m ${suggestion.reason || ''}`);
  console.log('実装タスクを Codex に委譲しますか？');
  console.log('  • 実行: /codex で新セッション開始、またはコマンドをコピペして手動実行');
  console.log('  • スキップ: Claude が実装を継続');
  console.log('');

} catch (err) {
  // Silent fail on parse errors
}

process.exit(0);
