#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const BASE = 'https://makimono-md.vercel.app';
const STOPWORDS = new Set(['ください', 'お願い', 'して', 'したい', '作って', '作成', 'よろしく', 'ほしい', '欲しい']);
const cacheFile = () => path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', '.makimono-cache.json');
const normalize = (q) => String(q).toLowerCase().replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(options.timeout || 8000) });
  return response;
}
function readCache() { try { const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
function writeCache(cache) { try { fs.mkdirSync(path.dirname(cacheFile()), { recursive: true }); fs.writeFileSync(cacheFile(), `${JSON.stringify(cache, null, 2)}\n`); } catch {} }

export async function search(query, options = {}) {
  const key = normalize(query);
  const cache = readCache();
  const hit = cache[key];
  const select = (results) => (results || []).filter((x) => !options.freeOnly || x.is_free).filter((x) => !options.maxTokens || x.content_tokens <= options.maxTokens).slice(0, options.limit || 5);
  if (!options.noCache && hit && Date.now() - new Date(hit.at).getTime() < 24 * 60 * 60 * 1000) return { ok: true, results: select(hit.results), cached: true };
  const url = new URL('/api/v1/search', BASE);
  url.searchParams.set('q', key);
  url.searchParams.set('limit', '20');
  url.searchParams.set('sort', 'roi');
  if (options.freeOnly) url.searchParams.set('free_only', 'true');
  if (options.maxTokens) url.searchParams.set('max_content_tokens', String(options.maxTokens));
  const response = await request(url, { timeout: options.timeout || 8000 });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  cache[key] = { at: new Date().toISOString(), results: data.results || [] };
  writeCache(cache);
  return { ...data, results: select(data.results) };
}

// サーバーの q は複数語ANDが厳しすぎ0件になり、sort は関連度を無視するため、
// 全件取得＋ローカル採点にする。
export async function catalog(options = {}) {
  const cache = readCache();
  const hit = cache.__catalog__;
  if (!options.noCache && hit && Date.now() - new Date(hit.at).getTime() < 24 * 60 * 60 * 1000) return { items: hit.items || [], cached: true };
  const url = new URL('/api/v1/search', BASE);
  url.searchParams.set('q', '');
  url.searchParams.set('limit', '200');
  const response = await request(url, { timeout: options.timeout || 8000 });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const items = data.results || data.items || [];
  cache.__catalog__ = { at: new Date().toISOString(), items };
  writeCache(cache);
  return { items, cached: false };
}

function tokens(text) {
  const result = [];
  for (const word of String(text).match(/[A-Za-z][A-Za-z0-9_+-]{1,}/g) || []) result.push(word.toLowerCase());
  for (const word of String(text).match(/[ぁ-んァ-ヶ一-龠々ー]{2,}/g) || []) {
    const meaningful = [...STOPWORDS].sort((a, b) => b.length - a.length).reduce((parts, stopword) => parts.flatMap((part) => part.split(stopword)), [word]);
    for (const part of meaningful) for (const size of [2, 3]) for (let i = 0; i <= part.length - size; i += 1) result.push(part.slice(i, i + size));
  }
  return [...new Set(result.filter((token) => !STOPWORDS.has(token)))].slice(0, 40);
}

export function rank(text, items, options = {}) {
  const queryTokens = tokens(text);
  const weights = [['tags', 3], ['title', 3], ['summary', 2], ['category', 1]];
  return (items || [])
    .filter((item) => !options.freeOnly || item.is_free)
    .filter((item) => !options.maxTokens || item.content_tokens <= options.maxTokens)
    .map((item) => {
      let score = 0;
      for (const [field, weight] of weights) {
        const haystack = (Array.isArray(item[field]) ? item[field].join(' ') : String(item[field] || '')).toLowerCase();
        for (const token of queryTokens) if (haystack.includes(token)) score += weight;
      }
      return { ...item, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.roi || 0) - Number(a.roi || 0) || Number(a.content_tokens || Infinity) - Number(b.content_tokens || Infinity))
    .slice(0, options.limit || 5);
}

export async function findRelevant(text, options = {}) {
  const data = await catalog(options);
  return { results: rank(text, data.items, options), cached: data.cached };
}

export async function fetchRaw(slug, options = {}) {
  const response = await request(`${BASE}/api/v1/files/${encodeURIComponent(slug)}/raw`, { timeout: options.timeout || 8000 });
  return { status: response.status, text: await response.text(), response };
}

function value(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function help() { console.log('使い方: makimono-search.mjs "依頼文または検索語" [--server] [--limit N] [--free-only] [--max-tokens N] [--json] [--no-cache]\n       既定は全カタログをローカル採点。--server の時だけサーバー検索を使用。\n       makimono-search.mjs --raw <slug> | --categories | --report <slug> --saved <tokens> [--model <name>]'); }
async function cli() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) { help(); return; }
  if (args.includes('--raw')) {
    const slug = value(args, '--raw'); const result = await fetchRaw(slug);
    if (result.status === 402) { let human = `${BASE}/files/${slug}`; try { const meta = await request(`${BASE}/api/v1/files/${encodeURIComponent(slug)}`); if (meta.ok) { const link = (await meta.json())?.file?.links?.human; if (link) human = new URL(link, BASE); } } catch {} console.error(`有料出品です。購入ページ: ${human}`); process.exitCode = 3; return; }
    if (!result.response.ok) throw new Error(`HTTP ${result.status}`);
    process.stdout.write(result.text); return;
  }
  if (args.includes('--categories')) {
    const response = await request(`${BASE}/api/v1/categories`); if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json(); console.log(args.includes('--json') ? JSON.stringify(data) : (data.categories || []).map((x) => `${x.name}\t${x.count}`).join('\n')); return;
  }
  if (args.includes('--report')) {
    const slug = value(args, '--report'); const saved = Number(value(args, '--saved'));
    if (!slug || !Number.isFinite(saved)) throw new Error('--report と --saved が必要です');
    const response = await request(`${BASE}/api/v1/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, savedTokens: saved, ...(value(args, '--model') ? { model: value(args, '--model') } : {}) }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`); console.log(JSON.stringify(await response.json())); return;
  }
  const query = args.find((x) => !x.startsWith('--') && !/^\d+$/.test(x));
  const options = { limit: Number(value(args, '--limit') || 5), freeOnly: args.includes('--free-only'), maxTokens: Number(value(args, '--max-tokens')) || undefined, noCache: args.includes('--no-cache') };
  const data = args.includes('--server') ? await search(query || '', options) : await findRelevant(query || '', options);
  if (args.includes('--json')) { console.log(JSON.stringify(data)); return; }
  for (const x of data.results || []) console.log(`${x.slug}\t${x.title}\t${x.score ?? '-'}\t${x.roi ?? x.saved_tokens ?? '-'}\t${x.content_tokens ?? '-'} tok\t${x.is_free ? '無料' : `¥${x.price ?? '-'}`}\t${x.links?.raw ? new URL(x.links.raw, BASE) : ''}`);
}

if (isEntry(import.meta.url)) cli().catch((e) => { console.error(`マキモノAPIエラー: ${e.message}`); process.exitCode = 1; });
