import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { KIM_DISCORD_USER_ID } from './notify-kim.mjs';

export function noticeOwner(home) {
  // 所有者設定の不備で autopilot 全体を止めない。不明なら従来どおりの宛先に戻し、
  // 設定が壊れていることだけ stderr に残す（無人周で全通知が消える方が危険）。
  let raw;
  try { raw = fs.readFileSync(path.join(home, '.claude/autopilot-owner.json'), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`autopilot-owner.json を読めません: ${error.code || error.message}\n`);
    return null;
  }
  try {
    const owner = JSON.parse(raw);
    if (!owner || typeof owner.email !== 'string' || !owner.email.trim()
      || (owner.discordUserId != null && !/^\d+$/.test(owner.discordUserId))) throw new Error('invalid_autopilot_owner');
    return owner;
  } catch (error) {
    process.stderr.write(`autopilot-owner.json が不正です: ${error.message}\n`);
    return null;
  }
}
export function noticeRecipient(home, fallback) {
  const owner = noticeOwner(home);
  const userId = owner?.discordUserId || (fallback !== undefined ? fallback : process.env.ORGIAST_DISCORD_USER_ID?.trim()
    || (() => { try { return fs.readFileSync(path.join(home, '.claude/orgiast-discord-user-id.txt'), 'utf8').trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; return ''; } })()
    || KIM_DISCORD_USER_ID);
  return { userId, notOwner: userId === KIM_DISCORD_USER_ID && Boolean(owner) && owner.email.trim().toLowerCase() !== 'kim@orgiast.jp' };
}
// 定時報告の1行目は長い目的文なので、先頭3行では持ち主が動くべき行がトーストに出ない。
// 判断待ち・作業待ち・状態の行を優先し、無ければ先頭3行に戻す。
export function toastSummary(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const clip = (line) => (line.length > 120 ? `${line.slice(0, 119)}…` : line);
  const picked = [
    ...lines.filter((line) => line.startsWith('判断待ち')),
    ...lines.filter((line) => /^-?\s*待ち \d+ 日/.test(line) || line.startsWith('完了')),
    ...lines.filter((line) => line.startsWith('状態:')),
  ];
  return (picked.length ? picked : lines).slice(0, 3).map(clip).join('\n').slice(0, 500);
}
export async function sendToast(text, { home, hostname = os.hostname(), platform = process.platform, execFileImpl = promisify(execFile) } = {}) {
  if (platform !== 'win32') return { status: 'skipped', reason: 'non-win32' };
  let temp;
  try {
    const dir = path.join(home, '.claude/autopilot');
    fs.mkdirSync(dir, { recursive: true });
    temp = fs.mkdtempSync(path.join(dir, 'toast-'));
    const bodyPath = path.join(temp, 'body.json');
    fs.writeFileSync(bodyPath, JSON.stringify({ title: `Claude 進捗（${hostname}）`, body: toastSummary(text) }), 'utf8');
    await execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./autopilot-toast.ps1', import.meta.url)), '-BodyPath', bodyPath], { timeout: 20_000, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 });
    return { status: 'submitted' };
  } catch (error) { return { status: 'failed', error: String(error.code || error.message) }; }
  finally { if (temp) fs.rmSync(temp, { recursive: true, force: true }); }
}
export async function localNotice(text, ctx) {
  let file;
  const destination = path.join(ctx.home, '.claude/autopilot/latest-digest.md');
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, text, 'utf8');
    file = { status: 'written', path: destination };
  } catch (error) { file = { status: 'failed', error: error.code || error.message }; }
  const toast = await sendToast(text, ctx);
  return { toast, file };
}
