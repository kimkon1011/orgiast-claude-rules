#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const FOLDER_ID = '1LMRI2jFpVG3WnDYlepgbOuyJ6ZBYzI8B';
const HUB_FOLDER_ID = '1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw';
const DOC_MIME = 'application/vnd.google-apps.document';
const BODY_MARKER = '---------- マニュアル本文 ----------';
const PAGE_DELIMITER = '================================================== 次のページ ==================================================';
const PART_TARGET_CHARS = 900000;
const CACHE_DIR = process.env.GROWI_MANUAL_CACHE_DIR ?? path.join(os.homedir(), '.claude', 'cache', 'growi-manual');

const cleanField = (value) => value.replace(/[\t\r\n]+/g, ' ').trim();
const partName = (part) => `part${String(part).padStart(2, '0')}.txt`;

export function normalizeText(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function parsePart(text, part) {
  const normalized = normalizeText(text);
  const buffer = Buffer.from(normalized, 'utf8');
  const lines = [];
  let start = 0;
  for (let i = 0; i <= buffer.length; i++) {
    if (i === buffer.length || buffer[i] === 0x0a) {
      lines.push({ start, end: i, next: i < buffer.length ? i + 1 : i, text: buffer.subarray(start, i).toString('utf8') });
      start = i + 1;
    }
  }
  const pages = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].text.startsWith('### ページタイトル: ')) continue;
    const title = lines[i].text.slice('### ページタイトル: '.length);
    const pathLine = lines[i + 1]?.text ?? '';
    const match = pathLine.match(/^--- 内部パス: (.*) ---$/);
    if (!match || lines[i + 3]?.text !== BODY_MARKER) continue;
    const byteStart = lines[i + 3].next;
    let byteEnd = buffer.length;
    for (let j = i + 4; j < lines.length; j++) {
      if (/^=+\s*次のページ\s*=+\s*$/.test(lines[j].text)) { byteEnd = lines[j].start; break; }
    }
    pages.push({ part, byteStart, byteEnd, title: cleanField(title), path: cleanField(match[1]) });
  }
  const header = normalized.slice(0, 1000);
  return {
    normalized,
    pages,
    updatedAt: header.match(/^更新日時:\s*(.+)$/m)?.[1]?.trim() ?? '',
    characterCount: Number((header.match(/^文字数:\s*([\d,]+)\s*文字$/m)?.[1] ?? '0').replaceAll(',', '')),
  };
}

function readIndex(cacheDir = CACHE_DIR) {
  const file = path.join(cacheDir, 'index.tsv');
  if (!fs.existsSync(file)) throw new Error('index.tsv がありません。先に index または sync/ingest を実行してください');
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    const [id, part, byteStart, byteEnd, title, manualPath] = line.split('\t');
    return { id, part: Number(part), byteStart: Number(byteStart), byteEnd: Number(byteEnd), title, path: manualPath };
  });
}

function loadPreviousMeta(cacheDir) {
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir, 'meta.json'), 'utf8')); } catch { return { parts: [] }; }
}

export function extractGrowiCsrf(html) {
  const match = String(html).match(/\bcsrftoken\s*=\s*(["'])(.*?)\1/i);
  if (!match) throw new Error('Growi ログイン画面から CSRF を取得できません');
  return match[2];
}

function responseCookies(response) {
  if (typeof response.headers?.getSetCookie === 'function') return response.headers.getSetCookie();
  const value = response.headers?.get?.('set-cookie');
  return value ? [value] : [];
}

function mergeCookies(jar, response) {
  for (const header of responseCookies(response)) {
    const pair = header.split(';', 1)[0];
    const split = pair.indexOf('=');
    if (split > 0) jar.set(pair.slice(0, split), pair.slice(split + 1));
  }
}

function cookieHeader(jar) { return [...jar].map(([key, value]) => `${key}=${value}`).join('; '); }

export async function loginGrowi({ baseUrl, user, password, http = fetch }) {
  const jar = new Map();
  const loginPage = await http(`${baseUrl.replace(/\/$/, '')}/login`, { redirect: 'manual' });
  mergeCookies(jar, loginPage);
  if (!loginPage.ok) throw new Error(`Growi ログイン画面の取得に失敗しました (${loginPage.status})`);
  const csrf = extractGrowiCsrf(await loginPage.text());
  const body = new URLSearchParams({ 'loginForm[username]': user, 'loginForm[password]': password, _csrf: csrf });
  const response = await http(`${baseUrl.replace(/\/$/, '')}/login`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) }, body,
  });
  mergeCookies(jar, response);
  if (response.status !== 302) throw new Error(`Growi ログインに失敗しました (HTTP ${response.status})`);
  return async (url, options = {}) => http(url, { ...options, headers: { ...options.headers, Cookie: cookieHeader(jar) } });
}

async function growiJson(http, url) {
  const response = await http(url);
  if (!response.ok) throw new Error(`Growi API エラー (${response.status})`);
  const type = response.headers?.get?.('content-type') ?? '';
  if (type && !type.includes('json')) throw new Error('Growi API が JSON 以外を返しました');
  return response.json();
}

export async function listGrowiPages(baseUrl, http, limit = 500, maxPasses = 5) {
  const pages = [];
  const seen = new Set();
  let totalCount = Infinity;
  let nextProgress = 100;
  let passes = 0;
  let executedPasses = 0;
  for (; passes < maxPasses; passes++) {
    executedPasses++;
    const countBeforePass = pages.length;
    const batchesSeen = new Set();
    let offset = 0;
    while (offset < totalCount) {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      const json = await growiJson(http, `${baseUrl.replace(/\/$/, '')}/_api/v3/pages/recent?${params}`);
      const batch = json.data?.pages ?? [];
      totalCount = Number(json.data?.totalCount ?? batch.length);
      if (batch.length === 0) break;
      const signature = batch.map((page) => page._id).join('\0');
      if (batchesSeen.has(signature)) break;
      batchesSeen.add(signature);
      for (const page of batch) {
        if (seen.has(page._id)) continue;
        seen.add(page._id);
        pages.push(page);
      }
      offset += batch.length;
      if (pages.length >= nextProgress) {
        console.error(`Growi ページ列挙中 ${pages.length}/${totalCount}`);
        nextProgress = Math.floor(pages.length / 100 + 1) * 100;
      }
    }
    if (pages.length >= totalCount || pages.length === countBeforePass) break;
  }
  const additionalPasses = Math.max(0, executedPasses - 1);
  if (pages.length < totalCount) {
    const reason = passes >= maxPasses ? `${maxPasses}パスの上限に達した` : '追加パスでも新規ページが増えなかった';
    console.error(`警告: Growi ページ列挙を打ち切ります（${reason}、収集 ${pages.length}/${totalCount}）`);
  }
  console.error(`Growi ページ列挙完了: 収集 ${pages.length} / totalCount ${totalCount}（追加パス ${additionalPasses} 回）`);
  return { pages, totalCount };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchGrowiBodies(pages, previous = {}, { baseUrl, http, full = false, concurrency = 6, retryDelay = wait } = {}) {
  const records = {};
  const changed = [];
  const failures = [];
  for (const page of pages) {
    const old = previous[page._id];
    if (!full && old?.updatedAt === page.updatedAt && typeof old.body === 'string') records[page._id] = { ...old, path: page.path };
    else changed.push(page);
  }
  let cursor = 0;
  let consecutiveFailures = 0;
  let aborted;
  async function worker() {
    while (!aborted) {
      const page = changed[cursor++];
      if (!page) return;
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const params = new URLSearchParams({ pageId: page._id, page: '1', limit: '1' });
          const json = await growiJson(http, `${baseUrl.replace(/\/$/, '')}/_api/v3/revisions/list?${params}`);
          const body = json.data?.docs?.[0]?.body;
          if (typeof body !== 'string') throw new Error('本文がありません');
          records[page._id] = { updatedAt: page.updatedAt, path: page.path, body };
          consecutiveFailures = 0;
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await retryDelay(250 * (2 ** attempt));
        }
      }
      if (lastError) {
        consecutiveFailures++;
        const old = previous[page._id];
        records[page._id] = { updatedAt: page.updatedAt, path: page.path, body: typeof old?.body === 'string' ? old.body : '' };
        failures.push({ id: page._id, path: page.path, error: lastError.message });
        if (consecutiveFailures > 20) aborted = new Error(`本文取得の連続失敗が20件を超えたため中断しました: ${lastError.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, changed.length)) }, worker));
  if (aborted) throw aborted;
  return { records, fetched: changed.length, failures };
}

function pageTitle(manualPath) {
  const segments = String(manualPath).split('/').filter(Boolean);
  return segments.at(-1) ?? '/';
}

function formatPage(record) {
  return `### ページタイトル: ${pageTitle(record.path)}\r\n--- 内部パス: ${record.path} ---\r\n\r\n${BODY_MARKER}\r\n${normalizeText(record.body).replaceAll('\n', '\r\n')}`;
}

export function generateGrowiParts(pages, records, { targetChars = PART_TARGET_CHARS, now = new Date() } = {}) {
  const groups = [];
  let current = [];
  let size = 0;
  for (const page of pages) {
    const rendered = formatPage(records[page._id]);
    const addition = rendered.length + (current.length ? PAGE_DELIMITER.length + 4 : 0);
    if (current.length && size + addition > targetChars) { groups.push(current); current = []; size = 0; }
    current.push(rendered); size += addition;
  }
  if (current.length) groups.push(current);
  const stamp = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now).replace(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)/, '$1/$2/$3 $4:$5:$6');
  return groups.map((group, index) => {
    const content = group.join(`\r\n${PAGE_DELIMITER}\r\n\r\n`);
    return `\uFEFF【社内マニュアル - Part ${index + 1}/${groups.length}】\r\n更新日時: ${stamp}\r\n文字数: ${content.length.toLocaleString('ja-JP')} 文字\r\n================================================================================\r\n\r\n${content}`;
  });
}

function decodeInput(file) {
  const raw = fs.readFileSync(file);
  try {
    const json = JSON.parse(raw.toString('utf8'));
    if (typeof json.content === 'string') return Buffer.from(json.content, 'base64').toString('utf8');
  } catch { /* 生ファイルとして扱う */ }
  return raw.toString('utf8');
}

export function buildIndex(cacheDir = CACHE_DIR, metadata = new Map()) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const files = fs.readdirSync(cacheDir).map((name) => ({ name, match: name.match(/^part(\d+)\.txt$/) }))
    .filter((item) => item.match).sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  const previous = loadPreviousMeta(cacheDir);
  const previousByPart = new Map((previous.parts ?? []).map((item) => [item.part, item]));
  const rows = [];
  const parts = [];
  for (const file of files) {
    const part = Number(file.match[1]);
    const parsed = parsePart(fs.readFileSync(path.join(cacheDir, file.name), 'utf8'), part);
    for (const page of parsed.pages) rows.push(page);
    const supplied = metadata.get(part) ?? previousByPart.get(part) ?? {};
    parts.push({ part, fileId: supplied.fileId ?? null, title: supplied.title ?? file.name, 更新日時: parsed.updatedAt, 文字数: parsed.characterCount, pages: parsed.pages.length });
  }
  const width = Math.max(4, String(rows.length).length);
  const tsv = rows.map((row, index) => [`p${String(index + 1).padStart(width, '0')}`, row.part, row.byteStart, row.byteEnd, cleanField(row.title), cleanField(row.path)].join('\t')).join('\n');
  fs.writeFileSync(path.join(cacheDir, 'index.tsv'), tsv ? `${tsv}\n` : '');
  fs.writeFileSync(path.join(cacheDir, 'meta.json'), `${JSON.stringify({ syncedAt: new Date().toISOString(), parts }, null, 2)}\n`);
  return { parts: parts.length, pages: rows.length };
}

function printSummary(result) { console.log(`Parts: ${result.parts} / Pages: ${result.pages}`); }

async function listManualDocs(token, driveApi) {
  const found = [];
  let pageToken = '';
  do {
    const q = `'${FOLDER_ID}' in parents and trashed=false and mimeType='${DOC_MIME}'`;
    const params = new URLSearchParams({ q, fields: 'nextPageToken,files(id,name,mimeType)', pageSize: '1000', orderBy: 'name' });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await driveApi(token, `https://www.googleapis.com/drive/v3/files?${params}`);
    const json = await response.json();
    found.push(...(json.files ?? []));
    pageToken = json.nextPageToken ?? '';
  } while (pageToken);
  return found.map((file) => ({ ...file, part: Number(file.name.match(/_Part(\d+)$/)?.[1]) }))
    .filter((file) => Number.isInteger(file.part)).sort((a, b) => a.part - b.part);
}

async function sync() {
  let auth;
  try {
    auth = await import('./lib/drive-auth.mjs');
  } catch {
    console.error('sync/publish-index は認証モジュール(tools/lib/drive-auth.mjs)が必要です。他アカウントは install-index を使ってください。');
    return 2;
  }
  const { defaultDriveKeyPath, driveApi, getDriveToken } = auth;
  const keyPath = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath();
  if (!fs.existsSync(keyPath)) {
    console.error('sync は kim 環境専用です。サービスアカウント鍵がない他の環境では ingest を使ってください。');
    return 2;
  }
  const token = await getDriveToken({ keyPath });
  const docs = await listManualDocs(token, driveApi);
  if (docs.length === 0) throw new Error('対象の Part が見つかりません');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const metadata = new Map();
  for (const doc of docs) {
    const response = await driveApi(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}/export?mimeType=${encodeURIComponent('text/plain')}`);
    const text = normalizeText(Buffer.from(await response.arrayBuffer()).toString('utf8'));
    fs.writeFileSync(path.join(CACHE_DIR, partName(doc.part)), text);
    metadata.set(doc.part, { fileId: doc.id, title: doc.name });
  }
  const currentParts = new Set(docs.map((doc) => doc.part));
  for (const name of fs.readdirSync(CACHE_DIR)) {
    const match = name.match(/^part(\d+)\.txt$/);
    if (match && !currentParts.has(Number(match[1]))) fs.rmSync(path.join(CACHE_DIR, name));
  }
  printSummary(buildIndex(CACHE_DIR, metadata));
  try { await publishIndex(CACHE_DIR); } catch (error) { console.error(`警告: 索引の発行に失敗しました: ${error.message}`); }
  return 0;
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return null;
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

// 戻り値: Map<Part番号, { fileId, title }>
async function writeManualDocs(parts, auth) {
  const { defaultDriveKeyPath, driveApi, getDriveToken } = auth;
  const keyPath = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath();
  if (!fs.existsSync(keyPath)) throw Object.assign(new Error('サービスアカウント鍵がありません'), { exitCode: 2 });
  const token = await getDriveToken({ keyPath, impersonate: process.env.GOOGLE_IMPERSONATE ?? 'seisaku-team@orgiast.jp' });
  const existing = await listManualDocs(token, driveApi);
  const byPart = new Map(existing.map((doc) => [doc.part, doc]));
  const metadata = new Map();
  for (let index = 0; index < parts.length; index++) {
    const part = index + 1;
    const found = byPart.get(part);
    if (found) {
      await driveApi(token, `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(found.id)}?uploadType=media`, {
        method: 'PATCH', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: Buffer.from(parts[index]),
      });
      metadata.set(part, { fileId: found.id, title: found.name });
    } else {
      const name = `社内マニュアル_Part${part}`;
      const boundary = `growi-part-${Date.now()}-${part}`;
      const info = JSON.stringify({ name, parents: [FOLDER_ID], mimeType: DOC_MIME });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${info}\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`),
        Buffer.from(parts[index]), Buffer.from(`\r\n--${boundary}--`),
      ]);
      const response = await driveApi(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      });
      const created = await response.json();
      metadata.set(part, { fileId: created.id, title: created.name ?? name });
    }
  }
  if (existing.length > parts.length) console.warn(`警告: 余剰 Part あり (${existing.length - parts.length}件)。NotebookLM の参照維持のため削除しません`);
  return metadata;
}

export async function syncGrowi(options = {}) {
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  const envFile = options.envFile ?? path.join(os.homedir(), '.claude', 'growi.env');
  const env = options.env ?? readEnvFile(envFile);
  if (!env) { console.error('Growi 認証情報がありません'); return 2; }
  const baseUrl = env.GROWI_BASE_URL;
  const user = env.GROWI_USER;
  const password = env.GROWI_PASS;
  if (!baseUrl || !user || !password) { console.error('Growi 認証情報が不足しています'); return 2; }
  const http = await loginGrowi({ baseUrl, user, password, http: options.http ?? fetch });
  const listed = await listGrowiPages(baseUrl, http, options.listLimit);
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(path.join(cacheDir, 'growi-pages.json'), 'utf8')).pages ?? {}; } catch { /* 初回同期 */ }
  const fetched = await fetchGrowiBodies(listed.pages, previous, { baseUrl, http, full: options.full, retryDelay: options.retryDelay });
  if (fetched.failures.length) console.warn(`警告: 本文取得に失敗したページが ${fetched.failures.length} 件あります（キャッシュまたは空本文で継続）`);
  const parts = generateGrowiParts(listed.pages, fetched.records, options.partOptions);
  const metadata = options.writeParts
    ? await options.writeParts(parts)
    : await writeManualDocs(parts, options.auth ?? await import('./lib/drive-auth.mjs'));
  if (!(metadata instanceof Map)) throw new TypeError('writeParts は Map<Part番号, { fileId, title }> を返す必要があります');
  fs.mkdirSync(cacheDir, { recursive: true });
  const active = new Set();
  for (let index = 0; index < parts.length; index++) {
    const name = partName(index + 1); active.add(name);
    fs.writeFileSync(path.join(cacheDir, name), normalizeText(parts[index]));
  }
  for (const name of fs.readdirSync(cacheDir)) if (/^part\d+\.txt$/.test(name) && !active.has(name)) fs.rmSync(path.join(cacheDir, name));
  fs.writeFileSync(path.join(cacheDir, 'growi-pages.json'), `${JSON.stringify({ pages: fetched.records }, null, 2)}\n`);
  const result = buildIndex(cacheDir, metadata);
  const metaFile = path.join(cacheDir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta.source = 'growi-sync';
  meta.growiSyncedAt = new Date().toISOString();
  fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  let reparsed = 0;
  for (let index = 0; index < parts.length; index++) reparsed += parsePart(parts[index], index + 1).pages.length;
  if (reparsed !== listed.totalCount) console.warn(`警告: Part のページ数 (${reparsed}) が Growi totalCount (${listed.totalCount}) と一致しません`);
  else console.log(`検証OK: ${reparsed}ページ`);
  const shouldPublish = options.publish ?? !options.writeParts;
  if (shouldPublish) {
    const code = options.publishIndex ? await options.publishIndex(cacheDir) : await publishIndex(cacheDir);
    if (code) return code;
  }
  printSummary(result);
  return 0;
}

async function findHubFile(token, title, driveApi) {
  const escaped = title.replaceAll("'", "\\'");
  const q = encodeURIComponent(`name='${escaped}' and '${HUB_FOLDER_ID}' in parents and trashed=false`);
  const response = await driveApi(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`);
  return (await response.json()).files ?? [];
}

async function uploadHubFile(token, localFile, title, mimeType, driveApi) {
  const content = fs.readFileSync(localFile);
  const existing = await findHubFile(token, title, driveApi);
  if (existing.length) {
    await driveApi(token, `https://www.googleapis.com/upload/drive/v3/files/${existing[0].id}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': `${mimeType}; charset=utf-8` }, body: content,
    });
    return { id: existing[0].id, bytes: content.length };
  }
  const boundary = `growi-index-${Date.now()}`;
  const metadata = JSON.stringify({ name: title, parents: [HUB_FOLDER_ID], mimeType });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}; charset=utf-8\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const response = await driveApi(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  });
  return { id: (await response.json()).id, bytes: content.length };
}

export async function publishIndex(cacheDir = CACHE_DIR, authOverride) {
  const indexFile = path.join(cacheDir, 'index.tsv');
  const metaFile = path.join(cacheDir, 'meta.json');
  if (!fs.existsSync(indexFile) || !fs.existsSync(metaFile)) {
    console.error('キャッシュがありません。先に sync を実行してください。');
    return 1;
  }
  let auth = authOverride;
  if (!auth) {
    try {
      auth = await import('./lib/drive-auth.mjs');
    } catch {
      console.error('sync/publish-index は認証モジュール(tools/lib/drive-auth.mjs)が必要です。他アカウントは install-index を使ってください。');
      return 2;
    }
  }
  const { defaultDriveKeyPath, driveApi, getDriveToken } = auth;
  const keyPath = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath();
  if (!fs.existsSync(keyPath)) {
    console.error('サービスアカウント鍵がありません。鍵のある環境で実行してください。');
    return 2;
  }
  const token = await getDriveToken({ keyPath });
  const index = await uploadHubFile(token, indexFile, 'growi-manual-index.tsv', 'text/tab-separated-values', driveApi);
  const meta = await uploadHubFile(token, metaFile, 'growi-manual-meta.json', 'application/json', driveApi);
  console.log(`published: growi-manual-index.tsv ${index.id} (${index.bytes} bytes) / growi-manual-meta.json ${meta.id}`);
  return 0;
}

export function ingestFiles(files, cacheDir = CACHE_DIR) {
  fs.mkdirSync(cacheDir, { recursive: true });
  let ingested = 0;
  for (const file of files) {
    try {
      const text = normalizeText(decodeInput(file));
      const part = Number(text.slice(0, 300).match(/【社内マニュアル - Part (\d+)\/\d+】/)?.[1]);
      if (!Number.isInteger(part) || part < 1) { console.error(`Part 番号を判定できないため skip: ${file}`); continue; }
      fs.writeFileSync(path.join(cacheDir, partName(part)), text);
      ingested++;
    } catch (error) { console.error(`読み込み失敗のため skip: ${file}: ${error.message}`); }
  }
  if (fs.existsSync(path.join(cacheDir, 'index.tsv')) && fs.existsSync(path.join(cacheDir, 'meta.json'))) {
    const meta = loadPreviousMeta(cacheDir);
    return { ingested, parts: meta.parts.length, pages: readIndex(cacheDir).length };
  }
  return { ingested, ...buildIndex(cacheDir) };
}

export function installIndexFiles(files, cacheDir = CACHE_DIR) {
  fs.mkdirSync(cacheDir, { recursive: true });
  let indexText;
  let meta;
  for (const file of files) {
    const text = normalizeText(decodeInput(file));
    const first = text.split('\n', 1)[0];
    if (/^p[^\t]*\t[^\t]+\t[^\t]+\t[^\t]+\t[^\t]*\t[^\t]*$/.test(first)) {
      indexText = text;
      continue;
    }
    try {
      const candidate = JSON.parse(text);
      if (Array.isArray(candidate.parts)) { meta = candidate; continue; }
    } catch { /* 下のエラーにまとめる */ }
    throw new Error(`索引ファイルとして判定できません: ${file}`);
  }
  if (!indexText || !meta) throw new Error('index.tsv と meta.json の両方を指定してください');
  meta.installedAt = new Date().toISOString();
  fs.writeFileSync(path.join(cacheDir, 'index.tsv'), indexText.endsWith('\n') ? indexText : `${indexText}\n`);
  fs.writeFileSync(path.join(cacheDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return { parts: meta.parts.length, pages: indexText.split('\n').filter(Boolean).length };
}

export function searchEntries(query, options = {}, cacheDir = CACHE_DIR) {
  const entries = readIndex(cacheDir);
  const limit = options.limit ?? 20;
  const handles = new Map();
  try {
    return entries.filter((entry) => {
      if (options.path && !entry.path.startsWith(options.path)) return false;
      let match = entry.title.includes(query) || entry.path.includes(query);
      if (!match && options.body) {
        if (!fs.existsSync(path.join(cacheDir, partName(entry.part)))) return false;
        let fd = handles.get(entry.part);
        if (fd === undefined) { fd = fs.openSync(path.join(cacheDir, partName(entry.part)), 'r'); handles.set(entry.part, fd); }
        match = readBody(fd, entry).toString('utf8').includes(query);
      }
      return match;
    }).slice(0, limit);
  } finally { for (const fd of handles.values()) fs.closeSync(fd); }
}

function formatEntry(entry) { return `${entry.id}\t${entry.part}\t${entry.title}\t${entry.path}`; }
function readBody(fd, entry) {
  const length = entry.byteEnd - entry.byteStart;
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, buffer, offset, length - offset, entry.byteStart + offset);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}

export function resolveGet(value, cacheDir = CACHE_DIR) {
  const entries = readIndex(cacheDir);
  for (const select of [
    (entry) => entry.id === value,
    (entry) => entry.path === value,
    (entry) => entry.title === value,
    (entry) => entry.title.includes(value),
  ]) {
    const matches = entries.filter(select);
    if (matches.length) return matches;
  }
  return [];
}

function usage() {
  console.error('usage: growi-manual.mjs sync-growi [--full] | sync | publish-index | install-index <file>... | ingest <file>... | index | search <query> [--limit N] [--path <prefix>] [--body] | get <id|title|path> | status');
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (!command) { usage(); return 2; }
  if (command === 'sync-growi') {
    if (rest.some((item) => item !== '--full')) { usage(); return 2; }
    try { return await syncGrowi({ full: rest.includes('--full') }); }
    catch (error) { if (error.exitCode) { console.error(error.message); return error.exitCode; } throw error; }
  }
  if (command === 'sync') return sync();
  if (command === 'publish-index') return publishIndex();
  if (command === 'install-index') {
    if (!rest.length) { usage(); return 2; }
    const result = installIndexFiles(rest);
    console.log(`索引を取り込みました: Parts ${result.parts} / Pages ${result.pages}（本文は未取得）`);
    return 0;
  }
  if (command === 'ingest') {
    if (!rest.length) { usage(); return 2; }
    const result = ingestFiles(rest); printSummary(result); return result.ingested ? 0 : 1;
  }
  if (command === 'index') { printSummary(buildIndex()); return 0; }
  if (command === 'search') {
    const query = rest.shift();
    if (!query) { usage(); return 2; }
    const options = { limit: 20, body: false };
    while (rest.length) {
      const option = rest.shift();
      if (option === '--body') options.body = true;
      else if (option === '--limit') { options.limit = Number(rest.shift()); if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('--limit には正の整数を指定してください'); }
      else if (option === '--path') { options.path = rest.shift(); if (options.path === undefined) throw new Error('--path に値が必要です'); }
      else throw new Error(`不明なオプション: ${option}`);
    }
    const matches = searchEntries(query, options);
    if (options.body) {
      const missing = [...new Set(readIndex(CACHE_DIR).map((entry) => entry.part))]
        .filter((part) => !fs.existsSync(path.join(CACHE_DIR, partName(part))));
      if (missing.length) console.error(`注意: 未取得の Part ${missing.join(',')} は本文検索の対象外です`);
    }
    console.log(matches.length ? matches.map(formatEntry).join('\n') : 'no match');
    return 0;
  }
  if (command === 'get') {
    if (rest.length !== 1) { usage(); return 2; }
    const matches = resolveGet(rest[0]);
    if (matches.length === 0) { console.error(`not found: ${rest[0]}`); return 1; }
    if (matches.length > 1) { console.log(matches.map(formatEntry).join('\n')); return 1; }
    const entry = matches[0];
    const bodyFile = path.join(CACHE_DIR, partName(entry.part));
    if (!fs.existsSync(bodyFile)) {
      const meta = loadPreviousMeta(CACHE_DIR);
      const item = (meta.parts ?? []).find((part) => part.part === entry.part) ?? {};
      console.error(`このページは Part ${entry.part} にありますが、本文がまだ取得されていません。\n\n  1) Drive MCP で download_file_content を呼ぶ\n     fileId: ${item.fileId ?? 'meta.json に fileId がありません'}\n     exportMimeType: text/plain\n     （サイズが大きいためローカルに保存されます。その保存パスを控える）\n  2) node ${process.argv[1]} ingest <保存パス>\n\n取り込むと Part ${entry.part} の ${item.pages ?? '不明な'} ページすべてが get できるようになります。`);
      return 3;
    }
    const fd = fs.openSync(bodyFile, 'r');
    try {
      process.stdout.write(`### ページタイトル: ${entry.title}\n--- 内部パス: ${entry.path} ---\n\n`);
      process.stdout.write(readBody(fd, entry));
    } finally { fs.closeSync(fd); }
    return 0;
  }
  if (command === 'status') {
    const metaFile = path.join(CACHE_DIR, 'meta.json');
    if (!fs.existsSync(metaFile)) { console.error('キャッシュがありません'); return 1; }
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const cached = meta.parts.filter((item) => fs.existsSync(path.join(CACHE_DIR, partName(item.part)))).length;
    console.log(`Parts: ${meta.parts.length} / Pages: ${meta.parts.reduce((sum, item) => sum + item.pages, 0)}  (本文取得済み ${cached}/${meta.parts.length})`);
    console.log(`索引: ${meta.source === 'growi-sync' ? `growi-sync ${meta.growiSyncedAt ?? meta.syncedAt}` : meta.installedAt ? `installed ${meta.installedAt}` : `synced ${meta.syncedAt}`}`);
    for (const item of meta.parts) console.log(`Part ${item.part}: ${item.更新日時} (${item.pages} pages) ${fs.existsSync(path.join(CACHE_DIR, partName(item.part))) ? '[本文あり]' : '[索引のみ]'}`);
    const dates = meta.parts.map((item) => Date.parse(String(item.更新日時).replaceAll('/', '-').replace(' ', 'T'))).filter(Number.isFinite);
    if (dates.length && Date.now() - Math.max(...dates) >= 90 * 86400000) console.log('STALE: 最新 Part の更新日時が 90 日以上前です');
    return 0;
  }
  usage(); return 2;
}

if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
