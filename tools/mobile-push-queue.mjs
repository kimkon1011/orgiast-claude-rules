#!/usr/bin/env node
// スマホ通知要求キュー（~/.claude/mobile-push-queue.jsonl）の参照・既読化 CLI。
// 使い方:
//   node tools/mobile-push-queue.mjs --list [--all]   … 未送信（--all で全行）を JSON 行で表示
//   node tools/mobile-push-queue.mjs --mark-sent <id> [--mark-sent <id> ...]  … 送信済みにする
//   node tools/mobile-push-queue.mjs --mark-attempt <id> [--mark-attempt <id> ...]  … 送信失敗回数を増やす
// テスト・診断用に --home <dir> で対象 HOME を切り替えられる。
import os from 'node:os';
import { isEntry } from './is-entry.mjs';
import { readMobilePushQueue, pendingMobilePush, markMobilePushAttempt, markMobilePushSent } from './lib/mobile-push-queue.mjs';

import { sweepMobilePushQueue } from './lib/mobile-push-queue.mjs';
import { spoolItem } from './kim-inbox.mjs';

export function main(args = process.argv.slice(2), { home = process.env.ORGIAST_HOME || os.homedir(), out = console.log } = {}) {
  let all = false;
  let sweep = false;
  let dryRun = false;
  const sentIds = [];
  const attemptIds = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') { /* 一覧は既定の動作 */ }
    else if (args[i] === '--all') all = true;
    else if (args[i] === '--sweep') sweep = true;
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--mark-sent') {
      const id = args[++i];
      if (!id || id.startsWith('--')) throw new Error('--mark-sent には id が1つ必要です');
      sentIds.push(id);
    } else if (args[i] === '--mark-attempt') {
      const id = args[++i];
      if (!id || id.startsWith('--')) throw new Error('--mark-attempt には id が1つ必要です');
      attemptIds.push(id);
    } else if (args[i] === '--home') {
      const value = args[++i];
      if (!value) throw new Error('--home にはパスが必要です');
      home = value;
    } else throw new Error(`不明な引数: ${args[i]}`);
  }
  if (sweep) {
    const result = sweepMobilePushQueue(home, { dryRun });
    out(JSON.stringify(result));
    return 0;
  }
  if (sentIds.length && attemptIds.length) throw new Error('--mark-sent と --mark-attempt は同時に指定できません');
  if (sentIds.length) {
    const result = markMobilePushSent(home, sentIds);
    out(JSON.stringify(result));
    return result.marked.length ? 0 : 1;
  }
  if (attemptIds.length) {
    const result = markMobilePushAttempt(home, attemptIds);
    if (result.escalated?.length) {
      const spooled = escalateToKimInbox(home, result.escalated);
      result.spooled = spooled;
    }
    out(JSON.stringify(result));
    return result.bumped.length ? 0 : 1;
  }
  for (const row of (all ? readMobilePushQueue(home) : pendingMobilePush(home))) out(JSON.stringify(row));
  return 0;
}

// 試行上限に達した項目を kim-inbox の info として spool する。
// 重複本文は1件にまとめて spool する。各 spool は次回の kim-inbox 処理で取込まれる。
function escalateToKimInbox(home, items) {
  const seen = new Set();
  let count = 0;
  for (const item of items) {
    const body = String(item.body || '').trim();
    if (!body) continue;
    if (seen.has(body)) continue;
    seen.add(body);
    const title = String(item.title || '').trim();
    const text = `【スマホ通知が送れなかったため転記】${title ? `（${title}）\n` : ''}${body}`;
    try {
      spoolItem(home, { kind: 'info', text, source: 'mobile-push-escalation', priority: 'high' });
      count++;
    } catch (error) {
      console.error(`mobile-push: kim-inbox へのエスカレーション spool 失敗: ${error.message}`);
    }
  }
  return count;
}

if (isEntry(import.meta.url)) process.exitCode = main();
