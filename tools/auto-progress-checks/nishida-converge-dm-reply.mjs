// Install at ~/.claude/auto-progress-checks/nishida-converge-dm-reply.mjs.
// A truncated steps JSON is not evidence of absence, and failing is never success.
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const TARGET_STEPS = ['task-hidden-actions', 'mobile-standby', 'node-runtime-security'];
const SINCE = Date.parse('2026-10-26T09:00:00Z');
export function evaluate(beacons) {
  const latest = beacons.filter(b => String(b.account).toLowerCase() === 'genbateam.toho@gmail.com'
    && (b.label === 'DESKTOP-BDOAK99' || b.hostname === 'DESKTOP-BDOAK99'))
    .sort((a, b) => (Date.parse(b.reportedAt) || 0) - (Date.parse(a.reportedAt) || 0))[0];
  if (!latest) return { code: 1, steps: Object.fromEntries(TARGET_STEPS.map(id => [id, 'unknown'])) };
  const failing = Array.isArray(latest.failing) ? latest.failing : String(latest.failing || '').split(',').map(s => s.trim());
  const steps = Object.fromEntries(TARGET_STEPS.map(id => [id,
    failing.includes(id) ? 'fail' : (Array.isArray(latest.steps) ? latest.steps.find(s => s.id === id)?.status : null) || 'unknown']));
  // Do not treat merely receiving the failed step as completion. Missing/skip
  // statuses are inconclusive; failing alone cannot prove other steps passed.
  const code = Date.parse(latest.reportedAt) > SINCE && steps['task-hidden-actions'] === 'ok'
    && steps['mobile-standby'] === 'ok' ? 0 : 1;
  return { code, label: latest.label, reportedAt: latest.reportedAt, steps };
}
export async function main({ home = process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir(), fetchBeacons, sleep = ms => new Promise(r => setTimeout(r, ms)), log = console.log } = {}) {
  if (!fetchBeacons) ({ fetchBeacons } = await import(pathToFileURL(path.join(home, '.claude', 'nightly-repo', 'tools', 'fleet-beacon.mjs')).href));
  let result;
  // Bounded below the registered 300-second timeout, even if every request times out.
  for (let i = 0; i < 4; i++) {
    result = await fetchBeacons({ home, timeoutMs: 45000 });
    if (result.ok) break;
    if (i < 3) await sleep(10000);
  }
  if (!result?.ok) { log(JSON.stringify({ errors: 1 })); return 2; }
  const outcome = evaluate(result.beacons);
  // Logs contain counts only. evaluate() exposes evidence for inspection/tests.
  log(JSON.stringify({ ok: Object.values(outcome.steps).filter(s => s === 'ok').length,
    fail: Object.values(outcome.steps).filter(s => s === 'fail').length,
    unknown: Object.values(outcome.steps).filter(s => s === 'unknown').length }));
  return outcome.code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await main(); } catch { console.error('1'); process.exitCode = 2; }
}
