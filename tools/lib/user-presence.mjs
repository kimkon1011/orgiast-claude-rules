// ユーザーが PC を操作中かどうかを、無操作時間（アイドル秒数）で判定する共通モジュール。
// 無人ジョブが user の画面操作を避けるためのガードとして使う。
// 依存注入可能な純粋関数で構成し、単体テストは mock で行う。
import { spawnSync } from 'node:child_process';

// Windows: PowerShell で user32 GetLastInputInfo から無操作秒数を取得する。
// C# Add-Type + GetLastInputInfo を使い、Environment.TickCount - dwTime を /1000 で秒に。
// 失敗時は安全側（操作中＝0）として返す。
export function getIdleSeconds({ spawn = spawnSync } = {}) {
  try {
    const script = `
Add-Type @'
using System;using System.Runtime.InteropServices;
public class IdleHelper {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO {public uint cbSize;public uint dwTime;}
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  public static uint IdleSeconds() {
    var p=new LASTINPUTINFO();p.cbSize=(uint)Marshal.SizeOf(p);
    if(!GetLastInputInfo(ref p)) return 0;
    return (unchecked((uint)Environment.TickCount)-p.dwTime)/1000;
  }
}
'@
[IdleHelper]::IdleSeconds()
`;
    const result = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script,
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (result.error || result.status !== 0) return 0;
    const output = String(result.stdout ?? '').trim();
    const parsed = parseInt(output, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

// 安全に画面を操作できるか（= ユーザーが minIdleSec 秒以上操作していない）を判定する。
// 戻り値: { ok, idleSec, reason }
export function canTouchScreen({ minIdleSec = 900, getIdleSec = getIdleSeconds } = {}) {
  const idleSec = getIdleSec();
  if (idleSec >= minIdleSec) {
    return { ok: true, idleSec, reason: `無操作 ${idleSec}秒（閾値 ${minIdleSec}秒以上）` };
  }
  return { ok: false, idleSec, reason: `ユーザー操作中（無操作 ${idleSec}秒、閾値 ${minIdleSec}秒未満）` };
}
