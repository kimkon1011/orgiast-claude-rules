#!/usr/bin/env node
/**
 * Beeper Relay サーバー
 * kim-PC（Tailscale IP）だけが持つ Beeper Desktop API への
 * 権限制御付き中継。送信は reply-queue 経由（承認制）。
 *
 * 使い方:
 *   サーバー起動: node tools/beeper-relay-server.mjs [--port 23380] [--bind 100.x.x.x]
 *   クライアント発行: node tools/beeper-relay-server.mjs --issue <client-name> --scope read,send [--networks line,messenger]
 *   クライアント失効: node tools/beeper-relay-server.mjs --revoke <client-name>
 *   一覧: node tools/beeper-relay-server.mjs --list
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';
import { BeeperApiError, getAccounts, listChats, listMessages, getChat } from './beeper-api.mjs';
import { enqueueItems, getItem } from './reply-queue.mjs';

// ── Config ──────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'beeper-relay');
const CLIENTS_FILE = path.join(CONFIG_DIR, 'clients.json');
const AUDIT_LOG = path.join(CONFIG_DIR, 'audit.jsonl');
const AUTH_SALT_FILE = path.join(CONFIG_DIR, 'auth-salt.txt');
const KEY_LENGTH = 32;
const DEFAULT_PORT = 23380;

// ── トークン管理 ──────────────────────────────────────────────────────

function getAuthSalt() {
  try {
    const existing = fs.readFileSync(AUTH_SALT_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first time */ }
  const salt = crypto.randomBytes(KEY_LENGTH).toString('hex');
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(AUTH_SALT_FILE, salt, { mode: 0o600 });
  return salt;
}

function hashToken(token) {
  const salt = getAuthSalt();
  return crypto.createHash('sha256').update(salt).update(':').update(token).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(KEY_LENGTH).toString('hex');
}

// ── clients.json 読み書き ─────────────────────────────────────────────

function readClients() {
  try {
    return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function writeClients(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

// ── Audit ──────────────────────────────────────────────────────────────

function auditLog(clientName, endpoint, chatID, status, { bodyPreview } = {}) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    client: clientName,
    endpoint,
    chatID,
    status,
  };
  if (bodyPreview) entry.bodyPreview = bodyPreview;
  // トークンが audit に出ないことを確認: 平文トークンを書かない
  fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n');
}

// ── レート制限（in-memory） ──────────────────────────────────────────

const rateLimitStore = new Map();

function checkRateLimit(clientName, scope) {
  const limits = { read: { windowMs: 60_000, max: 60 }, send: { windowMs: 3_600_000, max: 10 } };
  const limit = limits[scope];
  if (!limit) return;
  const now = Date.now();
  let entry = rateLimitStore.get(clientName);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitStore.set(clientName, entry);
  }
  entry.timestamps = entry.timestamps.filter(t => now - t < limit.windowMs);
  if (entry.timestamps.length >= limit.max) {
    const retryAfter = Math.ceil((limit.windowMs - (now - entry.timestamps[0])) / 1000);
    throw Object.assign(new Error(`rate_limit: ${scope} 上限 ${limit.max} 回/${limit.windowMs / 1000}秒、${retryAfter}秒後に再試行`), { status: 429, code: 'RATE_LIMIT' });
  }
  entry.timestamps.push(now);
}

// ── 認証 ───────────────────────────────────────────────────────────────

function authenticate(headers) {
  const auth = (headers.get && headers.get('authorization')) || headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error('認証が必要です'), { status: 401, code: 'UNAUTHORIZED' });
  const token = match[1];
  const tokenHash = hashToken(token);
  const clients = readClients();
  for (const [name, client] of Object.entries(clients)) {
    if (!client.revoked && client.tokenHash === tokenHash) {
      return client;
    }
  }
  throw Object.assign(new Error('トークンが無効です'), { status: 401, code: 'UNAUTHORIZED' });
}

function requireScope(client, scope) {
  if (!client.scope || !client.scope.includes(scope)) {
    throw Object.assign(new Error(`権限がありません（必要: ${scope}）`), { status: 403, code: 'FORBIDDEN' });
  }
}

function checkNetwork(client, accountNetwork) {
  if (!client.allowedNetworks || client.allowedNetworks.length === 0) return; // all allowed
  const normalMap = {
    'LINE': 'line', 'line': 'line',
    'Facebook': 'messenger', 'Facebook/Messenger': 'messenger',
    'WhatsApp': 'whatsapp', 'whatsapp': 'whatsapp',
    'Google Messages': 'sms',
    'Discord': 'discord', 'discord': 'discord',
    'Beeper': 'beeper', 'ChatGPT Dots': 'chatgpt', 'Grok Bot': 'grok',
  };
  const internal = normalMap[accountNetwork] || (accountNetwork ? accountNetwork.toLowerCase() : 'unknown');
  if (!client.allowedNetworks.includes(internal)) {
    throw Object.assign(new Error(`ネットワーク ${accountNetwork} へのアクセスは許可されていません`), { status: 403, code: 'NETWORK_FORBIDDEN' });
  }
}

// ── Beeper Desktop 生存確認 ────────────────────────────────────────────

let beeperAvailable = true;

async function probeBeeper() {
  try {
    await getAccounts();
    beeperAvailable = true;
  } catch {
    beeperAvailable = false;
  }
}

function requireBeeper() {
  if (!beeperAvailable) {
    throw Object.assign(new Error('Beeper Desktop が起動していないか応答しません'), { status: 503, code: 'BEEPER_DOWN' });
  }
}

// ── JSON レスポンス ────────────────────────────────────────────────────

function jsonResponse(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.write(body);
  res.end();
}

function errorResponse(res, message, status, code) {
  const body = JSON.stringify({ error: message, code: code || 'ERROR' });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.write(body);
  res.end();
}

// ── URL パース ─────────────────────────────────────────────────────────

function parsePath(url) {
  const u = new URL(url, 'http://localhost');
  const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const query = Object.fromEntries(u.searchParams.entries());
  return { parts, query };
}

// ── リクエストボディ読み込み ──────────────────────────────────────────

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// ── リクエストハンドラー ────────────────────────────────────────────

async function handleRequest(req, res) {
  const method = req.method;
  const { parts, query } = parsePath(req.url);

  try {
    // 認証
    const client = authenticate(req.headers);
    const allClients = readClients();
    const clientName = Object.entries(allClients).find(([, c]) => c === client)?.[0] || 'unknown';

    // /v1/* のみ
    if (parts.length < 1 || parts[0] !== 'v1') {
      return jsonResponse(res, { version: '1', beeperAvailable }, 200);
    }

    // ── GET /v1/accounts ─────────────────────────────────────────
    if (method === 'GET' && parts.length === 2 && parts[1] === 'accounts') {
      requireScope(client, 'read');
      requireBeeper();
      checkRateLimit(clientName, 'read');
      const accounts = await getAccounts();
      const safe = (accounts || []).map(a => ({
        accountID: a.accountID,
        network: a.network,
        displayName: a.user?.displayName || a.network,
        isLoggedIn: a.isLoggedIn,
      }));
      auditLog(clientName, 'GET /v1/accounts', null, 200);
      return jsonResponse(res, { accounts: safe });
    }

    // ── GET /v1/chats?query= ────────────────────────────────────
    if (method === 'GET' && parts.length === 2 && parts[1] === 'chats') {
      requireScope(client, 'read');
      requireBeeper();
      checkRateLimit(clientName, 'read');
      const searchQuery = query.query || '';
      const limit = Math.min(parseInt(query.limit || '50', 10), 100);

      const result = await listChats({ limit });
      const accounts = await getAccounts();
      const accountNetworks = {};
      for (const a of accounts) accountNetworks[a.accountID] = a.network;

      let chats = result.items || [];
      // ネットワークフィルタ
      if (client.allowedNetworks && client.allowedNetworks.length > 0) {
        chats = chats.filter(c => {
          const nw = accountNetworks[c.accountID] || c.network || '';
          return client.allowedNetworks.some(allowed => nw.toLowerCase().includes(allowed));
        });
      }
      // 検索フィルタ
      if (searchQuery) {
        const qLower = searchQuery.toLowerCase();
        chats = chats.filter(c => {
          const name = c.name || c.displayName || '';
          return name.toLowerCase().includes(qLower);
        });
      }
      const safe = chats.slice(0, limit).map(c => ({
        id: c.id,
        name: c.name || c.displayName || '(名称なし)',
        network: accountNetworks[c.accountID] || c.network || '',
        lastActivity: c.lastActivity,
        unread: c.unreadCount || 0,
      }));
      auditLog(clientName, 'GET /v1/chats', null, 200, { bodyPreview: `query=${searchQuery}, count=${safe.length}` });
      return jsonResponse(res, { chats: safe, total: safe.length });
    }

    // ── GET /v1/chats/:id/messages?limit= ──────────────────────
    if (method === 'GET' && parts.length === 4 && parts[1] === 'chats' && parts[3] === 'messages') {
      requireScope(client, 'read');
      requireBeeper();
      checkRateLimit(clientName, 'read');
      const chatID = parts[2];
      const msgLimit = Math.min(parseInt(query.limit || '20', 10), 100);

      // チャット情報でネットワークチェック
      try {
        const chatInfo = await getChat(chatID);
        if (chatInfo && client.allowedNetworks && client.allowedNetworks.length > 0) {
          const accounts = await getAccounts();
          const accountNetworks = {};
          for (const a of accounts) accountNetworks[a.accountID] = a.network;
          const nw = accountNetworks[chatInfo.accountID] || '';
          checkNetwork(client, nw);
        }
      } catch (err) {
        if (err.status === 403) throw err;
        // ネットワーク情報が取れなくても続行（read権限があるなら読める）
      }

      const msgResult = await listMessages(chatID, { limit: msgLimit, direction: query.direction || 'before' });
      const safe = (msgResult.items || []).map(m => ({
        id: m.id,
        sender: m.senderName || '',
        isSender: m.isSender || false,
        text: m.text || '',
        timestamp: m.timestamp,
        type: m.type,
      }));
      auditLog(clientName, `GET /v1/chats/${chatID}/messages`, chatID, 200, { bodyPreview: `count=${safe.length}` });
      return jsonResponse(res, { messages: safe, hasMore: msgResult.hasMore || false });
    }

    // ── POST /v1/send ──────────────────────────────────────────
    if (method === 'POST' && parts.length === 2 && parts[1] === 'send') {
      requireScope(client, 'send');
      requireBeeper();
      checkRateLimit(clientName, 'send');

      const rawBody = await readBody(req);
      let body;
      try { body = JSON.parse(rawBody); } catch { return errorResponse(res, 'リクエストボディが JSON として解析できません', 400, 'INVALID_JSON'); }

      if (!body.chatID || !body.body) {
        return errorResponse(res, 'chatID と body は必須です', 400, 'MISSING_FIELDS');
      }

      // ネットワークチェック
      try {
        const chatInfo = await getChat(body.chatID);
        if (chatInfo && client.allowedNetworks && client.allowedNetworks.length > 0) {
          const accounts = await getAccounts();
          const accountNetworks = {};
          for (const a of accounts) accountNetworks[a.accountID] = a.network;
          const nw = accountNetworks[chatInfo.accountID] || '';
          checkNetwork(client, nw);
        }
      } catch (err) {
        if (err.status === 403) throw err;
      }

      // reply-queue に enqueue（直接送信しない）
      const home = process.env.ORGIAST_HOME || os.homedir();
      const msgID = body.replyTo || `relay-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const items = [{
        channel: 'beeper',
        thread: `beeper:${body.chatID}`,
        message: msgID,
        from: { id: `relay:${clientName}`, name: `${clientName} via relay`, external: true },
        body: body.body,
        receivedAt: new Date().toISOString(),
        context: [{ sender: `relay:${clientName}`, body: `リモート送信依頼（${body.body.slice(0, 100)}）`, at: new Date().toISOString() }],
        category: 'relay',
        link: null,
      }];
      const result = enqueueItems(home, items);
      const queueID = result.ids[0];

      auditLog(clientName, 'POST /v1/send', body.chatID, 202, { bodyPreview: body.body.slice(0, 100) });
      return jsonResponse(res, { queueID, status: 'pending', message: '送信依頼を受け付けました。kim の承認後に送信されます' }, 202);
    }

    // ── GET /v1/send/:queueId ─────────────────────────────────
    if (method === 'GET' && parts.length === 3 && parts[1] === 'send') {
      const queueID = parts[2];
      const home = process.env.ORGIAST_HOME || os.homedir();
      try {
        const item = getItem(home, queueID);
        const response = {
          queueID,
          state: item.state,
          from: item.from,
          body: item.body,
          createdAt: item.receivedAt,
        };
        if (item.decision) response.decision = { verdict: item.decision.verdict, at: item.decision.at };
        if (item.sent) response.sent = { messageId: item.sent.messageId, at: item.sent.at };
        if (item.draft) response.draft = item.draft.text.slice(0, 200);
        auditLog(clientName, `GET /v1/send/${queueID}`, null, 200);
        return jsonResponse(res, response);
      } catch (err) {
        if (err.message && err.message.includes('見つかりません')) {
          return errorResponse(res, 'キュー項目が見つかりません', 404, 'NOT_FOUND');
        }
        throw err;
      }
    }

    // 404
    return errorResponse(res, '不明なエンドポイント', 404, 'NOT_FOUND');

  } catch (err) {
    if (err.status) {
      return errorResponse(res, err.message, err.status, err.code || 'ERROR');
    }
    if (err instanceof BeeperApiError) {
      const status = err.code === 'BEEPER_DOWN' ? 503 : (err.code === 'BEEPER_UNAUTHORIZED' ? 502 : 502);
      beeperAvailable = false;
      return errorResponse(res, `Beeper Desktop エラー: ${err.message}`, status, err.code);
    }
    console.error('BeeperRelayServer error:', err);
    return errorResponse(res, 'サーバー内部エラー', 500, 'INTERNAL_ERROR');
  }
}

// ── サーバー起動 ──────────────────────────────────────────────────────

async function startServer({ port = DEFAULT_PORT, bindIP = null } = {}) {
  // Tailscale IP 確認（未指定時は env か警告）
  const listenIP = bindIP || process.env.BEEPER_RELAY_BIND || '127.0.0.1';

  if (listenIP === '0.0.0.0') {
    console.error('エラー: 0.0.0.0 へのバインドは禁止されています。Tailscale IP を指定してください');
    process.exit(1);
  }

  // Beeper Desktop 生存確認
  await probeBeeper();

  const server = http.createServer(handleRequest);

  // 定期的に Beeper 生存確認
  setInterval(probeBeeper, 30_000);

  return new Promise((resolve, reject) => {
    server.listen(port, listenIP, () => {
      console.error(`Beeper Relay サーバー起動: http://${listenIP}:${port}`);
      console.error(`Beeper Desktop: ${beeperAvailable ? '接続OK' : '未接続（起動後に自動復旧します）'}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// ── CLI: クライアント発行 ────────────────────────────────────────────

function cmdIssue(clientName, scope, networks) {
  if (!clientName || !/^[a-zA-Z0-9_-]+$/.test(clientName)) {
    console.error('エラー: client-name は英数字・ハイフン・アンダースコアのみ');
    process.exit(1);
  }
  const scopes = scope ? scope.split(',').filter(s => ['read', 'send'].includes(s)) : ['read'];
  if (scopes.length === 0) {
    console.error('エラー: scope は read, send の組み合わせ');
    process.exit(1);
  }
  const allowedNetworks = networks ? networks.split(',').map(s => s.trim()).filter(Boolean) : null;

  const clients = readClients();
  if (clients[clientName] && !clients[clientName].revoked) {
    console.error(`エラー: クライアント ${clientName} は既に登録されています。失効してから再発行するか --revoke を使ってください`);
    process.exit(1);
  }

  const token = generateToken();
  const tokenHash = hashToken(token);

  clients[clientName] = {
    name: clientName,
    tokenHash,
    scope: scopes,
    allowedNetworks,
    createdAt: new Date().toISOString(),
    revoked: false,
  };
  writeClients(clients);

  console.log(JSON.stringify({
    ok: true,
    client: clientName,
    token,
    scope: scopes,
    networks: allowedNetworks || 'all',
    message: 'トークンは一度だけ表示されます。安全な場所に保存してください。keyserve に登録するか、各PCの ~/.claude/beeper-relay/token.txt に保存します',
  }, null, 2));
}

function cmdRevoke(clientName) {
  if (!clientName) { console.error('エラー: --revoke <client-name>'); process.exit(1); }
  const clients = readClients();
  if (!clients[clientName]) {
    console.error(`エラー: クライアント ${clientName} が見つかりません`);
    process.exit(1);
  }
  clients[clientName].revoked = true;
  clients[clientName].revokedAt = new Date().toISOString();
  writeClients(clients);
  console.log(JSON.stringify({ ok: true, client: clientName, revokedAt: clients[clientName].revokedAt }));
}

function cmdList() {
  const clients = readClients();
  const list = Object.entries(clients).map(([name, c]) => ({
    name,
    scope: c.scope,
    networks: c.allowedNetworks || 'all',
    createdAt: c.createdAt,
    revoked: c.revoked,
    revokedAt: c.revokedAt || null,
  }));
  console.log(JSON.stringify({ clients: list, count: list.length }, null, 2));
}

// ── CLI エントリ ──────────────────────────────────────────────────────

async function main(args = process.argv.slice(2)) {
  const val = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
  const has = flag => args.includes(flag);

  if (has('--help') || has('-h')) {
    console.log(`Beeper Relay サーバー

使い方:
  サーバー起動:  node tools/beeper-relay-server.mjs [--port 23380] [--bind 100.x.x.x]

  --issue <name>  クライアント発行（トークン・権限設定）
    --scope read,send    権限（既定: read,send）
    --networks line,messenger  許可ネットワーク（省略=全許可）

  --revoke <name>  クライアント失効
  --list           一覧表示

環境変数:
  BEEPER_RELAY_BIND  バインドIP（省略時 127.0.0.1）
  BEEPER_RELAY_PORT  ポート（省略時 23380）
`);
    return;
  }

  if (has('--issue')) {
    const clientName = val('--issue', '');
    const scope = val('--scope', 'read,send');
    const networks = val('--networks', '');
    cmdIssue(clientName, scope, networks);
    return;
  }
  if (has('--revoke')) {
    cmdRevoke(val('--revoke', ''));
    return;
  }
  if (has('--list')) {
    cmdList();
    return;
  }

  // サーバーモード
  const port = parseInt(val('--port', process.env.BEEPER_RELAY_PORT || String(DEFAULT_PORT)), 10);
  const bindIP = val('--bind', null);
  await startServer({ port, bindIP });
}

if (isEntry(import.meta.url)) {
  main().catch(err => {
    console.error(err.message || String(err));
    process.exit(1);
  });
}

export {
  startServer,
  hashToken,
  generateToken,
  readClients,
  writeClients,
  CONFIG_DIR,
  CLIENTS_FILE,
  AUDIT_LOG,
};