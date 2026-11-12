// ユーザーのアイドル時間を測定する。
// PowerShell + GetLastInputInfo で最終入力を検出し、spawnSync で結果を取得する。
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const SCRIPT = `
Add-Type @'
using System;using System.Runtime.InteropServices;
public class IdleCheck {
  [StructLayout(LayoutKind.Sequential)] public struct INPUTINFO {public uint cbSize,dwTime;}
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref INPUTINFO p);
  public static uint Tick(){var p=new INPUTINFO();p.cbSize=(uint)Marshal.SizeOf(p);if(!GetLastInputInfo(ref p))throw new Exception("GetLastInputInfo");return p.dwTime;}
  public static uint Idle(){return unchecked((uint)Environment.TickCount-Tick())/1000;}
}
'@
[IdleCheck]::Idle()
`;

/**
 * PowerShell + GetLastInputInfo でアイドル秒数を取得する。
 * @param {object} [opts]
 * @param {(cmd: string, args: string[], opts: object) => {status: number|null, stdout: string, error?: Error}} [opts.spawn]
 * @returns {{ ok: boolean, idleSec: number, reason: string }}
 */
export function getIdleSeconds({ spawn = spawnSync } = {}) {
  try {
    const result = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', SCRIPT
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (result.error) {
      return { ok: false, idleSec: 0, reason: result.error.message };
    }
    if (result.status !== 0) {
      return { ok: false, idleSec: 0, reason: `exit code ${result.status}` };
    }
    const sec = parseInt(String(result.stdout ?? '').trim(), 10);
    if (!Number.isFinite(sec)) {
      return { ok: false, idleSec: 0, reason: 'non-numeric output' };
    }
    return { ok: true, idleSec: sec, reason: 'ok' };
  } catch (e) {
    return { ok: false, idleSec: 0, reason: e.message };
  }
}

/**
 * タッチスクリーンが操作可能か（アイドル時間が閾値以上か）を判定する。
 * @param {number} [thresholdSec=600] - アイドル閾値（秒）
 * @param {object} [opts]
 * @param {(opts?: object) => {ok: boolean, idleSec: number, reason: string}} [opts.getIdleImpl]
 * @returns {{ ok: boolean, idleSec: number, reason: string }}
 */
export function canTouchScreen(thresholdSec = 600, { getIdleImpl = getIdleSeconds } = {}) {
  const presence = getIdleImpl();
  if (!presence.ok) {
    return { ok: false, idleSec: 0, reason: presence.reason };
  }
  if (presence.idleSec < thresholdSec) {
    return { ok: false, idleSec: presence.idleSec, reason: `user-active: ${presence.idleSec}s < ${thresholdSec}s` };
  }
  return { ok: true, idleSec: presence.idleSec, reason: 'ok' };
}
