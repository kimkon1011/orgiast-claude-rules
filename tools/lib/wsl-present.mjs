import { execFileSync } from 'node:child_process';

export function wslInstalled({ platform = process.platform, regQuery = execFileSync } = {}) {
  if (platform !== 'win32') return false;
  try {
    const output = regQuery('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    return /\\Lxss\\\{[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\}\s*$/im.test(String(output));
  } catch { return false; }
}
