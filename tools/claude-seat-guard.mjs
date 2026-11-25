#!/usr/bin/env node
import os from 'node:os';
import { evaluateClaudeSeatGuard, syncGbOffloadFlags } from './lib/claude-seat-guard.mjs';
import { isEntry } from './is-entry.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const callerIndex = argv.indexOf('--caller');
  const caller = callerIndex >= 0 ? argv[callerIndex + 1] || 'cli' : 'cli';
  const home = env.ORGIAST_HOME || os.homedir();
  const verdict = await evaluateClaudeSeatGuard({ home, env, caller });
  const flags = argv.includes('--sync-flags') ? syncGbOffloadFlags({ home, verdict }) : undefined;
  const result = flags ? { ...verdict, flags } : verdict;
  if (argv.includes('--json')) console.log(JSON.stringify(result));
  else console.log(verdict.blocked ? `[claude-seat-guard] blocked: ${verdict.reason} until ${verdict.resetsAt}` : `[claude-seat-guard] allow: ${verdict.reason}`);
  return verdict.blocked ? 3 : 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
