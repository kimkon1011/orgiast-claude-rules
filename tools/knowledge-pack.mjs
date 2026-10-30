#!/usr/bin/env node
// Byte-preserving Drive publication and installation. Never commit generated content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { redactForShare, findSharedSecret, parseMemoryFrontmatter } from './lib/share-content.mjs';
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { downloadFileContent, uploadFileContent } from './lib/drive-files.mjs';

export const HUB_ID = '1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw';
export const FOLDER_NAME = 'production-sales-knowledge';
export const MAX_BYTES = 60000;
export const FILES = ['00_INDEX.md', '10_booth-production.md', '20_sales-automation.md', '30_memory-booth.md', '31_memory-apps.md', '32_memory-biz.md', '40_playbooks.md'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const boundedDriveApi = (token, url, options = {}) => driveApi(token, url, { signal: AbortSignal.timeout(30000), ...options });
const homeDefault = () => process.env.ORGIAST_HOME || os.homedir();
export const installDir = home => path.join(home, '.claude', 'knowledge', 'production-sales');
export function sourcePaths(home = homeDefault()) {
  return {
    booth: path.join(home, 'Downloads', 'ブース制作アプリ'),
    sales: path.join(home, 'Downloads', 'CLAUDE.md配布', 'aujust-sales-automation'),
    memory: path.join(home, '.claude', 'projects', 'c--Users-uers-Downloads-CLAUDE-md--', 'memory'),
    playbooks: path.join(home, '.claude', 'playbooks'),
  };
}
export function isKnowledgeSource(home = homeDefault()) {
  const roots = sourcePaths(home);
  return fs.existsSync(roots.booth) && fs.existsSync(roots.sales) && fs.existsSync(path.join(roots.memory, 'index'));
}
function read(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function mdFiles(dir, emit) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(x => x.isFile() && x.name.endsWith('.md')).map(x => path.join(dir, x.name)).sort(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; emit(`スキップ(欠落): ${dir}`); return []; }
}
function safeSource(file, emit) {
  const original = read(file);
  if (original === null) { emit(`スキップ(欠落): ${file}`); return null; }
  const fm = parseMemoryFrontmatter(original);
  if ([fm.share, fm['metadata.share']].some(v => /^false(?:\s+#.*)?$/i.test(v || ''))) {
    emit(`除外(共有拒否): ${file}`); return null;
  }
  const text = redactForShare(original);
  const secret = findSharedSecret(text);
  if (secret) { emit(`除外(資格情報): ${file} — ${secret[0]}`); return null; }
  // Memory frontmatter is metadata, not operational guidance; reserve the byte
  // budget for the body so small per-source excerpts still contain useful facts.
  return { file, text: text.replace(/^---[^\S\n]*\n[\s\S]*?\n---(?:\n|$)/, '') };
}
function linkedFiles(text, index, root) {
  const names = [...text.matchAll(/\[[^\]\n]*\]\(([^)\n]+\.md)(?:#[^)]*)?\)/g)].map(m => m[1]);
  const wiki = [...text.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g)].map(m => m[1]);
  const found = [];
  for (const name of names) {
    if (/^[a-z]+:|^[/\\]/i.test(name)) continue;
    const file = path.resolve(path.dirname(index), name);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    found.push(file);
  }
  for (const name of wiki) if (/^[\w.-]+$/.test(name)) found.push(path.join(root, name.endsWith('.md') ? name : `${name}.md`));
  return [...new Set(found)];
}
export function collectKnowledge({ roots = sourcePaths(), emit = console.log } = {}) {
  const groups = new Map();
  const load = files => files.map(f => safeSource(f, emit)).filter(Boolean);
  groups.set(FILES[1], load(['CLAUDE.md', 'HANDOVER.md', 'HANDOFF.md'].map(f => path.join(roots.booth, f)).concat(mdFiles(path.join(roots.booth, 'docs'), emit))));
  groups.set(FILES[2], load(['CLAUDE.md', 'HANDOFF.md', 'docs/spec.md', 'docs/DATA_RULES.md'].map(f => path.join(roots.sales, f))));
  for (const [i, domain] of ['booth', 'apps', 'biz'].entries()) {
    const index = path.join(roots.memory, 'index', `${domain}.md`);
    const source = safeSource(index, emit);
    const entries = source ? load(linkedFiles(source.text, index, roots.memory)) : [];
    // Excluded memories must not leak through their descriptions in the index either.
    if (source) {
      const allowed = new Set(entries.map(x => x.file));
      source.text = source.text.split('\n').filter(line => linkedFiles(line, index, roots.memory).every(f => allowed.has(f))).join('\n');
    }
    groups.set(FILES[i + 3], source ? [source, ...entries] : []);
  }
  groups.set(FILES[6], load(mdFiles(roots.playbooks, emit)));
  return groups;
}
const byteLength = text => Buffer.byteLength(text, 'utf8');
function clip(text, budget) {
  const bytes = Buffer.from(text);
  if (bytes.length <= budget) return text;
  let end = Math.max(0, budget);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
function stamp(name, sources, generatedAt) {
  return `# ${name}\n\n生成日時: ${generatedAt}\nソースパス: ${sources}\n自動生成なので直接編集しない。ルールの正本: ONBOARDING.md の該当節。\n\n`;
}
export function renderGroup(name, entries, generatedAt) {
  const header = stamp(name, '各節の「全文はソース」を参照', generatedAt);
  const references = entries.map(x => `\n## ${path.basename(x.file)}\n全文はソース ${x.file}\n\n`);
  const remaining = MAX_BYTES - byteLength(header + references.join(''));
  if (remaining < 0) throw new Error(`${name}: ソース参照だけで60KBを超過`);
  if (!entries.length) return header + '利用可能なソースなし（欠落・共有拒否・資格情報の除外ログを確認）。\n';
  const allowance = Math.floor(remaining / entries.length);
  return header + entries.map((x, i) => {
    const suffix = '\n（上限のため抜粋。全文は上記ソースを参照）\n';
    return references[i] + (byteLength(x.text) <= allowance ? x.text : clip(x.text, Math.max(0, allowance - byteLength(suffix))) + (allowance >= byteLength(suffix) ? suffix : ''));
  }).join('');
}
const CORE_IDS = [
  ['ブース制作アプリ Drive フォルダ', '1Yt1E9En7K8tMVONET32KgHkMWR4jWT8t'],
  ['案件一覧 Sheet', '1mEa2mLEz0fv7RJIjRu9XsdwzJ-J-DcWw_E0Hyl7ll5A'],
  ['Growi マニュアル一次ソース', '1LMRI2jFpVG3WnDYlepgbOuyJ6ZBYzI8B'],
  ['営業ノウハウフォルダ', '1eEmYRetOvTnw6Pc6cyrmwVt9w1-YD68I'],
  ['営業統合マニュアル v2 Doc', '1xexbgkBg31fPhKHCGX9qHyFrPaxdab3y-RAMTKNMXgg'],
];
export function renderIndex(groups, generatedAt) {
  let text = stamp('制作・営業ナレッジ索引', '10〜40の各節に記載', generatedAt) +
    '読む順番: この索引 → 依頼に対応する節だけ Grep → 必要な一次資料。全文を丸読みしない。\n\n' +
    '10_booth-production.md: 制作アプリ・引継ぎ・仕様\n20_sales-automation.md: 営業アプリ・データ規則\n30_memory-booth.md: 制作の判断・失敗例\n31_memory-apps.md: 自社アプリの運用\n32_memory-biz.md: 経営・営業\n40_playbooks.md: 作業手順\n\n' +
    '使う skill: 案件調査 case-consult-sources／提案資料 design-deck／日程 secretary-schedule／請求追跡 invoice-payment-chase。各 SKILL.md を必要時に読む。\n' +
    'ルール正本: ONBOARDING.md §1.3 GAS、§1.11 DWD、§1.19 資料、§2.1 データ・文書、§2.9 Drive・共通知識。古い経緯は現在のルール・実物と照合する。\n\n主要 Drive ID（名前とセット）:\n' +
    CORE_IDS.map(([name, id]) => `- ${name}: ${id}\n`).join('');
  const templates = new Map();
  for (const entries of groups.values()) for (const entry of entries) for (const line of entry.text.split('\n')) {
    if (!/テンプレ|template/i.test(line)) continue;
    if (!/spreadsheets\/d\/|(?:見積|請求|実施計画|価格表|シート|sheet).{0,20}(?:テンプレ|template)|(?:テンプレ|template).{0,20}(?:シート|sheet)/i.test(line)) continue;
    for (const m of line.matchAll(/(?:spreadsheets\/d\/|["'`\s=:（(])([A-Za-z0-9_-]{25,})(?=["'`\s/）),;]|$)/g)) {
      const id = m[1];
      if (!/^1/.test(id) || CORE_IDS.some(x => x[1] === id)) continue;
      const label = clip(line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/[A-Za-z0-9_-]{25,}/g, '').replace(/[`*|\[\]()]/g, '').replace(/^\s*-\s*/, '').trim(), 72) || path.basename(entry.file);
      templates.set(id, label);
    }
  }
  const footer = '\nテンプレ Sheet の追加情報・全文は10〜40のソース節で「テンプレ」「TEMPLATE」を Grep。\n';
  for (const [id, label] of templates) {
    const line = `- テンプレ Sheet（${label}）: ${id}\n`;
    if (byteLength(text + line + footer) <= 3000) text += line;
  }
  text += footer;
  if (byteLength(text) > 3000) throw new Error('00_INDEX.md exceeds 3KB');
  return text;
}
function stableContent(next, previous) {
  const withoutTime = s => s.replace(/^生成日時: .*$/m, '生成日時:');
  return previous && withoutTime(previous) === withoutTime(next) ? previous : next;
}
export function generateKnowledge({ roots = sourcePaths(), outDir = path.join(homeDefault(), '.claude', 'knowledge-pack'), now = new Date(), emit = console.log } = {}) {
  const groups = collectKnowledge({ roots, emit });
  const generatedAt = now.toISOString();
  const contents = new Map([[FILES[0], renderIndex(groups, generatedAt)], ...[...groups].map(([name, entries]) => [name, renderGroup(name, entries, generatedAt)])]);
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, next] of contents) {
    const dest = path.join(outDir, name);
    const previous = read(dest);
    const content = stableContent(next, previous);
    if (content !== previous) fs.writeFileSync(dest, content);
    contents.set(name, Buffer.from(content));
    emit(`${name}\t${byteLength(content)} bytes`);
  }
  return { contents, outDir, sourceCount: [...groups.values()].reduce((sum, entries) => sum + entries.length, 0) };
}
async function find(token, name, parent, apiFn) {
  const params = new URLSearchParams({ q: `name='${name}' and '${parent}' in parents and trashed=false`, fields: 'files(id,name,mimeType)', pageSize: '100' });
  const { files = [] } = await (await apiFn(token, `https://www.googleapis.com/drive/v3/files?${params}`)).json();
  if (files.length > 1) throw new Error(`同名重複: ${name}（${parent}）`);
  return files[0];
}
async function folder(token, apiFn, create = false) {
  const found = await find(token, FOLDER_NAME, HUB_ID, apiFn);
  if (found) {
    if (found.mimeType !== 'application/vnd.google-apps.folder') throw new Error('knowledge folder MIME mismatch');
    return found.id;
  }
  if (!create) throw new Error('production-sales-knowledge が未公開');
  const res = await apiFn(token, 'https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER_NAME, parents: [HUB_ID], mimeType: 'application/vnd.google-apps.folder' }) });
  return (await res.json()).id;
}
export async function publishKnowledge({ contents, token, apiFn = boundedDriveApi, emit = console.log } = {}) {
  const folderId = await folder(token, apiFn, true);
  const plan = [];
  // Compare remote bytes, including stable timestamps, before any content writes.
  for (const [name, bytes] of contents) {
    const existing = await find(token, name, folderId, apiFn);
    const previous = existing ? await downloadFileContent(token, existing.id, { apiFn }) : null;
    const content = Buffer.from(stableContent(bytes.toString('utf8'), previous?.toString('utf8')));
    plan.push({ name, id: existing?.id, content, unchanged: previous?.equals(content) || false });
  }
  const manifestFile = await find(token, 'manifest.json', folderId, apiFn);
  const oldManifest = manifestFile ? await downloadFileContent(token, manifestFile.id, { apiFn }) : null;
  for (const item of plan) {
    if (!item.unchanged) item.id = (await uploadFileContent(token, { fileId: item.id, name: item.name, parentId: folderId, content: item.content, apiFn })).id;
    contents.set(item.name, item.content);
    emit(`${item.unchanged ? 'unchanged' : 'published'}: ${item.name} (${item.id}) ${item.content.length} bytes`);
  }
  const manifest = { version: 1, files: plan.map(x => ({ name: x.name, id: x.id, bytes: x.content.length, sha256: sha(x.content) })) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  if (!oldManifest?.equals(manifestBytes)) await uploadFileContent(token, { fileId: manifestFile?.id, name: 'manifest.json', parentId: folderId, content: manifestBytes, apiFn });
  return { folderId, manifest, updated: plan.filter(x => !x.unchanged).length, unchanged: plan.filter(x => x.unchanged).length };
}
export function validateManifest(manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== FILES.length) throw new Error('invalid knowledge manifest');
  const seen = new Set();
  for (const f of manifest.files) {
    if (!FILES.includes(f.name) || seen.has(f.name) || !/^[\w-]+$/.test(f.id || '') || !/^[a-f0-9]{64}$/.test(f.sha256 || '') || !Number.isInteger(f.bytes) || f.bytes < 1 || f.bytes > (f.name === FILES[0] ? 3000 : MAX_BYTES)) throw new Error('invalid knowledge manifest entry');
    seen.add(f.name);
  }
  return manifest;
}
function writeContents(contents, dir) {
  fs.mkdirSync(dir, { recursive: true });
  let updated = 0;
  for (const [name, bytes] of contents) {
    const dest = path.join(dir, name);
    if (fs.existsSync(dest) && fs.readFileSync(dest).equals(bytes)) continue;
    const tmp = `${dest}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, dest); } finally { fs.rmSync(tmp, { force: true }); }
    updated++;
  }
  return updated;
}
export async function installKnowledge({ home = homeDefault(), source = isKnowledgeSource(home), token, getToken = getDriveToken, apiFn = boundedDriveApi, emit = console.log, outDir = path.join(home, '.claude', 'knowledge-pack') } = {}) {
  if (source) {
    const { contents } = generateKnowledge({ roots: sourcePaths(home), outDir, emit });
    return { source: true, updated: writeContents(contents, installDir(home)) };
  }
  // DWD authorizes exact scopes: reuse the approved Drive scope from hub sync.
  // drive.readonly is not authorized for the existing SA (live verification).
  token ??= await getToken({ signal: AbortSignal.timeout(30000) });
  const folderId = await folder(token, apiFn);
  const file = await find(token, 'manifest.json', folderId, apiFn);
  if (!file) throw new Error('knowledge manifest missing');
  const manifestBytes = await downloadFileContent(token, file.id, { apiFn });
  const manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')));
  const contents = new Map();
  for (const f of manifest.files) {
    const dest = path.join(installDir(home), f.name);
    const local = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    const bytes = local?.length === f.bytes && sha(local) === f.sha256 ? local : await downloadFileContent(token, f.id, { apiFn });
    if (bytes.length !== f.bytes || sha(bytes) !== f.sha256) throw new Error(`knowledge integrity mismatch: ${f.name}`);
    contents.set(f.name, bytes);
  }
  // Download and validate the complete generation before replacing any local file.
  const updated = writeContents(contents, installDir(home));
  writeContents(new Map([['manifest.json', manifestBytes]]), installDir(home));
  emit(`knowledge-pack install: ${FILES.length} files, updated=${updated}`);
  return { source: false, updated, files: manifest.files, folderId };
}
export async function runKnowledgePack({ home = homeDefault(), sourceHome = home, outDir = path.join(home, '.claude', 'knowledge-pack'), dryRun = false, token, apiFn = boundedDriveApi, emit = console.log, localDir = installDir(home) } = {}) {
  const generated = generateKnowledge({ roots: sourcePaths(sourceHome), outDir, emit });
  if (dryRun) return generated;
  if (!generated.sourceCount) throw new Error('公開中止: 利用可能なソースが0件（既存のDrive内容を維持）');
  token ??= await getDriveToken({ signal: AbortSignal.timeout(30000) });
  const result = await publishKnowledge({ ...generated, token, apiFn, emit });
  writeContents(generated.contents, outDir);
  writeContents(generated.contents, localDir);
  return result;
}
export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--pull') options.pull = true;
    else if (flag === '--receiver') options.source = false;
    else if (['--out-dir', '--source-home', '--home'].includes(flag) && args[i + 1] && !args[i + 1].startsWith('--')) options[{ '--out-dir': 'outDir', '--source-home': 'sourceHome', '--home': 'home' }[flag]] = path.resolve(args[++i]);
    else throw new Error(`unknown/missing argument: ${flag}`);
  }
  if (options.pull && options.dryRun) throw new Error('--pull と --dry-run は併用不可');
  return options;
}
if (isEntry(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.pull ? await installKnowledge(options) : await runKnowledgePack(options);
    if (result.folderId) console.log(`production-sales-knowledge: ${result.folderId}`);
  } catch (e) { console.error(`knowledge-pack: ${e.message}`); process.exitCode = 1; }
}
