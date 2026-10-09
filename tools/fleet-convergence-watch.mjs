#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DAY, readJson, identityId, convergenceAddress, convergenceProblems } from './fleet-convergence.mjs';
import { parseEnvText } from './env-kv.mjs';
import { createClient, resolveFleetLabel, acquireLock } from './fleet-mail.mjs';
import { notifyKim } from './notify-kim.mjs';
import { buildPcIdentityIndex } from './fleet-pc-identity.mjs';
import { isEntry } from './is-entry.mjs';
const ownRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function save(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); }
export function convergenceTargets(rows, pcMap = {}) {
  const index = buildPcIdentityIndex(pcMap);
  const canonical = row => [row.label, row.hostname, row.pcName].map(name => index.find(name)?.label).find(Boolean)
    || row.hostname || row.label || row.pcName;
  const reported = new Set(rows.filter(row => row.hostname && row.username).map(canonical));
  const seen = new Set();
  return rows.filter(row => {
    if (!row.hostname && !row.label && !row.pcName) return false;
    if (row.hostname && row.username) {
      const id = identityId(row.hostname, row.username);
      if (seen.has(id)) return false; seen.add(id); return true;
    }
    const key = canonical(row);
    if (reported.has(key) || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export async function reconcileConvergence({ rows, state = {}, now = Date.now(), send, notify, persist = () => {}, dryRun = false }) {
  const next = structuredClone(state); next.targets ||= {};
  const sent = [], alerts = [], issues = [];
  for (const row of rows) {
    const id = identityId(row.hostname || row.label || row.pcName, row.username || '');
    const problems = convergenceProblems(row, now);
    if (!problems.length) { delete next.targets[id]; continue; }
    issues.push({ label: row.label || row.pcName, username: row.username || '未確認', problems });
    const entry = next.targets[id] ||= { firstSeen: now };
    // Exact per-user addresses are intentionally separate from ordinary PC mail.
    if (row.hostname && row.username && (!entry.sentAt || now - entry.sentAt >= DAY)) {
      // Keep a stable pending ID across ambiguous HTTP failures and process restarts.
      entry.pendingId ||= `mail-converge-${id}-${Math.floor(now / DAY)}`;
      if (!dryRun) {
        persist(next);
        try {
          await send({ id: entry.pendingId, from: 'kim-PC', to: convergenceAddress(row), messageKind: 'note',
            body: JSON.stringify({ action: 'rules-resync', version: 1, hostname: row.hostname, username: row.username }),
            why: `配布収束: ${problems.join(' / ')}`, expiresAt: new Date(now + 7 * DAY).toISOString() });
          entry.sentAt = now; entry.firstSentAt ||= now; delete entry.pendingId; delete entry.sendFailed;
          sent.push({ label: row.label, username: row.username }); persist(next);
        } catch { entry.sendFailed = true; persist(next); }
      }
    }
    if (now - (entry.firstSentAt || entry.firstSeen) >= DAY) alerts.push({ row, problems,
      unavailable: !row.hostname || !row.username, sendFailed: entry.sendFailed });
  }
  let notified = false;
  if (!dryRun && alerts.length && (!next.notifiedAt || now - next.notifiedAt >= DAY)) {
    const text = '配布収束: 自動追いつき後も未達（初回検知から24h）\n' + alerts.map(({row, problems, unavailable, sendFailed}) =>
      `${row.label || row.pcName || row.hostname} / OSユーザー ${row.username || '未確認'}: ${problems.join('・')}${unavailable ? '（宛先未確定）' : sendFailed ? '（送付失敗）' : ''}`).join('\n')
      + '\n最小手順: 対象ユーザーで配布リポを開きClaude Codeを起動。未導入なら tools/bootstrap.ps1（Windows）/ tools/bootstrap.sh（Mac/Linux）。鍵は既存enroll.envで日次再試行。未発行・期限切れは管理側でASCII PC名のenrollを再発行。';
    const result = await notify(text);
    if (result?.delivered === 'dm') { next.notifiedAt = now; notified = true; persist(next); }
  }
  if (!dryRun) persist(next);
  return { sent, issues, notified, state: next };
}
export async function runConvergenceWatch({ home = process.env.ORGIAST_HOME || os.homedir(), repo = ownRepo,
  now = Date.now(), dryRun = false, fetchImpl = fetch } = {}) {
  if (resolveFleetLabel(home) !== 'kim-PC') return { skipped: 'not-controller', sent: [] };
  const dir = path.join(home, '.claude');
  const config = parseEnvText(fs.readFileSync(path.join(dir, 'fleet-sheet.env'), 'utf8'));
  if (!config.FLEET_SHEET_URL || !config.FLEET_SHEET_TOKEN) throw new Error('fleet-sheet configuration missing');
  const release = dryRun ? () => {} : acquireLock(path.join(dir, '.fleet-convergence-watch.lock'));
  if (!release) return { skipped: 'locked', sent: [] };
  try {
    const url = new URL(config.FLEET_SHEET_URL); url.searchParams.set('token', config.FLEET_SHEET_TOKEN);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`fleet read HTTP ${response.status}`);
    const data = await response.json();
    if (!data.ok || !Array.isArray(data.rows)) throw new Error('invalid fleet sheet response');
    // Controller compares receipts against fresh main, not a stale remote ref on the client.
    const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore','pipe','pipe'] }).trim();
    git(['fetch', 'origin', 'main']);
    const rows = convergenceTargets(data.rows, readJson(path.join(repo, 'fleet-pc-map.json'))).map(row => {
      if (!/^[0-9a-f]{40}$/.test(row.syncHead || '')) return row;
      try { return { ...row, behindMain: Number(git(['rev-list', '--count', `${row.syncHead}..origin/main`])),
        missingSince: git(['log', '--reverse', '--format=%cI', `${row.syncHead}..origin/main`]).split(/\r?\n/)[0] }; }
      catch { return { ...row, behindMain: null }; }
    });
    const file = path.join(dir, '.fleet-convergence-watch.json');
    const client = createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN, fetchImpl });
    return await reconcileConvergence({ rows, now, dryRun, state: readJson(file), persist: state => save(file, state),
      send: payload => client('mail-send', payload), notify: text => notifyKim(text, { home, webhookFallback: false }) });
  } finally { release(); }
}
if (isEntry(import.meta.url)) {
  try { const r = await runConvergenceWatch({ dryRun: process.argv.includes('--dry-run') }); console.log(JSON.stringify({ sent: r.sent, issues: r.issues, notified: r.notified, skipped: r.skipped })); }
  catch { console.error('fleet-convergence-watch failed (credentials and URLs omitted)'); process.exitCode = 1; }
}
