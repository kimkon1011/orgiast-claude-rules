import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export class BeeperApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'BeeperApiError';
    this.code = code; // 'BEEPER_UNAUTHORIZED' | 'BEEPER_DOWN' | 'BEEPER_ERROR'
    this.status = status;
  }
}

/**
 * Resolves the Beeper access token from environment or SQLite database.
 * NEVER logs, prints, or includes the token in exceptions.
 */
export function getBeeperToken({ env = process.env, appData = process.env.APPDATA } = {}) {
  if (env.BEEPER_ACCESS_TOKEN) {
    return env.BEEPER_ACCESS_TOKEN;
  }
  try {
    const baseDir = appData || path.join(os.homedir(), 'AppData', 'Roaming');
    const dbPath = path.join(baseDir, 'BeeperTexts', 'account.db');
    if (!fs.existsSync(dbPath)) {
      return null;
    }
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT access_token FROM account LIMIT 1').get();
    db.close();
    return row?.access_token || null;
  } catch {
    return null;
  }
}

/**
 * 000 の Beeper 中継（tools/beeper-gateway.mjs）の設定を読む。
 * ~/.claude/secrets/beeper-gateway.json = { "base": "http://192.168.0.4:23380", "token": "..." }
 * NEVER logs, prints, or includes the token in exceptions.
 */
export function getGatewayConfig({ env = process.env, home = env.ORGIAST_HOME || (env === process.env ? os.homedir() : null) } = {}) {
  if (env.BEEPER_GATEWAY_DISABLE === '1') return null;
  // テスト等で env を差し替えたときは、明示した設定パス／ORGIAST_HOME 以外を読まない
  if (!env.BEEPER_GATEWAY_CONFIG && !home) return null;
  const p = env.BEEPER_GATEWAY_CONFIG || path.join(home, '.claude', 'secrets', 'beeper-gateway.json');
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    if (c && typeof c.base === 'string' && typeof c.token === 'string' && c.token) return { base: c.base, token: c.token };
  } catch { /* 設定なし */ }
  return null;
}

/**
 * 接続先を決める。Beeper 本体は 000 だけに置く（2026-11-17 kim 決定）。
 * 優先順: BEEPER_API_BASE 明示 → 000 の中継設定（beeper-gateway.json）→ このPCの Beeper（000 自身）。
 * BEEPER_PREFER_LOCAL=1 のときだけ、中継設定があってもローカルを先に使う。
 * 戻り値の token は呼び出し側で表示しないこと。
 */
export function resolveBeeperTarget({ env = process.env, appData = process.env.APPDATA } = {}) {
  const local = 'http://localhost:23373';
  if (env.BEEPER_API_BASE) return { via: 'env', baseUrl: env.BEEPER_API_BASE, token: getBeeperToken({ env, appData }) };
  const gw = getGatewayConfig({ env });
  if (gw && env.BEEPER_PREFER_LOCAL !== '1') return { via: 'gateway', baseUrl: gw.base, token: gw.token };
  const token = getBeeperToken({ env, appData });
  if (token) return { via: 'local', baseUrl: local, token };
  if (gw) return { via: 'gateway', baseUrl: gw.base, token: gw.token };
  return { via: 'none', baseUrl: local, token: null };
}

/**
 * Makes an HTTP request to the Beeper Desktop API.
 */
export async function beeperFetch(endpoint, { method = 'GET', body, query, timeoutMs = 20000, env = process.env, token: customToken, binary = false, fetchImpl = globalThis.fetch } = {}) {
  const target = customToken ? { baseUrl: env.BEEPER_API_BASE || 'http://localhost:23373', token: customToken } : resolveBeeperTarget({ env });
  const baseUrl = target.baseUrl;
  const token = target.token;

  if (!token) {
    throw new BeeperApiError('Beeper access token not found or unauthorized', 'BEEPER_UNAUTHORIZED', 401);
  }

  let urlStr = `${baseUrl.replace(/\/+$/, '')}${endpoint}`;
  if (query) {
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const item of v) searchParams.append(k, item);
      } else {
        searchParams.append(k, String(v));
      }
    }
    const qStr = searchParams.toString();
    if (qStr) {
      urlStr += `?${qStr}`;
    }
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await fetchImpl(urlStr, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new BeeperApiError('Beeper API server down or unreachable', 'BEEPER_DOWN', 0);
  }

  if (response.status === 401) {
    throw new BeeperApiError('Beeper API unauthorized', 'BEEPER_UNAUTHORIZED', 401);
  }

  if (!response.ok) {
    let msg = `Beeper API error (${response.status})`;
    try {
      const data = await response.json();
      if (data && data.message) msg += `: ${data.message}`;
    } catch { /* ignore parse error */ }
    throw new BeeperApiError(msg, 'BEEPER_ERROR', response.status);
  }

  return binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
}

export async function getAccounts(options = {}) {
  return await beeperFetch('/v1/accounts', { method: 'GET', ...options });
}

export async function listChats({ limit, cursor, direction, accountIDs } = {}, options = {}) {
  const query = {};
  if (limit !== undefined) query.limit = limit;
  if (cursor !== undefined) query.cursor = cursor;
  if (direction !== undefined) query.direction = direction;
  if (accountIDs !== undefined) query.accountIDs = accountIDs;
  return await beeperFetch('/v1/chats', { method: 'GET', query, ...options });
}

export async function listMessages(chatID, { limit, cursor, direction } = {}, options = {}) {
  const query = {};
  if (limit !== undefined) query.limit = limit;
  if (cursor !== undefined) query.cursor = cursor;
  if (direction !== undefined) query.direction = direction;
  return await beeperFetch(`/v1/chats/${encodeURIComponent(chatID)}/messages`, { method: 'GET', query, ...options });
}

export async function sendMessage(chatID, text, { replyToMessageID, attachment } = {}, options = {}) {
  const body = { text };
  if (replyToMessageID) body.replyToMessageID = replyToMessageID;
  if (attachment) body.attachment = attachment;
  return await beeperFetch(`/v1/chats/${encodeURIComponent(chatID)}/messages`, { method: 'POST', body, ...options });
}

// Read metadata again immediately before an automatic reply (does not mark read).
export async function getChat(chatID, options = {}) {
  return beeperFetch(`/v1/chats/${encodeURIComponent(chatID)}`, { method: 'GET', ...options });
}

// Search messages across all conversations.
export async function searchMessages(query, { limit = 20 } = {}, options = {}) {
  return await beeperFetch('/v1/messages/search', { method: 'GET', query: { query, limit }, ...options });
}

// Assets remain behind the Desktop API; mxc/file URLs are never fetched directly.
export async function downloadAttachment(attachment, options = {}) {
  let url = attachment.srcURL || attachment.url;
  if (!url) throw new Error('添付URLなし');
  // The gateway accepts only Matrix media identifiers, never client-supplied host file paths.
  if (!options.token && resolveBeeperTarget({ env: options.env || process.env }).via === 'gateway') {
    return beeperFetch('/gateway/attachment', { ...options, method: 'POST', body: { url }, binary: true });
  }
  if (/^(local)?mxc:\/\//.test(url)) {
    const downloaded = await beeperFetch('/v1/assets/download', { ...options, method: 'POST', body: { url } });
    if (downloaded.error || !downloaded.srcURL) throw new Error('Beeper asset download failed');
    url = downloaded.srcURL;
  }
  return beeperFetch('/v1/assets/serve', { ...options, query: { url }, binary: true });
}
