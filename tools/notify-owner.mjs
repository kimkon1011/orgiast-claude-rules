#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { notifyKim, KIM_DISCORD_USER_ID } from './notify-kim.mjs';
import { redactSecrets } from './redact-secrets.mjs';
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

export function resolveOwnerDiscordId(owner, { home = os.homedir(), directory, ...options } = {}) {
  const wanted = String(owner || '').trim().toLowerCase();
  const data = directory ?? readJson(path.join(home, '.claude', 'orgiast-discord-members.json'));
  const rows = Array.isArray(data) ? data : Object.values(data?.queries || data || {}).flatMap(v => Array.isArray(v?.members) ? v.members : []);
  const matches = [...new Set(rows.filter(row => wanted && (row.emails || []).some(email => String(email).toLowerCase() === wanted)).map(row => row.id).filter(Boolean).map(String))];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return '';
  const maps = options.pcMap ? [options.pcMap] : [ownerPcMap(home)];
  for (const map of maps) {
    const ids = [...new Set(Object.values(map).filter(row => row && typeof row === 'object' && String(row.account || row.owner || '').toLowerCase() === wanted).map(row => row.discordId).filter(Boolean).map(String))];
    if (ids.length) return ids.length === 1 ? ids[0] : '';
  }
  const localOwner = resolveOwner({ home, ...options }).toLowerCase();
  const id = wanted && wanted === localOwner ? readText(path.join(home, '.claude', 'orgiast-discord-user-id.txt')) : '';
  return id === KIM_DISCORD_USER_ID && wanted !== 'kim@orgiast.jp' ? '' : id;
}

// Text is data, never PowerShell syntax; nonzero exit is always undelivered.
export function sendOwnerToast(text, { platform = process.platform, spawn = spawnSync, noticeFile = '' } = {}) {
  if (platform !== 'win32') return { delivered: 'none', exitCode: null, reason: 'Windows toast requires win32' };
  const payload = Buffer.from(JSON.stringify({ body: Array.from(String(text)).slice(0, 300).join(''), file: noticeFile }), 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'
try {
  $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
  [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null
  [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] > $null
  $xml=New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Claude Code 進捗</text><text>'+[Security.SecurityElement]::Escape($p.body)+'</text><text>'+[Security.SecurityElement]::Escape($p.file)+'</text></binding></visual></toast>')
  $toast=[Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($toast)
  exit 0
} catch { exit 1 }`;
  try {
    const result = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    return { delivered: !result.error && result.status === 0 ? 'toast' : 'none', exitCode: result.status ?? null };
  } catch { return { delivered: 'none', exitCode: null, reason: 'PowerShell launch failed' }; }
}

export async function notifyOwner(owner, text, options = {}) {
  const home = options.home ?? os.homedir();
  owner = String(owner || resolveOwner(options)).trim();
  const userId = options.userId ?? resolveOwnerDiscordId(owner, options);
  const channels = { toast: true, discord: true, ...readJson(path.join(home, '.claude', 'notify-channels.json')), ...options.channels };
  let dm;
  let reason = 'owner Discord recipient unresolved or mismatched';
  if (channels.discord && owner && userId && !(String(userId) === KIM_DISCORD_USER_ID && owner.toLowerCase() !== 'kim@orgiast.jp')) {
    try {
      const result = await (options.notify ?? notifyKim)(text, { ...options, userId, webhookFallback: false });
      if (result?.delivered === 'dm') dm = result;
      reason = 'Discord DM delivery failed';
    } catch { reason = 'Discord DM delivery failed'; }
  }
  // Local desktop fallback is only appropriate for this PC's owner.
  let sent = false;
  let exitCode = null;
  let noticeFile;
  const localOwner = resolveOwner({ ...options, home });
  if (channels.toast && owner && owner.toLowerCase() === localOwner.toLowerCase()) {
    try {
      noticeFile = path.join(home, '.claude', 'state', 'progress-notices.md');
      fs.mkdirSync(path.dirname(noticeFile), { recursive: true });
      fs.appendFileSync(noticeFile, `\n## ${new Date().toISOString()}\n${redactSecrets(text)}\n`, { mode: 0o600 });
      const result = await (options.toast ?? sendOwnerToast)(redactSecrets(text), { ...options, noticeFile });
      sent = result === true || result?.delivered === 'toast';
      exitCode = result?.exitCode ?? null;
    } catch { reason = 'Toast delivery or notice append failed'; }
  }
  const channel = sent ? 'toast' : 'none';
  const file = path.join(home, '.claude', 'logs', 'owner-notify-fallback.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), owner: redactSecrets(owner), channel, reason, text: redactSecrets(text) }) + '\n', { mode: 0o600 });
  } catch { /* unwritable home must not break the caller */ }
  return { ...(dm || {}), delivered: dm ? 'dm' : sent ? 'toast' : 'none', channel: dm ? 'discord' : channel, toastDelivered: sent, exitCode, noticeFile, ...(!dm && !sent ? { reason } : {}) };
}
