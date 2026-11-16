import os from 'node:os';
import { execFileSync } from 'node:child_process';

export function getFreeMemoryMb(exec = execFileSync, { platform = process.platform, freemem = os.freemem } = {}) {
  try {
    if (platform !== 'win32') {
      const bytes = freemem();
      return Number.isFinite(bytes) && bytes >= 0 ? bytes / (1024 * 1024) : null;
    }
    const result = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory"], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result == null || result.error || (result.status !== undefined && result.status !== 0)) return null;
    const raw = String(result.stdout ?? result).trim();
    if (!/^\d+$/.test(raw)) return null;
    const kb = Number(raw);
    return Number.isFinite(kb) ? kb / 1024 : null;
  } catch { return null; }
}

export async function getCpuUsagePct({ cpusImpl = os.cpus, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), sampleMs = 1000 } = {}) {
  try {
    const snapshot = () => cpusImpl().reduce((sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      // Node uses user/nice/sys/idle/irq; don't add Linux-only fields (NaN).
      total: sum.total + Object.values(cpu.times).reduce((total, value) => total + value, 0),
    }), { idle: 0, total: 0 });
    const first = snapshot();
    await wait(sampleMs);
    const second = snapshot();
    const total = second.total - first.total;
    const idle = second.idle - first.idle;
    if (!Number.isFinite(total) || !Number.isFinite(idle) || total <= 0 || idle < 0 || idle > total) return null;
    return 100 * (1 - idle / total);
  } catch { return null; }
}
