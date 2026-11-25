// Windows 側と WSL 側の Codex ログイン(~/.codex/auth.json)のアカウントずれを直す。
// codex-do は Windows でも Codex を WSL で起動するが、ログインは Windows 側で行われることが多い（codex login / fleet-fix-now）。
// 2026-10-10 nishi-PC: Windows 側は nishi の Plus(使用率0%)なのに WSL 側だけ別アカウントで usage limit を返し、
// Codex が使えないまま Gemini へ退避し続けた。WSL 側を Windows 側（そのPCで最後にログインしたアカウント）に揃える。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function accountOf(text) {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    return j?.tokens?.account_id ? { accountId: String(j.tokens.account_id), lastRefresh: String(j.last_refresh || '') } : null;
  } catch { return null; }
}

export function pickDistro(listOutput) {
  const distros = String(listOutput || '').split(/\r?\n/).map(x => x.replace(/\0/g, '').trim()).filter(Boolean);
  return distros.find(x => x.toLowerCase() === 'ubuntu') || distros[0] || null;
}

// 戻り値: { action: 'synced'|'same'|'skip', reason, from?, to? }
export function syncWslCodexAuth({
  platform = process.platform, homeDir = os.homedir(), spawnImpl = spawnSync,
  readFile = f => fs.readFileSync(f, 'utf8'), clearCooldown = () => {}, log = () => {},
} = {}) {
  if (platform !== 'win32') return { action: 'skip', reason: 'not-windows' };
  let winText = null;
  try { winText = readFile(path.join(homeDir, '.codex', 'auth.json')); } catch { return { action: 'skip', reason: 'no-windows-auth' }; }
  const win = accountOf(winText);
  if (!win) return { action: 'skip', reason: 'windows-auth-unreadable' };
  const listed = spawnImpl('wsl', ['-l', '-q'], { encoding: 'utf16le', windowsHide: true, timeout: 60_000 });
  const distro = listed?.status === 0 ? pickDistro(listed.stdout) : null;
  if (!distro) return { action: 'skip', reason: 'no-wsl' };
  const cur = spawnImpl('wsl', ['-d', distro, '--', 'sh', '-c', 'cat "$HOME/.codex/auth.json" 2>/dev/null'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const wsl = accountOf(cur?.stdout);
  if (wsl && wsl.accountId === win.accountId) return { action: 'same', reason: 'same-account' };
  const wrote = spawnImpl('wsl', ['-d', distro, '--', 'sh', '-c', 'mkdir -p "$HOME/.codex" && umask 077 && cat > "$HOME/.codex/auth.json"'], { input: winText, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (wrote?.status !== 0) return { action: 'skip', reason: `write-failed:${wrote?.status}` };
  // 古いアカウントで記録した上限の待ちは新しいアカウントには当てはまらない。
  try { clearCooldown(); } catch {}
  log(`[codex-do] WSL の Codex ログインを Windows 側のアカウントに揃えました（${wsl ? wsl.accountId.slice(0, 8) : 'なし'} → ${win.accountId.slice(0, 8)}）`);
  return { action: 'synced', reason: wsl ? 'account-mismatch' : 'wsl-missing', from: wsl?.accountId ?? null, to: win.accountId };
}
