import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { repoDir, toolsDir, readContract } from './gate-contracts.mjs';
import { readEnvValue } from './env-kv.mjs';
import { notifyKim } from './notify-kim.mjs';

const DAY = 86400000;
const homeDir = () => process.env.ORGIAST_HOME || os.homedir();
function readRollout() { try { return JSON.parse(fs.readFileSync(path.join(toolsDir, 'gate-rollout-manifest.json'), 'utf8')); } catch { return { gates: {} }; } }
export function rolloutMode(name, { manifest = readRollout(), home = homeDir(), hostname = os.hostname(), now = Date.now() } = {}) {
  const entry = manifest?.gates?.[name];
  if (entry?.legacy === true && entry.rollout === 'deny') return 'deny';
  if (entry?.rollout === 'warn') return 'warn';
  if ((Array.isArray(manifest?.pilotHosts) ? manifest.pilotHosts : []).some(h => h.toLowerCase() === hostname.toLowerCase())) return entry?.rollout === 'deny' ? 'deny' : 'warn';
  // First receipt is per PC, so an offline PC never skips its observation week.
  const file = path.join(home, '.claude', 'gate-rollout', `${name}.json`);
  let firstSeen;
  try { firstSeen = JSON.parse(fs.readFileSync(file, 'utf8')).firstSeen; } catch {}
  if (!Number.isFinite(firstSeen)) {
    firstSeen = now;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ firstSeen }), { flag: 'wx' }); }
    catch { try { firstSeen = JSON.parse(fs.readFileSync(file, 'utf8')).firstSeen; } catch { return 'warn'; } }
  }
  const distributed = Date.parse(entry?.distributedAt);
  const promoted = Date.parse(entry?.denyAfter);
  return entry?.rollout === 'deny' && Number.isFinite(distributed) && Number.isFinite(promoted)
    && promoted >= distributed + 7 * DAY && now >= Math.max(promoted, firstSeen + 7 * DAY) ? 'deny' : 'warn';
}
export function remedyStatus(contract, { home = homeDir(), root = repoDir } = {}) {
  return (contract?.remedies || []).map(r => {
    let status = 'manual';
    if (r.kind === 'repo-file') status = fs.existsSync(path.join(root, r.ref)) ? 'available' : 'missing';
    if (r.kind === 'keyserve-key') {
      const [file, key] = r.ref.split('#');
      status = readEnvValue(path.join(home, '.claude', file), key) ? 'available' : 'missing';
    }
    if (r.kind === 'command') {
      const script = r.ref.match(/\b(tools\/[\w./-]+\.mjs)\b/)?.[1];
      status = script ? (fs.existsSync(path.join(root, script)) ? 'available' : 'missing') : 'unverified';
    }
    return { kind: r.kind, ref: r.ref, status };
  });
}
export async function reportGate(contract, verdict, statuses, { home = homeDir(), hostname = os.hostname(), now = Date.now(), notify = notifyKim } = {}) {
  const name = contract.name;
  const id = crypto.createHash('sha256').update(`${hostname}\0${name}`).digest('hex').slice(0, 24);
  const dir = path.join(home, '.claude', 'gate-reports');
  const file = path.join(dir, `${id}-${new Date(now).toISOString().slice(0, 10)}.json`);
  const safe = s => String(s).replace(/[\r\n\t]/g, ' ').slice(0, 180);
  // Never transmit reason, command arguments, transcript, URL or key values.
  const line = `gate pc=${safe(hostname)} name=${safe(name)} verdict=${verdict} remedy=${statuses.map(r => `${safe(r.ref)}:${r.status}`).join(',')}`;
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ name, verdict, statuses, delivery: 'pending' }), { flag: 'wx', mode: 0o600 }); }
  catch { return { delivered: 'suppressed' }; }
  let result;
  try { result = await notify(line, { home, signal: AbortSignal.timeout(2000), fleetFallback: true }); }
  catch { result = { delivered: 'none' }; }
  try { fs.writeFileSync(file, JSON.stringify({ name, verdict, statuses, delivery: result.delivered }), { mode: 0o600 }); } catch {}
  if (result.delivered === 'none') process.stderr.write(`[gate-report] ${name}: 通報未達（ローカル記録済み）。node tools/keyserve-status.mjs --json\n`);
  return result;
}
export async function applyGatePolicy(contract, result, { retry, refresh, ...options } = {}) {
  if (!contract) contract = { name: options.name || 'uncontracted-gate', remedies: [] };
  const blocked = result?.decision === 'block' || result?.deny === true;
  const warned = result?.decision === 'warn';
  if (!blocked && !warned) return result;
  let statuses = remedyStatus(contract, options);
  if (blocked && statuses.some(r => r.kind === 'keyserve-key' && r.status === 'missing')) {
    // Once per invocation, bounded; same merge/auth client as SessionStart.
    try {
      if (refresh) await refresh();
      else { const { provisionKeys } = await import('./onboarding-sync.mjs'); await provisionKeys(new Date(), { force: true, quiet: true, timeoutMs: 2000, singleAttempt: true }); }
      if (retry) result = await retry();
    } catch { /* Keep the original denial and show the acquisition path. */ }
    if (result?.decision !== 'block' && result?.deny !== true) return result;
    statuses = remedyStatus(contract, options);
  }
  const mode = warned ? 'warn' : rolloutMode(contract.name, options);
  await reportGate(contract, mode, statuses, options);
  const missing = statuses.filter(r => r.kind === 'keyserve-key' && r.status === 'missing');
  const hint = missing.length ? '\n取得: node tools/onboarding-sync.mjs --keys-only --force' : '';
  return { ...result, decision: mode === 'deny' ? 'block' : 'warn', deny: mode === 'deny', reason: `${result.reason || ''}${hint}` };
}
export async function applyNamedGatePolicy(name, result, options = {}) {
  const canonical = name === 'control-group-gate' ? 'control-group-stop-gate' : name;
  let contract; try { contract = readContract(path.join(toolsDir, `${canonical}.mjs`)); } catch {}
  return applyGatePolicy(contract, result, { ...options, name: canonical });
}
