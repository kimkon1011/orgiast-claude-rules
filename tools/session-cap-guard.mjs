#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const HOUR = 60 * 60 * 1000;
export const HOURLY_MARKER = '【グロボの毎時定時起動】';

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function evaluateSessionCap(processes, options = {}) {
  const marker = options.marker ?? HOURLY_MARKER;
  const limit = positiveNumber(options.limit, 2);
  const active = (Array.isArray(processes) ? processes : []).filter((process) =>
    String(process.Name ?? process.name ?? '').toLowerCase() === 'claude.exe'
    && String(process.CommandLine ?? process.commandLine ?? '').includes(marker));
  return { allow: active.length < limit, active, limit };
}

export function classifyAbandoned(sessions, now = Date.now(), staleHours = 3) {
  const thresholdMs = positiveNumber(staleHours, 3) * HOUR;
  return (Array.isArray(sessions) ? sessions : []).filter((session) => {
    if (session.closed) return false;
    const lastActivityMs = new Date(session.lastActivity).getTime();
    return Number.isFinite(lastActivityMs) && now - lastActivityMs >= thresholdMs;
  }).map((session) => ({
    ...session,
    idleHours: Math.round(((now - new Date(session.lastActivity).getTime()) / HOUR) * 100) / 100,
  }));
}

export function decideLaunch({ isHourlyLaunch = () => true, enumerateProcesses, listSessions, now = Date.now(), limit = 2, staleHours = 3 }) {
  try {
    if (!isHourlyLaunch()) return { allow: true, active: [], limit, abandoned: [], warning: null, applicable: false };
    const cap = evaluateSessionCap(enumerateProcesses(), { limit });
    const abandoned = classifyAbandoned(listSessions?.() ?? [], now, staleHours);
    return { ...cap, abandoned, warning: null, applicable: true };
  } catch (error) {
    return { allow: true, active: [], limit, abandoned: [], warning: `process enumeration failed: ${error.message}`, applicable: true };
  }
}

function isHourlyInvocation() {
  const script = `$all=Get-CimInstance Win32_Process;$id=${process.pid};1..4|%{$p=$all|? ProcessId -eq $id;if($p){$p.CommandLine;$id=$p.ParentProcessId}}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr.trim() || `PowerShell exited ${result.status}`);
  return result.stdout.includes(HOURLY_MARKER);
}

function enumerateWindowsProcesses() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object Name,ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr.trim() || `PowerShell exited ${result.status}`);
  const text = result.stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function findHourlySessions(home) {
  const root = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const text = fs.readFileSync(fullPath, 'utf8');
        if (!text.includes(HOURLY_MARKER)) continue;
        const stat = fs.statSync(fullPath);
        sessions.push({
          sessionId: path.basename(entry.name, '.jsonl'),
          lastActivity: stat.mtime.toISOString(),
          closed: /<command-name>\s*\/session-close\s*<\/command-name>|"commandName"\s*:\s*"\/?session-close"/.test(text),
          transcript: fullPath,
        });
      }
    }
  }
  return sessions;
}

function appendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

export function main(env = process.env) {
  const now = Date.now();
  const limit = positiveNumber(env.HOURLY_SESSION_CAP ?? env.SESSION_CAP_MAX, 2);
  const staleHours = positiveNumber(env.HOURLY_SESSION_STALE_HOURS, 3);
  const home = os.homedir();
  const result = decideLaunch({
    isHourlyLaunch: isHourlyInvocation,
    enumerateProcesses: enumerateWindowsProcesses,
    listSessions: () => findHourlySessions(home),
    now,
    limit,
    staleHours,
  });
  const record = {
    at: new Date(now).toISOString(),
    event: result.warning ? 'warning' : result.allow ? 'launch_allowed' : 'launch_skipped',
    reason: result.warning ?? (result.allow ? 'below_cap' : 'hourly_session_cap_reached'),
    activeCount: result.active.length,
    limit: result.limit,
    staleHours,
    abandoned: result.abandoned,
  };
  try {
    appendJsonLine(env.HOURLY_SESSION_GUARD_LOG ?? path.join(home, '.claude', 'logs', 'hourly-session-guard.jsonl'), record);
  } catch (error) {
    console.error(`[hourly-session-guard] warning: log write failed: ${error.message}`);
  }
  console.log(JSON.stringify(record));
  return result.allow ? 0 : 1;
}

if (isEntry(import.meta.url)) process.exitCode = main();
