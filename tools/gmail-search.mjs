#!/usr/bin/env node
// DWD の SA で任意の orgiast.jp ユーザーの Gmail を読む（読み取り専用）。
// seisaku-team@ のような共有アカウントは kim の Gmail コネクタからは見えないため、
// impersonate してこちらから読む。書き込み系は一切持たせない。
import { getDriveToken } from './lib/drive-auth.mjs';
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
    threadId: String(message?.threadId || ''),
    date: headerValue(message?.payload, 'date'),
    from: headerValue(message?.payload, 'from'),
    to: headerValue(message?.payload, 'to'),
    subject: headerValue(message?.payload, 'subject'),
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

async function gmail(token, path) {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Gmail API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

export async function searchGmail({ user, query, max = 10, withBody = false, bodyLimit = 4000 }) {
  const token = await getDriveToken({ scope: SCOPE, impersonate: user });
  const list = await gmail(token, `/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(100, max)}`);
  const results = [];
  for (const stub of (list.messages || []).slice(0, max)) {
    const format = withBody ? 'full' : 'metadata';
    const suffix = withBody ? '' : '&metadataHeaders=Date&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject';
    const message = await gmail(token, `/messages/${stub.id}?format=${format}${suffix}`);
    const compact = compactMessage(message);
    if (withBody) compact.body = extractBody(message.payload, bodyLimit);
    results.push(compact);
  }
  return { estimate: Number(list.resultSizeEstimate) || results.length, messages: results };
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
