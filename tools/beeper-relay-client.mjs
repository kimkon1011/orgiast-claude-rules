#!/usr/bin/env node
/**
 * Beeper Relay CLI クライアント
 * 他PCから kim-PC の Beeper Relay サーバー経由でチャットを読んだり、
 * 送信依頼を出す。
 *
 * 使い方:
 *   node tools/beeper-relay-client.mjs --chats <検索語>
 *   node tools/beeper-relay-client.mjs --messages <chatID>
 *   node tools/beeper-relay-client.mjs --send <chatID> --body-file <file> [--reply-to <msgID>]
 *   node tools/beeper-relay-client.mjs --status <queueID>
 *
 * 環境変数:
 *   BEEPER_RELAY_URL   サーバーURL（既定 http://127.0.0.1:23380）
 *   BEEPER_RELAY_TOKEN トークン（未設定なら ~/.claude/beeper-relay/token.txt）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

// ── Config ──────────────────────────────────────────────────────────────

function getToken() {
  const envToken = process.env.BEEPER_RELAY_TOKEN;
  if (envToken) return envToken;
  const tokenPath = path.join(os.homedir(), '.claude', 'beeper-relay', 'token.txt');
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return null;
  }
}

function getBaseURL() {
  return (process.env.BEEPER_RELAY_URL || 'http://127.0.0.1:23380').replace(/\/+$/, '');
}

// ── HTTP リクエスト ────────────────────────────────────────────────────

class RelayError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
    this.code = code;
  }
}

async function relayFetch(endpoint, options = {}) {
  const base = getBaseURL();
  const token = getToken();
  if (!token) throw new RelayError('トークンが設定されていません。BEEPER_RELAY_TOKEN か ~/.claude/beeper-relay/token.txt を設定してください', 0, 'NO_TOKEN');

  const url = `${base}${endpoint}`;
  const headers = { 'Authorization': `Bearer ${token}` };
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs || 30_000),
    });
  } catch (err) {
    throw new RelayError('サーバーに接続できません', 0, 'CONNECTION_FAILED');
  }

  if (response.status === 401) {
    throw new RelayError('認証エラー: トークンが無効です', 401, 'UNAUTHORIZED');
  }
  if (response.status === 403) {
    const data = await response.json().catch(() => ({}));
    throw new RelayError(`権限エラー: ${data.error || 'アクセスが拒否されました'}`, 403, data.code || 'FORBIDDEN');
  }
  if (response.status === 429) {
    const data = await response.json().catch(() => ({}));
    throw new RelayError(`レート制限: ${data.error || '制限に達しました'}`, 429, 'RATE_LIMIT');
  }
  if (response.status === 503) {
    throw new RelayError('Beeper Desktop が起動していません', 503, 'BEEPER_DOWN');
  }

  const data = await response.json();
  if (!response.ok) {
    throw new RelayError(data.error || `HTTP ${response.status}`, response.status, data.code || 'ERROR');
  }
  return data;
}

// ── CLI コマンド ──────────────────────────────────────────────────────

async function cmdChats(query) {
  const endpoint = query ? `/v1/chats?query=${encodeURIComponent(query)}&limit=50` : '/v1/chats?limit=50';
  const result = await relayFetch(endpoint);
  if (result.chats.length === 0) {
    console.log(JSON.stringify({ chats: [], total: 0 }));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function cmdMessages(chatID, limit) {
  if (!chatID) throw new Error('--messages <chatID> が必要です');
  const endpoint = `/v1/chats/${encodeURIComponent(chatID)}/messages?limit=${limit || 20}`;
  const result = await relayFetch(endpoint);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSend(chatID, bodyFile, replyTo) {
  if (!chatID) throw new Error('--send <chatID> が必要です');
  if (!bodyFile) throw new Error('--body-file <file> が必要です');
  const body = fs.readFileSync(bodyFile, 'utf8').trim();
  if (!body) throw new Error('本文が空です');

  const payload = { chatID, body };
  if (replyTo) payload.replyTo = replyTo;

  const result = await relayFetch('/v1/send', { method: 'POST', body: payload });
  console.log(JSON.stringify(result, null, 2));
  if (result.queueID) {
    console.error(`送信依頼を受け付けました。キューID: ${result.queueID}`);
    console.error(`状態確認: node tools/beeper-relay-client.mjs --status ${result.queueID}`);
  }
}

async function cmdStatus(queueID) {
  if (!queueID) throw new Error('--status <queueID> が必要です');
  const result = await relayFetch(`/v1/send/${encodeURIComponent(queueID)}`);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdAccounts() {
  const result = await relayFetch('/v1/accounts');
  console.log(JSON.stringify(result, null, 2));
}

// ── メイン ─────────────────────────────────────────────────────────────

async function main(args = process.argv.slice(2)) {
  const val = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
  const has = flag => args.includes(flag);

  if (has('--help') || args.length === 0) {
    console.log(`Beeper Relay CLI クライアント

使い方:
  --chats [<query>]       チャット一覧（検索）
  --messages <chatID>     メッセージ取得 [--limit 20]
  --send <chatID>         送信依頼（--body-file 必須） [--reply-to <msgID>]
  --status <queueID>      送信状態確認
  --accounts              アカウント一覧

  --body-file <file>      本文ファイル（--send と併用）
  --limit <n>             取得件数
  --reply-to <msgID>      返信先メッセージID
  --help                  このヘルプ

環境変数:
  BEEPER_RELAY_URL   サーバーURL（既定 http://127.0.0.1:23380）
  BEEPER_RELAY_TOKEN トークン（未設定なら ~/.claude/beeper-relay/token.txt）
`);
    return;
  }

  if (has('--chats')) {
    const query = val('--chats', '');
    await cmdChats(query);
  } else if (has('--messages')) {
    const chatID = val('--messages', '');
    const limit = parseInt(val('--limit', '20'), 10);
    await cmdMessages(chatID, limit);
  } else if (has('--send')) {
    const chatID = val('--send', '');
    const bodyFile = val('--body-file', '');
    const replyTo = val('--reply-to', null);
    await cmdSend(chatID, bodyFile, replyTo);
  } else if (has('--status')) {
    const queueID = val('--status', '');
    await cmdStatus(queueID);
  } else if (has('--accounts')) {
    await cmdAccounts();
  } else {
    console.error('不明なオプションです。--help で使い方を表示');
    process.exit(1);
  }
}

if (isEntry(import.meta.url)) {
  main().catch(err => {
    if (err instanceof RelayError) {
      console.error(err.message);
      process.exit(err.status > 0 ? err.status : 1);
    }
    console.error(err.message || String(err));
    process.exit(1);
  });
}

export { relayFetch, RelayError, getToken, getBaseURL };