#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const TREE_URL = 'https://api.github.com/repos/kimkon1011/orgiast-claude-rules/git/trees/main?recursive=1';
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function scriptRepo() {
  let pathname = decodeURIComponent(new URL(import.meta.url).pathname);
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
  return path.dirname(path.dirname(pathname));
}

function resolveRepo(explicitRepo) {
  if (explicitRepo) return path.resolve(explicitRepo);
  const home = process.env.ORGIAST_HOME || os.homedir();
  const candidates = [
    process.env.ORGIAST_REPO,
    path.join(home, 'orgiast-claude-rules'),
    path.join(home, 'Downloads', 'orgiast-claude-rules'),
    scriptRepo(),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'tools'))) || candidates.at(-1);
}

export function gitBlobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function selectedBlobs(tree) {
  const topLevel = new Set(['ONBOARDING.md', 'manifest.json', 'fleet-command.json', 'CLAUDE.md.template']);
  return (tree?.tree || []).filter((entry) => entry.type === 'blob' && entry.mode !== '120000'
    && (entry.path.startsWith('tools/') || topLevel.has(entry.path)));
}

function gitOutput(repo, args) {
  try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function defaultLsRemote(repo, timeoutMs) {
  try {
    return execFileSync('git', ['-C', repo, 'ls-remote', 'origin', 'refs/heads/main'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs,
    }).trim();
  } catch { return ''; }
}

function parseHeadSha(output) {
  return String(output || '').trim().split(/\s+/)[0] || '';
}

function readStatusPaths(repo) {
  const result = new Set();
  let output;
  try { output = execFileSync('git', ['-C', repo, 'status', '--porcelain', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return result; }
  const records = output.split('\0');
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3).replaceAll('\\', '/');
    if (file) result.add(file);
    if (code.includes('R') || code.includes('C')) i += 1;
  }
  return result;
}

function readIndexShas(repo) {
  const result = new Map();
  let output;
  try { output = execFileSync('git', ['-C', repo, 'ls-files', '-s', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return result; }
  for (const record of output.split('\0')) {
    if (!record) continue;
    const match = record.match(/^[0-7]+ ([0-9a-f]+) (\d+)\t([\s\S]+)$/);
    // ls-files -s は `<mode> <sha> <stage>\t<path>`。グループは 1=sha / 2=stage / 3=path。
    if (match?.[2] === '0') result.set(match[3].replaceAll('\\', '/'), match[1]);
  }
  return result;
}

function normalizedLfSha(content) {
  if (content.includes(0)) return null;
  const normalized = Buffer.from(content.toString('binary').replaceAll('\r\n', '\n'), 'binary');
  return gitBlobSha(normalized);
}

async function defaultFetchTree(timeoutMs) {
  const response = await fetch(TREE_URL, {
    headers: { 'User-Agent': 'orgiast-version-drift' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
  return response.json();
}

function readCache(cacheFile, now, ttlMs) {
  try {
    const stat = fs.statSync(cacheFile);
    if (now - stat.mtimeMs > ttlMs) return null;
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return Object.hasOwn(cached, 'headSha') && cached.tree ? cached : null;
  } catch { return null; }
}

function readAnyCache(cacheFile) {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return Object.hasOwn(cached, 'headSha') && cached.tree ? cached : null;
  } catch { return null; }
}

function writeCache(cacheFile, headSha, tree) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ headSha, tree }));
  } catch {}
}

function metadata(repo, upstreamTree, statusPaths) {
  const localTree = gitOutput(repo, ['rev-parse', 'HEAD^{tree}']);
  const treeMatches = localTree && upstreamTree?.sha ? localTree === upstreamTree.sha : undefined;
  const counts = gitOutput(repo, ['rev-list', '--count', '--left-right', 'origin/main...HEAD']).split(/\s+/);
  const ahead = counts.length === 2 && /^\d+$/.test(counts[1]) ? Number(counts[1]) : undefined;
  const behind = counts.length === 2 && /^\d+$/.test(counts[0]) ? Number(counts[0]) : undefined;
  return { treeMatches, ahead, behind, dirty: statusPaths.size };
}

export async function checkVersionDrift(options = {}) {
  // テストからGitHub APIを叩かせないための逃げ道(未認証は 60req/h でレート制限に当たる)。
  // 本番では設定しない。スキップ時は formatDriftLine が空文字を返し、呼び出し側は行を出さない。
  if (process.env.VERSION_DRIFT_SKIP === '1' && options.tree === undefined) {
    return { status: 'skipped', repo: resolveRepo(options.repo), checked: 0, drifted: [], wip: [], stale: false, headSha: undefined, method: 'content', note: 'VERSION_DRIFT_SKIP=1' };
  }
  const repo = resolveRepo(options.repo);
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const home = process.env.ORGIAST_HOME || os.homedir();
  const cacheFile = options.cacheFile || path.join(home, '.claude', '.version-drift-tree.json');
  let tree = options.tree;
  let stale = false;
  let note = '';
  let headSha;

  if (!tree) {
    let lsRemoteOutput = '';
    try {
      lsRemoteOutput = options.lsRemote
        ? await options.lsRemote(8000)
        : defaultLsRemote(repo, 8000);
    } catch {}
    const currentHeadSha = parseHeadSha(lsRemoteOutput);
    const cached = readCache(cacheFile, now, ttlMs);
    if (cached && (!currentHeadSha || cached.headSha === currentHeadSha)) {
      tree = cached.tree;
      headSha = cached.headSha || undefined;
    }
    else {
      try {
        tree = await (options.fetchTree || defaultFetchTree)(options.timeoutMs ?? 8000);
        headSha = currentHeadSha || undefined;
        writeCache(cacheFile, currentHeadSha, tree);
      } catch (error) {
        const fallback = readAnyCache(cacheFile);
        if (fallback) { tree = fallback.tree; headSha = fallback.headSha || undefined; stale = true; note = 'GitHub API取得失敗のためキャッシュを使用'; }
        else return { status: 'unknown', repo, checked: 0, drifted: [], wip: [], stale: false, headSha: currentHeadSha || undefined, treeMatches: undefined, ahead: undefined, behind: undefined, dirty: undefined, method: 'content', note: 'GitHub API 到達不可・キャッシュ無し' };
      }
    }
  }

  const statusPaths = options.statusPaths === undefined ? readStatusPaths(repo) : new Set(options.statusPaths);
  const normalizedStatusPaths = new Set([...statusPaths].map((item) => String(item).replaceAll('\\', '/')));
  const drifted = [];
  const wip = [];
  const blobs = selectedBlobs(tree);
  const suppliedIndexShas = options.indexShas;
  const indexShas = suppliedIndexShas === undefined ? readIndexShas(repo)
    : suppliedIndexShas instanceof Map ? suppliedIndexShas : new Map(Object.entries(suppliedIndexShas));
  let usedIndex = false;
  let usedContent = false;
  for (const entry of blobs) {
    const localPath = path.join(repo, ...entry.path.split('/'));
    if (!fs.existsSync(localPath)) { drifted.push({ path: entry.path, reason: '欠落' }); continue; }
    let matches;
    if (indexShas.has(entry.path)) {
      usedIndex = true;
      matches = indexShas.get(entry.path) === entry.sha;
    } else {
      usedContent = true;
      let content;
      try { content = fs.readFileSync(localPath); }
      catch { drifted.push({ path: entry.path, reason: '欠落' }); continue; }
      matches = gitBlobSha(content) === entry.sha || normalizedLfSha(content) === entry.sha;
    }
    if (!matches) {
      if (normalizedStatusPaths.has(entry.path)) wip.push(entry.path);
      else drifted.push({ path: entry.path, reason: '旧版' });
    }
  }
  const extra = metadata(repo, tree, normalizedStatusPaths);
  const status = drifted.length ? 'drift' : wip.length ? 'wip' : 'ok';
  const method = usedIndex && usedContent ? 'mixed' : usedIndex ? 'index' : 'content';
  return { status, repo, checked: blobs.length, drifted, wip, stale, headSha, ...extra, method, note };
}

export function formatDriftLine(result) {
  let line;
  if (result.status === 'skipped') return '';
  if (result.status === 'drift') {
    const shown = result.drifted.slice(0, 5).map((item) => `${item.path}(${item.reason})`);
    if (result.drifted.length > 5) shown.push(`他${result.drifted.length - 5}件`);
    line = `🚨 **配布物の版ドリフト** ${result.drifted.length}件 — ${shown.join(' / ')} → 復旧: \`node ~/orgiast-claude-rules/tools/onboarding-sync.mjs --force\`（失敗するなら共有作業ツリーの汚れ/diverge を解消）`;
  } else if (result.status === 'wip') {
    line = `⚠️ **配布物** ローカル編集中 ${result.wip.length}件（origin/main と不一致だが git 上で変更中＝開発機の想定内）`;
  } else if (result.status === 'ok') {
    line = `✅ **配布物の版一致**（origin/main と ${result.checked} ファイル一致）`;
  } else {
    // 文言に「判定不能(プローブが…)」を使わない。ツール採用チェック側の既存判定と衝突する。
    line = '⚠️ **配布物の版**照合できず（GitHub API 到達不可・キャッシュ無し。次回再判定）';
  }
  return result.stale ? `${line}（キャッシュ判定）` : line;
}

async function main() {
  const result = await checkVersionDrift();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`repo: ${result.repo}\nchecked: ${result.checked}\nstatus: ${result.status}`);
    console.log(formatDriftLine(result));
  }
  if (process.argv.includes('--exit-code') && result.status === 'drift') process.exitCode = 1;
}

if (isEntry(import.meta.url)) main().catch((error) => {
  console.error(formatDriftLine({ status: 'unknown', stale: false }));
  console.error(error?.message || String(error));
  if (process.argv.includes('--exit-code')) process.exitCode = 1;
});
