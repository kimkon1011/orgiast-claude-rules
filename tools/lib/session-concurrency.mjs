import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { isClaudeCodeCliProcess, listWindowsClaudeProcesses } from './windows-process.mjs';

export const SESSION_CONCURRENCY_CAP = 'session_concurrency_cap';

export function countOpenSessions(rows) {
  const claudePids = new Set(rows.map(row => Number(row.ProcessId)).filter(pid => pid > 0));
  return rows.filter(row => {
    if (!isClaudeCodeCliProcess(row) || claudePids.has(Number(row.ParentProcessId))) return false;
    const command = String(row.CommandLine ?? '');
    if (/(?:^|\s)"?--input-format(?=["=\s]|$)/i.test(command)) return true;
    if (/(?:^|\s)"?(?:-p|--print)(?=["\s]|$)/i.test(command)) return false;
    return /(?:^|\s)"?--resume(?=["=\s]|$)|(?:^|[=\s])"?stream-json(?=["\s]|$)/i.test(command);
  }).length;
}

const execFileAsync = promisify(execFile);

function evaluateSnapshot(list, limit) {
  const evaluate = rows => {
    const count = countOpenSessions(rows);
    return { ok: count < limit, reason: count < limit ? 'available' : SESSION_CONCURRENCY_CAP, count, limit };
  };
  const failOpen = () => ({ ok: true, reason: 'process_enumeration_failed', count: null, limit });
  try {
    const rows = list();
    return rows instanceof Promise ? rows.then(evaluate).catch(failOpen) : evaluate(rows);
  } catch {
    return failOpen();
  }
}

export function checkSessionConcurrency({
  env = process.env, platform = process.platform, list = () => listWindowsClaudeProcesses(execFileSync),
} = {}) {
  const configured = Number(env.CLAUDE_MAX_CONCURRENT_SESSIONS);
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 20;
  if (platform !== 'win32') return { ok: true, reason: 'unsupported_platform', count: null, limit };
  return evaluateSnapshot(list, limit);
}

export async function checkSessionConcurrencyAsync(options = {}) {
  return checkSessionConcurrency({
    list: () => listWindowsClaudeProcesses(async (...args) => (await execFileAsync(...args)).stdout),
    ...options,
  });
}

export function sessionConcurrencyLog({ reason, count, limit }) {
  return `${reason} count=${count} limit=${limit}`;
}
