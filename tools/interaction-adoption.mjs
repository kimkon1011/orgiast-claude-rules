#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitBlobSha } from './version-drift.mjs';
import { isEntry } from './is-entry.mjs';

const TREE_URL = 'https://api.github.com/repos/kimkon1011/orgiast-claude-rules/git/trees/main?recursive=1';
const TARGETS = ['tools/interaction-loop.mjs', 'tools/stop-gate.mjs'];
const TESTS = [
  ['interaction-loop', 'tools/interaction-loop.test.mjs'],
  ['stop-gate', 'tools/stop-gate.test.mjs'],
];

function defaultRepo() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

async function defaultFetchTree() {
  const response = await fetch(TREE_URL, {
    headers: { 'User-Agent': 'orgiast-interaction-adoption' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
  return response.json();
}

function defaultRunTest(file) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [file], { encoding: 'utf8', timeout: 60_000 }, (error, stdout = '', stderr = '') => {
      if (error?.killed || error?.code === 'ETIMEDOUT') { reject(error); return; }
      if (error && typeof error.code !== 'number') { reject(error); return; }
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

function toJst(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const p2 = (number) => String(number).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${p2(jst.getUTCMonth() + 1)}-${p2(jst.getUTCDate())} ${p2(jst.getUTCHours())}:${p2(jst.getUTCMinutes())}`;
}

function collectLastRun(home) {
  try {
    const metrics = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'interaction-metrics.json'), 'utf8'));
    const generatedAt = Array.isArray(metrics.history) ? metrics.history.at(-1)?.generatedAt : undefined;
    return toJst(generatedAt) || '未実行';
  } catch { return '未実行'; }
}

async function collectVersion(repo, fetchTree) {
  const local = new Map();
  for (const target of TARGETS) {
    try { local.set(target, gitBlobSha(fs.readFileSync(path.join(repo, ...target.split('/'))))); }
    catch { return '未適用'; }
  }
  try {
    const tree = await fetchTree();
    const upstream = new Map((tree?.tree || []).map((entry) => [entry.path, entry.sha]));
    if (TARGETS.some((target) => !upstream.get(target))) return '判定不能';
    const loopLocal = local.get(TARGETS[0]);
    const loopMain = upstream.get(TARGETS[0]);
    const matches = TARGETS.every((target) => local.get(target) === upstream.get(target));
    return matches ? `適用済(${loopLocal.slice(0, 7)})` : `旧版(${loopLocal.slice(0, 7)} / main=${loopMain.slice(0, 7)})`;
  } catch { return '判定不能'; }
}

function testCount(stdout) {
  const match = String(stdout).match(/(?:^|\n)\s*(?:ℹ|#)\s*tests\s+(\d+)\s*(?:\n|$)/m);
  return match ? Number(match[1]) : null;
}

async function collectSelftest(repo, runTest) {
  try {
    const results = [];
    for (const [name, relative] of TESTS) results.push({ name, ...(await runTest(path.join(repo, ...relative.split('/')))) });
    const failed = results.filter((result) => result.code !== 0);
    if (failed.length) return `FAIL ${failed.length}件 (${failed.map((result) => result.name).join(',')})`;
    const counts = results.map((result) => testCount(result.stdout));
    return counts.every((count) => count !== null) ? `PASS ${counts.reduce((sum, count) => sum + count, 0)}/${counts.reduce((sum, count) => sum + count, 0)}` : 'PASS';
  } catch { return '判定不能'; }
}

export async function collectInteractionAdoption(options = {}) {
  const repo = path.resolve(options.repo || defaultRepo());
  const home = path.resolve(options.home || process.env.ORGIAST_HOME || os.homedir());
  const [version, selftest] = await Promise.all([
    collectVersion(repo, options.fetchTree || defaultFetchTree),
    collectSelftest(repo, options.runTest || defaultRunTest),
  ]);
  return { version, selftest, lastRun: collectLastRun(home) };
}

if (isEntry(import.meta.url)) collectInteractionAdoption().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
