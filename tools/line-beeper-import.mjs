#!/usr/bin/env node
/**
 * Beeper 経由で LINE メッセージを取得し、~/.claude/line-openchat/YYYY-MM.jsonl に取り込む
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listChats, listMessages, getAccounts } from './beeper-api.mjs';

const LINE_ACCOUNT_ID = 'line.U9-I1LEYMoWVTwBzC7Bk4JgW6ptT4DwfdE6Z5sWNTTo8';
const EXCLUDED_CHAT_IDS = new Set([
  '!personal', // プライベート会話
]);

function extractText(msg) {
  if (msg.type !== 'TEXT' || !msg.text) return null;
  // Beeper の HTML タグを除去
  const text = msg.text.replace(/<[^>]+>/g, '').trim();
  return text || null;
}

function toJsonlRecord(msg, chatTitle) {
  const text = extractText(msg);
  if (!text) return null;
  const ts = new Date(msg.timestamp).getTime();
  return {
    id: `${msg.chatID}-${msg.id}`,
    chat: chatTitle || msg.chatID,
    sender: msg.senderName || 'unknown',
    text,
    ts,
    receivedAt: msg.timestamp,
  };
}

function getMonthFile(homeDir, ts) {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return path.join(homeDir, `${d.getFullYear()}-${month}.jsonl`);
}

export async function main() {
  const homeDir = path.join(os.homedir(), '.claude', 'line-openchat');
  fs.mkdirSync(homeDir, { recursive: true });

  // 全チャットを取得し LINE のみフィルタ
  const chatsResult = await listChats({ limit: 500 });
  const chats = (chatsResult.items || []).filter(c => c.accountID === LINE_ACCOUNT_ID);
  console.log(`LINE チャット数: ${chats.length}`);

  let totalImported = 0;
  const monthFiles = new Map(); // path -> lines[]

  for (const chat of chats) {
    if (EXCLUDED_CHAT_IDS.has(chat.id)) continue;
    if (!chat.title || chat.title.trim() === '') continue;

    try {
      const msgsResult = await listMessages(chat.id, { limit: 100 });
      const msgs = msgsResult.items || [];

      for (const msg of msgs) {
        const record = toJsonlRecord(msg, chat.title);
        if (!record) continue;

        const filePath = getMonthFile(homeDir, record.ts);
        if (!monthFiles.has(filePath)) monthFiles.set(filePath, []);
        monthFiles.get(filePath).push(JSON.stringify(record));
        totalImported++;
      }
    } catch (e) {
      console.error(`  スキップ: ${chat.title} - ${e.message}`);
    }
  }

  // monthFiles を追記モードで書き込み（既存データを保持）
  for (const [filePath, lines] of monthFiles) {
    const mode = fs.existsSync(filePath) ? 'a' : 'w';
    const prefix = mode === 'a' ? '\n' : '';
    fs.writeFileSync(filePath, prefix + lines.join('\n') + '\n', 'utf8');
    const stats = fs.statSync(filePath);
    console.log(`  ${path.basename(filePath)}: ${lines.length}件追加（計${stats.size}bytes）`);
  }

  console.log(`\n取り込み完了: 合計 ${totalImported} 件`);

  // 確認: 最新タイムスタンプを読み取る
  const month = String(new Date().getMonth() + 1).padStart(2, '0');
  const currentFile = path.join(homeDir, `2026-${month}.jsonl`);
  if (fs.existsSync(currentFile)) {
    const lines = fs.readFileSync(currentFile, 'utf8').split(/\r?\n/).filter(l => l.trim());
    const lastLine = lines[lines.length - 1];
    if (lastLine) {
      const last = JSON.parse(lastLine);
      console.log(`  最新メッセージ: ${new Date(last.ts).toISOString()} [${last.chat}] ${last.sender}: ${last.text.slice(0, 50)}`);
    }
  }

  return totalImported;
}

await main();