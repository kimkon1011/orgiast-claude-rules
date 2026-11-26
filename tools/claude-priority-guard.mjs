#!/usr/bin/env node
// Periodically lower idle claude.exe processes to BelowNormal, but keep active
// ones at Normal to prevent child-process priority inheritance issues.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isEntry } from './is-entry.mjs';

const STATE_PATH = resolve(homedir(), '.claude', 'state', 'claude-priority-guard.json');
const CHILD_NAMES = new Set([
  'node.exe', 'gh.exe', 'git.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'cmd.exe',
]);
const RECENT_CHILD_MS = 180_000; // 3 minutes

// ── PowerShell: collect raw process data ──────────────────────────────

export const COLLECT_SCRIPT = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$claudeRows = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Select-Object ProcessId, ExecutablePath, CommandLine)
$processes = @()
foreach ($row in $claudeRows) {
    $procId = $row.ProcessId
    try {
        $p = Get-Process -Id $procId -ErrorAction Stop
        $processes += @{pid=$procId; exe=[string]$row.ExecutablePath; cpu=$p.CPU; priority=[string]$p.PriorityClass}
    } catch {
        $processes += @{pid=$procId; exe=[string]$row.ExecutablePath; cpu=$null; priority=$null}
    }
}
$childNames = @('node.exe','gh.exe','git.exe','powershell.exe','pwsh.exe','bash.exe','cmd.exe')
$childRows = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in $childNames } | Select-Object Name, ProcessId, ParentProcessId, CreationDate, CommandLine)
$children = @()
foreach ($row in $childRows) {
    $createdMs = $null
    if ($row.CreationDate -is [datetime]) { $createdMs = ([DateTimeOffset]$row.CreationDate).ToUnixTimeMilliseconds() }
    $children += @{pid=$row.ProcessId; ppid=$row.ParentProcessId; name=$row.Name; createdMs=$createdMs; creationDate=[string]$row.CreationDate; commandLine=[string]$row.CommandLine}
}
Write-Output (ConvertTo-Json -InputObject @{processes=$processes; children=$children} -Compress -Depth 5)`;

// ── WMI datetime parser ──────────────────────────────────────────────

function parseWmiDate(dateStr) {
  // WMI format: yyyyMMddHHmmss.ffffff±UUU (UUU = minutes offset)
  if (!dateStr || typeof dateStr !== 'string') return null;
  const m = dateStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{3})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, offsetStr] = m;
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const offsetMinutes = +offsetStr; // e.g. 090 → 90 minutes
  return utcMs - offsetMinutes * 60 * 1000;
}

function parseCollectionOutput(raw) {
  const stdout = (typeof raw === 'string' ? raw : (raw.stdout ?? '')).replace(/^﻿/, '').trim();
  const json = JSON.parse(stdout);
  return {
    processes: (json.processes || []).filter(p => p.pid != null).map(p => ({
      pid: p.pid,
      exe: p.exe || '',
      cpu: p.cpu,
      priority: p.priority,
    })),
    children: (json.children || []).filter(c => c.pid != null && c.ppid != null).map(c => ({
      pid: c.pid,
      ppid: c.ppid,
      name: c.name || '',
      commandLine: c.commandLine || '',
      // Get-CimInstance の CreationDate は DateTime で、[string] にすると地域の書式になる。
      // 書式に依存しない createdMs（Unix ミリ秒）を優先し、WMI 形式の文字列は予備として読む。
      createdAt: Number.isFinite(c.createdMs) ? c.createdMs : parseWmiDate(c.creationDate),
    })),
  };
}

export { parseCollectionOutput };

// ── State file I/O ───────────────────────────────────────────────────

function readStateFile(path = STATE_PATH) {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf8'));
    }
  } catch { /* ignore read failures */ }
  return { pids: {}, epochMs: Date.now() };
}

function saveStateFile(state, path = STATE_PATH) {
  try {
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
  } catch { /* ignore write failures */ }
}

// ── Pure functions (testable) ────────────────────────────────────────

export function calcMedian(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function calcThreshold(cpuDeltas, elapsedSeconds) {
  const median = calcMedian(cpuDeltas);
  return Math.max(median * 3, elapsedSeconds * 0.25);
}

const MAX_DEPTH = 4;
const isMcp = proc => Boolean(proc.commandLine && proc.commandLine.toLowerCase().includes('mcp'));
const isRecent = (proc, now) => proc.createdAt != null && (now - proc.createdAt) <= RECENT_CHILD_MS;

// claude の子孫（孫・ひ孫まで）のうち、最近起動したもの。Bash ツールは起動しっぱなしのシェルの下で
// node や gh を起動するので、直下の子だけでは作業中を見落とす。MCP サーバーの枝は待機中でも常駐するので除く。
// 返すのは最近起動したものと、そこから claude までの途中のシェル（以後の起動を Normal で引き継がせるため）。
export function getActiveChildren(claudePid, children, now = Date.now()) {
  const byParent = new Map();
  for (const child of children) {
    if (!CHILD_NAMES.has(child.name) || isMcp(child)) continue;
    if (!byParent.has(child.ppid)) byParent.set(child.ppid, []);
    byParent.get(child.ppid).push(child);
  }
  const result = new Set();
  const walk = (parentPid, chain, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const child of byParent.get(parentPid) || []) {
      if (chain.includes(child.pid)) continue;
      const path = [...chain, child.pid];
      if (isRecent(child, now)) for (const pid of path) result.add(pid);
      walk(child.pid, path, depth + 1);
    }
  };
  walk(claudePid, [], 1);
  return [...result];
}

export function hasActiveChildren(claudePid, children, now = Date.now()) {
  return getActiveChildren(claudePid, children, now).length > 0;
}

/**
 * Build a decision from raw process/child data and previous state.
 * Returns { claudeToRaise, claudeToLower, childrenToRaise, newState }.
 */
export function buildDecision(processes, children, prevState, now = Date.now()) {
  const claudeProcs = processes.filter(p => p.pid != null);
  const prevPids = prevState?.pids || {};
  const elapsedSeconds = prevState?.epochMs ? (now - prevState.epochMs) / 1000 : 0;

  // Compute CPU deltas for non-WindowsApps processes that have previous state
  const cpuDeltas = [];
  const procDeltas = new Map(); // pid → cpuDelta (only for non-excluded with prev state)
  for (const proc of claudeProcs) {
    const isExcluded = proc.exe && proc.exe.toLowerCase().includes('\\windowsapps\\');
    if (isExcluded) continue;
    const prev = prevPids[proc.pid];
    if (prev != null && proc.cpu != null) {
      const delta = Math.max(0, proc.cpu - prev.cpu);
      cpuDeltas.push(delta);
      procDeltas.set(proc.pid, delta);
    }
  }

  const threshold = calcThreshold(cpuDeltas, elapsedSeconds);
  const claudeToRaise = [];
  const claudeToLower = [];
  const childrenToRaise = [];
  const newPids = {};

  for (const proc of claudeProcs) {
    // Always save CPU state for future runs (even excluded processes)
    if (proc.cpu != null) {
      newPids[proc.pid] = { cpu: proc.cpu, at: now };
    }

    const isExcluded = proc.exe && proc.exe.toLowerCase().includes('\\windowsapps\\');
    if (isExcluded) continue;

    const prev = prevPids[proc.pid];
    const delta = procDeltas.get(proc.pid) ?? 0;

    // Active check: CPU delta above threshold OR recent non-MCP children
    const activeByCPU = prev != null && delta >= threshold;
    const activeByChildren = hasActiveChildren(proc.pid, children, now);
    const isActive = activeByCPU || activeByChildren;

    if (isActive) {
      claudeToRaise.push(proc.pid);
      const activeChildPids = getActiveChildren(proc.pid, children, now);
      childrenToRaise.push(...activeChildPids);
    } else {
      claudeToLower.push(proc.pid);
    }
  }

  return {
    claudeToRaise,
    claudeToLower,
    childrenToRaise: [...new Set(childrenToRaise)], // deduplicate
    newState: { pids: newPids, epochMs: now },
  };
}

// ── Apply script builder ────────────────────────────────────────────

export function buildApplyScript(raiseClaude, lowerClaude, raiseChildren) {
  const fmt = arr => arr.length > 0 ? `@(${arr.join(',')})` : '@()';
  const raiseArr = fmt(raiseClaude);
  const lowerArr = fmt(lowerClaude);
  const childrenArr = fmt(raiseChildren);

  return `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$raiseClaude = ${raiseArr}
$lowerClaude = ${lowerArr}
$raiseChildren = ${childrenArr}
$result = @{lowered=0; alreadyLow=0; excluded=0; failed=0; raised=0; childrenRaised=0}
$rows = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Select-Object ProcessId, ExecutablePath)
foreach ($row in $rows) {
    $procId = $row.ProcessId
    $exePath = [string]$row.ExecutablePath
    if ($exePath.ToLower().Contains('\\windowsapps\\')) { $result.excluded++; continue }
    try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        $current = $proc.PriorityClass
        if ($raiseClaude -contains $procId) {
            if ($current -in @('BelowNormal','Idle','Normal')) {
                $proc.PriorityClass = 'Normal'
                $result.raised++
            }
        } elseif ($lowerClaude -contains $procId) {
            if ($current -in @('BelowNormal','Idle')) { $result.alreadyLow++; continue }
            if ($current -ne 'Normal') { continue }
            $proc.PriorityClass = 'BelowNormal'
            $result.lowered++
        }
    } catch { $result.failed++ }
}
foreach ($procId in $raiseChildren) {
    try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        $current = $proc.PriorityClass
        if ($current -in @('BelowNormal','Idle')) {
            $proc.PriorityClass = 'Normal'
            $result.childrenRaised++
        }
    } catch { $result.failed++ }
}
Write-Output (ConvertTo-Json -InputObject $result -Compress)`;
}

// ── Main guard function ──────────────────────────────────────────────

export function guardClaudePriority({
  exec = spawnSync,
  platform = process.platform,
  statePath = STATE_PATH,
} = {}) {
  if (platform !== 'win32') return { skipped: 'non-win32' };

  // Call 1: collect raw process/child data
  let raw;
  try {
    const collResult = exec('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', COLLECT_SCRIPT,
    ], { encoding: 'utf8', windowsHide: true, timeout: 45000 });
    if (collResult.error || (collResult.status != null && collResult.status !== 0)) {
      throw new Error('Collection PowerShell failed');
    }
    raw = parseCollectionOutput(collResult);
  } catch {
    return { lowered: 0, alreadyLow: 0, excluded: 0, failed: 1, raised: 0, childrenRaised: 0 };
  }

  // Read previous state
  const prevState = readStateFile(statePath);

  // Build decision (pure logic)
  const decision = buildDecision(raw.processes, raw.children, prevState, Date.now());

  // Save new state
  saveStateFile(decision.newState, statePath);

  // Call 2: apply priority changes (skip if nothing to do)
  if (
    decision.claudeToRaise.length === 0 &&
    decision.claudeToLower.length === 0 &&
    decision.childrenToRaise.length === 0
  ) {
    return { lowered: 0, alreadyLow: 0, excluded: 0, failed: 0, raised: 0, childrenRaised: 0 };
  }

  try {
    const applyScriptStr = buildApplyScript(
      decision.claudeToRaise, decision.claudeToLower, decision.childrenToRaise,
    );
    const applyResult = exec('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', applyScriptStr,
    ], { encoding: 'utf8', windowsHide: true, timeout: 45000 });
    if (applyResult.error || (applyResult.status != null && applyResult.status !== 0)) {
      throw new Error('Apply PowerShell failed');
    }
    const stdout = (applyResult.stdout ?? '').replace(/^﻿/, '').trim();
    const json = JSON.parse(stdout);
    for (const key of ['lowered', 'alreadyLow', 'excluded', 'failed', 'raised', 'childrenRaised']) {
      if (!Number.isInteger(json[key]) || json[key] < 0) throw new Error(`Invalid ${key}`);
    }
    return json;
  } catch {
    return { lowered: 0, alreadyLow: 0, excluded: 0, failed: 1, raised: 0, childrenRaised: 0 };
  }
}

if (isEntry(import.meta.url)) {
  const result = guardClaudePriority();
  console.log(JSON.stringify(result));
}
