import fs from 'node:fs';
import path from 'node:path';

// Error counters and capability probes also rewrite this file. Only `at`
// records a successful poll; mtime must never hide a receive outage.
export function successfulPollIsFresh(home, maxAgeMs, now = Date.now) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.fleet-mail-last-poll.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
  const at = typeof state?.at === 'string' ? Date.parse(state.at) : NaN;
  const age = now() - at;
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}
