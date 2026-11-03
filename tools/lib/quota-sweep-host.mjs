// Host discovery is kept separate so --dry-run never starts a process.
import { wslInstalled as present } from './wsl-present.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pickDistro } from './codex-wsl-auth-sync.mjs';

// WSL VM のコールドスタートは 15 秒を超える（2026-10-21 kim-PC 実測 15.7 秒）。codex-do と同じ 60 秒で待つ。
// stdin は閉じる: パイプのまま渡すと claude/codex CLI が入力待ちで固まる（同日実測）。
export const WSL_PROBE_TIMEOUT_MS = 60_000;
const NO_STDIN = ['ignore', 'pipe', 'pipe'];

export function discoverWsl({ platform = process.platform, spawnImpl = spawnSync, wslInstalled = present } = {}) {
  if (platform !== 'win32' || !wslInstalled({ platform })) return null;
  const list = spawnImpl('wsl', ['-l', '-q'], { encoding: 'utf16le', timeout: WSL_PROBE_TIMEOUT_MS, windowsHide: true, stdio: NO_STDIN });
  const distro = list.status === 0 ? pickDistro(list.stdout) : null;
  if (!distro) return null;
  const probe = spawnImpl('wsl', ['-d', distro, '--', 'sh', '-c', 'printf "%s" "$HOME"'], { encoding: 'utf8', timeout: WSL_PROBE_TIMEOUT_MS, windowsHide: true, stdio: NO_STDIN });
  const unixHome = String(probe.stdout || '').trim();
  return probe.status === 0 && unixHome.startsWith('/') ? { distro, unixHome, home: `\\\\wsl$\\${distro}${unixHome.replaceAll('/', '\\')}` } : null;
}

export function passiveWslHomes({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return [];
  // UNC filesystem discovery, not wsl.exe: dry-run must not spawn even for probes.
  let distros;
  try { distros = fs.readdirSync('\\\\wsl$\\'); } catch { distros = ['Ubuntu', 'Debian']; }
  const homes = [];
  for (const distro of new Set([env.WSL_DISTRO_NAME, ...distros].filter(Boolean))) {
    const base = `\\\\wsl$\\${distro}\\home`;
    try { for (const user of fs.readdirSync(base)) homes.push(path.win32.join(base, user)); } catch { /* absent distro */ }
  }
  return homes;
}

export function wslPath(value) {
  return value.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

export function interactiveCodex(text) {
  return String(text).split(/\r?\n/).some(line => {
    const tokens = (line.trim().match(/"[^"]*"|\S+/g) || []).map(t => t.replace(/^"|"$/g, ''));
    const index = tokens.findIndex(t => /(?:^|[/\\])codex(?:\.exe)?$/.test(t));
    if (index < 0) return false;
    const args = tokens.slice(index + 1);
    return !args.some(t => ['exec', 'e', 'review', 'plugin', 'login', 'logout', 'mcp-server', 'app-server', '--version', '--help', '-h', '-V'].includes(t));
  });
}

// npm の .cmd シム（claude/codex）は引用符をそのまま実体へ渡すので、空白を含む引数だけ引用する
// （`codex "plugin" "list"` は `unexpected argument '"list"'` で落ちる。2026-10-21 実測）。
export function cmdQuote(arg) {
  return /\s/.test(arg) || arg === '' ? `"${arg}"` : arg;
}

export function nativeCommand(executable, args) {
  if ([executable, ...args].some(value => /["%\r\n!&|<>^]/.test(value))) throw new Error('Unsafe cmd argument');
  return { executable: 'cmd.exe', args: ['/d', '/s', '/c', [executable, ...args.map(cmdQuote)].join(' ')] };
}
