#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { sessionSummary } from './stall-scan.mjs';
import { laneHome } from './lane-doctor.mjs';
import { laneDoctorQuick, summarize } from './lane-doctor.mjs';
export function sessionLaneHealth(options) {
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: [summarize(laneDoctorQuick(options)), sessionSummary(options?.home || laneHome(), options?.now)].filter(Boolean).join(" / ") } };
}
export async function main() {
  await readStdinWithTimeout();
  console.log(JSON.stringify(sessionLaneHealth()));
}
if (isEntry(import.meta.url)) await main();
