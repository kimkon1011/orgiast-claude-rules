#!/usr/bin/env node
// 影響調査: 自動返信が合成メッセージに返信していないか確認（読み取りのみ、送信しない）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const SYNTHETIC_PTN = /started a call|Use the Discord app to answer|不在着信|missed call/i;

/**
 * 過去 N 日間の sent-log.jsonl（where:'dm'）を調査し、
 * 各自動返信の質問に合成メッセージが混入した疑いを一覧化する。
 * スクリプト単体で完結するため、Beeper API への依存は無い。
 * sent-log.jsonl の replyId と channelId を使い、既存の sent-log
 * データのみから判定する。
 *
 * NOTE: 実際の返信先が合成メッセージかどうかを確定するには Beeper
 * の会話履歴を読む必要がある。本スクリプトは sent-log.jsonl の
 * linkedMessageID が利用可能かどうかに依存する。
 * sent-log.jsonl には replyId のみ保存されており、replyToMessageID
 * （返信先メッセージID）は保存されていない。そのため、現状の
 * sent-log.jsonl だけでは完全な判定はできない。
 * 本スクリプトは sent-log.jsonl のエントリ一覧と特徴量を出力し、
 * 合成メッセージへの返信が疑われるものを特定する。
 */
async function main(args = process.argv.slice(2)) {
  const daysIndex = args.indexOf('--days');
  const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : 7;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    console.error('--days must be an integer between 1 and 365');
    process.exit(1);
  }

  const home = os.homedir();
  const sentLogFile = path.join(home, '.claude', 'discord-autoreply', 'sent-log.jsonl');

  if (!fs.existsSync(sentLogFile)) {
    console.log(JSON.stringify({ ok: true, days, count: 0, entries: [], note: 'sent-log.jsonl not found' }));
    return 0;
  }

  const cutoff = Date.now() - days * 86400000;
  const rawLines = fs.readFileSync(sentLogFile, 'utf8').split('\n').filter(Boolean);
  const entries = [];

  for (const line of rawLines) {
    try {
      const entry = JSON.parse(line);
      // DM（Beeper）送信のみ対象
      if (entry.where !== 'dm') continue;
      const ts = Date.parse(entry.ts);
      if (!Number.isFinite(ts) || ts < cutoff) continue;

      // 疑わしいエントリを洗い出す
      // question の内容に合成メッセージパターンが含まれているか
      const questionText = entry.question || '';
      const suspicious = SYNTHETIC_PTN.test(questionText);

      entries.push({
        ts: entry.ts,
        channelName: entry.channelName || '(unknown)',
        channelId: entry.channelId || '(unknown)',
        replyId: entry.replyId || '(unknown)',
        senderName: entry.senderName || '(unknown)',
        questionPreview: questionText.slice(0, 80),
        contentPreview: (entry.content || '').slice(0, 60),
        suspicious,
      });
    } catch {
      // ignore parse errors
    }
  }

  console.log(JSON.stringify({
    ok: true,
    days,
    totalDmEntries: entries.length,
    suspiciousCount: entries.filter(e => e.suspicious).length,
    entries,
  }, null, 2));
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
