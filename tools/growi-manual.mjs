#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDriveKeyPath, driveApi, getDriveToken } from '../scripts/lib/drive-auth.mjs';

const FOLDER_ID = '1LMRI2jFpVG3WnDYlepgbOuyJ6ZBYzI8B';
const DOC_MIME = 'application/vnd.google-apps.document';
const BODY_MARKER = '---------- マニュアル本文 ----------';
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

async function listManualDocs(token) {
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
  const keyPath = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath();
  if (!fs.existsSync(keyPath)) {
    console.error('sync は kim 環境専用です。サービスアカウント鍵がない他の環境では ingest を使ってください。');
    return 2;
  }
  const token = await getDriveToken({ keyPath });
  const docs = await listManualDocs(token);
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
  return 0;
}

export function ingestFiles(files, cacheDir = CACHE_DIR) {
  fs.mkdirSync(cacheDir, { recursive: true });
  let ingested = 0;
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file);
      let text;
      try {
        const json = JSON.parse(raw.toString('utf8'));
        text = typeof json.content === 'string' ? Buffer.from(json.content, 'base64').toString('utf8') : raw.toString('utf8');
      } catch { text = raw.toString('utf8'); }
      text = normalizeText(text);
      const part = Number(text.slice(0, 300).match(/【社内マニュアル - Part (\d+)\/\d+】/)?.[1]);
      if (!Number.isInteger(part) || part < 1) { console.error(`Part 番号を判定できないため skip: ${file}`); continue; }
      fs.writeFileSync(path.join(cacheDir, partName(part)), text);
      ingested++;
    } catch (error) { console.error(`読み込み失敗のため skip: ${file}: ${error.message}`); }
  }
  return { ingested, ...buildIndex(cacheDir) };
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
  console.error('usage: growi-manual.mjs sync | ingest <file>... | index | search <query> [--limit N] [--path <prefix>] [--body] | get <id|title|path> | status');
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (!command) { usage(); return 2; }
  if (command === 'sync') return sync();
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
    console.log(matches.length ? matches.map(formatEntry).join('\n') : 'no match');
    return 0;
  }
  if (command === 'get') {
    if (rest.length !== 1) { usage(); return 2; }
    const matches = resolveGet(rest[0]);
    if (matches.length === 0) { console.error(`not found: ${rest[0]}`); return 1; }
    if (matches.length > 1) { console.log(matches.map(formatEntry).join('\n')); return 1; }
    const entry = matches[0];
    const fd = fs.openSync(path.join(CACHE_DIR, partName(entry.part)), 'r');
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
    console.log(`Parts: ${meta.parts.length} / Pages: ${meta.parts.reduce((sum, item) => sum + item.pages, 0)}`);
    console.log(`syncedAt: ${meta.syncedAt}`);
    for (const item of meta.parts) console.log(`Part ${item.part}: ${item.更新日時} (${item.pages} pages)`);
    const dates = meta.parts.map((item) => Date.parse(String(item.更新日時).replaceAll('/', '-').replace(' ', 'T'))).filter(Number.isFinite);
    if (dates.length && Date.now() - Math.max(...dates) >= 90 * 86400000) console.log('STALE: 最新 Part の更新日時が 90 日以上前です');
    return 0;
  }
  usage(); return 2;
}

// シンボリックリンク経由で起動されると argv[1] はリンクのパス、import.meta.url は実体のパスに
// なる。素の比較だと一致せず main が呼ばれないまま exit 0 で無言終了する（~/orgiast-claude-rules
// が Downloads/orgiast-claude-rules へのリンクになっている環境で実際に踏んだ / 2026-08-28）。
export function isMainModule(argv1, metaUrl) {
  if (!argv1) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(argv1) === real(fileURLToPath(metaUrl));
}

if (isMainModule(process.argv[1], import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
