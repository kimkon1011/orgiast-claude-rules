#!/usr/bin/env node
// DWD の SA で任意の orgiast.jp ユーザーの Gmail を読む（読み取り専用）。
// seisaku-team@ のような共有アカウントは kim の Gmail コネクタからは見えないため、
// impersonate してこちらから読む。書き込み系は一切持たせない。
import { getDriveToken } from './lib/drive-auth.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';
import { routeMailbox } from './lib/mail-groups.mjs';
import { isEntry } from './is-entry.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export function headerValue(payload, name) {
  const target = String(name).toLowerCase();
  const found = (payload?.headers || []).find((header) => String(header.name).toLowerCase() === target);
  return found ? String(found.value) : '';
}

export function compactMessage(message) {
  return {
    id: String(message?.id || ''),
    internalDate: message?.internalDate || null,
    threadId: String(message?.threadId || ''),
    date: headerValue(message?.payload, 'date'),
    from: headerValue(message?.payload, 'from'),
    to: headerValue(message?.payload, 'to'),
    subject: headerValue(message?.payload, 'subject'),
    listUnsubscribe: headerValue(message?.payload, 'list-unsubscribe'),
    snippet: String(message?.snippet || '').replace(/\s+/g, ' ').trim(),
    labels: Array.isArray(message?.labelIds) ? message.labelIds : [],
  };
}

// 本文は base64url の入れ子で届く。text/plain を優先し、無ければ html を素のテキストに落とす。
export function extractBody(payload, limit = 4000) {
  const parts = [];
  const walk = (node) => {
    if (!node) return;
    const data = node.body?.data;
    if (data && /^text\/(plain|html)$/.test(String(node.mimeType || ''))) {
      parts.push({ mime: node.mimeType, text: Buffer.from(data, 'base64url').toString('utf8') });
    }
    for (const child of node.parts || []) walk(child);
  };
  walk(payload);
  const plain = parts.find((part) => part.mime === 'text/plain');
  const chosen = plain || parts[0];
  if (!chosen) return '';
  const text = chosen.mime === 'text/html'
    ? chosen.text.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ')
    : chosen.text;
  return text.replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
}

async function gmail(token, path, fetchImpl, signal) {
  const response = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]) });
  if (!response.ok) {
    const error = new Error(`Gmail API ${response.status}: ${(await response.text()).slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function searchGmail({ user, query, max = 10, withBody = false, bodyLimit = 4000, pageToken, fetchImpl = gwsFetch, getToken = getDriveToken, signal, concurrency = 1, shouldFetchBody, pendingIds, resumeNext, onMessage, skipId = () => false, allowPartial = false }) {
  const routed = routeMailbox(user, query);
  user = routed.user; query = routed.query;
  if (routed.notice) console.error(routed.notice);
  let token;
  try { token = await getToken({ scope: SCOPE, impersonate: user, signal: signal || AbortSignal.timeout(20_000) }); }
  catch (error) {
    if (/unauthorized_client/.test(error.message)) throw new Error(`${error.message}。そのアドレスはグループの可能性がある。seisaku-team@orgiast.jp で to:${user} 検索すること`);
    throw error;
  }
  const list = pendingIds ? { messages: pendingIds.map(id => ({ id })), nextPageToken: resumeNext } : await gmail(token, `/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(100, max)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, fetchImpl, signal);
  const results = [], stubs = (list.messages || []).slice(0, max);
  const pending = new Set((list.messages || []).map(s => s.id));
  let skipped = 0, offset = 0, failure;
  async function worker() {
    while (offset < stubs.length && !signal?.aborted) {
      const stub = stubs[offset++];
      let retrieved = false;
      try {
        if (skipId(stub.id)) { pending.delete(stub.id); continue; }
        const metadata = !withBody || !!shouldFetchBody;
        let message = await gmail(token, `/messages/${stub.id}?format=${metadata ? 'metadata' : 'full'}${metadata ? '&metadataHeaders=Date&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe' : ''}`, fetchImpl, signal);
        let compact = compactMessage(message);
        if (withBody && (!shouldFetchBody || shouldFetchBody(compact))) {
          if (metadata) message = await gmail(token, `/messages/${stub.id}?format=full`, fetchImpl, signal);
          compact = { ...compactMessage(message), body: extractBody(message.payload, bodyLimit) };
        }
        retrieved = true;
        if (onMessage) await onMessage(compact);
        results.push(compact); pending.delete(stub.id);
      } catch (error) {
        if (!retrieved && (error?.status === 404 || error?.status === 410)) { skipped++; pending.delete(stub.id); continue; }
        failure ||= error;
        if (!allowPartial) break;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(5, concurrency)) }, worker));
  if (failure && !allowPartial) throw failure;
  if (signal?.aborted && !allowPartial) throw signal.reason || new Error('Gmail search interrupted');

  if (skipped > 0) console.error(`gmail-search: ${skipped}件のメッセージが取得前に削除または移動されたためスキップしました`);
  return { user, query, ...(routed.notice ? { notice: routed.notice } : {}), estimate: Number(list.resultSizeEstimate) || results.length, messages: results, skipped, nextPageToken: list.nextPageToken || null, ...(allowPartial ? { pendingIds: [...pending], partial: pending.size > 0, error: failure?.message || (signal?.aborted ? "Gmail source budget exhausted" : undefined) } : {}) };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
  const user = value('--user', 'seisaku-team@orgiast.jp');
  const query = value('--query', '');
  if (!query) throw new Error('使い方: node tools/gmail-search.mjs --query "<Gmail検索式>" [--user <address>] [--max N] [--body]');
  const result = await searchGmail({
    user, query,
    max: Math.max(1, Number(value('--max', 10)) || 10),
    withBody: args.includes('--body'),
    bodyLimit: Math.max(200, Number(value('--body-limit', 4000)) || 4000),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (isEntry(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
