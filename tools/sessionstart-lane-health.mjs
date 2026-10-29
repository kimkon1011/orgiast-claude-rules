#!/usr/bin/env node
import { launchAudit, auditContext } from './unattended-job-audit.mjs';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { sessionSummary } from './stall-scan.mjs';
import { laneHome } from './lane-doctor.mjs';
import { laneDoctorQuick, summarize, notifyLaneStops } from './lane-doctor.mjs';
import { repairContext } from './lib/lane-repair-state.mjs';
export function sessionLaneHealth(options) {
  const home = options?.home || laneHome();
  const context = auditContext(home);
  (options?.auditLaunch || launchAudit)({ ...options, home, intervalHours: 6 });
  const health = laneDoctorQuick(options);
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
