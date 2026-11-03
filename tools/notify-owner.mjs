#!/usr/bin/env node
import fs from 'node:fs';
import { notificationKind, routeOwnerDm } from './lib/owner-dm-policy.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendOwnerInbox } from './lib/auto-progress-inbox.mjs';
import { notifyKim, KIM_DISCORD_USER_ID } from './notify-kim.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { isEntry } from './is-entry.mjs';
// 所有者解決は lib/fleet-owner.mjs（kim-inbox と共用。ここに置くと notify-kim -> kim-inbox -> notify-owner の import が循環する）。
import { ownerPcMap, resolveOwner } from './lib/fleet-owner.mjs';
export { resolveOwner };

const readJson = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const readText = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };

function localPcEntry(map, label) {
  return map[label] || Object.values(map).find(value => value && typeof value === 'object'
    && [value.hostname, value.sheetName, value.remoteName, ...(value.aliases || [])].includes(label));
}

function explicitNotifyDiscordId(owner, { home = os.homedir(), label = resolveFleetLabel(home), pcMap } = {}) {
  const configured = localPcEntry(pcMap ?? ownerPcMap(home), label);
  const localOwner = String(configured?.account || configured?.owner || '').trim().toLowerCase();
  return localOwner && localOwner === String(owner || '').trim().toLowerCase()
    ? String(configured.notifyDiscordId || '').trim()
    : '';
}

function directoryRows(home, directory) {
  const data = directory ?? readJson(path.join(home, '.claude', 'orgiast-discord-members.json'));
  return Array.isArray(data) ? data : Object.values(data?.queries || data || {}).flatMap(v => Array.isArray(v?.members) ? v.members : []);
}

function recipientMatchesOwner(owner, id, options = {}) {
  const { home = os.homedir(), directory, pcMap } = options;
  const wanted = String(owner || '').trim().toLowerCase();
  if (!wanted || !String(id || '').trim()) return false;
  if (String(id) === explicitNotifyDiscordId(owner, options)) return true;
  if (String(id) === KIM_DISCORD_USER_ID && wanted !== 'kim@orgiast.jp') return false;
  const memberMismatch = directoryRows(home, directory).some(row => String(row.id) === String(id)
    && ((wanted !== 'kim@orgiast.jp' && [row.username, row.global_name, row.nick].some(name => ['kimkon.', '金功勇'].includes(name)))
      || (row.emails || []).some(email => String(email).trim() && String(email).trim().toLowerCase() !== wanted)));
  const mapMismatch = Object.values(pcMap ?? ownerPcMap(home)).some(row => row && typeof row === 'object'
    && String(row.discordId || '') === String(id) && (row.account || row.owner)
    && String(row.account || row.owner).trim().toLowerCase() !== wanted);
  return !memberMismatch && !mapMismatch;
}

export function resolveOwnerDiscordId(owner, { home = os.homedir(), directory, ...options } = {}) {
  const wanted = String(owner || '').trim().toLowerCase();
  const explicitId = explicitNotifyDiscordId(owner, { home, ...options });
  if (explicitId) return explicitId;
  const rows = directoryRows(home, directory);
  const safeId = id => recipientMatchesOwner(owner, id, { home, directory, ...options }) ? id : '';
  const matches = [...new Set(rows.filter(row => wanted && (row.emails || []).some(email => String(email).toLowerCase() === wanted)).map(row => row.id).filter(Boolean).map(String))];
  if (matches.length === 1) return safeId(matches[0]);
  if (matches.length > 1) return '';
  const maps = options.pcMap ? [options.pcMap] : [ownerPcMap(home)];
  for (const map of maps) {
    const ids = [...new Set(Object.values(map).filter(row => row && typeof row === 'object' && String(row.account || row.owner || '').toLowerCase() === wanted).map(row => row.discordId).filter(Boolean).map(String))];
    if (ids.length) return ids.length === 1 ? safeId(ids[0]) : '';
  }
  const localOwner = resolveOwner({ home, ...options }).toLowerCase();
  const id = wanted && wanted === localOwner ? readText(path.join(home, '.claude', 'orgiast-discord-user-id.txt')) : '';
  return safeId(id);
}

// EncodedCommand uses UTF-16LE in Windows PowerShell, including Japanese text.
// 2026-11-04: ToastNotificationManager が画面に出ないため NotifyIcon.ShowBalloonTip に変更。
// pwsh.exe 優先、無ければ powershell.exe。
export function sendOwnerToast(text, { spawn = spawnSync, onToastResult, exe } = {}) {
  const payload = Buffer.from(Array.from(String(text)).slice(0, 300).join(''), 'utf8').toString('base64');
  const shellExe = exe || resolvePowerShellExe();
  const script = `$ErrorActionPreference='Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  $body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
  $icon=New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon=[System.Drawing.SystemIcons]::Information
  $icon.BalloonTipIcon='Info'
  $icon.BalloonTipTitle='Claude 進捗'
  $icon.BalloonTipText=$body
  $icon.Visible=$true
  $icon.ShowBalloonTip(5000)
  Start-Sleep -Seconds 6
  $icon.Dispose()
  exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  let result;
  try {
    const child = spawn(shellExe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
    result = { ok: !child.error && child.status === 0, exitCode: child.status ?? null, ...(child.error ? { error: child.error.code || child.error.message } : child.status !== 0 ? { error: redactSecrets(String(child.stderr || '')).trim().slice(0, 500) } : {}) };
  } catch (error) { result = { ok: false, exitCode: null, error: error.code || error.message }; }
  onToastResult?.(result);
  return result.ok;
}

function resolvePowerShellExe() {
  try {
    const result = spawnSync('where.exe', ['pwsh'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    if (result.status === 0 && String(result.stdout || '').trim()) return 'pwsh.exe';
  } catch { /* fall through */ }
  return 'powershell.exe';
}

export const RECIPIENT_NOTICE = 'Discord の宛先が未設定です。Claude のチャットに『Discordユーザー名: xxx』と送れば設定されます';

async function prependInbox(home, text, at) {
  const file = path.join(home, '.claude', 'owner-inbox.md');
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Serialize watch and digest so neither can overwrite the other's message.
  let fd;
  for (let retry = 0; retry < 100; retry++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (retry === 99) throw new Error('owner inbox is locked');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.writeFileSync(temporary, `## ${at}\n\n${text}\n\n${previous}`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
    try { fs.unlinkSync(temporary); } catch { /* renamed or write failed */ }
  }
}

// 日単位の排他と送信前記録で、watch/digest の同時実行でも警告は1回まで。
export async function alertUnresolvedRecipient(owner, options = {}) {
  const home = options.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const now = new Date(options.now ?? Date.now());
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const file = path.join(home, '.claude', 'logs', 'owner-recipient-kim-alert.json');
  const lock = `${file}.${day}.lock`;
  let fd;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (readJson(file).day === day) return;
    fd = fs.openSync(lock, 'wx', 0o600);
    if (readJson(file).day === day) return;
    fs.writeFileSync(file, JSON.stringify({ day, at: now.toISOString() }), { mode: 0o600 });
    const label = options.label ?? resolveFleetLabel(home);
    const text = redactSecrets(`⚠️ 進捗通知の Discord 宛先が未設定です。PC: ${label} / owner: ${owner || '(未設定)'}。notifyDiscordId の設定が必要です。通知は owner-inbox に保存され、チャットで表示されます。`);
    await (options.notifyKim ?? notifyKim)(text, { home, userId: KIM_DISCORD_USER_ID, kimActionRequired: true, plainJa: false, webhookFallback: false, source: 'owner-recipient' });
  } catch { /* warning failure must not prevent local delivery */ }
  finally { if (fd !== undefined) { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch {} } }
}

export async function notifyOwner(owner, text, options = {}) {
  const home = options.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  options = { ...options, home };
  owner = String(owner || resolveOwner(options)).trim();
  const deferred = await routeOwnerDm(owner, text, options);
  if (deferred) {
    // DM の保留とセッション受け箱への配達は独立（#1485）。
    if (owner && owner.toLowerCase() === resolveOwner(options).toLowerCase()) {
      const safeText = redactSecrets(String(text));
      try { await prependInbox(home, safeText, new Date(options.now ?? Date.now()).toISOString()); } catch { /* continue chat inbox */ }
      try { appendOwnerInbox(home, { source: 'notify-owner', text: safeText }); } catch { /* DM remains queued */ }
    }
    return deferred;
  }
  options = { ...options, ...(notificationKind(text, options) === 'action' ? { kimActionRequired: true, kind: 'ask', plainJa: false } : {}) };
  // kim 宛は Discord ID の有無に関わらず notify-kim に渡し、kim-inbox 台帳（セッション回収）へ入れる（2026-10-27）。
  const userId = options.userId ?? (owner.toLowerCase() === 'kim@orgiast.jp' ? KIM_DISCORD_USER_ID : resolveOwnerDiscordId(owner, options));
  const valid = recipientMatchesOwner(owner, userId, options);
  const now = new Date(options.now ?? Date.now());
  const at = now.toISOString();
  const safeText = redactSecrets(String(text));
  const attempts = [];
  const finish = result => {
    result = { ...result, attempts };
    try {
      const file = path.join(home, '.claude', 'logs', 'owner-notify-fallback.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ at, owner: redactSecrets(owner), ...result, text: safeText }) + '\n', { mode: 0o600 });
    } catch { /* return the receipt even when the ledger is unwritable */ }
    return result;
  };
  const local = owner && owner.toLowerCase() === resolveOwner(options).toLowerCase();
  const kim = owner.toLowerCase() === 'kim@orgiast.jp';
  const configured = localPcEntry(options.pcMap ?? ownerPcMap(home), options.label ?? resolveFleetLabel(home));
  const channels = local && !kim && Array.isArray(configured?.notifyChannels) ? configured.notifyChannels : null;
  const discordEnabled = !channels || channels.includes('discord');
  let localInboxOk = false;
  if (local && !kim) {
    try { await prependInbox(home, safeText, at); localInboxOk = true; } catch { /* continue other delivery paths */ }
    try { appendOwnerInbox(home, { source: 'notify-owner', text: safeText }); } catch { /* continue other delivery paths */ }
  }
  let reason = discordEnabled ? 'owner Discord recipient unresolved or mismatched' : 'Discord disabled by notifyChannels';
  if (valid && discordEnabled) {
    try {
      const result = await (options.notify ?? notifyKim)(text, { ...options, userId, webhookFallback: false });
      if (result?.delivered === 'session-inbox') {
        attempts.push({ channel: 'session-inbox', ok: true, id: result.id });
        return finish({ ...result, channel: 'session-inbox', ok: true });
      }
      if (result?.delivered === 'dm' && typeof result.messageId === 'string' && result.messageId.trim()) {
        attempts.push({ channel: 'discord', ok: true, messageId: result.messageId });
        return finish({ ...result, channel: 'discord', ok: true });
      }
      reason = result?.reason || 'Discord DM delivery failed or message id missing';
    } catch { reason = 'Discord DM delivery failed'; }
  }
  const degradation = !valid && discordEnabled ? { degraded: 'no-recipient' } : {};
  attempts.push({ channel: 'discord', ok: false, skipped: !valid || !discordEnabled, reason, ...degradation });
  if (!valid && discordEnabled) await alertUnresolvedRecipient(owner, options);
  // Local fallbacks must never deliver another PC owner's private progress here.
  if (!owner || owner.toLowerCase() !== resolveOwner(options).toLowerCase()) {
    return finish({ delivered: 'none', channel: 'none', ok: false, reason });
  }
  const fallbackText = !valid && discordEnabled
    ? safeText + `\n\n⚠ Discord 宛先未設定: fleet-pc-map.json の「${options.label ?? resolveFleetLabel(home)}」に notifyDiscordId を追加`
    : safeText;
  let inboxOk = localInboxOk;
  try { if (!inboxOk) { await prependInbox(home, fallbackText, at); inboxOk = true; } } catch { /* recorded below */ }
  attempts.push({ channel: 'inbox', ok: inboxOk, ...degradation });
  try { if (!local || kim) appendOwnerInbox(home, { source: 'notify-owner', text: safeText }); } catch { /* legacy chat inbox */ }
  const toast = async (body, purpose) => {
    let receipt;
    let ok = false;
    try { ok = Boolean(await (options.toast ?? sendOwnerToast)(body, { ...options, onToastResult: value => { receipt = value; } })); } catch { /* recorded below */ }
    attempts.push({ channel: 'toast', purpose, ...(receipt || {}), ok });
    return ok;
  };
  const sent = (!channels || channels.includes('toast')) && await toast(fallbackText, 'progress');
  if (!valid && discordEnabled) {
    const file = path.join(home, '.claude', 'logs', 'owner-recipient-notice.json');
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    // Exclusive creation prevents hourly watch and morning digest racing each other.
    const claim = `${file}.${day}.lock`;
    let claimed = false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (readJson(file).day !== day) {
        fs.writeFileSync(claim, at, { flag: 'wx', mode: 0o600 });
        claimed = true;
        if (readJson(file).day !== day && await toast(RECIPIENT_NOTICE, 'recipient-setup')) fs.writeFileSync(file, JSON.stringify({ day, at }), { mode: 0o600 });
      }
    } catch { /* keep progress delivery independent of setup notice */ }
    finally { if (claimed) { try { fs.unlinkSync(claim); } catch {} } }
  }
  const channel = sent ? 'toast' : inboxOk ? 'inbox' : 'none';
  const progressToast = attempts.find(a => a.purpose === 'progress');
  return finish({ delivered: channel, channel, ok: channel !== 'none', ...degradation, reason, toastExitCode: progressToast?.exitCode ?? null });
}

export async function main(args = process.argv.slice(2), options = {}) {
  if (!args.length) throw new Error('notification body is required');
  const result = await notifyOwner('', args.join(' '), options);
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
