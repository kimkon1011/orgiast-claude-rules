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
 * Makes an HTTP request to the Beeper Desktop API.
 */
export async function beeperFetch(endpoint, { method = 'GET', body, query, timeoutMs = 20000, env = process.env, token: customToken, fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = env.BEEPER_API_BASE || 'http://localhost:23373';
  const token = customToken || getBeeperToken({ env });

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

  return await response.json();
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
