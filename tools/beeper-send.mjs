#!/usr/bin/env node
// Beeper メッセージ送信 CLI。
// Beeper Desktop API 経由でメッセージを送信し、送信結果を読み戻して JSON 出力する。
//
// 使い方:
//   node tools/beeper-send.mjs --chat <chatID> --body-file <本文.txt> [--reply-to <messageID>] --queue-id <id> --receipt <rid>
//
// exit コード:
//   0: 正常送信（stdout に JSON）
//   2: Beeper 停止・認証エラー
//   3: 送信したが読み戻せなかった（uncertain）
//   4: receipt 無効（期限切れ・コンテキスト変化・承認状態でない）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { BeeperApiError, sendMessage, listMessages } from './beeper-api.mjs';
import { assertContextApproved, latestOf, recordOutbound } from './lib/send-context.mjs';

// ── レート制限 ───────────────────────────────────────────────────────

function sendLogPath(home) {
  return path.join(home, '.claude', 'reply-queue', 'beeper-send-log.jsonl');
}

function checkRateLimit(chatID, home) {
  const now = Date.now();
  const oneHourAgo = now - 3_600_000;
  const logPath = sendLogPath(home);

  // ログファイルがあれば読む
  let logLines = [];
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    logLines = raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).filter(e => new Date(e.ts).getTime() >= oneHourAgo);
  } catch {
    // 初回
  }

  // このチャットへの直近1時間の送信数
  const sameChat = logLines.filter(e => e.chatID === chatID).length;
  if (sameChat >= 3) {
    const oldestInWindow = logLines.filter(e => e.chatID === chatID).sort((a, b) => a.ts.localeCompare(b.ts))[0];
    const retryAfter = new Date(oldestInWindow.ts).getTime() + 3_600_000 - now;
    const err = new Error(`このチャットへの送信上限（1時間3通）に達しました。${Math.ceil(retryAfter / 60000)}分後に再試行してください`);
    err.code = 'RATE_LIMIT_CHAT';
    err.exitCode = 1;
    throw err;
  }

  // 全体の直近1時間の送信数
  if (logLines.length >= 20) {
    const oldestInWindow = logLines.sort((a, b) => a.ts.localeCompare(b.ts))[0];
    const retryAfter = new Date(oldestInWindow.ts).getTime() + 3_600_000 - now;
    const err = new Error(`全体の送信上限（1時間20通）に達しました。${Math.ceil(retryAfter / 60000)}分後に再試行してください`);
    err.code = 'RATE_LIMIT_TOTAL';
    err.exitCode = 1;
    throw err;
  }

  return logLines.length; // 既存の総数
}

function recordSend(chatID, messageID, queueID, receiptID, home) {
  const logPath = sendLogPath(home);
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    chatID,
    messageID,
    queueID,
    receiptID,
  }) + '\n';
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, entry, 'utf8');
}

// ── Receipt 検証 ──────────────────────────────────────────────────────

function verifyReceipt(home, queueID, receiptID) {
  const queuePath = path.join(home, '.claude', 'reply-queue', 'queue.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw Object.assign(new Error('返信キューが見つかりません'), { exitCode: 4 });
    }
    throw err;
  }

  const item = data.items[queueID];
  if (!item) {
    throw Object.assign(new Error(`キュー項目 ${queueID} が見つかりません`), { exitCode: 4 });
  }

  // 状態チェック
  if (!['approved', 'edited'].includes(item.state)) {
    throw Object.assign(
      new Error(`送信は approved/edited からのみ可能です（現在: ${item.state}）`),
      { exitCode: 4 },
    );
  }

  // receipt チェック
  if (!item.receipt || item.receipt.id !== receiptID) {
    throw Object.assign(new Error('receipt が一致しません'), { exitCode: 4 });
  }

  // 期限切れチェック
  if (Date.parse(item.receipt.expiresAt) <= Date.now()) {
    throw Object.assign(new Error('receipt の有効期限が切れています'), { exitCode: 4 });
  }

  return item;
}

// ── メイン送信処理 ───────────────────────────────────────────────────

async function beeperSend(options) {
  const { chatID, bodyFile, replyTo, queueID, receiptID, home } = options;

  if (!chatID) throw new Error('--chat が必要です');
  if (!bodyFile) throw new Error('--body-file が必要です');
  if (!queueID) throw new Error('--queue-id が必要です');
  if (!receiptID) throw new Error('--receipt が必要です');

  // 本文は必ずファイルから
  const text = fs.readFileSync(bodyFile, 'utf8').trim();
  if (!text) throw new Error('本文が空です');

  // 1. Receipt 検証
  const item = verifyReceipt(home, queueID, receiptID);

  // 2. レート制限チェック
  checkRateLimit(chatID, home);

  // 3. 文脈変化チェック: 案作成後に相手の新着があれば送らない
  //    基準時刻はキュー項目の receivedAt、無ければ receipt 発行時刻を使う
  const referenceAt = item.receivedAt || item.receipt?.issuedAt;
  if (referenceAt) {
    const latest = await listMessages(chatID, { limit: 10 });
    const newerFromOther = (latest.items || []).some(m =>
      !m.isSender && m.timestamp && new Date(m.timestamp) > new Date(referenceAt),
    );
    if (newerFromOther) {
      throw Object.assign(new Error('context_changed: 新着あり。案を作り直してください'), { exitCode: 4 });
    }
  }

  await assertContextApproved({ channel: 'beeper', target: chatID, text, home, getLatest: async () => {
    const latest = await listMessages(chatID, { limit: 1 });
    return latestOf((latest.items || []).map(m => ({ id: m.id, at: m.timestamp })));
  }});

  // 4. 送信
  const result = await sendMessage(chatID, text, replyTo ? { replyToMessageID: replyTo } : {});

  if (!result || !result.pendingMessageID) {
    throw Object.assign(new Error('送信結果に pendingMessageID がありません'), { exitCode: 3 });
  }

  // 5. 読み戻し（最大 15 秒待つ）
  let messageID = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    // 少し待ってから読み戻す
    await new Promise(r => setTimeout(r, 2000));
    try {
      const msgResult = await listMessages(chatID, { limit: 5, direction: 'before' });
      const sent = (msgResult.items || []).find(m => m.isSender === true && m.text && text.includes(m.text.slice(0, 40)));
      if (sent) {
        messageID = sent.id;
        break;
      }
      // pendingMessageID で直接 lookup
      try {
        const { getMessage } = await import('./beeper-api.mjs');
        const resolved = await getMessage(chatID, result.pendingMessageID);
        if (resolved && resolved.id && resolved.isSender) {
          messageID = resolved.id;
          break;
        }
      } catch { /* still pending, try again */ }
    } catch { /* try again */ }
  }

  if (!messageID) {
    // 読み戻せなかった
    process.exitCode = 3;
    return {
      ok: false,
      uncertain: true,
      pendingMessageID: result.pendingMessageID,
      chatID: result.chatID || chatID,
      reason: '送信は完了しましたが、メッセージIDを読み戻せませんでした',
    };
  }

  // 6. レート制限ログに記録
  recordSend(chatID, messageID, queueID, receiptID, home);
  recordOutbound({ channel: 'beeper', target: chatID, text, messageId: messageID }, home);

  return {
    ok: true,
    messageID,
    pendingMessageID: result.pendingMessageID,
    chatID: result.chatID || chatID,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────

async function main(args = process.argv.slice(2)) {
  const val = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
  const has = flag => args.includes(flag);

  if (has('--help') || args.length === 0) {
    console.error(`使い方: node tools/beeper-send.mjs --chat <chatID> --body-file <本文.txt> [--reply-to <messageID>] --queue-id <id> --receipt <rid>

  --chat <id>       必須。Beeper Chat ID
  --body-file <path> 必須。本文ファイル
  --reply-to <id>    返信先メッセージ ID
  --queue-id <id>    必須。reply-queue の項目 ID
  --receipt <rid>    必須。reply-queue の receipt ID
`);
    process.exit(1);
  }

  const home = process.env.ORGIAST_HOME || os.homedir();
  const chatID = val('--chat', '');
  const bodyFile = val('--body-file', '');
  const replyTo = val('--reply-to', undefined);
  const queueID = val('--queue-id', '');
  const receiptID = val('--receipt', '');

  if (has('--dry-run')) {
    if (!chatID || !bodyFile) { console.error('--dry-run にも --chat と --body-file が必要です'); return 1; }
    console.log(JSON.stringify({ dryRun: true, chatID, textLength: fs.readFileSync(bodyFile, 'utf8').trim().length }));
    return 0;
  }

  try {
    const result = await beeperSend({ chatID, bodyFile, replyTo, queueID, receiptID, home });
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 3;
  } catch (err) {
    if (err instanceof BeeperApiError) {
      const msg = err.code === 'BEEPER_DOWN'
        ? 'Beeper Desktop が起動していません'
        : err.code === 'BEEPER_UNAUTHORIZED'
          ? 'Beeper Desktop の認証に失敗しました'
          : `Beeper API エラー: ${err.message}`;
      console.error(msg);
      process.exit(2);
    }
    if (err.exitCode) {
      console.error(err.message);
      process.exit(err.exitCode);
    }
    throw err;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
