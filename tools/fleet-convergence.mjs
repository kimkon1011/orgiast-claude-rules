// Non-secret, per-host/per-OS-user distribution receipt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseEnvText } from './env-kv.mjs';
import { getClaudeAccountEmail } from './machine-identity.mjs';
import { extractHookTreeRoots } from './hook-tree-selfheal.mjs';
import { getSyncedRepoRoot } from './resolve-synced-repo.mjs';

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
// Report the tree used by installed hooks, never a ZIP distribution directory.
export function resolveConvergenceRepo({ home, repo, env = process.env } = {}) {
  const settings = readJson(path.join(home, '.claude/settings.json'));
  const candidates = [...extractHookTreeRoots(settings), repo,
    getSyncedRepoRoot({ env: { ...env, ORGIAST_HOME: home } }), path.join(home, 'orgiast-claude-rules')];
  for (const candidate of new Set(candidates.filter(Boolean))) {
    try {
      // Require a checkout root (including worktree .git files), not a directory
      // accidentally nested inside some unrelated parent repository.
      if (!fs.existsSync(path.join(candidate, '.git'))) continue;
      if (execFileSync('git', ['-C', candidate, 'rev-parse', '--is-inside-work-tree'],
        { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim() === 'true') return path.resolve(candidate);
    } catch { /* try the next checkout */ }
  }
  return null;
}
export function collectConvergence({ home, repo, hostname = os.hostname(), username = os.userInfo().username,
  platform = process.platform, now = new Date(), git, expectedHooks } = {}) {
  repo = resolveConvergenceRepo({ home, repo });
  git ||= args => execFileSync('git', ['-C', repo, ...args],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const row = { convergenceId: identityId(hostname, username), hostname, username, platform,
    claudeAccount: '', syncRepo: repo, syncHead: '', mainHead: '', behindMain: null,
    missingSince: '', hookMissing: null, keyMissing: null, convergenceReportedAt: now.toISOString() };
  row.claudeAccount = getClaudeAccountEmail(home) || row.claudeAccount;
  if (!repo) row.note = 'sync repo not a git checkout';
  if (repo) try {
    row.syncHead = git(['rev-parse', 'HEAD']); row.mainHead = git(['rev-parse', 'origin/main']);
    const count = git(['rev-list', '--count', 'HEAD..origin/main']);
    row.behindMain = /^\d+$/.test(count) ? Number(count) : null;
    if (row.behindMain > 0) {
      const missing = git(['log', '--reverse', '--format=%cI', 'HEAD..origin/main']).split(/\r?\n/)[0];
      if (Number.isFinite(Date.parse(missing))) row.missingSince = missing;
    }
  } catch { /* ZIP/offline/missing remote is unknown, never zero. */ }
  if (repo) try {
    const expected = expectedHooks || JSON.parse(execFileSync(process.execPath,
      [fileURLToPath(new URL('./register-hooks.mjs', import.meta.url)), '--expected-json'],
      { encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo } }));
    const actual = readJson(path.join(home, '.claude/settings.json'));
    row.hookMissingNames = actual.disableAllHooks === true
      ? hookEntries(expected.hooks).map(h => `${h.event}:${h.command.match(/[\w-]+\.mjs/g)?.at(-1) || 'unknown'}`)
      : missingHooks(actual.hooks, expected.hooks);
    row.hookMissingNames.push(...(expected.skippedNames || []).map(name => `unavailable:${name}`));
    row.hookMissing = row.hookMissingNames.length;
  } catch { /* failed expected-set generation remains unknown */ }
  const missing = repo ? keyDeficits(home, readJson(path.join(repo, 'tools/keyserve-distribution-manifest.json'))) : null;
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
