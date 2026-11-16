import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { seatCheck } from './lib/deadline-seat.mjs';
import { isEntry } from './is-entry.mjs';
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
export function convergeDeadlineTasks({ platform = process.platform, home = process.env.ORGIAST_HOME || os.homedir(), run = execFileSync, seat } = {}) {
  const result = { description: '期限台帳（02:40検出・08:30追跡）', checked: true, repaired: false };
  const currentSeat = seat ?? seatCheck(home);
  if (platform !== 'win32' || !currentSeat.kim) return { ...result, status: 'NOTICE' };
  try {
    const output = run('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(toolsDir,'register-deadline-watch-tasks.ps1'),'-Ensure'], { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, ORGIAST_HOME: home } });
    return { ...result, status: 'OK', repaired: /registered:/.test(String(output)) };
  } catch (e) { return { ...result, status: 'NG', reason: e.message }; }
}
if (isEntry(import.meta.url)) {
  if (process.argv.includes('--seat-check')) console.log(JSON.stringify(seatCheck(process.env.ORGIAST_HOME || os.homedir())));
  else { const result = convergeDeadlineTasks(); console.log(JSON.stringify(result)); process.exitCode = result.status === 'NG' ? 1 : 0; }
}
