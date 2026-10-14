// register-*.ps1 を setup.mjs の repair(node 実行のみ対応)から呼ぶための共通ラッパ。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function runRegisterPs1(scriptName, { platform = process.platform, spawnImpl = spawnSync, baseUrl = new URL('../', import.meta.url) } = {}) {
  if (platform !== 'win32') return 0;
  const script = fileURLToPath(new URL(scriptName, baseUrl));
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${scriptName} exit=${result.status}`);
  console.log(result.stdout || `${scriptName} registered`);
  return 0;
}
