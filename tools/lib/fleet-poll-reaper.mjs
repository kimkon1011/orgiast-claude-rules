import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const POLL_REAP_AFTER_MS = 17 * 60_000;
const execFileAsync = promisify(execFile);

// Only the canonical scheduled poll is eligible; worktrees and extra arguments
// must never widen the process selection. No network or mail work happens here.
export async function reapStalePolls({ home, stderr = console.error, platform = process.platform,
  execFileImpl = execFileAsync } = {}) {
  const script = path.join(home, '.claude', 'nightly-repo', 'tools', 'fleet-mail.mjs');
  if (platform !== 'win32' || !fs.existsSync(script)) return 0;
  try {
    const logFile = path.join(home, '.claude', 'logs', 'fleet-mail.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const { stdout } = await execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', fileURLToPath(new URL('./fleet-poll-reaper.ps1', import.meta.url)),
      '-PollScript', script, '-NodeExe', process.execPath, '-CallerPid', String(process.pid),
      '-MaxAgeMs', String(POLL_REAP_AFTER_MS), '-LogFile', logFile],
    { windowsHide: true, timeout: 15_000, encoding: 'utf8', maxBuffer: 16 * 1024 });
    return Number(stdout.trim()) || 0;
  } catch {
    stderr('fleet-mail: stale poll recovery failed=1');
    return 0;
  }
}
