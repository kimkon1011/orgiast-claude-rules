#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { machineIdentity } from './machine-identity.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { keyserveAuthHeaders, keyserveSecret } from './keyserve-auth.mjs';

const DEFAULT_MEMORY_URL = 'https://orgiast-keyserve.vercel.app/api/memory';
const SHARED_INDEX_LINE = '- **他PCからの共有知見** 別アカウントPCで確立した実測ノウハウ → [index/shared.md](index/shared.md)';
const SECRET_PATTERNS = [
  ['Discord webhook URL', /discord\.com\/api\/webhooks\//i],
  ['OpenAI API key', /sk-[A-Za-z0-9]{20,}/],
  ['Groq API key', /gsk_[A-Za-z0-9]{20,}/],
  ['GitHub token', /ghp_[A-Za-z0-9]{20,}/],
  ['Slack bot token', /xoxb-/],
  ['Google API key', /AIza[A-Za-z0-9_-]{20,}/],
  ['private key', /-----BEGIN .*PRIVATE KEY-----/],
  ['40文字以上のhex', /[A-Fa-f0-9]{40,}/],
  ['ORGIAST_SHARED_SECRET', /ORGIAST_SHARED_SECRET\s*=\s*\S/],
];
const CUSTOMER_PATTERNS = [
  ['案件ID', /C0\d{3,}/],
  ['法人名', /株式会社|有限会社|合同会社/],
];
const EXCLUDED_FILE = 'EXCLUDED.md';

function isNonMemoryFile(name) {
  return name.startsWith('.') || name.includes('-bak-') || name.includes('.bak') || name.endsWith('~');
}

function excludedIndex(items) {
  const lines = [
    '# Export exclusions',
    '',
    '公開リポジトリへ書き出さなかった feedback memory の一覧です。本文や一致内容は記録しません。',
    '',
    ...items.sort((a, b) => a.name.localeCompare(b.name)).map(({ name, category }) =>
      `- \`${name}\` — ${category === 'customer' ? '顧客情報（法人名/案件ID）を含む' : '資格情報を含む'}`),
    '',
  ];
  return lines.join('\n');
}

function oneLine(error) { return String(error?.message || error || '不明').split(/\r?\n/)[0]; }
function argValue(argv, name) { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function sameFile(file, bytes) { try { return fs.readFileSync(file).equals(bytes); } catch { return false; } }
function safeReadJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }

export function parseMemoryFrontmatter(text) {
  const match = /^(?:\uFEFF)?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/.exec(String(text));
  if (!match) return {};
  let inMetadata = false;
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const metadata = /^metadata\s*:\s*(?:#.*)?$/.exec(line);
    if (metadata) { inMetadata = true; continue; }
    const nested = /^\s+([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (inMetadata && nested) { result[`metadata.${nested[1]}`] = nested[2].replace(/^(['"])(.*)\1$/, '$2'); continue; }
    if (/^\S/.test(line)) inMetadata = false;
    const top = /^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (top) result[top[1]] = top[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}

function memoryFiles(home, emit) {
  const root = path.join(home, '.claude', 'projects');
  const files = [];
  try {
    for (const project of fs.readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const memory = path.join(root, project.name, 'memory');
      try {
        for (const entry of fs.readdirSync(memory, { withFileTypes: true })) {
          if (entry.isFile() && isNonMemoryFile(entry.name)) {
            emit(`除外(対象外ファイル): ${entry.name} — バックアップ/隠しファイル`);
            continue;
          }
          if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') files.push(path.join(memory, entry.name));
        }
      } catch (error) { if (error?.code !== 'ENOENT') emit(`失敗: ${memory} — ${oneLine(error)}`); }
    }
  } catch (error) { if (error?.code !== 'ENOENT') emit(`失敗: ${root} — ${oneLine(error)}`); }
  return files.sort();
}

function sourceIdentity(home) {
  let identity = {};
  try { identity = machineIdentity() || {}; } catch {}
  const account = safeReadJson(path.join(home, '.claude.json'))?.oauthAccount?.emailAddress || 'unknown';
  const hostname = identity.hostname || process.env.COMPUTERNAME || os.hostname() || 'unknown';
  return { label: identity.label || hostname, hostname, account };
}

export function exportMemories(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const outputDir = options.outDir || path.join(home, '.claude', 'memory-bundle');
  const channel = options.channel || 'private';
  if (!['private', 'public'].includes(channel)) throw new Error('--channel は private または public を指定してください');
  const dryRun = Boolean(options.dryRun);
  const emit = options.emit || console.log;
  if (!findLatestMemoryDir(home, emit)) {
    emit('memory が1件も無いため export をスキップ');
    return { exported: 0, written: 0, unchanged: 0, removed: 0, excluded: 0 };
  }
  const selected = new Map();
  const exclusions = [];
  for (const file of memoryFiles(home, emit)) {
    const name = path.basename(file);
    try {
      const original = fs.readFileSync(file, 'utf8');
      const frontmatter = parseMemoryFrontmatter(original);
      const type = frontmatter['metadata.type'] || frontmatter.type;
      if (type !== 'feedback') continue;
      const secret = SECRET_PATTERNS.find(([, pattern]) => pattern.test(original));
      if (secret) {
        exclusions.push({ name, category: 'secret' });
        emit(`除外(資格情報): ${name} — 秘密パターン ${secret[0]} に一致`);
        continue;
      }
      const redacted = redactSecrets(original);
      const customer = channel === 'public' && CUSTOMER_PATTERNS.find(([, pattern]) => pattern.test(redacted));
      if (customer) {
        exclusions.push({ name, category: 'customer' });
        emit(`除外(顧客情報): ${name} — ${customer[0]}`);
        continue;
      }
      if (selected.has(name)) { emit(`スキップ: ${name} — 同名のfeedbackを既に採用`); continue; }
      const bytes = Buffer.from(redacted, 'utf8');
      selected.set(name, { name, description: frontmatter.description || name, bytes });
    } catch (error) { emit(`失敗: ${name} — ${oneLine(error)}`); }
  }
  let written = 0, unchanged = 0, removed = 0;
  for (const item of selected.values()) {
    const destination = path.join(outputDir, item.name);
    if (sameFile(destination, item.bytes)) { unchanged++; continue; }
    emit(`${dryRun ? '書き込み予定' : '書き込み'}: ${path.join(outputDir, item.name)}`);
    if (!dryRun) { try { fs.mkdirSync(outputDir, { recursive: true }); fs.writeFileSync(destination, item.bytes); written++; } catch (error) { emit(`失敗: ${item.name} — ${oneLine(error)}`); } }
    else written++;
  }
  try {
    for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === EXCLUDED_FILE || selected.has(entry.name)) continue;
      emit(`${dryRun ? '削除予定' : '削除'}: ${path.join(outputDir, entry.name)}`);
      if (!dryRun) fs.rmSync(path.join(outputDir, entry.name));
      removed++;
    }
  } catch (error) { if (error?.code !== 'ENOENT') emit(`失敗: ${outputDir} — ${oneLine(error)}`); }
  const files = [...selected.values()].sort((a, b) => a.name.localeCompare(b.name)).map((item) => ({
    name: item.name, description: item.description, sha256: sha256(item.bytes), bytes: item.bytes.length,
  }));
  const source = sourceIdentity(home);
  const manifestPath = path.join(outputDir, 'manifest.json');
  const previous = safeReadJson(manifestPath);
  const stable = previous?.version === 1 && previous?.channel === channel && JSON.stringify(previous.source) === JSON.stringify(source) && JSON.stringify(previous.files) === JSON.stringify(files);
  const manifest = { version: 1, channel, generatedAt: stable ? previous.generatedAt : (options.now || new Date()).toISOString(), source, files };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (!sameFile(manifestPath, manifestBytes)) {
    emit(`${dryRun ? '書き込み予定' : '書き込み'}: ${manifestPath}`);
    if (!dryRun) { try { fs.mkdirSync(outputDir, { recursive: true }); fs.writeFileSync(manifestPath, manifestBytes); } catch (error) { emit(`失敗: manifest.json — ${oneLine(error)}`); } }
  }
  const excludedPath = path.join(outputDir, EXCLUDED_FILE);
  const excludedBytes = Buffer.from(excludedIndex(exclusions), 'utf8');
  if (!sameFile(excludedPath, excludedBytes)) {
    emit(`${dryRun ? '書き込み予定' : '書き込み'}: ${excludedPath}`);
    if (!dryRun) { fs.mkdirSync(outputDir, { recursive: true }); fs.writeFileSync(excludedPath, excludedBytes); }
  }
  return {
    exported: files.length, written, unchanged, removed, excluded: exclusions.length,
    excludedSecrets: exclusions.filter((item) => item.category === 'secret').length,
    excludedCustomerInfo: exclusions.filter((item) => item.category === 'customer').length,
  };
}

export function findLatestMemoryDir(home, emit = console.log) {
  const projects = path.join(home, '.claude', 'projects');
  const candidates = [];
  try {
    for (const project of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const file = path.join(projects, project.name, 'memory', 'MEMORY.md');
      try { candidates.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch {}
    }
  } catch (error) { if (error?.code !== 'ENOENT') emit(`失敗: ${projects} — ${oneLine(error)}`); }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ? path.dirname(candidates[0].file) : '';
}

function updateMemoryIndex(text, count) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const line = `${SHARED_INDEX_LINE} (${count}件)`;
  const pattern = /^- \*\*他PCからの共有知見\*\*.*$/gm;
  if (pattern.test(text)) return text.replace(pattern, line);
  const heading = /^## ドメイン索引\s*$/m;
  if (heading.test(text)) return text.replace(heading, (value) => `${value}${newline}${line}`);
  return text;
}

function bundleFiles(payload) {
  const raw = payload?.files ?? payload?.bundle?.files;
  if (Array.isArray(raw)) return raw.map((item) => [item.name, item.content ?? item.body ?? item.data]);
  if (raw && typeof raw === 'object') return Object.entries(raw).map(([name, value]) => [name, value?.content ?? value?.body ?? value?.data ?? value]);
  throw new Error('壊れた JSON (files がありません)');
}

function readBundleDirectory(sourceDir) {
  return fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== EXCLUDED_FILE)
    .map((entry) => [entry.name, fs.readFileSync(path.join(sourceDir, entry.name))]);
}

export async function installSharedMemories(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const dryRun = Boolean(options.dryRun);
  const emit = options.emit || console.log;
  const memoryDir = findLatestMemoryDir(home, emit);
  const result = { installed: 0, skipped: 0, unchanged: 0, indexed: 0 };
  if (!memoryDir) { emit('memory が1件も無いため install をスキップ'); return result; }
  let incoming;
  try {
    const secret = keyserveSecret(home, options.env || process.env);
    const response = await (options.fetchImpl || fetch)(options.memoryUrl || process.env.ORGIAST_MEMORY_URL || DEFAULT_MEMORY_URL, {
      headers: keyserveAuthHeaders(secret, options.nowMs || Date.now()), signal: AbortSignal.timeout(options.timeoutMs || 10000),
    });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    incoming = bundleFiles(await response.json()).map(([name, value]) => [name, Buffer.from(String(value), 'utf8')]);
  } catch (error) {
    if (options.fromDir && fs.existsSync(options.fromDir)) incoming = readBundleDirectory(options.fromDir);
    else {
      const authHint = error?.status === 401 ? ' (~/.claude/keyserve.env 未受領またはローテーションの可能性)' : '';
      emit(`memory-share install 取得失敗: ${oneLine(error)}${authHint}`);
      return result;
    }
  }
  const sharedDir = path.join(memoryDir, 'shared');
  const planned = new Map();
  try {
    for (const [name, source] of incoming.sort(([a], [b]) => a.localeCompare(b))) {
      if (!name.endsWith('.md') || name === EXCLUDED_FILE || path.basename(name) !== name || isNonMemoryFile(name)) continue;
      try {
        const local = path.join(memoryDir, name);
        if (fs.existsSync(local)) { result.skipped++; emit(`スキップ: ${name} — ローカル直下に同名memoryあり`); continue; }
        const destination = path.join(sharedDir, name);
        if (fs.existsSync(destination)) {
          const current = fs.readFileSync(destination);
          if (current.equals(source)) { result.unchanged++; planned.set(name, current); continue; }
          if (parseMemoryFrontmatter(current.toString('utf8'))['metadata.localOverride'] === 'true') {
            result.skipped++; planned.set(name, current); emit(`スキップ: ${name} — metadata.localOverride: true`); continue;
          }
        }
        planned.set(name, source); result.installed++;
        emit(`${dryRun ? '配置予定' : '配置'}: shared/${name}`);
        if (!dryRun) { fs.mkdirSync(sharedDir, { recursive: true }); fs.writeFileSync(destination, source); }
      } catch (error) { emit(`失敗: ${name} — ${oneLine(error)}`); }
    }
  } catch (error) { emit(`失敗: bundle — ${oneLine(error)}`); }
  if (!dryRun) {
    try {
      for (const entry of fs.readdirSync(sharedDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md') && !planned.has(entry.name)) fs.rmSync(path.join(sharedDir, entry.name));
      }
    } catch (error) { if (error?.code !== 'ENOENT') emit(`失敗: ${sharedDir} — ${oneLine(error)}`); }
  }
  const entries = [...planned.entries()].sort(([a], [b]) => a.localeCompare(b));
  const index = ['# 他PCからの共有知見', '', '（MEMORY.md から辿られるサブ索引。新規は共有元PCで管理）', '', ...entries.map(([name, bytes]) => {
    const description = parseMemoryFrontmatter(bytes.toString('utf8')).description || name;
    return `- [${description}](../shared/${name})`;
  }), ''].join('\n');
  const indexPath = path.join(memoryDir, 'index', 'shared.md');
  const memoryPath = path.join(memoryDir, 'MEMORY.md');
  try {
    const indexBytes = Buffer.from(index);
    if (!sameFile(indexPath, indexBytes)) {
      emit(`${dryRun ? '生成予定' : '生成'}: index/shared.md`);
      if (!dryRun) { fs.mkdirSync(path.dirname(indexPath), { recursive: true }); fs.writeFileSync(indexPath, indexBytes); }
    }
    const current = fs.readFileSync(memoryPath, 'utf8');
    const updated = updateMemoryIndex(current, entries.length);
    if (updated !== current) {
      emit(`${dryRun ? '更新予定' : '更新'}: MEMORY.md 共有索引 (${entries.length}件)`);
      if (!dryRun) fs.writeFileSync(memoryPath, updated, 'utf8');
    }
    result.indexed = entries.length;
  } catch (error) { emit(`失敗: shared index — ${oneLine(error)}`); }
  return result;
}

export async function run(argv = process.argv.slice(2), options = {}) {
  const dryRun = argv.includes('--dry-run');
  const json = argv.includes('--json');
  const common = { ...options, dryRun, emit: json ? (line) => console.error(line) : (options.emit || console.log) };
  let result;
  if (argv.includes('--export')) result = exportMemories({ ...common, outDir: argValue(argv, '--out'), channel: argValue(argv, '--channel') || 'private' });
  else if (argv.includes('--install')) result = await installSharedMemories({ ...common, fromDir: argValue(argv, '--from') });
  else { console.error('使い方: node tools/memory-share.mjs (--export [--out <dir>] [--channel private|public]|--install [--from <dir>]) [--dry-run] [--json]'); return null; }
  if (json) console.log(JSON.stringify(result));
  else console.log(`完了: ${Object.entries(result).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  return result;
}

if (isEntry(import.meta.url)) await run().catch((error) => console.error(`memory-share 失敗（処理は継続）: ${oneLine(error)}`));
