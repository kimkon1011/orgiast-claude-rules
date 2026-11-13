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
export const CLAUDE_PROCESS_SCRIPT = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$rows=@(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Select-Object Name,ExecutablePath,CommandLine)
ConvertTo-Json -InputObject $rows -Compress`;

export function countWindowsClaudeProcesses(exec) {
  try {
    const raw = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CLAUDE_PROCESS_SCRIPT], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const rows = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || !row.Name)) throw new Error('Invalid process snapshot');
    return rows.filter(isClaudeCodeCliProcess).length;
  } catch {
    // If CIM is unavailable, preserve the conservative name-only count.
    const raw = exec('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    return String(raw || '').split(/\r?\n/).filter(line => /^"claude\.exe"/i.test(line.trim())).length;
  }
}
