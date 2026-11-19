import { spawnSync } from 'node:child_process';

/**
 * WSL サブシステム自体の故障を検出する。
 * Windows 以外のプラットフォームでは null を返す。
 * LxssManager サービスが STOPPED → { kind: 'lxss_stopped', detail }
 * wsl -l -v がタイムアウト/異常終了 → { kind: 'wsl_unresponsive', detail }
 * 正常 → null
 *
 * @param {object} [options]
 * @param {string} [options.platform=process.platform]
 * @param {Function} [options.spawnImpl=spawnSync]
 * @returns {{ kind: string, detail: string } | null}
 */
export function wslSubsystemFault({ platform = process.platform, spawnImpl = spawnSync } = {}) {
  if (platform !== 'win32') return null;

  // 1) LxssManager サービス状態確認
  const sc = spawnImpl('sc', ['query', 'LxssManager'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  const scOut = String(sc.stdout || '');
  if (/STOPPED/i.test(scOut)) {
    return { kind: 'lxss_stopped', detail: scOut.trim().slice(-200) };
  }

  // 2) wsl -l -v で応答確認
  const wsl = spawnImpl('wsl.exe', ['-l', '-v'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (wsl.error || wsl.status !== 0 || wsl.signal) {
    return {
      kind: 'wsl_unresponsive',
      detail: [
        wsl.error ? `error: ${wsl.error.message}` : '',
        wsl.status !== undefined ? `exitCode: ${wsl.status}` : '',
        wsl.signal ? `signal: ${wsl.signal}` : '',
        String(wsl.stderr || '').trim().slice(-200),
      ].filter(Boolean).join('; ') || '(unknown)',
    };
  }

  return null;
}