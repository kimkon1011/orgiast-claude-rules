#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendOwnerInbox } from './auto-progress-inbox-hook.mjs';
import { notifyKim, KIM_DISCORD_USER_ID } from './notify-kim.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { isEntry } from './is-entry.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const readText = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };

function ownerPcMap(home) {
  const map = readJson(path.join(repo, 'fleet-pc-map.json'));
  for (const [label, row] of Object.entries(readJson(path.join(home, '.claude', 'fleet-pc-map.json')))) {
    map[label] = row && typeof row === 'object' ? { ...map[label], ...row } : row;
  }
  return map;
}

export function resolveOwner({ home = os.homedir(), label = resolveFleetLabel(home), pcMap, gitEmail } = {}) {
  const map = pcMap ?? ownerPcMap(home);
  const aliases = Object.entries(map).find(([, value]) => value && typeof value === 'object' && [value.hostname, value.sheetName, value.remoteName, ...(value.aliases || [])].includes(label));
  const configured = map[label] || aliases?.[1];
  if (configured?.account) return configured.account;
  try { return String(gitEmail ?? execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8', windowsHide: true })).trim(); } catch { return ''; }
}

function directoryRows(home, directory) {
  const data = directory ?? readJson(path.join(home, '.claude', 'orgiast-discord-members.json'));
  return Array.isArray(data) ? data : Object.values(data?.queries || data || {}).flatMap(v => Array.isArray(v?.members) ? v.members : []);
}

function recipientMatchesOwner(owner, id, { home = os.homedir(), directory, pcMap } = {}) {
  const wanted = String(owner || '').trim().toLowerCase();
  if (!wanted || !String(id || '').trim()) return false;
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
  const rows = directoryRows(home, directory);
  const safeId = id => recipientMatchesOwner(owner, id, { home, directory, pcMap: options.pcMap }) ? id : '';
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
export function sendOwnerToast(text, { spawn = spawnSync, onToastResult } = {}) {
  const payload = Buffer.from(Array.from(String(text)).slice(0, 300).join(''), 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'
try {
  $body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
  [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null
  [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] > $null
  $xml=New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Claude 進捗</text><text>'+[Security.SecurityElement]::Escape($body)+'</text></binding></visual></toast>')
  $toast=[Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)
  exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  let result;
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
    result = { ok: !child.error && child.status === 0, exitCode: child.status ?? null, ...(child.error ? { error: child.error.code || child.error.message } : child.status !== 0 ? { error: redactSecrets(String(child.stderr || '')).trim().slice(0, 500) } : {}) };
  } catch (error) { result = { ok: false, exitCode: null, error: error.code || error.message }; }
  onToastResult?.(result);
  return result.ok;
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

export async function notifyOwner(owner, text, options = {}) {
  const home = options.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  options = { ...options, home };
  owner = String(owner || resolveOwner(options)).trim();
  const userId = options.userId ?? resolveOwnerDiscordId(owner, options);
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
  let reason = 'owner Discord recipient unresolved or mismatched';
  if (valid) {
    try {
      const result = await (options.notify ?? notifyKim)(text, { ...options, userId, webhookFallback: false });
      if (result?.delivered === 'dm' && typeof result.messageId === 'string' && result.messageId.trim()) {
        attempts.push({ channel: 'discord', ok: true, messageId: result.messageId });
        return finish({ ...result, channel: 'discord', ok: true });
      }
      reason = result?.reason || 'Discord DM delivery failed or message id missing';
    } catch { reason = 'Discord DM delivery failed'; }
  }
  attempts.push({ channel: 'discord', ok: false, skipped: !valid, reason });
  // Local fallbacks must never deliver another PC owner's private progress here.
  if (!owner || owner.toLowerCase() !== resolveOwner(options).toLowerCase()) {
    return finish({ delivered: 'none', channel: 'none', ok: false, reason });
  }
  let inboxOk = false;
  try { await prependInbox(home, safeText, at); inboxOk = true; } catch { /* recorded below */ }
  attempts.push({ channel: 'inbox', ok: inboxOk });
  try { appendOwnerInbox(home, { source: 'notify-owner', text: safeText }); } catch { /* legacy chat inbox */ }
  const toast = async (body, purpose) => {
    let receipt;
    let ok = false;
    try { ok = Boolean(await (options.toast ?? sendOwnerToast)(body, { ...options, onToastResult: value => { receipt = value; } })); } catch { /* recorded below */ }
    attempts.push({ channel: 'toast', purpose, ...(receipt || {}), ok });
    return ok;
  };
  const sent = await toast(safeText, 'progress');
  if (!valid) {
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
  return finish({ delivered: channel, channel, ok: channel !== 'none', reason, toastExitCode: progressToast?.exitCode ?? null });
}

export async function main(args = process.argv.slice(2), options = {}) {
  if (!args.length) throw new Error('notification body is required');
  const result = await notifyOwner('', args.join(' '), options);
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
