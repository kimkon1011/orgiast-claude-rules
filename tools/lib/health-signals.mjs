import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './stuck-dialog-state.mjs';
export function expectationLog(home, exp) {
  // Ledger/files under ~/.claude (not logs/) — e.g. next-actions.md freshness.
  if (exp.homeFile) {
    const file = path.join(home, '.claude', exp.homeFile);
    if (!fs.existsSync(file)) return null;
    return { file, mtimeMs: fs.statSync(file).mtimeMs };
  }
  const dir = path.join(home, '.claude', 'logs');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const escaped = String(exp.log || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\.log$/, '');
  const rotated = new RegExp(`^${escaped}\\.locked-\\d{8}-\\d{6}-[a-zA-Z0-9]+\\.log$`);
  const matches = exp.pattern ? files.filter(f => new RegExp(exp.pattern).test(f)) : files.filter(f => f === exp.log || (exp.log && rotated.test(f)));
  return matches.map(file => ({ file: path.join(dir, file), mtimeMs: fs.statSync(path.join(dir,file)).mtimeMs })).sort((a,b) => b.mtimeMs-a.mtimeMs)[0] || null;
}
export function logIsStale(mtimeMs, maxAgeHours, now) { return (now - mtimeMs) / 3600000 > maxAgeHours; }

export function expectationSuccess(home, exp) {
  const job = exp.log?.replace(/\.log$/, '');
  const file = path.join(home, '.claude', 'heartbeat', `${job}.json`);
  const heartbeat = job ? readJson(file) : {};
  // lastRun and file mtime alone do not prove functional success.
  if (heartbeat.ok === true && heartbeat.finishedAt) return { file, at: heartbeat.finishedAt };
  if (!exp.successState) return null;
  const stateFile = path.join(home, '.claude', exp.successState.file);
  const state = readJson(stateFile);
  if (state.ok !== true) return null;
  return { file: stateFile, at: state[exp.successState.field || 'lastSuccessAt'] };
}
