#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { machineIdentity } from './machine-identity.mjs';
import { redactForShare, findSharedSecret, parseMemoryFrontmatter } from './lib/share-content.mjs';
import { readEnvValue } from './env-kv.mjs';
import { keyserveAuthHeaders, requireKeyservePcId, keyserveSecret } from './keyserve-auth.mjs';
import { isKimOperated } from './lib/kim-operated.mjs';

const DEFAULT_MEMORY_URL = 'https://orgiast-memoryserve.vercel.app/api/memory';
const CUSTOMER_PATTERNS = [
  ['案件ID', /C0\d{3,}/],
  ['法人名', /株式会社|有限会社|合同会社/],
];
const EXCLUDED_FILE = 'EXCLUDED.md';
// user 型は kim 本人が操作する席にだけ入れる。受信側は本文を読まずに名前で判別する。
const isUserMemory = name => /^user_[^/]*\.md$/.test(String(name));

function isNonMemoryFile(name) {
  return name.startsWith('.') || name.includes('-bak-') || name.includes('.bak') || name.endsWith('~');
}

function excludedIndex(items) {
  const lines = [
    '# Export exclusions',
    '',
    '書き出さなかった memory の一覧です。本文や一致内容は記録しません。',
    '',
    ...items.sort((a, b) => a.name.localeCompare(b.name)).map(({ name, category }) =>
      `- \`${name}\` — ${category === 'opt-out' ? 'share: false' : category === 'customer' ? '顧客情報（法人名/案件ID）を含む' : '資格情報を含む'}`),
    '',
  ];
  return lines.join('\n');
}

function oneLine(error) { return String(error?.message || error || '不明').split(/\r?\n/)[0]; }
function argValue(argv, name) { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function sameFile(file, bytes) { try { return fs.readFileSync(file).equals(bytes); } catch { return false; } }
function safeReadJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }

export { parseMemoryFrontmatter } from './lib/share-content.mjs';

function memoryFiles(home, emit, channel) {
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
          if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== EXCLUDED_FILE && (channel === 'private' || entry.name !== 'MEMORY.md')) files.push({ file: path.join(memory, entry.name), name: entry.name });
          if (channel === 'private' && entry.isDirectory() && entry.name === 'index') {
            for (const child of fs.readdirSync(path.join(memory, 'index'), { withFileTypes: true })) {
              if (child.isFile() && child.name.endsWith('.md') && child.name !== EXCLUDED_FILE && !isNonMemoryFile(child.name)) files.push({ file: path.join(memory, 'index', child.name), name: `index/${child.name}` });
            }
          }
        }
      } catch (error) { if (error?.code !== 'ENOENT') emit(`失敗: ${memory} — ${oneLine(error)}`); }
    }
  } catch (error) { if (error?.code !== 'ENOENT') emit(`失敗: ${root} — ${oneLine(error)}`); }
  return files.sort((a, b) => a.file.localeCompare(b.file));
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
  for (const { file, name } of memoryFiles(home, emit, channel)) {
    try {
      const original = fs.readFileSync(file, 'utf8');
      const frontmatter = parseMemoryFrontmatter(original);
      const type = frontmatter['metadata.type'] || frontmatter.type;
      const allowed = channel === 'public' ? type === 'feedback'
        : type === 'user' ? isUserMemory(name) : (['feedback', 'project', 'reference'].includes(type) || name === 'MEMORY.md' || name.startsWith('index/'));
      if (!allowed) continue;
      if (channel === 'private' && [frontmatter.share, frontmatter['metadata.share']].some(value => /^false(?:\s+#.*)?$/i.test(value || ''))) {
        exclusions.push({ name, category: 'opt-out' });
        emit(`除外(共有拒否): ${name} — share: false`);
        continue;
      }
      const redacted = redactForShare(original);
      const secret = findSharedSecret(redacted);
      if (secret) {
        exclusions.push({ name, category: 'secret' });
        emit(`除外(資格情報): ${name} — 秘密パターン ${secret[0]} に一致`);
        continue;
      }
      const customer = channel === 'public' && CUSTOMER_PATTERNS.find(([, pattern]) => pattern.test(redacted));
      if (customer) {
        exclusions.push({ name, category: 'customer' });
        emit(`除外(顧客情報): ${name} — ${customer[0]}`);
        continue;
      }
      if (selected.has(name)) { emit(`スキップ: ${name} — 同名のmemoryを既に採用`); continue; }
      const bytes = Buffer.from(redacted, 'utf8');
      selected.set(name, { name, description: frontmatter.description || name, bytes });
    } catch (error) { emit(`失敗: ${name} — ${oneLine(error)}`); }
  }
  let written = 0, unchanged = 0, removed = 0;
  for (const item of selected.values()) {
    const destination = path.join(outputDir, item.name);
    if (sameFile(destination, item.bytes)) { unchanged++; continue; }
    emit(`${dryRun ? '書き込み予定' : '書き込み'}: ${path.join(outputDir, item.name)}`);
    if (!dryRun) { try { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, item.bytes); written++; } catch (error) { emit(`失敗: ${item.name} — ${oneLine(error)}`); } }
    else written++;
  }
  try {
    for (const name of localFiles(outputDir)) {
      const entry = { name };
      if (!name.endsWith('.md') || name === EXCLUDED_FILE || selected.has(name)) continue;
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
    ...(options.includeContents ? { contents: Object.fromEntries([...selected].map(([name, item]) => [name, item.bytes.toString('utf8')])) } : {}),
    excludedSecrets: exclusions.filter((item) => item.category === 'secret').length,
    excludedCustomerInfo: exclusions.filter((item) => item.category === 'customer').length,
  };
}

export function findLatestMemoryDir(home, emit = console.log) {
  const projects = path.join(home, '.claude', 'projects');
  const candidates = [];
  const directories = [];
  try {
    for (const project of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const dir = path.join(projects, project.name, 'memory');
      const file = path.join(dir, 'MEMORY.md');
      try { candidates.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch {}
      try { directories.push({ dir, mtime: fs.statSync(dir).mtimeMs }); } catch {}
    }
  } catch (error) { if (error?.code !== 'ENOENT') emit(`失敗: ${projects} — ${oneLine(error)}`); }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates[0]) return path.dirname(candidates[0].file);
  // 索引未作成の auto-memory も export と発信元判定の対象にする
  directories.sort((a, b) => b.mtime - a.mtime);
  return directories[0] ? directories[0].dir : '';
}

// Only the documented two-level layout is accepted, on both Windows and Unix.
export function validMemoryName(name) {
  return typeof name === 'string' && /^(?:index\/)?[^/\\:<>"|?*\x00-\x1f]+\.md$/.test(name)
    && !name.split('/').some(isNonMemoryFile) && path.posix.basename(name) !== EXCLUDED_FILE;
}
function localFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? localFiles(path.join(dir, entry.name), name + '/') : [name];
  });
}
function annotation(manifest, kimOperated) {
  const who = kimOperated
    ? 'このPCの Claude アカウントも kim 本人が操作している（tools/lib/kim-operated.mjs）。本文中の『ユーザー』『kim』はこのPCの user と同一人物なので、kim の好み・厳命・判断基準はそのまま適用する（既定ブラウザ等このPC固有の環境だけは実測で確かめる）。kim はこの画面を見ている前提で進め、「kim-PC に確認」「kim に伝えて」など kim が別PCにいる前提の手渡しや判断依頼の転送をせず、この場で直接聞く。'
    : '本文中の『ユーザー』『kim』は発信元の人物を指す。このPCの user は別人なので、人物固有の既定（既定ブラウザ・個人アカウント等）はそのまま適用せず、運用ノウハウ・手順・失敗の型として使う。';
  return `<!-- orgiast-shared-memory -->
この索引は ${manifest.source.account}（${manifest.source.pc}）の Claude Code memory の自動コピー（${manifest.generatedAt}）。${who}このディレクトリは毎日上書きされるので編集しない。このPCで得た知見は通常の auto-memory に書き、全社化したいものは /share-knowledge で投稿する。
<!-- orgiast-shared-memory -->

`;
}
export async function installSharedMemories(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const env = options.env || process.env;
  const dir = options.sharedDir || env.ORGIAST_SHARED_MEMORY_DIR || path.join(home, '.claude', 'shared-memory');
  const emit = options.emit || console.log;
  const result = { generatedAt: '', installed: 0, updated: 0, removed: 0, unchanged: 0, skipped: 0, dir };
  try {
    const request = async (query) => {
      const url = new URL(options.memoryUrl || env.ORGIAST_MEMORY_URL || DEFAULT_MEMORY_URL);
      url.search = query;
      const response = await (options.fetchImpl || fetch)(url.toString(), {
        headers: keyserveAuthHeaders(keyserveSecret(home, env), options.nowMs ?? Date.now(), requireKeyservePcId(home, env)),
        signal: AbortSignal.timeout(options.timeoutMs || 10000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}${response.status === 401 ? ' (~/.claude/keyserve.env 未受領またはローテーションの可能性)' : ''}`);
      return response.json();
    };
    let offline;
    let manifest;
    if (options.fromDir) {
      offline = Object.fromEntries(localFiles(options.fromDir).filter(validMemoryName).map(name => [name, fs.readFileSync(path.join(options.fromDir, name), 'utf8')]));
      const metadata = safeReadJson(path.join(options.fromDir, 'manifest.json'));
      manifest = { version: 2, generatedAt: metadata?.generatedAt || 'offline', source: { pc: metadata?.source?.pc || metadata?.source?.hostname || '', account: metadata?.source?.account || '' }, parts: 1,
        files: Object.entries(offline).map(([name, content]) => ({ name, sha256: sha256(content), bytes: Buffer.byteLength(content), part: 0 })) };
    } else manifest = await request('manifest=1');
    if (manifest?.version !== 2 || typeof manifest.generatedAt !== 'string' || !manifest.source || !Array.isArray(manifest.files) || !Number.isInteger(manifest.parts) || manifest.parts < 0) throw new Error('invalid v2 manifest');
    const kimOperated = options.kimOperated ?? isKimOperated(home);
    if (!kimOperated) manifest.files = manifest.files.filter(file => !isUserMemory(file?.name));
    const names = new Set();
    for (const file of manifest.files) {
      if (!validMemoryName(file.name) || names.has(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isInteger(file.bytes) || file.bytes < 0 || !Number.isInteger(file.part) || file.part < 0 || file.part >= manifest.parts) throw new Error('invalid manifest file');
      names.add(file.name);
    }
    result.generatedAt = manifest.generatedAt;
    // Hostname fallback used for authentication is not proof of the configured publishing identity.
    const pc = env.ORGIAST_KEYSERVE_PC || readEnvValue(path.join(home, '.claude', 'keyserve.env'), 'ORGIAST_KEYSERVE_PC');
    const rootNames = manifest.files.filter(file => !file.name.includes('/')).map(file => file.name);
    const local = findLatestMemoryDir(home, () => {});
    if ((pc && pc === manifest.source.pc) || (!pc && local && rootNames.length && rootNames.filter(name => fs.existsSync(path.join(local, name))).length / rootNames.length >= 0.5)) {
      result.skipped = manifest.files.length; emit('発信元のため install スキップ'); return result;
    }
    for (const target of [dir, path.join(dir, 'index'), path.join(dir, '.state.json')]) {
      try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error('shared-memory symlink rejected'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const statePath = path.join(dir, '.state.json');
    const previous = safeReadJson(statePath);
    const changed = manifest.files.filter(file => previous?.files?.[file.name] !== file.sha256 || !fs.existsSync(path.join(dir, file.name)) || (file.name === 'MEMORY.md' && (previous.generatedAt !== manifest.generatedAt || JSON.stringify(previous.source) !== JSON.stringify(manifest.source) || previous.kimOperated !== kimOperated)));
    const incoming = new Map();
    // Validate every downloaded part before changing any installed file or pruning.
    for (const part of new Set(changed.map(file => file.part))) {
      const payload = offline ? { version: 2, generatedAt: manifest.generatedAt, part, parts: manifest.parts, files: offline } : await request(`part=${part}`);
      if (payload?.version !== 2 || payload.generatedAt !== manifest.generatedAt || payload.part !== part || payload.parts !== manifest.parts || !payload.files) throw new Error('part generation mismatch');
      for (const file of changed.filter(file => file.part === part)) {
        const content = payload.files[file.name];
        if (typeof content !== 'string' || sha256(content) !== file.sha256 || Buffer.byteLength(content) !== file.bytes) throw new Error('part integrity mismatch');
        incoming.set(file.name, file.name === 'MEMORY.md' ? annotation(manifest, kimOperated) + content : content);
      }
    }
    for (const [name, content] of incoming) {
      const destination = path.join(dir, name);
      // Never follow a local symlink outside the managed directory.
      for (const target of [dir, path.dirname(destination), destination]) {
        try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error('shared-memory symlink rejected'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (fs.existsSync(destination)) result.updated++; else result.installed++;
      if (!options.dryRun) { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, content); }
    }
    result.unchanged = manifest.files.length - changed.length;
    for (const name of localFiles(dir)) {
      if (names.has(name) || ['.state.json', 'README.md'].includes(name)) continue;
      if (!options.dryRun) fs.rmSync(path.join(dir, name));
      result.removed++;
    }
    if (!options.dryRun) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ generatedAt: manifest.generatedAt, source: manifest.source, kimOperated, files: Object.fromEntries(manifest.files.map(file => [file.name, file.sha256])) }, null, 2) + '\n');
    }
  } catch (error) { emit(`memory-share install 取得失敗: ${oneLine(error)}`); result.error = oneLine(error); }
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
