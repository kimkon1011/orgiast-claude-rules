// Shared Win32_Process enumeration; one CIM query per snapshot.
export const WINDOWS_PROCESS_SCRIPT = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$separator=[char]31
Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object {
  $commandLine=[string]$_.CommandLine
  $commandLine=$commandLine.Replace([char]13,' ').Replace([char]10,' ')
  $fields=@([string]$_.ProcessId,[string]$_.ParentProcessId,$_.CreationDate.ToUniversalTime().ToString('o'),[string]$_.WorkingSetSize,[string]$_.Name,$commandLine)
  ($fields -join $separator)
}`;

/**
 * Checks whether a given process is a Claude Code CLI process, excluding Claude Desktop App
 * (main Electron app process and Electron child processes).
 *
 * Excludes:
 * - Executable path containing \WindowsApps\Claude_ or under \AppData\Local\AnthropicClaude\
 * - Command line containing --type= (Electron child processes like --type=renderer, --type=gpu-process, etc.)
 *
 * If path and command line are not available, defaults to true (safe side).
 */
export function isClaudeCodeCliProcess(processInfo) {
  if (processInfo == null) return false;

  let name = '';
  let commandLine = '';
  let executablePath = '';

  if (typeof processInfo === 'string') {
    const trimmed = processInfo.trim();
    if (/^"claude\.exe"/i.test(trimmed)) {
      name = 'claude.exe';
    } else {
      commandLine = trimmed;
    }
  } else if (typeof processInfo === 'object') {
    name = String(processInfo.Name ?? processInfo.name ?? processInfo.IMAGENAME ?? processInfo.imagename ?? '');
    commandLine = String(processInfo.CommandLine ?? processInfo.commandLine ?? processInfo.cmdline ?? processInfo.command ?? '');
    executablePath = String(processInfo.ExecutablePath ?? processInfo.executablePath ?? processInfo.Path ?? processInfo.path ?? processInfo.exe ?? '');
  }

  if (name && !/^claude(\.exe)?$/i.test(name)) {
    return false;
  }

  const combined = (commandLine + ' ' + executablePath).trim();
  if (!combined || combined.toLowerCase() === name.toLowerCase()) {
    return true;
  }

  const normalized = combined.replaceAll('/', '\\').toLowerCase();
  if (normalized.includes('\\windowsapps\\claude_') || normalized.includes('\\appdata\\local\\anthropicclaude\\')) {
    return false;
  }

  if (normalized.includes('--type=')) {
    return false;
  }

  return true;
}

// JSON keeps processes with inaccessible CommandLine/ExecutablePath in the snapshot.
// Includes ProcessId and ParentProcessId for orphan/zombie detection.
export const CLAUDE_PROCESS_SCRIPT = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$rows=@(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Select-Object Name,ExecutablePath,CommandLine,ProcessId,ParentProcessId)
ConvertTo-Json -InputObject $rows -Compress`;

// Well-known system PIDs (idle, system, process manager) always considered alive.
const ALWAYS_ALIVE_PIDS = new Set([0, 1, 4]);

/**
 * Filters out orphaned claude.exe processes (parent PID not in the alive set).
 * An orphaned CLI process has no parent session \u2014 it's a zombie that inflates
 * the count and should not block RC reconnection.
 */
function excludeOrphans(rows) {
  const alivePids = new Set(rows.map(r => Number(r.ProcessId)).filter(pid => Number.isInteger(pid) && pid > 0));
  return rows.filter(row => {
    const ppid = Number(row.ParentProcessId);
    // Parent PID 0 or missing \u2192 system-initiated, treat as alive
    if (!Number.isInteger(ppid) || ppid <= 0) return true;
    // Well-known system PIDs are always alive (idle/process manager)
    if (ALWAYS_ALIVE_PIDS.has(ppid)) return true;
    // Parent is in the alive set \u2192 not orphaned
    if (alivePids.has(ppid)) return true;
    return false;
  });
}

export function countWindowsClaudeProcesses(exec, { sessionsDir, isWaitingSession, now = Date.now, fsImpl } = {}) {
  try {
    const raw = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CLAUDE_PROCESS_SCRIPT], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const rows = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || !row.Name)) throw new Error('Invalid process snapshot');
    const cliProcs = rows.filter(isClaudeCodeCliProcess);
    const nonOrphan = excludeOrphans(cliProcs);

    // Filter out waiting sessions and Claude Desktop app from the count
    const activeProcs = nonOrphan.filter(row => {
      // Exclude Claude Desktop app (already handled by isClaudeCodeCliProcess, but double-check)
      if (!isClaudeCodeCliProcess(row)) return false;

      const pid = Number(row.ProcessId);
      // Missing or invalid ProcessId: cannot identify the session but still count
      // as an active CLI process (attributed based on name/command line).
      if (!Number.isInteger(pid) || pid <= 0) return true;

      // Check if this process belongs to a waiting session
      const sessionId = getSessionIdFromPid(pid, { sessionsDir, now, fsImpl });
      if (sessionId && isWaitingSession?.(sessionId)) {
        return false; // Exclude waiting session
      }

      return true; // Count as active Claude CLI process
    });

    return activeProcs.length;
  } catch {
    // If CIM is unavailable, preserve the conservative name-only count.
    const raw = exec('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    return String(raw || '').split(/\r?\n/).filter(line => /^"claude\.exe"/i.test(line.trim())).length;
  }
}

// Helper function to get session ID from PID
export function getSessionIdFromPid(pid, { sessionsDir, now = Date.now, fsImpl } = {}) {
  if (!sessionsDir) return null;

  try {
    const entries = fsImpl.readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = entry.path;
      let data;
      try {
        const content = fsImpl.readFileSync(filePath, 'utf8');
        data = JSON.parse(content);
      } catch {
        continue;
      }

      if (data.pid === pid && typeof data.sessionId === 'string' && data.sessionId) {
        return data.sessionId;
      }
    }
  } catch {
    // Registry access failed, cannot determine session ID
  }
  return null;
}
