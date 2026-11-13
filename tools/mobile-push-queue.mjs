#!/usr/bin/env node
// スマホ通知要求キュー（~/.claude/mobile-push-queue.jsonl）の参照・既読化 CLI。
// 使い方:
//   node tools/mobile-push-queue.mjs --list [--all]   … 未送信（--all で全行）を JSON 行で表示
//   node tools/mobile-push-queue.mjs --mark-sent <id> [--mark-sent <id> ...]  … 送信済みにする
// テスト・診断用に --home <dir> で対象 HOME を切り替えられる。
import os from 'node:os';
import { isEntry } from './is-entry.mjs';
import { readMobilePushQueue, pendingMobilePush, markMobilePushSent } from './lib/mobile-push-queue.mjs';

export function main(args = process.argv.slice(2), { home = process.env.ORGIAST_HOME || os.homedir(), out = console.log } = {}) {
  let all = false;
  const ids = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') { /* 一覧は既定の動作 */ }
    else if (args[i] === '--all') all = true;
    else if (args[i] === '--mark-sent') {
      const id = args[++i];
      if (!id || id.startsWith('--')) throw new Error('--mark-sent には id が1つ必要です');
      ids.push(id);
    } else if (args[i] === '--home') {
      const value = args[++i];
      if (!value) throw new Error('--home にはパスが必要です');
      home = value;
    } else throw new Error(`不明な引数: ${args[i]}`);
  }
  if (ids.length) {
    const result = markMobilePushSent(home, ids);
    out(JSON.stringify(result));
    return result.marked.length ? 0 : 1;
  }
  for (const row of (all ? readMobilePushQueue(home) : pendingMobilePush(home))) out(JSON.stringify(row));
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = main();
