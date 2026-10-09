// Non-secret, per-host/per-OS-user distribution receipt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseEnvText } from './env-kv.mjs';

export const DAY = 86400000;
export function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
export function identityId(hostname, username) {
  return createHash('sha256').update(JSON.stringify([hostname, username])).digest('hex').slice(0, 32);
}
export function convergenceAddress(row) { return `converge-${identityId(row.hostname, row.username)}`; }
export function hookEntries(hooks) {
  return Object.entries(hooks || {}).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : []).flatMap(group =>
    (group.hooks || []).map(hook => ({ event, matcher: group.matcher || '', ...hook }))));
}
export function missingHooks(actual, expected) {
  const entries = hookEntries(actual);
  // Compare full command, event and matcher: a name in the wrong event/path is not installed.
  return hookEntries(expected).filter(wanted => !entries.some(found => found.event === wanted.event
    && found.matcher === wanted.matcher && found.type === wanted.type && found.command === wanted.command
    && Boolean(found.async) === Boolean(wanted.async))).map(h => `${h.event}:${h.command.match(/[\w-]+\.mjs/g)?.at(-1) || 'unknown'}`);
}
export function keyDeficits(home, manifest) {
  if (!Array.isArray(manifest?.distributions)) return null;
  const missing = [];
  for (const item of manifest.distributions) {
    let raw = ''; try { raw = fs.readFileSync(path.join(home, '.claude', item.file), 'utf8').replace(/^\uFEFF/, ''); } catch {}
    const values = parseEnvText(raw);
    for (const key of item.keys) if (!(key === '(file)' ? raw.trim() : values[key]?.trim())) missing.push(`${item.file}:${key}`);
  }
  return missing;
}
export function collectConvergence({ home, repo, hostname = os.hostname(), username = os.userInfo().username,
  platform = process.platform, now = new Date(), git = args => execFileSync('git', ['-C', repo, ...args],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(), expectedHooks } = {}) {
  const row = { convergenceId: identityId(hostname, username), hostname, username, platform,
    claudeAccount: '', syncRepo: path.resolve(repo), syncHead: '', mainHead: '', behindMain: null,
    missingSince: '', hookMissing: null, keyMissing: null, convergenceReportedAt: now.toISOString() };
  const account = readJson(path.join(home, '.claude.json')).oauthAccount?.emailAddress;
  if (typeof account === 'string' && /^[^\s@]+@[^\s@]+$/.test(account)) row.claudeAccount = account;
  try {
    row.syncHead = git(['rev-parse', 'HEAD']); row.mainHead = git(['rev-parse', 'origin/main']);
    const count = git(['rev-list', '--count', 'HEAD..origin/main']);
    row.behindMain = /^\d+$/.test(count) ? Number(count) : null;
    if (row.behindMain > 0) {
      const missing = git(['log', '--reverse', '--format=%cI', 'HEAD..origin/main']).split(/\r?\n/)[0];
      if (Number.isFinite(Date.parse(missing))) row.missingSince = missing;
    }
  } catch { /* ZIP/offline/missing remote is unknown, never zero. */ }
  try {
    const expected = expectedHooks || JSON.parse(execFileSync(process.execPath,
      [path.join(repo, 'tools/register-hooks.mjs'), '--expected-json'],
      { encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo } }));
    const actual = readJson(path.join(home, '.claude/settings.json'));
    row.hookMissing = (actual.disableAllHooks === true ? hookEntries(expected.hooks).length : missingHooks(actual.hooks, expected.hooks).length) + (expected.skippedNames?.length || 0);
  } catch { /* failed expected-set generation remains unknown */ }
  const missing = keyDeficits(home, readJson(path.join(repo, 'tools/keyserve-distribution-manifest.json')));
  row.keyMissing = missing?.length ?? null;
  const has = (file, key) => { try { return Boolean(parseEnvText(fs.readFileSync(path.join(home, '.claude', file), 'utf8'))[key]); } catch { return false; } };
  row.keyserveAuth = has('keyserve.env', 'ORGIAST_KEYSERVE_SECRET') ? 'primary' : has('enroll.env', 'ORGIAST_ENROLL_TOKEN') ? 'enroll' : has('cost-reporter.env', 'DISCORD_COST_WEBHOOK') ? 'legacy' : 'unset';
  return row;
}
export function parseReportedAt(value) {
  const text = String(value || '');
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(text) ? text.replace(' ', 'T') + ':00+09:00' : text);
}
const count = value => value === '' || value == null || !Number.isFinite(Number(value)) ? null : Number(value);
export function convergenceProblems(row, now = Date.now()) {
  const result = [];
  const at = parseReportedAt(row.convergenceReportedAt || row.reportedAt);
  if (!Number.isFinite(at) || now - at >= 2 * DAY) result.push('48時間報告なし');
  if (!row.convergenceReportedAt) result.push('収束レポート未導入');
  if (count(row.behindMain) > 0 && now - parseReportedAt(row.missingSince) >= DAY) result.push('main反映が24時間以上遅延');
  if (count(row.hookMissing) > 0) result.push(`hook不足${row.hookMissing}`);
  if (count(row.keyMissing) > 0 || row.keyserveAuth === 'unset') result.push(`キー欠落${count(row.keyMissing) ?? '未確認'}`);
  if (row.convergenceReportedAt && [row.behindMain, row.hookMissing, row.keyMissing].some(v => count(v) === null)) result.push('収束状態未確認');
  return result;
}
