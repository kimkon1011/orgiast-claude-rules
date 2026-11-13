#!/usr/bin/env node
// Beeper 未返信メッセージ収集 CLI。
// Beeper Desktop API から未返信チャットを収集し、reply-queue の enqueue 形式で出力する。
// 読み取り専用。既読を付けない。
//
// 使い方:
//   node tools/beeper-unreplied.mjs --since 7d [--networks line,messenger,whatsapp,sms] [--out <json>]
//
// exit コード:
//   0: 正常終了（0件でも 0）
//   2: Beeper 停止・認証エラー（stderr に日本語理由）

import fs from 'node:fs';
import path from 'node:path';
import { BeeperApiError, getAccounts, listChats, listMessages } from './beeper-api.mjs';

// ── 期間パース ───────────────────────────────────────────────────────

function parseDuration(str) {
  const m = str.match(/^(\d+)\s*([dhms])$/);
  if (!m) throw new Error(`--since の形式が不正です: ${str}（例: 7d, 2h, 30m）`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }[unit] || 86_400_000;
  return n * ms;
}

// ── ネットワーク名マッピング ─────────────────────────────────────────

// Beeper の Chat.network 値 → 内部チャネル名（チャットレベルは account と表記が違う）
const NETWORK_TO_CHANNEL = {
  'LINE': 'line',
  'line': 'line',
  'Facebook': 'messenger',
  'Facebook/Messenger': 'messenger',
  'WhatsApp': 'whatsapp',
  'Google Messages': 'sms',
  'Discord': 'discord',
  'Beeper': 'beeper',
  'ChatGPT Dots': 'chatgpt',
  'Grok Bot': 'grok',
};

function channelFromNetwork(nw) {
  return NETWORK_TO_CHANNEL[nw] || (nw ? nw.toLowerCase().replace(/\s+/g, '') : 'unknown');
}

// ── ネットワーク名エイリアス（--networks 入力値の正規化） ────────────────

// CLI 引数のネットワーク名 → 内部チャネル名。
// channelFromNetwork が返すチャネル名は 'messenger' / 'sms' なので、
// 旧表記の 'facebook' / 'googlemessages' も同じチャネルに正規化する。
const NETWORK_ALIASES = {
  'line': 'line',
  'messenger': 'messenger',
  'facebook': 'messenger',
  'whatsapp': 'whatsapp',
  'sms': 'sms',
  'googlemessages': 'sms',
  'google-messages': 'sms',
};

function normalizeNetwork(raw) {
  const normalized = String(raw).toLowerCase().replace(/[\s_-]+/g, '');
  return NETWORK_ALIASES[normalized] || normalized;
}

function normalizeNetworks(csv) {
  return [...new Set(csv.split(',').map(s => s.trim()).filter(Boolean).map(normalizeNetwork))];
}

// ── 公式アカウント判定 ───────────────────────────────────────────────

// 部分一致は「公式」「official」のみ。bot 判定は participants の isNetworkBot
// （isBotParticipant）を主にする（'bot' 等を部分一致にすると 'Abbott' 等の
// 人名まで除外してしまう）。
const OFFICIAL_ACCOUNT_KEYWORDS = [
  '公式', 'official',
];

function looksLikeOfficial(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return OFFICIAL_ACCOUNT_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

function isBotParticipant(participants, senderID) {
  if (!participants?.items) return false;
  return participants.items.some(p => p.id === senderID && p.isNetworkBot === true);
}

// ── 収集メイン ───────────────────────────────────────────────────────

async function collectUnreplied({ sinceMs, networks, outFile }) {
  const since = new Date(Date.now() - sinceMs);

  // 1. アカウント一覧 → 対象ネットワークの accountID と kim の自己 ID を収集
  //    チャットの network は表示用で account と表記が違う（'line'・'Facebook/Messenger' 等）ため、
  //    チャネル解決は accountID ベースで行う
  const accounts = await getAccounts();
  const targetAccountIDs = new Set();
  const channelByAccountID = new Map(); // accountID → チャネル（出力用）
  const selfUserIDs = new Set(); // kim の自己ID。メンションは Beeper/Matrix ID で届くため全アカウントを合算

  for (const acc of accounts) {
    const ch = channelFromNetwork(acc.network);
    if (networks.includes(ch)) {
      targetAccountIDs.add(acc.accountID);
      channelByAccountID.set(acc.accountID, ch);
    }
    if (acc.user?.isSelf && acc.user?.id) {
      selfUserIDs.add(acc.user.id);
    }
  }

  if (targetAccountIDs.size === 0) return [];

  // 2. 全チャットを取得（ページネーション）
  const allChats = [];
  let cursor = null;
  for (let safety = 0; safety < 20; safety++) {
    const result = await listChats({ limit: 200, cursor, direction: cursor ? 'before' : undefined });
    allChats.push(...result.items);
    if (!result.hasMore || !result.oldestCursor) break;
    cursor = result.oldestCursor;
  }

  // 3. 対象アカウントのチャットをフィルタ
  const candidates = allChats.filter(c => {
    if (!targetAccountIDs.has(c.accountID)) return false;
    if (c.isArchived) return false;
    if (c.isMuted) return false;
    if (c.isLowPriority) return false;
    if (c.isReadOnly) return false;
    if (!c.lastActivity) return false;
    if (new Date(c.lastActivity) < since) return false;
    return true;
  });

  // 4. 各チャットのメッセージを取得して未返信判定
  const results = [];

  for (const chat of candidates) {
    const msgResult = await listMessages(chat.id, { limit: 50, direction: 'before' });
    const allMsgs = msgResult.items || [];
    if (allMsgs.length === 0) continue;

    // 期間内のメッセージに絞る
    const periodMsgs = allMsgs.filter(m => new Date(m.timestamp) >= since);
    if (periodMsgs.length === 0) continue;

    // 期間内の最後のメッセージ（送信者を問わない）
    const sortedAll = [...periodMsgs].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const lastMsg = sortedAll[sortedAll.length - 1];

    // kim が最後に送信していれば返信済み・未返信ではない
    if (lastMsg.isSender) continue;

    // 期間内で相手からのメッセージがなければスキップ（kim の一方的な発言だけのチャット）
    const otherMsgs = periodMsgs.filter(m => !m.isSender);
    if (otherMsgs.length === 0) continue;

    // グループチャット: メンションか kim への返信があるか
    if (chat.type === 'group') {
      const hasKimMentionOrReply = otherMsgs.some(m => {
        // メンション（kim の自己IDは Beeper/Matrix ID を含む全アカウント合算）
        if (m.mentions && Array.isArray(m.mentions)) {
          for (const mention of m.mentions) {
            if (mention === '@room') continue;
            if (selfUserIDs.has(mention)) return true;
          }
        }
        // 返信: linkedMessageID が kim の送信メッセージかどうか
        if (m.linkedMessageID) {
          const linkedMsg = allMsgs.find(x => x.id === m.linkedMessageID);
          if (linkedMsg && linkedMsg.isSender) return true;
        }
        return false;
      });
      if (!hasKimMentionOrReply) continue;
    }

    // この時点で lastMsg は相手の発言（kim の発言の後追いでない）
    const sorted = [...otherMsgs].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // bot/公式アカウントの送信は除外
    if (looksLikeOfficial(lastMsg.senderName)) continue;
    if (isBotParticipant(chat.participants, lastMsg.senderID)) continue;

    // 本文: 相手の連続する発言を連結
    // 期間内の全メッセージを時系列順で、相手の連続発言を最後から辿る
    const allSorted = [...allMsgs].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const bodyParts = [];
    for (let i = allSorted.length - 1; i >= 0; i--) {
      const m = allSorted[i];
      if (m.isSender) break; // kim の発言で区切る
      if (m.type && m.type !== 'TEXT' && m.type !== 'NOTICE') continue;
      if (m.text) bodyParts.unshift(m.text);
    }
    if (bodyParts.length === 0) continue;

    // コンテキスト: 直前 5 件
    const contextMsgs = sorted.slice(-5).map(m => ({
      sender: m.senderName || '',
      body: m.text || '',
      at: m.timestamp,
    }));

    results.push({
      channel: channelByAccountID.get(chat.accountID) || channelFromNetwork(chat.network || ''),
      thread: `beeper:${chat.id}`,
      message: lastMsg.id,
      from: {
        id: lastMsg.senderID || '',
        name: lastMsg.senderName || '',
        external: true,
      },
      body: bodyParts.join('\n'),
      receivedAt: lastMsg.timestamp,
      context: contextMsgs,
    });
  }

  return results;
}

// ── CLI ──────────────────────────────────────────────────────────────

async function main(args = process.argv.slice(2)) {
  const val = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
  const has = flag => args.includes(flag);

  if (has('--help') || args.length === 0) {
    console.error(`使い方: node tools/beeper-unreplied.mjs --since 7d [--networks line,messenger,whatsapp,sms] [--out <json>]

  --since <dur>    必須。収集期間（例: 7d, 2h, 30m）
  --networks <csv>  対象ネットワーク（既定: line,messenger,whatsapp,sms。facebook/messenger・googlemessages/google-messages/sms は同じ扱い）
  --out <file>      出力先 JSON ファイル（省略時は stdout）
`);
    process.exit(1);
  }

  const sinceRaw = val('--since', '');
  if (!sinceRaw) throw new Error('--since が必要です');
  const sinceMs = parseDuration(sinceRaw);

  const networks = normalizeNetworks(val('--networks', 'line,messenger,whatsapp,sms'));

  const outFile = val('--out', '');

  try {
    const results = await collectUnreplied({ sinceMs, networks, outFile });
    const json = JSON.stringify(results);
    if (outFile) {
      fs.writeFileSync(outFile, json, 'utf8');
    } else {
      console.log(json);
    }
  } catch (err) {
    if (err instanceof BeeperApiError) {
      if (err.code === 'BEEPER_UNAUTHORIZED' || err.code === 'BEEPER_DOWN') {
        const msg = err.code === 'BEEPER_DOWN'
          ? 'Beeper Desktop が起動していません'
          : 'Beeper Desktop の認証に失敗しました';
        console.error(msg);
        process.exit(2);
      }
    }
    throw err;
  }
}

main().catch(err => {
  console.error(err.message || String(err));
  process.exit(1);
});