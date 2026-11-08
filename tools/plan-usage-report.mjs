#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchClaudePlanUsage } from './claude-plan-usage.mjs';
import { getClaudeAccountEmail, machineIdentity } from './machine-identity.mjs';
import { resolveReporterLabel } from './reporter-label.mjs';
import { parseEnvText } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

const INTERVAL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 30_000;
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function readState(file) { try { return JSON.parse(readText(file)); } catch { return {}; } }

export function shouldReport(lastSentAt, now = Date.now(), force = false) {
  if (force || !Number.isFinite(lastSentAt) || lastSentAt > now) return true;
  return now - lastSentAt >= INTERVAL_MS;
}

function toJst(now) {
  return new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

// Explicit allowlist: never spread credentials, identity, or API responses into a report.
export function buildPlanUsagePayload({ token, label, hostname, claudeAccount, usage, now = Date.now() }) {
  const available = usage?.available === true;
  return {
    token, kind: 'plan-usage', label, hostname, claudeAccount: claudeAccount || '', reportedAt: toJst(now),
    available, reason: available ? '' : String(usage?.reason || 'unknown'),
    fiveHourPct: available ? usage.fiveHour?.utilization ?? null : null,
    fiveHourResetsAt: available ? usage.fiveHour?.resetsAt ?? null : null,
    sevenDayPct: available ? usage.sevenDay?.utilization ?? null : null,
    sevenDayResetsAt: available ? usage.sevenDay?.resetsAt ?? null : null,
    scoped: available && Array.isArray(usage.scoped) ? usage.scoped.map(({ label, percent, resetsAt }) => ({ label, percent, resetsAt })) : [],
  };
}

function logResult(home, result) {
  try {
    const file = path.join(home, '.claude', 'logs', 'plan-usage-report.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Only locally defined status codes: URLs, remote response bodies and exception messages stay private.
    fs.appendFileSync(file, `${new Date().toISOString()} kind=plan-usage attempts=1 result=${result}\n`);
  } catch { /* A read-only log directory must not break hooks. */ }
}

export async function runPlanUsageReport({
  home = process.env.ORGIAST_HOME || os.homedir(), args = process.argv.slice(2), now = Date.now(),
  fetchImpl = fetch, usageFetchImpl = fetch, identity = machineIdentity, spawnImpl = spawn, output = console.log,
} = {}) {
  const dir = path.join(home, '.claude');
  const env = parseEnvText(readText(path.join(dir, 'fleet-sheet.env')));
  if (!env.FLEET_SHEET_URL || !env.FLEET_SHEET_TOKEN) return { skipped: 'unconfigured' };
  const stateFile = path.join(dir, '.plan-usage-report.json');
  if (!shouldReport(readState(stateFile)?.lastSentAt, now, args.includes('--force'))) return { skipped: 'throttled' };
  // 間引き判定を先に済ませ、毎プロンプトで子プロセスを起動しない。
  if (args.includes('--hook') && !args.includes('--from-hook')) {
    try {
      // Windows で detached を外すと libuv のジョブオブジェクトごと親と一緒に殺され送信されない（2026-10-21 実測）。
      // purge-sessions と同じく windowsHide + stdio:'ignore' を必ず併記して窓を出さない。
      const child = spawnImpl(process.execPath, [fileURLToPath(import.meta.url), ...args.filter(arg => arg !== '--hook'), '--from-hook'], {
        detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ORGIAST_HOME: home },
      });
      child.on('error', () => {});
      child.unref();
    } catch { /* Hook always exits successfully, without reading stdin. */ }
    return { backgrounded: true };
  }
  const { hostname } = identity();
  const { label } = resolveReporterLabel({ envText: readText(path.join(dir, 'cost-reporter.env')), hostname });
  const usage = await fetchClaudePlanUsage({ home, fetchImpl: (url, options) => usageFetchImpl(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) }) });
  const payload = buildPlanUsagePayload({ token: env.FLEET_SHEET_TOKEN, label, hostname, claudeAccount: getClaudeAccountEmail(home), usage, now });
  if (args.includes('--dry-run')) {
    output(JSON.stringify({ ...payload, token: '<redacted>' }));
    return { dryRun: true };
  }
  let result = 'network-error';
  try {
    const response = await fetchImpl(env.FLEET_SHEET_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow',
    });
    result = 'rejected';
    // A login page / non-JSON response is not a successful GAS write.
    const body = await response.json();
    if (response.ok && body?.ok === true) {
      result = 'ok';
      try { fs.writeFileSync(stateFile, JSON.stringify({ lastSentAt: now }), { mode: 0o600 }); }
      catch { result = 'ok-state-write-failed'; }
    }
  } catch { /* No retries and no raw error output. */ }
  logResult(home, result);
  return { ok: result.startsWith('ok') };
}

if (isEntry(import.meta.url)) {
  try { if ((await runPlanUsageReport()).ok === false) process.exitCode = 1; }
  catch { process.exitCode = process.argv.includes('--hook') ? 0 : 1; }
}
