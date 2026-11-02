#!/usr/bin/env node
import { launchAudit, auditContext } from './unattended-job-audit.mjs';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { sessionSummary } from './stall-scan.mjs';
import { laneHome } from './lane-doctor.mjs';
import { laneDoctorQuick, summarize, notifyLaneStops } from './lane-doctor.mjs';
import { repairContext } from './lib/lane-repair-state.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../', import.meta.url));
const RETRY_MS = 30 * 60_000;
const RETRY_REASONS = /^(?:probe_failed(?::stale)?|configured:unprobed|probe_expired|dead:payment_required)$/;
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
export function launchLaneAutoProbes(health, { home = laneHome(), now = Date.now(), spawnProbe = spawn } = {}) {
  const file = path.join(home, '.claude', 'lane-autoprobe.json');
  let last = {};
  try { last = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const started = [];
  for (const [provider, state] of Object.entries(health.lanes || {})) {
    if (provider === 'gemini-cli' || state.alive || !RETRY_REASONS.test(state.reason || '')) continue;
    if (Number.isFinite(timestamp(state.until)) && timestamp(state.until) > now) continue;
    if (state.reason === 'dead:payment_required' && Number.isFinite(timestamp(state.probedAt)) && now - timestamp(state.probedAt) < 86400_000) continue;
    if (now - timestamp(last[provider] || 0) < RETRY_MS) continue;
    const child = spawnProbe(process.execPath, [path.join(repo, 'tools/lane-doctor.mjs'), '--probe', '--provider', provider], { cwd: repo, env: { ...process.env, ORGIAST_HOME: home }, detached: true, windowsHide: true, stdio: 'ignore' });
    child?.unref?.();
    last[provider] = new Date(now).toISOString();
    state.autoProbeStarted = true;
    started.push(provider);
  }
  if (started.length) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(last, null, 2) + '\n', { mode: 0o600 }); }
  return started;
}
export function sessionLaneHealth(options) {
  const home = options?.home || laneHome();
  const context = auditContext(home);
  (options?.auditLaunch || launchAudit)({ ...options, home, intervalHours: 6 });
  const health = laneDoctorQuick(options);
launchLaneAutoProbes(health, { ...options, home });
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: [context, summarize(health), repairContext(health, home, options?.now), sessionSummary(home, options?.now)].filter(Boolean).join(" / ") } };
}
export async function main() {
  await readStdinWithTimeout();
  const output = sessionLaneHealth();
  const health = laneDoctorQuick({ save: false });
  await notifyLaneStops(health);
  console.log(JSON.stringify(output));
}
if (isEntry(import.meta.url)) await main();
