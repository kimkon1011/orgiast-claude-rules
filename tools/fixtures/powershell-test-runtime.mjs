import { spawnSync } from 'node:child_process';

// A mounted powershell.exe (or `exit 0`) does not prove that WSL interop can
// execute scripts and return output. Probe the same transport as these tests.
// Native Windows CI must always execute the tests and surface runtime failures.
export function powerShellTestRuntime(shell, { platform = process.platform, spawn = spawnSync } = {}) {
  if (platform === 'win32') return true;
  const command = "[Console]::Write('orgiast-powershell-test-ready')";
  const result = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    encoding: 'utf8', input: '', timeout: 3000, windowsHide: true,
  });
  return !result.error && result.status === 0 && result.stdout?.trim() === 'orgiast-powershell-test-ready';
}
