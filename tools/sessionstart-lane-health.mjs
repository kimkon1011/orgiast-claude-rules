#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { laneDoctorQuick, summarize } from './lane-doctor.mjs';
export function sessionLaneHealth(options) {
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: summarize(laneDoctorQuick(options)) } };
}
export async function main() {
  await readStdinWithTimeout();
  console.log(JSON.stringify(sessionLaneHealth()));
}
if (isEntry(import.meta.url)) await main();
