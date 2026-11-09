// PID-file-based session liveness detection.
// Reads ~/.claude/sessions/<pid>.json to identify live sessions without
// launching claude.exe, avoiding ETIMEDOUT under high load.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
// Maximum tolerated difference (ms) between JSON startedAt and process start
// time to detect PID reuse. See Windows process-hygiene pattern.
export const START_TIME_TOLERANCE_MS = 120_000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}

// Windows: get process start time via WMI to detect PID reuse.
function psCreateDate(pid, spawn) {
  try {
    const result = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToUniversalTime().ToString('o')`],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    );
    if (result.status === 0 && result.stdout.trim()) {
      return new Date(result.stdout.trim());
    }
    return null;
  } catch {
    return null;
  }
}

// Cross-platform: check if a PID is alive without killing the process.
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

// Check if a PID is alive AND its start time matches the recorded startedAt
// (prevents PID-reuse false positives). Uses process.kill(0) first, then
// verifies start time when available.
export function pidIsSessionProcess(pid, startedAt, { spawn = psCreateDate, now = Date.now } = {}) {
  if (!pidAlive(pid)) return false;
  if (!startedAt) return true; // No timestamp to check — trust kill(0)
  const recorded = new Date(startedAt).getTime();
  const created = spawn(pid);
  if (!created) return true; // Cannot verify — trust kill(0)
  const diff = Math.abs(created.getTime() - recorded);
  return diff < START_TIME_TOLERANCE_MS;
}

// Parse a PID metadata file and return normalized entry or null.
export function parseSessionMeta(sessionsDir, pid, { fsImpl = fs, now = Date.now } = {}) {
  const file = path.join(sessionsDir, `${pid}.json`);
  try {
    const meta = readJson(file);
    if (!meta || typeof meta.pid !== 'number' || typeof meta.sessionId !== 'string') return null;
    if (!pidIsSessionProcess(meta.pid, meta.startedAt)) return null;
    return {
      pid: meta.pid,
      sessionId: meta.sessionId,
      bridgeSessionId: meta.bridgeSessionId || null,
      cwd: meta.cwd || null,
    };
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e instanceof SyntaxError) return null;
    throw e;
  }
}

// Main entry point: enumerate all PID files in sessions dir, validate each,
// return a Map<sessionId, { pid, bridgeSessionId, cwd }> of live sessions.
// Falls back to empty Map when the sessions dir does not exist.
// base: optional ~/.claude directory (e.g. os.homedir() + '/.claude').
//       When omitted, SESSIONS_DIR is used directly.
export function liveSessions(base, { fsImpl = fs, spawn } = {}) {
  const dir = base ? path.join(base, 'sessions') : SESSIONS_DIR;
  const result = new Map();
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return result;
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const pid = parseInt(entry.name.slice(0, -5), 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const meta = parseSessionMeta(dir, pid, { fsImpl, now: Date.now });
    if (!meta || !meta.sessionId) continue;
    // Prefer first entry; duplicates with same sessionId keep first.
    if (!result.has(meta.sessionId)) {
      result.set(meta.sessionId, { pid: meta.pid, bridgeSessionId: meta.bridgeSessionId, cwd: meta.cwd });
    }
  }
  return result;
}