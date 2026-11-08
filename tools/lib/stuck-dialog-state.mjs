import fs from 'node:fs';
import path from 'node:path';
export const DAY_MS = 86400000;
export function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function dialogMetrics(home, now = Date.now()) {
  const state = readJson(path.join(home, '.claude', 'state', 'stuck-dialog-watch.json'));
  const heartbeat = readJson(path.join(home, '.claude', 'heartbeat', 'stuck-dialog-watch.json'));
  return {
    stuckDialogs24h: (state.events || []).filter(e => now - e.at >= 0 && now - e.at < DAY_MS).length,
    stuckDialogWatcherAt: heartbeat.finishedAt || null,
    stuckDialogWatcherOk: heartbeat.ok === true && now - Date.parse(heartbeat.finishedAt) >= 0 && now - Date.parse(heartbeat.finishedAt) < 10 * 60000,
  };
}

// An unreadable new metric must not block the PC's existing fleet report.
export function safeDialogMetrics(home, now = Date.now()) {
  try { return dialogMetrics(home, now); }
  catch { return { stuckDialogs24h: null, stuckDialogWatcherAt: null, stuckDialogWatcherOk: false }; }
}
