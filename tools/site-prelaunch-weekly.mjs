#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { appendFile, readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inspectSite } from './site-prelaunch-check.mjs';
import { addItem } from './kim-inbox.mjs';
import { isEntry } from './is-entry.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONFIG = path.join(repoRoot, 'config', 'prelaunch-sites.txt');
const DEFAULT_STATE = path.join(os.homedir(), '.claude', 'site-prelaunch', 'last.json');
const DEFAULT_LOG = path.join(os.homedir(), '.claude', 'site-prelaunch', 'logs', 'weekly.log');
const INCLUDED = {
  public: new Set(Array.from({ length: 25 }, (_, index) => index + 1)),
  internal: new Set(Array.from({ length: 25 }, (_, index) => index + 1).filter(id => ![5, 6, 7, 9].includes(id))),
  api: new Set([3, 4, 24]),
};

export function parseSites(text) {
  return String(text).split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#')).map((line, index) => {
    const [rawUrl, rawType] = line.split('\t');
    const url = new URL(rawUrl.trim()).href;
    const type = rawType?.trim();
    if (!INCLUDED[type]) throw new Error(`設定${index + 1}行目の種別が不正です: ${type || '未指定'}`);
    return { url, type };
  });
}

export function isFetchFailure(checks) {
  return checks.length > 0 && checks.every(check => check.verdict === '要手動' && /^ネットワーク失敗:/.test(check.evidence));
}

function comparableChecks(site) {
  const included = INCLUDED[site.type];
  return (site.checks || []).filter(check => included.has(Number(check.id)));
}

export function compareSite(previous, current) {
  if (current.fetchFailed) return { kind: 'stopped', items: [], ngBefore: null, ngAfter: null };
  if (!previous || previous.fetchFailed) return null;
  const before = new Map(comparableChecks(previous).map(check => [Number(check.id), check]));
  const after = comparableChecks(current);
  const beforeNg = [...before.values()].filter(check => check.verdict === 'NG');
  const afterNg = after.filter(check => check.verdict === 'NG');
  const newNg = afterNg.filter(check => before.get(Number(check.id))?.verdict !== 'NG');
  const okToNg = newNg.filter(check => before.get(Number(check.id))?.verdict === 'OK');
  if (afterNg.length <= beforeNg.length && okToNg.length === 0) return null;
  return { kind: 'regression', items: newNg, okToNg, ngBefore: beforeNg.length, ngAfter: afterNg.length };
}

export function compareResults(previousResults = [], currentResults = []) {
  const previous = new Map(previousResults.map(site => [site.url, site]));
  return currentResults.map(site => ({ site, change: compareSite(previous.get(site.url), site) })).filter(entry => entry.change);
}

export function formatNotice(entries) {
  const lines = ['サイト公開前チェック週次点検で悪化を検出しました。'];
  for (const { site, change } of entries) {
    lines.push('', `${new URL(site.url).hostname} (${site.type})`, site.url);
    if (change.kind === 'stopped') {
      lines.push(`取得失敗（サイト停止）: ${site.checks[0]?.evidence || 'ネットワーク取得に失敗'}`);
      continue;
    }
    lines.push(`比較対象のNG件数: ${change.ngBefore}→${change.ngAfter}`);
    const items = change.items.length ? change.items : change.okToNg;
    for (const check of items) lines.push(`${check.id} ${check.item}: ${check.evidence}`);
  }
  return lines.join('\n');
}

async function readPrevious(stateFile) {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveState(stateFile, results, now = new Date()) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ checkedAt: now.toISOString(), results }, null, 2)}\n`, 'utf8');
  await rename(temporary, stateFile);
}

function parseArgs(argv) {
  const options = { dryRun: false, config: DEFAULT_CONFIG, state: DEFAULT_STATE };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--config') options.config = path.resolve(argv[++index]);
    else if (arg === '--state') options.state = path.resolve(argv[++index]);
    else throw new Error(`不明な引数: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const sites = parseSites(await readFile(options.config, 'utf8'));
  const previous = await readPrevious(options.state);
  const inspect = dependencies.inspectSite || inspectSite;
  const results = [];
  for (const site of sites) {
    const checks = await inspect(site.url);
    results.push({ ...site, fetchFailed: isFetchFailure(checks), checks });
  }
  const changes = compareResults(previous, results);
  const notice = changes.length ? formatNotice(changes) : 'サイト公開前チェック週次点検: 前回から悪化なし';
  if (options.dryRun) process.stdout.write(`${notice}\n`);
  else {
    if (changes.length) await (dependencies.addItem || addItem)(os.homedir(), { kind: 'info', forceKind: true, source: 'site-prelaunch-weekly', dedupeKey: `site-prelaunch-weekly:${new Date().toISOString().slice(0, 10)}`, text: notice });
    if (!results.some(site => site.fetchFailed)) await saveState(options.state, results);
    await mkdir(path.dirname(DEFAULT_LOG), { recursive: true });
    await appendFile(DEFAULT_LOG, `${new Date().toISOString()} sites=${results.length} changes=${changes.length} fetchFailures=${results.filter(site => site.fetchFailed).length}\n`, 'utf8');
  }
  return 0;
}

if (isEntry(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(error => { console.error(`エラー: ${error.message}`); process.exitCode = 2; });
