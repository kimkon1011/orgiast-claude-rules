#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function pickActiveBuckets(entries, now, days) {
  const nowMs = new Date(now).getTime();
  const cutoff = nowMs - Number(days) * 86400000;
  if (!Number.isFinite(nowMs) || !Number.isFinite(cutoff)) return [];
  return entries.filter((entry) => {
    const changed = new Date(entry.mtimeMs ?? entry.mtime ?? entry.updatedAt).getTime();
    return Number.isFinite(changed) && changed >= cutoff && changed <= nowMs;
  }).sort((a, b) => new Date(b.mtimeMs ?? b.mtime ?? b.updatedAt) - new Date(a.mtimeMs ?? a.mtime ?? a.updatedAt));
}

export function extractCwd(text) {
  const match = String(text).match(/"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match) return '';
  try { return JSON.parse(`"${match[1]}"`); } catch { return ''; }
}

export function summarizeProjects(items, limit = 5) {
  return [...items].sort((a, b) => {
    const count = (Number.isFinite(b.commits) ? b.commits : -1) - (Number.isFinite(a.commits) ? a.commits : -1);
    return count || String(b.lastCommitAt || '').localeCompare(String(a.lastCommitAt || '')) || String(a.project).localeCompare(String(b.project));
  }).slice(0, limit);
}

export function formatProjectsCell(items) {
  return items.filter((item) => item.project).map((item) => Number.isFinite(item.commits) ? `${item.project}(${item.commits})` : item.project).join(', ');
}

export function formatArtifactsCell(items) {
  return items.filter((item) => item.repoName && item.branch).map((item) => `${item.repoName}@${item.branch}`).join(', ');
}

export function formatLastCommitCell(items) {
  const item = items.find((candidate) => candidate.lastCommitAt && candidate.lastCommitSubject);
  return item ? `${String(item.lastCommitAt).slice(0, 10)} ${[...String(item.lastCommitSubject)].slice(0, 60).join('')}` : '';
}

function basenameAny(value) {
  return String(value).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

function repoNameFromRemote(remote) {
  const tail = String(remote).replace(/[\\/]+$/, '').split(/[\\/:]/).pop() || '';
  return tail.replace(/\.git$/, '');
}

function defaultRunGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, stdout: String(result.stdout || '').trim(), error: result.error?.message || String(result.stderr || '').trim() };
}

export function collectProjectInventory(options = {}) {
  const projectsDir = options.projectsDir || path.join(os.homedir(), '.claude', 'projects');
  const now = options.now || new Date();
  const days = options.days ?? 7;
  const limit = options.limit ?? 5;
  const runGit = options.runGit || defaultRunGit;
  const warn = options.warn || ((message) => console.error(`project-inventory: ${message}`));
  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
      const fullPath = path.join(projectsDir, entry.name);
      const transcripts = fs.readdirSync(fullPath, { withFileTypes: true }).filter((child) => child.isFile() && child.name.endsWith('.jsonl')).map((child) => {
        const transcriptPath = path.join(fullPath, child.name);
        return { path: transcriptPath, mtimeMs: fs.statSync(transcriptPath).mtimeMs };
      }).sort((a, b) => b.mtimeMs - a.mtimeMs);
      return { name: entry.name, path: fullPath, transcripts, mtimeMs: transcripts[0]?.mtimeMs ?? fs.statSync(fullPath).mtimeMs };
    });
  } catch (error) {
    warn(`バケット一覧を取得できません (${error.code || error.name || 'error'})`);
    return [];
  }

  const items = [];
  for (const bucket of pickActiveBuckets(dirs, now, days)) {
    const transcripts = bucket.transcripts;
    if (!transcripts[0]) { warn(`transcriptがありません: ${bucket.name}`); continue; }
    let cwd = '';
    try { cwd = extractCwd(fs.readFileSync(transcripts[0].path, 'utf8')); } catch (error) { warn(`cwdを取得できません: ${bucket.name} (${error.code || error.name || 'error'})`); continue; }
    if (!cwd) { warn(`cwdが見つかりません: ${bucket.name}`); continue; }
    const item = { project: basenameAny(cwd), repoName: '', branch: '', lastCommitAt: '', lastCommitSubject: '', commits: null };
    const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok || inside.stdout !== 'true') { warn(`Gitリポジトリを確認できません: ${item.project} (${inside.error || 'not a repository'})`); items.push(item); continue; }
    const get = (args, label) => {
      const result = runGit(cwd, args);
      if (!result.ok) warn(`${label}を取得できません: ${item.project} (${result.error || 'git error'})`);
      return result.ok ? result.stdout : '';
    };
    item.repoName = repoNameFromRemote(get(['remote', 'get-url', 'origin'], 'remote'));
    item.branch = get(['branch', '--show-current'], 'ブランチ');
    const last = get(['log', '-1', '--format=%cs%x00%s'], '直近コミット');
    if (last) [item.lastCommitAt, item.lastCommitSubject] = last.split('\0');
    const email = get(['config', 'user.email'], 'Gitメール');
    if (email) {
      const since = new Date(new Date(now).getTime() - Number(days) * 86400000).toISOString();
      const countResult = runGit(cwd, ['log', `--since=${since}`, `--author=${email}`, '--format=%H']);
      if (countResult.ok) item.commits = countResult.stdout ? countResult.stdout.split(/\r?\n/).filter(Boolean).length : 0;
      else warn(`コミット数を取得できません: ${item.project} (${countResult.error || 'git error'})`);
    }
    items.push(item);
  }
  return summarizeProjects(items, limit);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) console.log(JSON.stringify(collectProjectInventory(), null, 2));
